-- Neon의 전용 앱 DB에서 DB 소유자로 한 번 실행한다.
-- 콘솔에서 만든 역할에는 넓은 권한이 붙으므로 실행 계정은 SQL로 만든다.
CREATE ROLE alpha_media_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO alpha_media_app;

-- 비밀번호는 파일에 넣지 않는다. psql의 \password alpha_media_app으로 설정한다.
-- 테이블과 세부 권한은 Service 시작 시 Flyway가 만든다.
