ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
    CHECK (status IN ('PENDING_PAYMENT', 'PAYMENT_PROCESSING', 'PAID', 'EXPIRED'));

CREATE TABLE payment_attempts (
    id UUID PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES orders(id),
    idempotency_key UUID NOT NULL,
    amount BIGINT NOT NULL CHECK (amount >= 0),
    currency VARCHAR(3) NOT NULL CHECK (currency = 'KRW'),
    scenario VARCHAR(20) NOT NULL CHECK (scenario IN ('APPROVE', 'DECLINE', 'RESPONSE_LOST')),
    webhook_copies INTEGER NOT NULL CHECK (webhook_copies BETWEEN 0 AND 20),
    webhook_delay_ms INTEGER NOT NULL CHECK (webhook_delay_ms BETWEEN 0 AND 60000),
    status VARCHAR(20) NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED', 'PROCESSING', 'UNKNOWN', 'APPROVED', 'DECLINED', 'REVIEW_REQUIRED')),
    pg_transaction_id VARCHAR(120) UNIQUE,
    decline_code VARCHAR(64),
    last_error VARCHAR(64),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lease_until TIMESTAMPTZ,
    lease_token UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (order_id, idempotency_key),
    CHECK ((status = 'PROCESSING') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
-- 거절된 결제만 새 시도를 허용한다. 결과 불명·승인·검토 중에는 새 과금을 막는다.
CREATE UNIQUE INDEX payment_one_active_order_idx ON payment_attempts(order_id)
    WHERE status <> 'DECLINED';
CREATE INDEX payment_due_idx ON payment_attempts(next_attempt_at)
    WHERE status IN ('QUEUED', 'UNKNOWN', 'PROCESSING');
CREATE INDEX payment_order_created_idx ON payment_attempts(order_id, created_at DESC, id DESC);

CREATE TABLE payment_events (
    event_id UUID PRIMARY KEY,
    payment_id UUID NOT NULL REFERENCES payment_attempts(id),
    payload_hash VARCHAR(64) NOT NULL,
    source VARCHAR(10) NOT NULL CHECK (source IN ('RESPONSE', 'WEBHOOK')),
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX payment_events_payment_idx ON payment_events(payment_id);

-- 외부 PG를 흉내 내는 독립 원장. 업무 트랜잭션과 별도로 커밋한다.
CREATE TABLE mock_pg_payments (
    payment_id UUID PRIMARY KEY,
    order_id UUID NOT NULL,
    amount BIGINT NOT NULL CHECK (amount >= 0),
    currency VARCHAR(3) NOT NULL CHECK (currency = 'KRW'),
    scenario VARCHAR(20) NOT NULL,
    event_id UUID NOT NULL UNIQUE,
    status VARCHAR(10) NOT NULL CHECK (status IN ('APPROVED', 'DECLINED')),
    transaction_id VARCHAR(120) UNIQUE,
    decline_code VARCHAR(64),
    approval_requests INTEGER NOT NULL DEFAULT 1,
    approval_executions INTEGER NOT NULL CHECK (approval_executions IN (0, 1)),
    cancelled_amount BIGINT NOT NULL DEFAULT 0 CHECK (cancelled_amount BETWEEN 0 AND amount),
    webhook_copies INTEGER NOT NULL,
    webhook_delay_ms INTEGER NOT NULL,
    webhook_sent INTEGER NOT NULL DEFAULT 0,
    webhook_failures INTEGER NOT NULL DEFAULT 0,
    webhook_next_at TIMESTAMPTZ,
    webhook_lease_token UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX mock_pg_webhook_due_idx ON mock_pg_payments(webhook_next_at) WHERE webhook_next_at IS NOT NULL;

CREATE TABLE mock_pg_cancellations (
    id UUID PRIMARY KEY,
    payment_id UUID NOT NULL REFERENCES mock_pg_payments(payment_id),
    idempotency_key UUID NOT NULL,
    amount BIGINT NOT NULL CHECK (amount > 0),
    cancelled_total BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (payment_id, idempotency_key)
);

GRANT SELECT, INSERT ON payment_attempts, payment_events TO alpha_media_app;
GRANT UPDATE (status, pg_transaction_id, decline_code, last_error, attempt_count,
    next_attempt_at, lease_until, lease_token, updated_at) ON payment_attempts TO alpha_media_app;
GRANT SELECT, INSERT, UPDATE ON mock_pg_payments TO alpha_media_app;
GRANT SELECT, INSERT ON mock_pg_cancellations TO alpha_media_app;
