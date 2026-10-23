-- One fault cycle per order; immutable actions retain the operator and retry evidence.
CREATE TABLE mock_payment_storage_actions (
    id UUID PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES orders(id),
    action VARCHAR(10) NOT NULL CHECK (action IN ('ARM','RELEASE')),
    actor_id UUID NOT NULL REFERENCES members(id),
    idempotency_key UUID NOT NULL,
    reason VARCHAR(300) NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 300),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(order_id,action),
    UNIQUE(order_id,idempotency_key)
);
GRANT SELECT,INSERT ON mock_payment_storage_actions TO alpha_media_app;

CREATE FUNCTION record_mock_payment_storage_action() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    INSERT INTO public.order_history(order_id,target,target_id,from_status,to_status,actor,source,reason)
    SELECT NEW.order_id,'ORDER',NEW.order_id,
        CASE WHEN NEW.action='ARM' THEN 'DB_WRITE_NORMAL' ELSE 'DB_WRITE_FAULT' END,
        CASE WHEN NEW.action='ARM' THEN 'DB_WRITE_FAULT' ELSE 'DB_WRITE_RELEASED' END,
        'ADMIN:'||username,'MOCK_PAYMENT_STORAGE_'||NEW.action,NEW.reason
    FROM public.members WHERE id=NEW.actor_id;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION record_mock_payment_storage_action() FROM PUBLIC;
CREATE TRIGGER mock_payment_storage_history AFTER INSERT ON mock_payment_storage_actions
    FOR EACH ROW EXECUTE FUNCTION record_mock_payment_storage_action();

-- Fail a real SQL write after PG approval, without rejecting durable webhook receipt storage.
-- Applies to response, lookup and webhook paths so another worker cannot bypass the fault.
CREATE FUNCTION simulate_mock_payment_storage_failure() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM public.mock_payment_storage_actions WHERE order_id=NEW.order_id AND action='ARM')
       AND NOT EXISTS(SELECT 1 FROM public.mock_payment_storage_actions WHERE order_id=NEW.order_id AND action='RELEASE')
       AND EXISTS(SELECT 1 FROM public.mock_pg_payments WHERE payment_id=NEW.id AND order_id=NEW.order_id AND status='APPROVED') THEN
        RAISE EXCEPTION 'Simulated payment approval storage failure' USING ERRCODE='40001';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION simulate_mock_payment_storage_failure() FROM PUBLIC;
CREATE TRIGGER mock_payment_storage_failure AFTER UPDATE OF status ON payment_attempts
    FOR EACH ROW WHEN (NEW.status='APPROVED' AND OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION simulate_mock_payment_storage_failure();
