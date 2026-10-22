-- Receipt is independent of business rows so an early callback can wait for its dependency.
CREATE TABLE inbound_events (
    id UUID PRIMARY KEY,
    source VARCHAR(16) NOT NULL CHECK (source IN ('PG','SUPPLIER','PROFILE')),
    event_id UUID NOT NULL,
    target_id UUID NOT NULL,
    order_id UUID,
    -- AES-GCM envelope: version (1), nonce (12), tag (16), and at most 16 KiB of plaintext.
    body BYTEA NOT NULL CHECK (octet_length(body) <= 16413),
    payload_hash VARCHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING','PROCESSING','RETRY','PROCESSED','REVIEW_REQUIRED')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    receive_count INTEGER NOT NULL DEFAULT 1 CHECK (receive_count > 0),
    next_attempt_at TIMESTAMPTZ DEFAULT clock_timestamp(),
    lease_token UUID,
    lease_until TIMESTAMPTZ,
    processed_at TIMESTAMPTZ,
    last_error VARCHAR(80),
    error_status INTEGER CHECK (error_status BETWEEN 400 AND 599),
    conflicting_payload_hash VARCHAR(64),
    UNIQUE(source,event_id),
    CHECK ((status='PROCESSING') = (lease_token IS NOT NULL)),
    CHECK ((status='PROCESSING') = (lease_until IS NOT NULL))
);
CREATE INDEX inbound_events_due_idx ON inbound_events(next_attempt_at,id)
    WHERE status IN ('PENDING','RETRY','PROCESSING');
CREATE INDEX inbound_events_order_idx ON inbound_events(order_id,received_at DESC,id);

-- Preserve the encrypted receipt and its identity; application updates only delivery/processing metadata.
GRANT SELECT,INSERT ON inbound_events TO alpha_media_app;
GRANT UPDATE(status,attempt_count,last_received_at,receive_count,next_attempt_at,
    lease_token,lease_until,processed_at,last_error,error_status,conflicting_payload_hash)
    ON inbound_events TO alpha_media_app;
