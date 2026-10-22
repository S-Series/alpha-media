ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK(status IN
 ('PENDING_PAYMENT','PAYMENT_PROCESSING','PAID','EXPIRED','REFUND_PROCESSING','PARTIALLY_REFUNDED','REFUNDED'));
ALTER TABLE refunds DROP CONSTRAINT refunds_order_id_key, DROP CONSTRAINT refunds_payment_id_key,
 DROP CONSTRAINT refunds_status_check, DROP CONSTRAINT refunds_scenario_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_status_check CHECK(status IN
 ('WAITING_GUARD','REQUESTED','PROCESSING','UNKNOWN','SUCCEEDED','FAILED','REVIEW_REQUIRED')),
 ADD CONSTRAINT refunds_scenario_check CHECK(scenario IN ('SUCCESS','RESPONSE_LOST','UNAVAILABLE','DECLINED'));
CREATE INDEX refunds_payment_idx ON refunds(payment_id);
CREATE INDEX refunds_order_idx ON refunds(order_id,created_at DESC,id);

-- Each provider cancellation is counted once, including cancellations performed outside this app.
CREATE TABLE refund_ledger (
 id UUID PRIMARY KEY, payment_id UUID NOT NULL REFERENCES payment_attempts(id),
 request_id UUID NOT NULL, amount BIGINT NOT NULL CHECK(amount>0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), UNIQUE(payment_id,request_id)
);
INSERT INTO refund_ledger(id,payment_id,request_id,amount)
 SELECT pg_cancellation_id,payment_id,id,amount FROM refunds WHERE status='SUCCEEDED';
GRANT SELECT,INSERT ON refund_ledger TO alpha_media_app;

-- A definitive rejection is durable and cannot later become a cancellation with the same key.
CREATE TABLE mock_pg_cancel_rejections (
 id UUID PRIMARY KEY, payment_id UUID NOT NULL REFERENCES mock_pg_payments(payment_id),
 idempotency_key UUID NOT NULL, amount BIGINT NOT NULL CHECK(amount>0),
 cancelled_total BIGINT NOT NULL, scenario VARCHAR(20) NOT NULL, UNIQUE(payment_id,idempotency_key)
);
GRANT SELECT,INSERT ON mock_pg_cancel_rejections TO alpha_media_app;

CREATE TABLE refund_protection_jobs (
 id UUID PRIMARY KEY, order_id UUID NOT NULL REFERENCES orders(id), refund_id UUID NOT NULL REFERENCES refunds(id),
 iccid VARCHAR(22) NOT NULL, phase VARCHAR(12) NOT NULL CHECK(phase IN ('HOLD','RELEASE','TERMINATE')),
 scenario VARCHAR(20) NOT NULL CHECK(scenario IN ('SUCCESS','RESPONSE_LOST','UNAVAILABLE')),
 cleanup_scenario VARCHAR(20) NOT NULL CHECK(cleanup_scenario IN ('SUCCESS','RESPONSE_LOST','UNAVAILABLE')),
 status VARCHAR(20) NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','PROCESSING','UNKNOWN','SUCCEEDED','REJECTED','REVIEW_REQUIRED')),
 attempt_count INTEGER NOT NULL DEFAULT 0, round_attempt_count INTEGER NOT NULL DEFAULT 0,
 execution_round INTEGER NOT NULL DEFAULT 1 CHECK(execution_round BETWEEN 1 AND 3), recovery_revision BIGINT NOT NULL DEFAULT 0,
 last_error VARCHAR(120), next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), lease_token UUID, lease_until TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(refund_id,phase), CHECK((status='PROCESSING')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX refund_protection_due_idx ON refund_protection_jobs(next_attempt_at) WHERE status IN ('QUEUED','PROCESSING','UNKNOWN');
GRANT SELECT,INSERT ON refund_protection_jobs TO alpha_media_app;
GRANT UPDATE(status,attempt_count,round_attempt_count,execution_round,recovery_revision,last_error,next_attempt_at,lease_token,lease_until,updated_at)
 ON refund_protection_jobs TO alpha_media_app;

-- Holds never expire. Every operation locks the same supplier profile row as installation.
CREATE TABLE mock_supplier_holds (
 refund_id UUID PRIMARY KEY, order_id UUID NOT NULL, iccid VARCHAR(22) NOT NULL REFERENCES mock_supplier_profiles(iccid),
 state VARCHAR(12) NOT NULL CHECK(state IN ('BLOCKED','REJECTED','RELEASED','TERMINATED')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX mock_supplier_holds_profile_idx ON mock_supplier_holds(iccid);
CREATE TABLE mock_supplier_hold_operations (
 id UUID PRIMARY KEY, refund_id UUID NOT NULL REFERENCES mock_supplier_holds(refund_id),
 phase VARCHAR(12) NOT NULL, scenario VARCHAR(20) NOT NULL, body TEXT NOT NULL, UNIQUE(refund_id,phase)
);
GRANT SELECT,INSERT,UPDATE ON mock_supplier_holds TO alpha_media_app;
GRANT SELECT,INSERT ON mock_supplier_hold_operations TO alpha_media_app;

ALTER TABLE recovery_actions DROP CONSTRAINT recovery_actions_target_check;
ALTER TABLE recovery_actions ADD CONSTRAINT recovery_actions_target_check CHECK(target IN ('PAYMENT','ISSUANCE','REFUND','INBOUND','PROTECTION'));
ALTER TABLE reconciliation_items DROP CONSTRAINT reconciliation_items_kind_check;
ALTER TABLE reconciliation_items ADD CONSTRAINT reconciliation_items_kind_check CHECK(kind IN ('PAYMENT','ISSUANCE','REFUND','PROTECTION'));

CREATE FUNCTION record_refund_protection() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 INSERT INTO public.order_history(order_id,target,target_id,from_status,to_status,actor,source,reason)
 VALUES(NEW.order_id,'REFUND',NEW.refund_id,CASE WHEN TG_OP='UPDATE' THEN OLD.status END,NEW.status,
 'SYSTEM','SUPPLIER_'||NEW.phase,COALESCE(NEW.last_error,NEW.phase));
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION record_refund_protection() FROM PUBLIC;
CREATE TRIGGER refund_protection_history AFTER INSERT OR UPDATE ON refund_protection_jobs FOR EACH ROW EXECUTE FUNCTION record_refund_protection();

CREATE OR REPLACE VIEW monitoring_queue_items AS
SELECT 'PAYMENT'::varchar AS queue,id,order_id,
    CASE WHEN status='PROCESSING' THEN lease_until ELSE next_attempt_at END AS due_at
    FROM payment_attempts WHERE status IN ('QUEUED','PROCESSING','UNKNOWN')
UNION ALL SELECT 'REFUND',id,order_id,CASE WHEN status='PROCESSING' THEN lease_until ELSE next_attempt_at END
    FROM refunds WHERE status IN ('REQUESTED','PROCESSING','UNKNOWN')
UNION ALL SELECT 'ISSUANCE',id,order_id,CASE WHEN status='PROCESSING' THEN lease_until ELSE next_check_at END
    FROM issuance_jobs WHERE is_current AND status IN ('QUEUED','PROCESSING','WAITING_CALLBACK')
UNION ALL SELECT 'PROFILE',id,order_id,COALESCE(sync_lease_until,next_sync_at)
    FROM sim_profiles WHERE install_status<>'DELETED'
UNION ALL SELECT 'INBOUND',id,order_id,CASE WHEN status='PROCESSING' THEN lease_until ELSE next_attempt_at END
    FROM inbound_events WHERE status IN ('PENDING','PROCESSING','RETRY')
UNION ALL SELECT 'RECOVERY',id,order_id,CASE WHEN status='PROCESSING' THEN lease_until ELSE next_attempt_at END
    FROM recovery_actions WHERE status IN ('QUEUED','PROCESSING','RETRY')
UNION ALL SELECT 'RECONCILIATION_PAGE',id,NULL::uuid,COALESCE(lease_until,next_attempt_at)
    FROM reconciliation_runs WHERE status IN ('QUEUED','SCANNING')
UNION ALL SELECT 'RECONCILIATION_ITEM',id,order_id,CASE WHEN status='PROCESSING' THEN lease_until ELSE next_attempt_at END
    FROM reconciliation_items WHERE status IN ('QUEUED','PROCESSING','RETRY')
 UNION ALL SELECT 'PROTECTION',id,order_id,CASE WHEN status='PROCESSING' THEN lease_until ELSE next_attempt_at END FROM refund_protection_jobs WHERE status IN ('QUEUED','PROCESSING','UNKNOWN');

ALTER TABLE sim_profile_events DROP CONSTRAINT sim_profile_events_source_check;
ALTER TABLE sim_profile_events ADD CONSTRAINT sim_profile_events_source_check CHECK(source IN ('CALLBACK','LOOKUP','QR_VIEW','EXPIRY','REFUND'));
