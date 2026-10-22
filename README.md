# Alpha Media

여행용 eSIM·USIM 서비스. 프론트엔드는 Next.js, Gateway와 업무 Service는 Spring Boot, DB는 PostgreSQL을 사용한다.

현재 상품 조회·회원 인증·eSIM 주문 생성·본인 주문 목록과 상세 조회까지 구현했다. 결제·발급·환불은 아직 실행되지 않으며, SIM·운영자 화면은 예시 데이터다. USIM은 수령·ICCID 등록 흐름을 연결한 뒤 구현한다.

## 주문 생성 흐름

```text
브라우저의 주문 생성 버튼
  → Next.js /api/orders rewrite
  → Gateway /api/orders (내부 키·추적 ID 추가, 자동 재전송 안 함)
  → Service 인증·CSRF → OrderController → OrderService
  → OrderRepository → PostgreSQL orders
  ← 주문번호·고정 금액·상태·10분 유효 기한
  → /mypage/orders/{orderId}에서 본인 주문 재조회
```

POST 본문은 `{planId, travelStartDate}`다. 브라우저는 UUID인 `Idempotency-Key`를 함께 보낸다. 최초 요청은 201, 같은 회원·키·내용의 재요청은 200, 다른 내용으로 키를 재사용하면 409다. 가격과 상품 조건은 DB에서 읽어 저장하며 클라이언트의 금액·회원 ID는 신뢰하지 않는다.

상태는 `PENDING_PAYMENT → EXPIRED`다. 유효 기한은 생성 후 정확히 10분이며 DB 시각으로 판단한다. 결제·발급 상태 전이는 다음 구현 범위다.

## 실행 환경

Node.js 24, Java 21, PostgreSQL 18의 `initdb`, `pg_ctl`, `psql` 도구가 PATH에 필요하다. 각 Spring 폴더의 Maven Wrapper를 사용한다. 비밀 값은 `.env` 또는 배포 환경변수에만 보관한다.

```powershell
npm ci
npm --prefix frontend ci
npm run build
npm --prefix frontend run lint
```

```powershell
cd backend/service
.\mvnw.cmd package
cd ../gateway
.\mvnw.cmd package
```

일반 실행에서는 `backend/service/.env`의 DB 설정을 사용하며 현재 이 PC의 파일은 Neon을 가리킨다. 새 마이그레이션 V3를 운영 DB에 적용하는 작업은 배포 단계에서 수행한다. 운영 DB를 사용하지 않고 주문 로직만 검증하려면 아래 테스트 명령을 사용한다.

## 주문 통합 테스트

위 두 Maven 빌드 후 루트에서 실행한다. Docker나 별도 테스트 라이브러리를 설치하지 않는다.

```powershell
cd D:\Projects\alpha-media
npm run test:orders
```

Node.js 기본 테스트 실행기가 별도의 임시 PostgreSQL 클러스터·DB·역할과 임의 포트의 Gateway·Service를 시작한다. V1~V3 마이그레이션을 실제로 적용하고 HTTP로 회원가입·로그인·주문 API를 호출한다. 기존 `.env`의 DB 정보는 테스트용 환경변수로 덮어쓰며 Neon에 접속하지 않는다. 테스트 종료 시 자신이 만든 서버와 클러스터만 정리한다.

11개 통합 시나리오에서 동시 요청 20개, 결과 응답을 버린 뒤 재시도, 요청 내용 충돌, 가격·소유자 변조, 타인 주문 접근, 입력 검증, 가격 스냅샷, 페이지네이션, Service 재시작 후 세션·주문 유지, 만료 조회·워커 반영을 검증한다. 실제 60초 주기의 만료 워커를 기다리므로 전체 실행은 약 80초다. Java 소스를 변경했다면 두 JAR을 다시 빌드한다.

## 연결·배포

Frontend → Gateway → Service → DB 순서다. 브라우저와 Next.js는 DB에 직접 접속하지 않는다. 배포 환경에서는 Vercel → Render Gateway → Render Service → Neon으로 연결된다.

이번 주문 변경은 로컬에서 검증했으며 아직 공개 서버에 배포하지 않았다. 공개 배포에는 커밋·푸시와 Render Service의 V3 마이그레이션 적용이 필요하다.

- [데이터 형식·API·실패 처리](docs/data-contract.md)
- [로컬 실행과 Vercel·Render·Neon 배포](docs/deployment.md)
- [DB 설정과 마이그레이션](backend/database/README.md)

요구사항별 설계 답변과 실제 작업 시간·AI 사용 기록은 별도로 보완해야 한다. 기록되지 않은 작업 시간을 임의로 추정하지 않았다.
