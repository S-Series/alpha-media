CREATE TABLE scenario_generations (
    id UUID PRIMARY KEY,
    actor_id UUID NOT NULL REFERENCES members(id),
    customer_id UUID NOT NULL REFERENCES members(id),
    plan_id VARCHAR(64) NOT NULL REFERENCES plans(id),
    scenario VARCHAR(32) NOT NULL CHECK (scenario IN
        ('PENDING_PAYMENT','ISSUANCE_FAILED','ISSUED','REFUNDED','REFUND_REVIEW_REQUIRED')),
    order_id UUID UNIQUE REFERENCES orders(id),
    status VARCHAR(16) NOT NULL DEFAULT 'GENERATING' CHECK (status IN ('GENERATING','READY','FAILED')),
    last_error VARCHAR(80),
    next_check_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX scenario_generations_due_idx ON scenario_generations(next_check_at,id) WHERE status='GENERATING';
GRANT SELECT, INSERT ON scenario_generations TO alpha_media_app;
GRANT UPDATE (order_id,status,last_error,next_check_at,updated_at) ON scenario_generations TO alpha_media_app;
