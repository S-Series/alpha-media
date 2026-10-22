ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN
    ('PENDING_PAYMENT','PAYMENT_PROCESSING','PAID','EXPIRED','REFUND_PROCESSING','REFUNDED'));

ALTER TABLE issuance_jobs DROP CONSTRAINT issuance_jobs_order_id_key;
ALTER TABLE issuance_jobs ADD COLUMN is_current BOOLEAN NOT NULL DEFAULT TRUE;
CREATE UNIQUE INDEX issuance_current_order_idx ON issuance_jobs(order_id) WHERE is_current;
ALTER TABLE mock_supplier_orders DROP CONSTRAINT mock_supplier_orders_order_id_key;
CREATE INDEX mock_supplier_order_idx ON mock_supplier_orders(order_id);
GRANT UPDATE (is_current) ON issuance_jobs TO alpha_media_app;

CREATE TABLE refunds (
    id UUID PRIMARY KEY,
    order_id UUID NOT NULL UNIQUE REFERENCES orders(id),
    payment_id UUID NOT NULL UNIQUE REFERENCES payment_attempts(id),
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency VARCHAR(3) NOT NULL CHECK (currency='KRW'),
    scenario VARCHAR(20) NOT NULL CHECK (scenario IN ('SUCCESS','RESPONSE_LOST','UNAVAILABLE')),
    status VARCHAR(20) NOT NULL DEFAULT 'REQUESTED'
        CHECK (status IN ('REQUESTED','PROCESSING','UNKNOWN','SUCCEEDED','REVIEW_REQUIRED')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    pg_cancellation_id UUID UNIQUE,
    last_error VARCHAR(120),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lease_token UUID,
    lease_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((status='PROCESSING') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX refunds_due_idx ON refunds(next_attempt_at) WHERE status IN ('REQUESTED','PROCESSING','UNKNOWN');

CREATE TABLE admin_actions (
    id UUID PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES orders(id),
    actor_id UUID NOT NULL REFERENCES members(id),
    idempotency_key UUID NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('ISSUANCE_RETRY','REFUND')),
    reason VARCHAR(300) NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 300),
    issuance_id UUID REFERENCES issuance_jobs(id),
    refund_id UUID REFERENCES refunds(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(order_id,idempotency_key),
    CHECK ((type='ISSUANCE_RETRY' AND issuance_id IS NOT NULL AND refund_id IS NULL)
        OR (type='REFUND' AND refund_id IS NOT NULL AND issuance_id IS NULL))
);
CREATE INDEX admin_actions_order_idx ON admin_actions(order_id,created_at DESC,id DESC);
CREATE TABLE admin_action_events (
    id UUID PRIMARY KEY,
    action_id UUID NOT NULL REFERENCES admin_actions(id),
    status VARCHAR(30) NOT NULL,
    detail VARCHAR(120),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX admin_action_events_action_idx ON admin_action_events(action_id,created_at,id);
ALTER TABLE mock_pg_cancellations ADD COLUMN scenario VARCHAR(20) NOT NULL DEFAULT 'SUCCESS';
GRANT SELECT, INSERT ON refunds, admin_actions, admin_action_events TO alpha_media_app;
GRANT UPDATE (status,attempt_count,pg_cancellation_id,last_error,next_attempt_at,lease_token,lease_until,updated_at)
    ON refunds TO alpha_media_app;
