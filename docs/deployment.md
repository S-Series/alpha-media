# Vercel 프론트엔드·Render 서버·Neon PostgreSQL

## 배포 구성

```text
브라우저 → Vercel Next.js /api rewrite → Render Gateway → Render Service → Neon PostgreSQL
                                 공개 HTTPS        공개 HTTPS      pooled JDBC
                                                    └────────────→ direct JDBC (Flyway)
```

Gateway와 Service는 Render Singapore의 무료 Web Service로 각각 배포한다. 무료 Web Service는 사설 요청을 받을 수 없으므로 두 서버 사이도 공개 HTTPS 주소를 사용한다. Service는 `X-Gateway-Token`을 검사하고, Gateway는 외부에서 들어온 해당 헤더를 제거한 뒤 서버의 공유 키로 교체한다. 사용자 세션·CSRF·관리자 권한 검사는 별도로 유지한다.

프론트엔드는 Vercel Hobby의 `alpha-media` 프로젝트에서 배포한다. 공개 주소는 `https://alpha-media-mauve.vercel.app`이다. Vercel과 Render는 GitHub `S-Series/alpha-media`의 `main`에 연결해 커밋을 자동 배포한다.

실제 생성한 무료 서비스 주소는 Gateway `https://alpha-media-gateway.onrender.com`, Service `https://alpha-media-service.onrender.com`이다. Neon 접속 정보와 동일한 내부 키를 Render 비밀 환경변수로 등록하고 다시 읽어 값이 일치하는지 확인했다. 실제 값은 이 문서나 Git에 넣지 않는다.

## 1 Neon 연결

이 프로젝트에 적용한 CLI 명령이다. 로그인 화면이 열리면 브라우저에서 인증한다.

```powershell
npm i -g neon@latest
neon init -y --org-id org-wandering-dew-78292972 --project-id royal-morning-81650365 --branch production --services postgres
neon deploy
```

초기 실행에서 GitHub Copilot CLI의 플러그인 설치가 실패했다. Codex용 플러그인은 설치됐으며 아래 명령으로 추가 에이전트 설치를 건너뛰고 초기화를 완료했다.

```powershell
neon init -y --org-id org-wandering-dew-78292972 --project-id royal-morning-81650365 --branch production --services postgres --no-agent-setup
```

`neon deploy`는 PostgreSQL 설정을 확인하고 `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NEON_BRANCH`를 루트 `.env.local`에 내려받는다. `.env`가 이미 있으면 그 파일을 사용한다. `.neon`은 로컬 프로젝트 연결 정보이며 Git에서 제외한다. `neon.ts`는 PostgreSQL만 사용하는 정책이며 Neon Auth·Functions·Storage는 배포하지 않는다.

## 2 Spring Boot 환경변수 구성

프로젝트 루트에서 실행한다. Node.js 20.12 이상과 `psql`이 필요하다. 현재 PC에서는 Node.js 24와 PostgreSQL 18의 도구를 사용했다.

```powershell
npm run neon:configure
```

`backend/database/configure-neon.mjs`가 CLI에서 받은 URL을 읽어 다음 작업을 수행한다.

1. DB 소유자 연결로 제한된 실행 역할 `alpha_media_app`을 SQL로 생성한다. 이미 연결된 역할의 비밀번호를 변경하지 않는다. 처음 생성할 때 무작위 비밀번호를 발급한다.
2. pooled URL을 일반 조회·저장용 JDBC URL로, direct URL을 Flyway용 JDBC URL로 변환한다. 기존 PostgreSQL JDBC·JdbcTemplate을 유지하며 프론트엔드에서 DB에 직접 연결하지 않는다.
3. `backend/service/.env`에 접속 정보를 저장한다. 기존 로컬 DB 설정은 최초 전환 시 `.local/service-before-neon.env`에 백업한다. 비밀번호를 로그로 출력하지 않는다.

TLS는 `sslmode=verify-full`, `DefaultJavaSSLFactory`, `channelBinding=require`로 설정한다. 별도의 `root.crt` 파일 대신 Java 신뢰 저장소를 사용해 인증서와 호스트를 검증한다.

| Service 환경변수 | 값의 출처 |
|---|---|
| `DB_URL` | pooled `DATABASE_URL`에서 변환한 JDBC URL, 자격 증명 제외 |
| `DB_USERNAME`, `DB_PASSWORD` | SQL로 만든 `alpha_media_app`의 접속 정보 |
| `DB_MIGRATION_URL` | `DATABASE_URL_UNPOOLED`에서 변환한 direct JDBC URL |
| `DB_MIGRATION_USERNAME`, `DB_MIGRATION_PASSWORD` | 내려받은 direct URL의 DB 소유자 접속 정보 |

Neon 콘솔에서 만든 역할에는 `neon_superuser` 권한이 붙을 수 있으므로 앱 실행 역할은 SQL로 만든다. Flyway가 테이블을 만든 뒤 조회·입력·세션 관리에 필요한 권한만 부여한다. 기존 계정이 있는데 해당 프로젝트의 비밀번호를 알 수 없으면 설정 도구는 재설정하지 않고 중단한다.

## 3 로컬 실행과 빌드

최초 설치 시 루트에서 `npm ci`, 프론트엔드 폴더에서 `npm ci`를 각각 실행한다. 루트 Node 의존성은 Neon 설정 도구용이고 화면은 기존 `frontend` 프로젝트에 둔다.

```powershell
cd D:\Projects\alpha-media
npm run build
```

이 명령은 프론트엔드 빌드를 수행한다. 두 Spring 서버는 각 폴더에서 Maven Wrapper로 별도 빌드·실행한다.

```powershell
cd D:\Projects\alpha-media\backend\service
.\mvnw.cmd package
.\mvnw.cmd spring-boot:run
```

```powershell
cd D:\Projects\alpha-media\backend\gateway
.\mvnw.cmd package
.\mvnw.cmd spring-boot:run
```

```powershell
cd D:\Projects\alpha-media
npm start
```

로컬 주소는 Frontend 3000, Gateway 8080, Service 8081이다. 일반 로컬 실행은 내부 키 없이 사용할 수 있다. `render` 프로필에서는 32자 이상의 `INTERNAL_GATEWAY_TOKEN`이 없으면 서버 시작을 거부한다.

## 4 Render CI/CD 설정

루트 `render.yaml`을 Blueprint로 사용한다. 두 서비스 모두 `plan: free`이며 유료 DB·디스크·워커를 생성하지 않는다.

| 서비스 | Dockerfile | 빌드 컨텍스트 | 상태 확인 |
|---|---|---|---|
| `alpha-media-service` | `backend/service/Dockerfile` | `backend` | GET `/health` |
| `alpha-media-gateway` | `backend/gateway/Dockerfile` | `backend` | GET `/health` |

빌드 컨텍스트를 `backend`로 지정해야 Service 빌드에서 `database/migration` SQL도 포함된다. Root Directory를 `backend/service`로 좁히면 SQL 경로가 사라지므로 변경하지 않는다. Docker 빌드는 Java 21에서 Maven으로 JAR을 만들고, JRE 이미지에서 일반 사용자 UID 10001로 실행한다. `.dockerignore`는 `.env`·빌드 산출물·로컬 비밀 파일을 제외한다.

Blueprint 생성 시 `sync: false` 항목은 Service의 `.env`에 생성된 접속 정보를 Render의 비밀 환경변수로 입력한다. GitHub 저장소, 워크플로 로그, Docker build args에 비밀번호를 넣지 않는다. 기존 Blueprint의 비밀 값을 변경할 때는 Render 환경변수도 직접 갱신해야 한다.

Blueprint를 사용하는 경우 공유 환경 그룹 `alpha-media-internal`이 무작위 `INTERNAL_GATEWAY_TOKEN`을 생성해 두 서버에 제공한다. Gateway의 `SERVICE_BASE_URL`은 Service의 `RENDER_EXTERNAL_URL`을 참조한다. 현재 API로 직접 생성한 두 서버에는 같은 무작위 키를 각각 등록했고, Gateway에는 Service의 실제 HTTPS 주소를 넣었다.

| 공통 설정 | Blueprint 값 |
|---|---|
| `SPRING_PROFILES_ACTIVE` | `render` |
| `JAVA_TOOL_OPTIONS` | 힙에 컨테이너 메모리의 50%, CPU 수 1, 스택 512KB |
| 포트 | Render의 `PORT`를 Spring이 읽음 |

Service의 `SESSION_COOKIE_SECURE=true`는 HTTPS 배포용이다. Vercel의 HTTPS 주소에서 로그인하면 같은 출처의 `/api/**` 프록시를 통해 Secure 세션 쿠키를 사용한다. 로컬 프론트엔드에서 원격 Gateway를 사용할 때도 HTTPS 개발 서버를 사용하면 브라우저별 localhost 예외에 의존하지 않는다.

```dotenv
# frontend/.env.local, 값은 실제 배포된 Gateway 주소로 바꾼다.
GATEWAY_BASE_URL=https://실제-gateway-주소.onrender.com
GATEWAY_REQUEST_TIMEOUT_MS=150000
```

프론트엔드는 이 값을 바꾼 뒤 다시 빌드한다. Next.js rewrite가 같은 출처의 `/api/**`를 Gateway로 전달한다. `GATEWAY_REQUEST_TIMEOUT_MS`는 서버 조회와 rewrite 프록시의 대기 시간에 사용한다. 이 값은 사용하는 프론트엔드 호스팅의 최대 요청 시간도 넘지 않아야 한다.

`FRONTEND_ORIGINS`에는 localhost와 127.0.0.1의 HTTP·HTTPS 개발 출처와 Vercel의 정확한 운영 주소를 등록했다. 같은 출처의 Next.js rewrite를 사용해도 POST 요청의 `Origin` 헤더는 Gateway에 전달될 수 있으므로 Gateway의 CORS 필터에서 운영 출처를 허용해야 한다. 모든 `vercel.app` 하위 도메인을 포괄적으로 허용하지 않는다.

커밋 전에 프론트엔드의 `npm run build`와 두 Maven `package`를 검증했다. 별도 GitHub Actions 워크플로는 아직 없다. CD는 Render Git 연동으로 실행하며, 승인된 배포 파일은 `main`에 반영했다.

## 5 Vercel 프론트엔드

Vercel 프로젝트 설정은 Root Directory `frontend`, Framework `Next.js`, Node.js `24.x`, Install Command `npm ci`, Build Command `npm run build`다. 저장소 전체가 아닌 프론트엔드 폴더를 앱 루트로 빌드한다. `frontend/vercel.json`에서 Next.js·싱가포르 `sin1`·Fluid Compute를 지정해 Render와 가까운 리전에서 서버 렌더링을 수행한다.

운영 환경변수는 다음 두 개만 등록했다. DB 접속 정보와 `INTERNAL_GATEWAY_TOKEN`은 프론트엔드에 전달하지 않는다. `NEXT_PUBLIC_` 접두사도 사용하지 않는다.

```dotenv
GATEWAY_BASE_URL=https://alpha-media-gateway.onrender.com
GATEWAY_REQUEST_TIMEOUT_MS=110000
```

외부 rewrite에 적용되는 Vercel 제한은 최대 120초이므로 앱의 대기 시간은 110초로 설정했다. Next.js의 `proxyTimeout` 설정이 호스팅 플랫폼의 제한을 늘려 주지는 않는다. 서버 렌더링에서도 같은 Gateway 주소를 사용한다. 인증은 Vercel 도메인의 HttpOnly·Secure·SameSite=Lax 쿠키로 유지한다.

Vercel은 `main`을 운영 브랜치로 사용한다. 위 환경변수는 운영 환경에만 등록했으며, 별도 Preview DB·Gateway는 아직 구성하지 않았다. 첫 배포는 Git 연동으로 실행됐고, 로컬 PC의 프론트엔드 서버 없이 공개 주소로 접속한다.

## 6 무료 플랜의 동작 범위

Render 무료 웹 서비스는 15분 동안 요청이 없으면 중지되고 재시작에 약 1분이 걸린다. 월 750 실행 시간을 같은 워크스페이스의 무료 서비스가 공유한다. 두 서버를 30일 내내 실행하면 1,440시간이 필요하므로 항상 실행할 수 있는 구성은 아니다. 시작 중 첫 요청이 실패하면 준비된 뒤 다시 요청한다. 변경 요청을 Gateway가 자동 재시도하지 않는다.

현재 Gateway의 Service 연결 대기는 10초, 응답 대기는 90초로 설정했다. 이 시간은 외부 프록시의 제한이나 전체 서버 시작 시간까지 보장하는 값은 아니다.

Neon 무료 컴퓨트도 5분 비활성 후 절전한다. Hikari는 사용하지 않는 연결을 60초 후 반납하고 최소 유휴 연결과 keepalive를 0으로 둔다. 배포된 세션 정리는 매시간 실행하며 만료 여부는 요청 시에도 검사한다. Spring 세션의 비활성 만료 기준은 그대로 30분이다. 서버가 절전하면 예약 정리도 실행되지 않는다.

따라서 현재 구성은 개발 확인용이다. 향후 결제·발급·환불 워커를 붙일 때는 상시 실행 환경과 비용을 다시 정한다. 무료 한도를 넘기지 않도록 각 서비스의 사용량을 확인한다.

## 7 2026-10-22 검증 결과

Neon `production` 브랜치에서 Flyway V1·V2가 적용되고 요금제 3건이 저장됐다. 프론트엔드·Gateway·Service는 로컬에서 실행하고 DB만 실제 Neon을 사용해 검증했다.

```text
neon deploy
No changes — branch production already matches the policy.
Pulled 3 Neon variables into .env.local

npm run build
✓ Compiled successfully
✓ Generating static pages using 15 workers (38/38)

PASS 13 end-to-end checks: Frontend -> Gateway -> Service -> Neon PostgreSQL
PASS Neon-backed member and authenticated session survive Service restart
PASS logout invalidates Neon session
PASS runtime price and role changes denied
```

추가로 Render에 Gateway·Service를 실제 배포하고 로컬 프론트엔드를 원격 Gateway에 연결해 22개 검증을 통과했다.

```text
Render Gateway Docker build: BUILD SUCCESS, live
Render Service Docker build: BUILD SUCCESS, live
PASS Gateway reads 3 Neon plans HTTP 200
PASS direct Service blocked HTTP 403
PASS signup persisted to Neon HTTP 201
PASS duplicate signup HTTP 409
PASS login HTTP 200, session ID rotation
PASS Secure HttpOnly SameSite=Lax cookie
PASS authenticated me HTTP 200, USER admin access HTTP 403
PASS logout HTTP 204, logged-out me HTTP 401
PASS Frontend -> Render -> Neon HTTP 200
PASS gzip response headers match compressed body
PASS 22 remote checks total
```

Vercel 공개 주소에서는 브라우저의 운영 `Origin`을 포함해 19개 HTTP 검증을 통과했다. 요금제·필터·상세·회원가입·중복 가입·로그인·세션 회전·쿠키 속성·권한 검사·로그아웃·허용하지 않은 출처 차단을 확인했다.

```text
Vercel Git deployment: Build Completed in .vercel/build-output [24s]
PASS Vercel -> Render -> Neon returns 3 plans
PASS signup from production Origin HTTP 201
PASS login through Vercel HTTP 200
PASS Vercel host Secure HttpOnly SameSite=Lax cookie
PASS production Origin CORS preflight HTTP 200
PASS unapproved Origin HTTP 403
PASS 19 Vercel end-to-end checks
```

초기 브라우저 확인에서 로그인 후 이전 비로그인 경로가 재사용되는 현상이 있었다. 외부 API 프록시가 세션을 변경한 뒤에는 로그인·로그아웃 모두 전체 페이지 이동으로 클라이언트 경로 캐시를 버리고 서버가 새 쿠키를 읽게 했다.

첫 원격 Gateway 요청은 압축 응답 처리 중 `HttpException`으로 502가 발생했다. HTTP 클라이언트의 자동 압축 해제를 끄고 압축 본문과 `Content-Encoding`을 함께 전달한 뒤 정상화됐다. HTTPS 인증서 검증과 공유 키 검사는 유지했다.

두 상태 확인 API, Render 공식 CLI의 Blueprint 검증, SQL의 JAR 포함도 확인했다. 검증용 회원·인증 세션은 삭제했고, SQL에서 해당 회원이 0건인지 확인했다.

`npm --prefix frontend run lint`도 통과했다. 루트 Neon 패키지를 추가한 뒤 발생한 중첩 `.next` 캐시가 lint에 포함되는 문제는 생성물 제외 경로를 `**/.next/**`로 조정해 해결했다.

첫 `neon init`은 Copilot 플러그인 설치 오류가 있었고, 첫 JDBC 접속은 기본 LibPQFactory가 `root.crt`를 찾지 못해 실패했다. 추가 에이전트 설치를 건너뛰고 Java 기본 SSL Factory를 명시한 뒤 두 문제 모두 해결했다. Docker 실행 도구가 이 PC에 없어 로컬 컨테이너 실행은 생략했다. Render에서 두 Dockerfile의 실제 이미지 빌드 성공과 `/health` 200 응답을 확인했다.

## 공식 문서

- [Render 무료 플랜 제한](https://render.com/docs/free)
- [Render Blueprint](https://render.com/docs/blueprint-spec)
- [Render Docker 배포](https://render.com/docs/docker)
- [Neon Java 연결](https://neon.com/docs/guides/java)
- [Neon 역할과 권한](https://neon.com/docs/manage/roles)
- [pgJDBC SSL 설정](https://jdbc.postgresql.org/documentation/ssl/)

- [Vercel 모노레포 설정](https://vercel.com/docs/monorepos)
- [Vercel 외부 프록시 제한](https://vercel.com/docs/limits)
