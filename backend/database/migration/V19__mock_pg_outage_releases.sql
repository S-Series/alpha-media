-- Releasing a mock outage must not rewrite the original refund request or retry budget.
CREATE TABLE mock_pg_outage_releases (
    id UUID PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES orders(id),
    refund_id UUID NOT NULL UNIQUE REFERENCES refunds(id),
    payment_id UUID NOT NULL REFERENCES payment_attempts(id),
    actor_id UUID NOT NULL REFERENCES members(id),
    idempotency_key UUID NOT NULL,
    reason VARCHAR(300) NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 300),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(order_id,idempotency_key)
);
GRANT SELECT,INSERT ON mock_pg_outage_releases TO alpha_media_app;

CREATE FUNCTION record_mock_pg_outage_release() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    INSERT INTO public.order_history(order_id,target,target_id,from_status,to_status,actor,source,reason)
    SELECT NEW.order_id,'REFUND',NEW.refund_id,'MOCK_PG_UNAVAILABLE','MOCK_PG_OUTAGE_RELEASED',
        'ADMIN:'||username,'MOCK_PG_OUTAGE_RELEASE',NEW.reason
    FROM public.members WHERE id=NEW.actor_id;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION record_mock_pg_outage_release() FROM PUBLIC;
CREATE TRIGGER mock_pg_outage_release_history AFTER INSERT ON mock_pg_outage_releases
    FOR EACH ROW EXECUTE FUNCTION record_mock_pg_outage_release();
