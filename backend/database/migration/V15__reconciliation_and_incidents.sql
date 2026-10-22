CREATE TABLE reconciliation_schedule (
    mode VARCHAR(12) PRIMARY KEY CHECK(mode IN ('PENDING','LEDGER')),
    next_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_successful_at TIMESTAMPTZ
);
INSERT INTO reconciliation_schedule(mode) VALUES('PENDING'),('LEDGER');
CREATE TABLE reconciliation_runs (
    id UUID PRIMARY KEY, idempotency_key UUID NOT NULL UNIQUE, payload_hash VARCHAR(64) NOT NULL,
    mode VARCHAR(12) NOT NULL CHECK(mode IN ('PENDING','LEDGER')),
    actor_id UUID REFERENCES members(id), reason VARCHAR(300) NOT NULL,
    from_at TIMESTAMPTZ NOT NULL, to_at TIMESTAMPTZ NOT NULL CHECK(to_at>from_at),
    status VARCHAR(24) NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','SCANNING','PROCESSING','SUCCEEDED','REVIEW_REQUIRED')),
    phase VARCHAR(24) NOT NULL DEFAULT 'INTERNAL', cursor_key VARCHAR(80), cursor_time TIMESTAMPTZ, cursor_id UUID,
    page_count INTEGER NOT NULL DEFAULT 0, attempt_count INTEGER NOT NULL DEFAULT 0,
    page_attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    lease_token UUID, lease_until TIMESTAMPTZ, last_error VARCHAR(80),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX reconciliation_active_mode_idx ON reconciliation_runs(mode) WHERE status IN ('QUEUED','SCANNING','PROCESSING');
CREATE INDEX reconciliation_runs_due_idx ON reconciliation_runs(next_attempt_at,id) WHERE status IN ('QUEUED','SCANNING');
CREATE TABLE reconciliation_items (
    id UUID PRIMARY KEY, run_id UUID NOT NULL REFERENCES reconciliation_runs(id),
    kind VARCHAR(12) NOT NULL CHECK(kind IN ('PAYMENT','ISSUANCE','REFUND')), target_id UUID NOT NULL,
    order_id UUID REFERENCES orders(id),
    status VARCHAR(24) NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','PROCESSING','RETRY','SUCCEEDED','REVIEW_REQUIRED','STALE')),
    outcome VARCHAR(40), attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), lease_token UUID, lease_until TIMESTAMPTZ,
    last_error VARCHAR(80), external_status VARCHAR(32), external_reference VARCHAR(120), evidence_hash VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), checked_at TIMESTAMPTZ,
    UNIQUE(run_id,kind,target_id)
);
CREATE INDEX reconciliation_items_due_idx ON reconciliation_items(next_attempt_at,id) WHERE status IN ('QUEUED','PROCESSING','RETRY');
CREATE INDEX reconciliation_items_run_idx ON reconciliation_items(run_id,id);
CREATE TABLE external_cancellations (
    id UUID PRIMARY KEY, payment_id UUID NOT NULL, request_id UUID NOT NULL,
    amount BIGINT NOT NULL CHECK(amount>0), cancelled_total BIGINT NOT NULL CHECK(cancelled_total>=amount),
    evidence_hash VARCHAR(64) NOT NULL, external_occurred_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX external_cancellations_payment_idx ON external_cancellations(payment_id,id);
CREATE TABLE incidents (
    id UUID PRIMARY KEY, order_id UUID REFERENCES orders(id), kind VARCHAR(12) NOT NULL,
    target_id UUID NOT NULL, code VARCHAR(80) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','INVESTIGATING','RESOLVED')),
    version BIGINT NOT NULL DEFAULT 1, actor_id UUID REFERENCES members(id), reason VARCHAR(300),
    external_reference VARCHAR(120), evidence_hash VARCHAR(64),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    resolved_at TIMESTAMPTZ, UNIQUE(kind,target_id,code)
);
CREATE INDEX incidents_open_idx ON incidents(last_seen_at DESC,id) WHERE status<>'RESOLVED';
CREATE TABLE incident_actions (
    id UUID PRIMARY KEY, incident_id UUID NOT NULL REFERENCES incidents(id), actor_id UUID NOT NULL REFERENCES members(id),
    idempotency_key UUID NOT NULL, payload_hash VARCHAR(64) NOT NULL, reason VARCHAR(300) NOT NULL,
    expected_version BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(incident_id,idempotency_key)
);
CREATE TABLE incident_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, incident_id UUID NOT NULL REFERENCES incidents(id),
    status VARCHAR(16) NOT NULL, actor VARCHAR(100), reason VARCHAR(300), evidence_hash VARCHAR(64),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX incident_events_incident_idx ON incident_events(incident_id,id);
CREATE FUNCTION record_incident_change() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
BEGIN
    IF TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash
        OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.reason IS DISTINCT FROM OLD.reason THEN
        INSERT INTO public.incident_events(incident_id,status,actor,reason,evidence_hash)
        VALUES(NEW.id,NEW.status,COALESCE((SELECT username FROM public.members WHERE id=NEW.actor_id),'SYSTEM'),NEW.reason,NEW.evidence_hash);
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION record_incident_change() FROM PUBLIC;
CREATE TRIGGER incident_history AFTER INSERT OR UPDATE ON incidents FOR EACH ROW EXECUTE FUNCTION record_incident_change();
GRANT SELECT,UPDATE ON reconciliation_schedule TO alpha_media_app;
GRANT SELECT,INSERT ON reconciliation_runs,reconciliation_items,incidents,incident_actions,external_cancellations TO alpha_media_app;
GRANT UPDATE(status,phase,cursor_key,cursor_time,cursor_id,page_count,attempt_count,page_attempt_count,next_attempt_at,lease_token,lease_until,last_error,completed_at)
    ON reconciliation_runs TO alpha_media_app;
GRANT UPDATE(order_id,status,outcome,attempt_count,next_attempt_at,lease_token,lease_until,last_error,external_status,external_reference,evidence_hash,checked_at)
    ON reconciliation_items TO alpha_media_app;
GRANT UPDATE(order_id,status,version,actor_id,reason,external_reference,evidence_hash,last_seen_at,resolved_at) ON incidents TO alpha_media_app;
GRANT SELECT ON incident_events TO alpha_media_app;
