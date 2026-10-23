CREATE TABLE mock_reconciliation_demos (
    id UUID PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES orders(id),
    payment_id UUID NOT NULL REFERENCES payment_attempts(id),
    kind VARCHAR(32) NOT NULL CHECK(kind IN ('CONFLICTING_DECLINE','EXTERNAL_CANCELLATION')),
    actor_id UUID NOT NULL REFERENCES members(id),
    idempotency_key UUID NOT NULL,
    reason VARCHAR(300) NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 300),
    event_id UUID NOT NULL UNIQUE,
    cancellation_id UUID REFERENCES mock_pg_cancellations(id),
    amount BIGINT NOT NULL CHECK(amount>0),
    copies INTEGER NOT NULL CHECK(copies BETWEEN 1 AND 20),
    delay_ms INTEGER NOT NULL CHECK(delay_ms BETWEEN 0 AND 60000),
    status VARCHAR(20) NOT NULL CHECK(status IN ('PENDING','SENDING','DELIVERED','REVIEW_REQUIRED')),
    sent_count INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ,
    lease_token UUID,
    lease_until TIMESTAMPTZ,
    last_error VARCHAR(80),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    delivered_at TIMESTAMPTZ,
    UNIQUE(order_id),
    UNIQUE(order_id,idempotency_key)
);
CREATE INDEX mock_reconciliation_demo_due ON mock_reconciliation_demos(next_attempt_at) WHERE status IN ('PENDING','SENDING');
GRANT SELECT,INSERT ON mock_reconciliation_demos TO alpha_media_app;
GRANT UPDATE(status,sent_count,attempt_count,next_attempt_at,lease_token,lease_until,last_error,delivered_at)
    ON mock_reconciliation_demos TO alpha_media_app;

CREATE FUNCTION record_mock_reconciliation_demo() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
    INSERT INTO public.order_history(order_id,target,target_id,to_status,actor,source,reason)
    SELECT NEW.order_id,'PAYMENT',NEW.payment_id,NEW.kind,'ADMIN:'||username,'MOCK_RECONCILIATION_DEMO',NEW.reason
    FROM public.members WHERE id=NEW.actor_id;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION record_mock_reconciliation_demo() FROM PUBLIC;
CREATE TRIGGER mock_reconciliation_demo_history AFTER INSERT ON mock_reconciliation_demos
    FOR EACH ROW EXECUTE FUNCTION record_mock_reconciliation_demo();
