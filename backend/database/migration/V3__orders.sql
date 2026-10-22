CREATE TABLE orders (
    id UUID PRIMARY KEY,
    member_id UUID NOT NULL REFERENCES members(id),
    idempotency_key UUID NOT NULL,
    plan_id VARCHAR(64) NOT NULL REFERENCES plans(id),
    plan_name VARCHAR(120) NOT NULL,
    country VARCHAR(100) NOT NULL,
    days INTEGER NOT NULL CHECK (days > 0),
    data_mb INTEGER NOT NULL CHECK (data_mb > 0),
    sim_type VARCHAR(4) NOT NULL CHECK (sim_type = 'ESIM'),
    travel_start_date DATE NOT NULL,
    amount BIGINT NOT NULL CHECK (amount >= 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'KRW' CHECK (currency = 'KRW'),
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING_PAYMENT'
        CHECK (status IN ('PENDING_PAYMENT', 'EXPIRED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '10 minutes'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (member_id, idempotency_key),
    CHECK (expires_at = created_at + INTERVAL '10 minutes')
);

CREATE INDEX orders_member_created_idx ON orders (member_id, created_at DESC, id DESC);
CREATE INDEX orders_plan_idx ON orders (plan_id);
CREATE INDEX orders_pending_expiry_idx ON orders (expires_at) WHERE status = 'PENDING_PAYMENT';

GRANT SELECT, INSERT ON orders TO alpha_media_app;
-- 생성 시 고정한 소유자·가격·상품 조건을 실행 계정이 덮어쓰지 못하게 한다.
GRANT UPDATE (status, updated_at) ON orders TO alpha_media_app;
