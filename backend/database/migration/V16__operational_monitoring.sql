CREATE TABLE worker_heartbeats (
    name VARCHAR(32) PRIMARY KEY,
    enabled BOOLEAN NOT NULL,
    initialized_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_seen_at TIMESTAMPTZ
);
CREATE TABLE monitoring_status (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(id),
    last_checked_at TIMESTAMPTZ
);
INSERT INTO monitoring_status(id) VALUES(TRUE);
GRANT SELECT,INSERT ON worker_heartbeats TO alpha_media_app;
GRANT UPDATE(last_seen_at,enabled,initialized_at) ON worker_heartbeats TO alpha_media_app;
GRANT SELECT ON monitoring_status TO alpha_media_app;
GRANT UPDATE(last_checked_at) ON monitoring_status TO alpha_media_app;

-- Keep the start of an uninterrupted failure, not the time of the latest retry.
ALTER TABLE issuance_jobs ADD COLUMN supplier_failure_since TIMESTAMPTZ;
ALTER TABLE sim_profiles ADD COLUMN sync_failure_since TIMESTAMPTZ;
UPDATE issuance_jobs SET supplier_failure_since=clock_timestamp() WHERE last_error IS NOT NULL;
UPDATE sim_profiles SET sync_failure_since=clock_timestamp() WHERE sync_error IS NOT NULL;
CREATE FUNCTION track_supplier_failure() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME='issuance_jobs' THEN
        NEW.supplier_failure_since=CASE WHEN NEW.last_error IS NULL THEN NULL
            ELSE COALESCE(OLD.supplier_failure_since,clock_timestamp()) END;
    ELSE
        NEW.sync_failure_since=CASE WHEN NEW.sync_error IS NULL THEN NULL
            ELSE COALESCE(OLD.sync_failure_since,clock_timestamp()) END;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER issuance_failure_clock BEFORE UPDATE OF last_error ON issuance_jobs
    FOR EACH ROW EXECUTE FUNCTION track_supplier_failure();
CREATE TRIGGER profile_failure_clock BEFORE UPDATE OF sync_error ON sim_profiles
    FOR EACH ROW EXECUTE FUNCTION track_supplier_failure();

-- Active leases and future retry times are not executable backlog.
CREATE VIEW monitoring_queue_items AS
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
    FROM reconciliation_items WHERE status IN ('QUEUED','PROCESSING','RETRY');
CREATE VIEW monitoring_supplier_failures AS
SELECT 'ISSUANCE'::varchar AS kind,id,order_id,supplier_failure_since AS since,last_error AS error
    FROM issuance_jobs WHERE is_current AND status NOT IN ('ISSUED','FAILED') AND supplier_failure_since IS NOT NULL
UNION ALL SELECT 'PROFILE',id,order_id,sync_failure_since,sync_error FROM sim_profiles
    WHERE install_status<>'DELETED' AND sync_failure_since IS NOT NULL;
GRANT SELECT ON monitoring_queue_items,monitoring_supplier_failures TO alpha_media_app;

-- Critical conflicts must appear when committed, without waiting for the 15-minute reconciliation.
CREATE FUNCTION incident_on_order_conflict() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
BEGIN
    INSERT INTO public.incidents(id,order_id,kind,target_id,code,reason,evidence_hash)
    VALUES(gen_random_uuid(),NEW.order_id,NEW.target,NEW.target_id,'ORDER_RESULT_CONFLICT',NEW.code,NEW.payload_hash)
    ON CONFLICT(kind,target_id,code) DO UPDATE SET
        last_seen_at=clock_timestamp(),
        status=CASE WHEN incidents.status='RESOLVED' THEN 'OPEN' ELSE incidents.status END,
        actor_id=CASE WHEN incidents.status='RESOLVED' THEN NULL ELSE incidents.actor_id END,
        reason=CASE WHEN incidents.status='RESOLVED' THEN EXCLUDED.reason ELSE incidents.reason END,
        version=incidents.version+CASE WHEN incidents.status='RESOLVED' OR incidents.evidence_hash IS DISTINCT FROM EXCLUDED.evidence_hash THEN 1 ELSE 0 END,
        evidence_hash=EXCLUDED.evidence_hash,resolved_at=NULL;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION incident_on_order_conflict() FROM PUBLIC;
CREATE TRIGGER order_conflict_incident AFTER INSERT ON order_conflicts
    FOR EACH ROW EXECUTE FUNCTION incident_on_order_conflict();
INSERT INTO incidents(id,order_id,kind,target_id,code,reason,evidence_hash)
SELECT gen_random_uuid(),order_id,target,target_id,'ORDER_RESULT_CONFLICT',code,payload_hash
FROM (SELECT DISTINCT ON(target,target_id) * FROM order_conflicts ORDER BY target,target_id,recorded_at DESC,id) c
ON CONFLICT(kind,target_id,code) DO NOTHING;
