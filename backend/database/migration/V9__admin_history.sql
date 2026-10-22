-- Omit the second demo operator when its deployment secret is not configured.
INSERT INTO members(id,username,display_name,password_hash,role)
SELECT '10000000-0000-4000-8000-000000000004','admin2','운영자 2','${admin2PasswordHash}','ADMIN'
WHERE '${admin2PasswordHash}' <> '';

CREATE TABLE order_history (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES orders(id),
    target VARCHAR(16) NOT NULL CHECK (target IN ('ORDER','PAYMENT','ISSUANCE','PROFILE','REFUND','ACTION')),
    target_id UUID NOT NULL,
    from_status VARCHAR(32),
    to_status VARCHAR(32) NOT NULL,
    actor VARCHAR(80) NOT NULL,
    source VARCHAR(40) NOT NULL,
    reason TEXT,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX order_history_order_idx ON order_history(order_id,id DESC);

-- Old rows are snapshots at migration time, not reconstructed transitions.
INSERT INTO order_history(order_id,target,target_id,to_status,actor,source,reason)
SELECT id,'ORDER',id,status,'SYSTEM','SNAPSHOT','이력 수집 시작 시점의 상태. 이전 변경 이력은 보유하지 않습니다.' FROM orders
UNION ALL SELECT order_id,'PAYMENT',id,status,'SYSTEM','SNAPSHOT',NULL FROM payment_attempts
UNION ALL SELECT order_id,'ISSUANCE',id,status,'SYSTEM','SNAPSHOT',NULL FROM issuance_jobs
UNION ALL SELECT order_id,'PROFILE',id,install_status,'SYSTEM','SNAPSHOT',NULL FROM sim_profiles
UNION ALL SELECT order_id,'REFUND',id,status,'SYSTEM','SNAPSHOT',NULL FROM refunds;

-- Triggers keep worker claims, expiry and callbacks in the same transaction as history.
CREATE FUNCTION record_order_transition() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    row_data JSONB := to_jsonb(NEW);
    old_data JSONB;
    previous TEXT;
    current_status TEXT := row_data->>TG_ARGV[1];
    order_ref UUID;
    who TEXT := 'SYSTEM';
    signal TEXT := NULLIF(current_setting('alpha.history_source',true),'');
    explanation TEXT := NULLIF(current_setting('alpha.history_reason',true),'');
    actor_ref TEXT := NULLIF(current_setting('alpha.history_actor',true),'');
BEGIN
    IF TG_OP='UPDATE' THEN
        old_data := to_jsonb(OLD);
        previous := old_data->>TG_ARGV[1];
        IF previous IS NOT DISTINCT FROM current_status
            AND NOT (TG_ARGV[0]='PROFILE' AND old_data->>'qr_viewed_at' IS NULL AND row_data->>'qr_viewed_at' IS NOT NULL) THEN
            RETURN NEW;
        END IF;
    END IF;
    order_ref := CASE WHEN TG_ARGV[0]='ORDER' THEN NEW.id ELSE (row_data->>'order_id')::UUID END;
    IF actor_ref IS NOT NULL THEN
        SELECT role||':'||username INTO who FROM public.members WHERE id=actor_ref::UUID;
    ELSIF TG_ARGV[0]='ORDER' AND TG_OP='INSERT' THEN
        SELECT role||':'||username INTO who FROM public.members WHERE id=(row_data->>'member_id')::UUID;
    END IF;
    signal := COALESCE(signal,CASE
        WHEN TG_ARGV[0]='ORDER' AND current_status='EXPIRED' THEN 'ORDER_EXPIRY'
        WHEN TG_ARGV[0]='PROFILE' AND current_status='EXPIRED' THEN 'SIM_EXPIRY'
        ELSE TG_ARGV[0]||'_WORKER' END);
    explanation := COALESCE(explanation,row_data->>'last_error',row_data->>'decline_code');
    INSERT INTO public.order_history(order_id,target,target_id,from_status,to_status,actor,source,reason)
    VALUES(order_ref,TG_ARGV[0],NEW.id,previous,current_status,COALESCE(who,'SYSTEM'),signal,explanation);
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION record_order_transition() FROM PUBLIC;

CREATE TRIGGER orders_history AFTER INSERT OR UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION record_order_transition('ORDER','status');
CREATE TRIGGER payments_history AFTER INSERT OR UPDATE ON payment_attempts
    FOR EACH ROW EXECUTE FUNCTION record_order_transition('PAYMENT','status');
CREATE TRIGGER issuances_history AFTER INSERT OR UPDATE ON issuance_jobs
    FOR EACH ROW EXECUTE FUNCTION record_order_transition('ISSUANCE','status');
CREATE TRIGGER profiles_history AFTER INSERT OR UPDATE ON sim_profiles
    FOR EACH ROW EXECUTE FUNCTION record_order_transition('PROFILE','install_status');
CREATE TRIGGER refunds_history AFTER INSERT OR UPDATE ON refunds
    FOR EACH ROW EXECUTE FUNCTION record_order_transition('REFUND','status');

CREATE FUNCTION record_admin_action() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    INSERT INTO public.order_history(order_id,target,target_id,to_status,actor,source,reason)
    SELECT NEW.order_id,'ACTION',NEW.id,NEW.type,'ADMIN:'||username,'ADMIN_ACTION',NEW.reason
    FROM public.members WHERE id=NEW.actor_id;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION record_admin_action() FROM PUBLIC;
CREATE TRIGGER admin_actions_history AFTER INSERT ON admin_actions
    FOR EACH ROW EXECUTE FUNCTION record_admin_action();

-- The application can read history, but cannot rewrite, remove or insert it directly.
GRANT SELECT ON order_history TO alpha_media_app;
