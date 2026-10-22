ALTER TABLE payment_attempts
    ADD COLUMN supplier_scenario VARCHAR(10) NOT NULL DEFAULT 'SUCCEED' CHECK (supplier_scenario IN ('SUCCEED','FAIL')),
    ADD COLUMN supplier_callback_copies INTEGER NOT NULL DEFAULT 1 CHECK (supplier_callback_copies BETWEEN 0 AND 20),
    ADD COLUMN supplier_callback_delay_ms INTEGER NOT NULL DEFAULT 2000 CHECK (supplier_callback_delay_ms BETWEEN 0 AND 60000);

CREATE TABLE issuance_jobs (
    id UUID PRIMARY KEY,
    order_id UUID NOT NULL UNIQUE REFERENCES orders(id),
    scenario VARCHAR(10) NOT NULL CHECK (scenario IN ('SUCCEED','FAIL')),
    callback_copies INTEGER NOT NULL CHECK (callback_copies BETWEEN 0 AND 20),
    callback_delay_ms INTEGER NOT NULL CHECK (callback_delay_ms BETWEEN 0 AND 60000),
    status VARCHAR(20) NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED','PROCESSING','WAITING_CALLBACK','ISSUED','FAILED','REVIEW_REQUIRED')),
    supplier_order_no VARCHAR(100) UNIQUE,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 2),
    check_count INTEGER NOT NULL DEFAULT 0 CHECK (check_count >= 0),
    last_error VARCHAR(120),
    next_check_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lease_token UUID,
    lease_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((status='PROCESSING') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX issuance_due_idx ON issuance_jobs(next_check_at)
    WHERE status IN ('QUEUED','PROCESSING','WAITING_CALLBACK');

CREATE TABLE sim_profiles (
    id UUID PRIMARY KEY,
    order_id UUID NOT NULL UNIQUE REFERENCES orders(id),
    issuance_id UUID NOT NULL UNIQUE REFERENCES issuance_jobs(id),
    supplier_order_no VARCHAR(100) NOT NULL UNIQUE,
    iccid VARCHAR(20) NOT NULL UNIQUE CHECK (iccid ~ '^[0-9]{19,20}$'),
    activation_code VARCHAR(200) NOT NULL,
    install_status VARCHAR(20) NOT NULL DEFAULT 'ISSUED' CHECK (install_status='ISSUED'),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE issuance_events (
    event_id UUID PRIMARY KEY,
    issuance_id UUID NOT NULL REFERENCES issuance_jobs(id),
    payload_hash VARCHAR(64) NOT NULL,
    source VARCHAR(12) NOT NULL CHECK (source IN ('ACCEPTANCE','LOOKUP','CALLBACK')),
    status VARCHAR(10) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX issuance_events_job_idx ON issuance_events(issuance_id,received_at);

-- 모의 공급사의 원장과 작업은 서비스의 발급 트랜잭션과 독립적으로 커밋한다.
CREATE TABLE mock_supplier_orders (
    request_id UUID PRIMARY KEY,
    order_id UUID NOT NULL UNIQUE,
    supplier_order_no VARCHAR(100) NOT NULL UNIQUE,
    accepted_event_id UUID NOT NULL UNIQUE,
    result_event_id UUID NOT NULL UNIQUE,
    scenario VARCHAR(10) NOT NULL CHECK (scenario IN ('SUCCEED','FAIL')),
    callback_copies INTEGER NOT NULL CHECK (callback_copies BETWEEN 0 AND 20),
    callback_delay_ms INTEGER NOT NULL CHECK (callback_delay_ms BETWEEN 0 AND 60000),
    status VARCHAR(10) NOT NULL DEFAULT 'ACCEPTED' CHECK (status IN ('ACCEPTED','ISSUED','FAILED')),
    iccid VARCHAR(20) UNIQUE,
    activation_code VARCHAR(200),
    request_count INTEGER NOT NULL DEFAULT 1,
    issue_executions INTEGER NOT NULL DEFAULT 0 CHECK (issue_executions BETWEEN 0 AND 1),
    ready_at TIMESTAMPTZ NOT NULL,
    callback_sent INTEGER NOT NULL DEFAULT 0,
    callback_failures INTEGER NOT NULL DEFAULT 0,
    callback_next_at TIMESTAMPTZ,
    callback_lease_token UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX mock_supplier_ready_idx ON mock_supplier_orders(ready_at) WHERE status='ACCEPTED';
CREATE INDEX mock_supplier_callback_idx ON mock_supplier_orders(callback_next_at) WHERE callback_next_at IS NOT NULL;

-- 이번 기능 이전에 승인된 주문도 한 번만 발급 작업으로 연결한다.
INSERT INTO issuance_jobs(id,order_id,scenario,callback_copies,callback_delay_ms)
    SELECT gen_random_uuid(), p.order_id, p.supplier_scenario, p.supplier_callback_copies, p.supplier_callback_delay_ms
    FROM payment_attempts p JOIN orders o ON o.id=p.order_id
    WHERE p.status='APPROVED' AND o.status='PAID';

GRANT SELECT, INSERT ON issuance_jobs, sim_profiles, issuance_events TO alpha_media_app;
GRANT UPDATE (status,supplier_order_no,revision,check_count,last_error,next_check_at,
    lease_token,lease_until,updated_at) ON issuance_jobs TO alpha_media_app;
GRANT SELECT, INSERT, UPDATE ON mock_supplier_orders TO alpha_media_app;
