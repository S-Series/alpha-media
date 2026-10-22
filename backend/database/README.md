# 로컬 PostgreSQL

현재 PC에 설치된 PostgreSQL 18.6을 사용한다. 프로젝트의 `.local/postgres`에 별도 클러스터를 생성했으며 `127.0.0.1:5432/alpha_media`로 접속한다. 데이터와 비밀번호는 Git에 포함하지 않는다.

## 실행 순서

DB가 꺼져 있을 때 프로젝트 루트에서 실행한다. 이미 실행 중이면 다시 시작하지 않는다.

```powershell
pg_ctl -D D:\Projects\alpha-media\.local\postgres status
pg_ctl -D D:\Projects\alpha-media\.local\postgres -l D:\Projects\alpha-media\.local\postgres.log -w start
```

서로 다른 터미널에서 Service, Gateway, Frontend를 실행한다.

```powershell
cd D:\Projects\alpha-media\backend\service
.\mvnw.cmd spring-boot:run
```

```powershell
cd D:\Projects\alpha-media\backend\gateway
.\mvnw.cmd spring-boot:run
```

```powershell
cd D:\Projects\alpha-media\frontend
npm run dev
```

현재 포트는 Frontend 3000, Gateway 8080, Service 8081이다. 처음 실행하는 다른 PC에서는 Node.js, Java 21, PostgreSQL과 `npm ci`가 필요하다. Maven은 각 폴더의 Wrapper가 준비한다.

종료는 앱 터미널의 Ctrl+C 후 DB를 중지한다.

```powershell
pg_ctl -D D:\Projects\alpha-media\.local\postgres -m fast -w stop
```

## 접속 정보

`backend/service/.env`는 이 PC의 실제 접속 정보다. `.env.example`에는 항목 설명과 교체할 자리만 제공한다. Service는 해당 폴더를 작업 디렉터리로 실행해야 `.env`를 읽는다. 접속 비밀번호나 `.local`을 커밋하지 않는다.

| 계정 | 용도 | 권한 |
|---|---|---|
| `postgres` | 클러스터 초기 관리 | 로컬 관리자 |
| `alpha_media_owner` | Flyway 마이그레이션 | alpha_media DB 소유자, 슈퍼유저 아님 |
| `alpha_media_app` | 업무 API | 상품·회원 조회, 회원 일반 컬럼 입력, 세션 관리 |

로컬 관리자 비밀번호는 `.local/postgres-admin.password`에 보관하며 현재 Windows 사용자만 파일을 읽도록 제한했다. 접속이 필요하면 비밀번호를 터미널 입력 프롬프트에 입력한다.

```powershell
psql -h 127.0.0.1 -U alpha_media_app -d alpha_media -W
```

## 새 DB 준비

다른 PC나 배포 환경의 빈 PostgreSQL에서는 관리자로 다음 SQL을 실행하고 `\password` 프롬프트에서 서로 다른 비밀번호를 설정한다. 현재 PC에는 이미 적용되어 있으므로 반복 실행하지 않는다.

```sql
CREATE ROLE alpha_media_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE alpha_media_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
\password alpha_media_owner
\password alpha_media_app
CREATE DATABASE alpha_media OWNER alpha_media_owner;
REVOKE ALL ON DATABASE alpha_media FROM PUBLIC;
GRANT CONNECT ON DATABASE alpha_media TO alpha_media_owner, alpha_media_app;
\connect alpha_media
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO alpha_media_app;
```

관리형 PostgreSQL에서는 계정·DB 생성 권한에 맞춰 별도 준비가 필요하다. 마이그레이션 SQL은 실행 계정 이름 `alpha_media_app`을 사용하므로 해당 역할이 먼저 있어야 한다. `.env.example`을 `.env`로 복사해 실제 주소와 두 계정의 비밀번호를 설정한 뒤 Service를 시작한다.

## 마이그레이션

`migration/V1__members_and_plans.sql`은 회원·요금제와 초기 상품을 생성한다. `V2__http_sessions.sql`은 로그인 세션을 저장한다. SQL은 Service 빌드 때 JAR의 `db/migration`에 포함되고 Flyway가 시작 시 적용한다.

이미 적용한 SQL을 고치지 않고 다음 `V3__설명.sql`을 추가한다. 적용 여부는 `flyway_schema_history`에 기록된다. 마이그레이션 계정은 스키마 변경용이며 애플리케이션 쿼리는 제한된 실행 계정의 별도 커넥션 풀을 사용한다.

## 요청 흐름과 현재 범위

```text
Browser → Next.js /api rewrite → Gateway → Service → PostgreSQL
                                             ├─ PlanRepository: 상품
                                             ├─ MemberRepository: 회원
                                             └─ Spring Session: 로그인·CSRF 세션
```

회원가입·로그인·로그아웃·본인 정보와 상품 조회까지 동작한다. 주문·결제·발급·환불은 아직 화면 예시 단계다. 이메일 소유 확인·비밀번호 재설정·로그인 시도 제한도 아직 구현하지 않았다.

배포 시 HTTPS를 사용하고 `SESSION_COOKIE_SECURE=true`를 설정한다. DB 주소와 비밀번호는 배포 환경변수로 넣으며 Service와 DB의 외부 공개 여부는 배포 단계에서 제한한다.
