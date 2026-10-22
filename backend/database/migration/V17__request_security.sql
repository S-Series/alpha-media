CREATE TABLE request_rate_buckets (
    scope VARCHAR(32) NOT NULL,
    subject_hash CHAR(64) NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    hits INTEGER NOT NULL CHECK(hits>0),
    PRIMARY KEY(scope,subject_hash,window_start)
);
CREATE INDEX request_rate_expiry ON request_rate_buckets(window_start);
CREATE TABLE request_security_counts (
    source VARCHAR(32) NOT NULL,
    reason VARCHAR(40) NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    hits BIGINT NOT NULL DEFAULT 1,
    PRIMARY KEY(source,reason,window_start)
);
CREATE TABLE webhook_key_history (
    id UUID PRIMARY KEY,
    source VARCHAR(16) NOT NULL,
    key_id VARCHAR(64) NOT NULL,
    fingerprint CHAR(64) NOT NULL,
    valid_until TIMESTAMPTZ,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE request_guard_history (
    id UUID PRIMARY KEY,
    enabled BOOLEAN NOT NULL,
    limits JSONB NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE inbound_verifications (
    inbound_id UUID NOT NULL REFERENCES inbound_events(id),
    key_history_id UUID NOT NULL REFERENCES webhook_key_history(id),
    signed_at TIMESTAMPTZ NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(inbound_id,key_history_id)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON request_rate_buckets,request_security_counts TO alpha_media_app;
GRANT SELECT,INSERT ON webhook_key_history,inbound_verifications TO alpha_media_app;
GRANT SELECT,INSERT ON request_guard_history TO alpha_media_app;
