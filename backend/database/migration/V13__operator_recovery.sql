-- Lifetime counters never reset when an operator opens another bounded execution round.
ALTER TABLE issuance_jobs ADD COLUMN round_submission_count INTEGER NOT NULL DEFAULT 0 CHECK (round_submission_count>=0);
UPDATE issuance_jobs SET round_submission_count=submission_count;
ALTER TABLE inbound_events ADD COLUMN execution_round INTEGER NOT NULL DEFAULT 1 CHECK (execution_round>0),
    ADD COLUMN round_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (round_attempt_count>=0);
UPDATE inbound_events SET round_attempt_count=attempt_count;
GRANT UPDATE(execution_round) ON payment_attempts,refunds,issuance_jobs TO alpha_media_app;
GRANT UPDATE(round_submission_count) ON issuance_jobs TO alpha_media_app;
GRANT UPDATE(execution_round,round_attempt_count) ON inbound_events TO alpha_media_app;
ALTER TABLE payment_attempts ADD COLUMN recovery_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE issuance_jobs ADD COLUMN recovery_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE refunds ADD COLUMN recovery_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE inbound_events ADD COLUMN recovery_revision BIGINT NOT NULL DEFAULT 0;
GRANT UPDATE(recovery_revision) ON payment_attempts,issuance_jobs,refunds,inbound_events TO alpha_media_app;

CREATE TABLE recovery_actions (
    id UUID PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES orders(id),
    actor_id UUID NOT NULL REFERENCES members(id),
    idempotency_key UUID NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    kind VARCHAR(12) NOT NULL CHECK (kind IN ('RECONCILE','RESUME')),
    target VARCHAR(12) NOT NULL CHECK (target IN ('PAYMENT','ISSUANCE','REFUND','INBOUND')),
    target_id UUID NOT NULL,
    expected_version VARCHAR(64) NOT NULL,
    work_version VARCHAR(64) NOT NULL,
    reason VARCHAR(300) NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 300),
    before_snapshot JSONB NOT NULL,
    evidence_id UUID REFERENCES recovery_actions(id),
    from_round INTEGER NOT NULL,
    to_round INTEGER,
    status VARCHAR(24) NOT NULL CHECK (status IN ('QUEUED','PROCESSING','RETRY','SUCCEEDED','REVIEW_REQUIRED','STALE')),
    outcome VARCHAR(40),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    lease_token UUID,
    lease_until TIMESTAMPTZ,
    last_error VARCHAR(80),
    external_status VARCHAR(32),
    external_reference VARCHAR(120),
    evidence_hash VARCHAR(64),
    result_version VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    checked_at TIMESTAMPTZ,
    UNIQUE(order_id,idempotency_key),
    CHECK ((status='PROCESSING')=(lease_token IS NOT NULL)),
    CHECK ((status='PROCESSING')=(lease_until IS NOT NULL)),
    CHECK ((kind='RESUME')=(evidence_id IS NOT NULL))
);
CREATE UNIQUE INDEX recovery_active_target_idx ON recovery_actions(target,target_id)
    WHERE status IN ('QUEUED','PROCESSING','RETRY');
CREATE INDEX recovery_actions_due_idx ON recovery_actions(next_attempt_at,id)
    WHERE status IN ('QUEUED','PROCESSING','RETRY');
CREATE INDEX recovery_actions_order_idx ON recovery_actions(order_id,created_at DESC,id);

CREATE TABLE recovery_action_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    action_id UUID NOT NULL REFERENCES recovery_actions(id),
    status VARCHAR(24) NOT NULL,
    outcome VARCHAR(40),
    attempt_count INTEGER NOT NULL,
    last_error VARCHAR(80),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX recovery_events_action_idx ON recovery_action_events(action_id,id);
CREATE FUNCTION record_recovery_action() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
    INSERT INTO public.recovery_action_events(action_id,status,outcome,attempt_count,last_error)
    VALUES(NEW.id,NEW.status,NEW.outcome,NEW.attempt_count,NEW.last_error);
    INSERT INTO public.order_history(order_id,target,target_id,to_status,actor,source,reason)
    SELECT NEW.order_id,'ACTION',NEW.id,NEW.status,'ADMIN:'||username,'ADMIN_'||NEW.kind,
        NEW.reason||COALESCE(' · '||NEW.outcome,'')||COALESCE(' · '||NEW.last_error,'')
    FROM public.members WHERE id=NEW.actor_id;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION record_recovery_action() FROM PUBLIC;
CREATE TRIGGER recovery_actions_history AFTER INSERT OR UPDATE ON recovery_actions
    FOR EACH ROW EXECUTE FUNCTION record_recovery_action();
GRANT SELECT,INSERT ON recovery_actions TO alpha_media_app;
GRANT UPDATE(status,outcome,attempt_count,next_attempt_at,lease_token,lease_until,last_error,
    external_status,external_reference,evidence_hash,result_version,checked_at) ON recovery_actions TO alpha_media_app;
GRANT SELECT ON recovery_action_events TO alpha_media_app;
