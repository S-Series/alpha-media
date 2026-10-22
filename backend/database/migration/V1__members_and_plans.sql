CREATE TABLE members (
    id UUID PRIMARY KEY,
    email VARCHAR(254) NOT NULL UNIQUE,
    display_name VARCHAR(60) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(16) NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (email = lower(btrim(email))),
    CHECK (char_length(display_name) BETWEEN 2 AND 60)
);

CREATE TABLE plans (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    country VARCHAR(100) NOT NULL,
    days INTEGER NOT NULL CHECK (days > 0),
    data_mb INTEGER NOT NULL CHECK (data_mb > 0),
    sim_type VARCHAR(4) NOT NULL CHECK (sim_type IN ('ESIM', 'USIM')),
    price BIGINT NOT NULL CHECK (price >= 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'KRW' CHECK (currency = 'KRW')
);

INSERT INTO plans (id, name, country, days, data_mb, sim_type, price) VALUES
    ('jp-esim-7d', '일본 eSIM 7일', '일본', 7, 5000, 'ESIM', 15900),
    ('jp-usim-7d', '일본 USIM 7일', '일본', 7, 5000, 'USIM', 19900),
    ('th-esim-5d', '태국 eSIM 5일', '태국', 5, 3000, 'ESIM', 9900);

-- 실행용 계정은 가격 변경이나 관리자 권한 부여를 할 수 없다.
GRANT SELECT ON plans, members TO alpha_media_app;
GRANT INSERT (id, email, display_name, password_hash) ON members TO alpha_media_app;
