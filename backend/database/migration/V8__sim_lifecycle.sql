ALTER TABLE sim_profiles DROP CONSTRAINT sim_profiles_install_status_check;
ALTER TABLE sim_profiles ADD CONSTRAINT sim_profiles_install_status_check
    CHECK (install_status IN ('ISSUED','QR_VIEWED','INSTALLED','ACTIVE','EXPIRED','DELETED'));
ALTER TABLE sim_profiles
    ADD COLUMN qr_viewed_at TIMESTAMPTZ,
    ADD COLUMN installed_at TIMESTAMPTZ,
    ADD COLUMN activated_at TIMESTAMPTZ,
    ADD COLUMN expires_at TIMESTAMPTZ,
    ADD COLUMN supplier_state VARCHAR(12),
    ADD COLUMN supplier_revision BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN supplier_payload_hash VARCHAR(64),
    ADD COLUMN last_synced_at TIMESTAMPTZ,
    ADD COLUMN sync_error VARCHAR(100),
    ADD COLUMN next_sync_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN sync_lease_token UUID,
    ADD COLUMN sync_lease_until TIMESTAMPTZ;
CREATE INDEX sim_profiles_sync_idx ON sim_profiles(next_sync_at)
    WHERE install_status NOT IN ('EXPIRED','DELETED');
CREATE INDEX sim_profiles_expiry_idx ON sim_profiles(expires_at) WHERE install_status='ACTIVE';

CREATE TABLE sim_profile_events (
    event_id UUID PRIMARY KEY,
    profile_id UUID NOT NULL REFERENCES sim_profiles(id),
    payload_hash VARCHAR(64),
    revision BIGINT,
    source VARCHAR(12) NOT NULL CHECK (source IN ('CALLBACK','LOOKUP','QR_VIEW','EXPIRY')),
    from_status VARCHAR(20) NOT NULL,
    to_status VARCHAR(20) NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX sim_profile_events_profile_idx ON sim_profile_events(profile_id,received_at,event_id);

CREATE TABLE mock_supplier_profiles (
    iccid VARCHAR(20) PRIMARY KEY,
    request_id UUID NOT NULL UNIQUE REFERENCES mock_supplier_orders(request_id),
    order_id UUID NOT NULL,
    state VARCHAR(12) NOT NULL DEFAULT 'RELEASED'
        CHECK (state IN ('RELEASED','INSTALLED','ENABLED','DELETED')),
    revision BIGINT NOT NULL DEFAULT 1,
    event_id UUID NOT NULL UNIQUE,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    installed_at TIMESTAMPTZ,
    activated_at TIMESTAMPTZ
);
INSERT INTO mock_supplier_profiles(iccid,request_id,order_id,event_id)
    SELECT iccid,request_id,order_id,gen_random_uuid() FROM mock_supplier_orders WHERE status='ISSUED';

CREATE TABLE mock_profile_notifications (
    event_id UUID PRIMARY KEY,
    iccid VARCHAR(20) NOT NULL REFERENCES mock_supplier_profiles(iccid),
    idempotency_key UUID NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    body TEXT NOT NULL,
    callback_copies INTEGER NOT NULL CHECK (callback_copies BETWEEN 0 AND 20),
    callback_delay_ms INTEGER NOT NULL CHECK (callback_delay_ms BETWEEN 0 AND 60000),
    callback_sent INTEGER NOT NULL DEFAULT 0,
    callback_failures INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ,
    lease_token UUID,
    UNIQUE(iccid,idempotency_key)
);
CREATE INDEX mock_profile_notifications_due_idx ON mock_profile_notifications(next_attempt_at)
    WHERE next_attempt_at IS NOT NULL;
GRANT UPDATE (install_status,qr_viewed_at,installed_at,activated_at,expires_at,supplier_state,
    supplier_revision,supplier_payload_hash,last_synced_at,sync_error,next_sync_at,sync_lease_token,sync_lease_until)
    ON sim_profiles TO alpha_media_app;
GRANT SELECT, INSERT ON sim_profile_events TO alpha_media_app;
GRANT SELECT, INSERT, UPDATE ON mock_supplier_profiles,mock_profile_notifications TO alpha_media_app;
