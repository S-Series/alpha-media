-- 기존 회원 정보가 있다면 자동 삭제하거나 잘라 변환하지 않고 적용을 중단한다.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM members) THEN
        RAISE EXCEPTION 'Fixed-account migration requires an empty members table; review existing data first';
    END IF;
END $$;

ALTER TABLE members RENAME COLUMN email TO username;
ALTER TABLE members ALTER COLUMN username TYPE VARCHAR(32);
ALTER TABLE members RENAME CONSTRAINT members_email_key TO members_username_key;
ALTER TABLE members ADD CONSTRAINT members_username_format
    CHECK (username ~ '^[a-z0-9][a-z0-9_-]{2,31}$');

INSERT INTO members (id, username, display_name, password_hash, role) VALUES
    ('10000000-0000-4000-8000-000000000001', 'customer1', '고객 1', '${customer1PasswordHash}', 'USER'),
    ('10000000-0000-4000-8000-000000000002', 'customer2', '고객 2', '${customer2PasswordHash}', 'USER'),
    ('10000000-0000-4000-8000-000000000003', 'admin', '운영자', '${adminPasswordHash}', 'ADMIN');

-- 회원은 배포 시에만 구성한다. 실행 API로 회원을 추가하거나 비밀번호·권한을 바꿀 수 없다.
REVOKE INSERT (id, username, display_name, password_hash) ON members FROM alpha_media_app;
