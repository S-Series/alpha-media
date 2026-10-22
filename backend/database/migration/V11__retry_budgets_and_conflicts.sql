-- Reserve each execution before calling a provider so process death cannot reset its budget.
ALTER TABLE payment_attempts ADD COLUMN execution_round INTEGER NOT NULL DEFAULT 1 CHECK (execution_round > 0),
    ADD COLUMN round_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (round_attempt_count >= 0);
UPDATE payment_attempts SET round_attempt_count=attempt_count;
ALTER TABLE refunds ADD COLUMN execution_round INTEGER NOT NULL DEFAULT 1 CHECK (execution_round > 0),
    ADD COLUMN round_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (round_attempt_count >= 0);
UPDATE refunds SET round_attempt_count=attempt_count;
ALTER TABLE issuance_jobs ADD COLUMN execution_round INTEGER NOT NULL DEFAULT 1 CHECK (execution_round > 0),
    ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    ADD COLUMN submission_count INTEGER NOT NULL DEFAULT 0 CHECK (submission_count >= 0),
    ADD COLUMN waiting_since TIMESTAMPTZ;
-- Old jobs did not distinguish polls from submissions. Conservatively reserve the possible writes.
UPDATE issuance_jobs SET submission_count=LEAST(check_count,6),
    consecutive_failures=CASE WHEN last_error IS NOT NULL OR status='PROCESSING' THEN LEAST(check_count,6) ELSE 0 END,
    waiting_since=CASE WHEN supplier_order_no IS NOT NULL THEN created_at ELSE NULL END;
GRANT UPDATE(round_attempt_count) ON payment_attempts,refunds TO alpha_media_app;
GRANT UPDATE(consecutive_failures,submission_count,waiting_since) ON issuance_jobs TO alpha_media_app;

-- Every recorded conflict holds the order until a future evidence-based recovery action resolves it.
CREATE TABLE order_conflicts (
    id UUID PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES orders(id),
    target VARCHAR(16) NOT NULL CHECK (target IN ('PAYMENT','ISSUANCE','REFUND','PROFILE')),
    target_id UUID NOT NULL,
    code VARCHAR(80) NOT NULL,
    source VARCHAR(40) NOT NULL,
    expected_status VARCHAR(32),
    observed_status VARCHAR(32),
    payload_hash VARCHAR(64) NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(order_id,target,target_id,code,payload_hash)
);
GRANT SELECT,INSERT ON order_conflicts TO alpha_media_app;
ALTER TABLE order_history DROP CONSTRAINT order_history_target_check;
ALTER TABLE order_history ADD CONSTRAINT order_history_target_check
    CHECK (target IN ('ORDER','PAYMENT','ISSUANCE','PROFILE','REFUND','ACTION','CONFLICT'));
CREATE FUNCTION record_order_conflict() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    INSERT INTO public.order_history(order_id,target,target_id,to_status,actor,source,reason)
    VALUES(NEW.order_id,'CONFLICT',NEW.id,'REVIEW_REQUIRED','SYSTEM',NEW.source,NEW.code);
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION record_order_conflict() FROM PUBLIC;
CREATE TRIGGER order_conflicts_history AFTER INSERT ON order_conflicts
    FOR EACH ROW EXECUTE FUNCTION record_order_conflict();
