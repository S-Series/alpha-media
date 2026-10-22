# Alpha Media 데이터 형식

요금제, 회원, 주문, SIM, 처리 이력을 화면과 API에서 어떻게 표현하는지 정리한다. 요금제·회원·로그인 세션은 PostgreSQL에 저장한다. 주문·SIM·처리 이력은 화면 확인용 예시 데이터이며 실제 주문·결제 API는 아직 없다.

## 1 공통 규칙

| 항목 | 현재 형식 | 예시 | 설명 |
|---|---|---|---|
| 금액 | KRW 원 단위 정수 | `15900` | 화면에서는 `₩15,900`처럼 표시한다. 소수 원 단위는 사용하지 않는다. |
| 사건 발생 시각 | UTC ISO 8601 문자열 | `2026-10-21T01:05:00Z` | 화면에서는 KST인 `2026-10-21 10:05:00`으로 변환한다. |
| 여행 시작일 | `YYYY-MM-DD` 문자열 | `2026-11-01` | 시각이 없는 날짜다. UTC 시각처럼 변환하지 않는다. |
| 식별자 | 문자열 | `jp-esim-7d`, `order-active` | 현재 값은 예시 식별자다. 운영 환경의 발급 규칙은 별도로 정한다. |

현재 요금제 JSON에는 `currency` 필드가 없으며 `price`를 KRW로 해석한다. DB에는 `currency = 'KRW'` 제약을 둔다. 주문·결제 구현 시 주문 시점의 금액과 통화를 별도로 저장한다.

## 2 요금제 Plan

현재 API에서 사용하는 상품 형식이다. Service의 `Plan`과 프론트엔드의 `Plan` 타입을 동일한 필드명으로 유지한다.

### 식별과 표시 정보

| 필드 | JSON 타입 | 예시 | 의미 |
|---|---|---|---|
| `id` | string | `jp-esim-7d` | 상품 식별자 |
| `name` | string | `일본 eSIM 7일` | 화면에 표시할 상품명 |
| `country` | string | `일본` | 판매 대상 국가·지역 |

### 사용 조건과 가격

| 필드 | JSON 타입 | 예시 | 의미 |
|---|---|---|---|
| `days` | integer | `7` | 사용 일수 |
| `dataMb` | integer | `5000` | 데이터 제공량 MB |
| `simType` | string | `ESIM` | `ESIM` 또는 `USIM` |
| `price` | integer | `15900` | 상품 가격, KRW 원 단위 |

모든 필드는 현재 응답에 필수이며 `null`을 반환하지 않는다. 목록은 `Plan[]`, 상세는 `Plan` 객체 한 개로 반환한다.

### 현재 예시 상품

| id | 상품명 | 사용 조건 | 가격 KRW |
|---|---|---|---|
| `jp-esim-7d` | 일본 eSIM 7일 | 7일, 5,000MB, ESIM | 15,900 |
| `jp-usim-7d` | 일본 USIM 7일 | 7일, 5,000MB, USIM | 19,900 |
| `th-esim-5d` | 태국 eSIM 5일 | 5일, 3,000MB, ESIM | 9,900 |

현재 상품은 PostgreSQL `plans` 테이블에 저장한다. `PlanController → PlanService → PlanRepository → JdbcTemplate → PostgreSQL` 순서로 조회한다. 상품 등록·수정 API는 아직 없다.

## 3 주문 PreviewOrder

현재 주문 화면의 예시 형식이다. `planId`로 상품을 연결하며, 주문 금액은 화면에서 해당 상품의 `price`를 찾아 표시한다. 실제 주문 API에는 주문 시점의 금액·통화를 고정하는 정책과 별도 필드 설계가 필요하다.

### 주문과 상품 연결

| 필드 | 타입 | 예시 | 의미 |
|---|---|---|---|
| `id` | string | `order-pending` | 주문 식별자 |
| `planId` | string | `jp-esim-7d` | 선택한 상품 식별자 |
| `travelStartDate` | string | `2026-11-01` | 여행 시작일 |

### 현재 상태 표시

| 필드 | 타입 | 예시 | 의미 |
|---|---|---|---|
| `payment` | string | `승인 완료` | 결제 상태 표시문 |
| `fulfillment` | string | `발급 중` | 발급·수령 상태 표시문 |
| `installation` | string | `미설치` | 설치·개통 상태 표시문 |
| `refund` | string | `요청 없음` | 환불 상태 표시문 |

이 값들은 현재 화면의 한글 표시문이다. 결제·발급·설치·환불을 각각 독립된 상태로 표현하며, 실제 저장용 상태 코드와 전이 규칙은 아직 확정하지 않았다.

### 조회 시각과 처리 이력

| 필드 | 타입 | 필수 여부 | 의미 |
|---|---|---|---|
| `updatedAt` | string | 필수 | 예시 주문의 마지막 확인 시각, UTC |
| `simId` | string | 선택 | 연결된 SIM 식별자. 미발급 주문에는 없을 수 있다. |
| `issue` | string | 선택 | 발급 지연·환불 실패 등 확인할 내용 |
| `history` | HistoryEvent[] | 필수 | 주문의 처리 이력 배열 |

현재 TypeScript의 선택 속성은 값이 없으면 생략한다. 실제 주문 JSON의 생략·`null` 정책은 API 구현 시 확정한다.

### 현재 예시에 사용한 상태 표시문

| 영역 | 사용 중인 표시문 |
|---|---|
| 결제 | 결제 대기, 승인 완료 |
| 발급·수령 | 발급 대기, 발급 중, 발급 완료, 공항 수령 대기, 발급 실패 |
| 설치·개통 | 미발급, 미설치, 미등록, 개통 |
| 환불 | 요청 없음, 환불 제한, 환불 실패 |

위 목록은 현재 화면 예시의 값이며, 승인 거절·결제 결과 불명·주문 만료 등의 전체 상태를 정의한 목록은 아니다.

## 4 처리 이력 HistoryEvent

| 필드 | 타입 | 예시 | 의미 |
|---|---|---|---|
| `at` | string | `2026-10-21T01:02:00Z` | 사건 발생 시각, UTC |
| `change` | string | `발급 요청 접수` | 무엇이 변경됐는지 |
| `actor` | string | `서버 워커` | 실행자 또는 외부 신호의 출처 |
| `reason` | string | `승인 후 발급` | 처리 사유 |

현재 `actor`는 설명 문자열이다. 실제 운영 이력에는 인증된 실행자 식별자와 이벤트 식별자 등의 추가 설계가 필요하다.

## 5 SIM PreviewSim

주문과 연결된 SIM의 화면 예시 형식이다. 현재는 별도 이름의 TypeScript 타입 선언 없이 `previewSims` 배열에서 형태를 정의한다.

### 주문 연결과 상태

| 필드 | 타입 | 예시 | 의미 |
|---|---|---|---|
| `id` | string | `sim-esim-active` | SIM 식별자 |
| `orderId` | string | `order-active` | 연결된 주문 식별자 |
| `state` | string | `사용 중 · ACTIVE` | 화면 표시문과 상태 코드가 함께 들어 있는 예시 값 |

### 설치와 사용 시각

| 필드 | 타입 | 예시 | 의미 |
|---|---|---|---|
| `installed` | string | `설치·개통 확인` | 설치 상태 설명. boolean 값이 아니다. |
| `activatedAt` | string 또는 null | `2026-10-21T01:05:00Z` | 개통 시각. 개통 전에는 `null`이다. |
| `expiresAt` | string 또는 null | `2026-10-28T01:05:00Z` | 만료 시각. 현재 예시에서는 개통 전에 `null`이다. |

현재 배열에는 QR·활성화 코드·ICCID를 넣지 않았다. 해당 정보는 발급·등록 API를 설계할 때 접근 권한과 응답 형식을 함께 정한다. 현재 주문·SIM 화면의 데이터는 모두 로컬 예시이며, 실제 환불 가능 여부를 판정하지 않는다.

## 6 현재 요금제 API

클라이언트의 공개 진입점은 Gateway이고, Gateway가 동일한 경로로 Service에 전달한다. 요금제 화면에서는 Next.js 서버가 Gateway를 호출한다.

| 기능 | 메서드 | Gateway 경로 | 응답 |
|---|---|---|---|
| 상품 목록·검색 | GET | `/api/plans` | Plan[] |
| 상품 상세 | GET | `/api/plans/{planId}` | Plan |

로컬 기본 주소는 Gateway `http://127.0.0.1:8080`, Service `http://127.0.0.1:8081`이다. 프론트엔드 서버의 `GATEWAY_BASE_URL` 환경변수로 Gateway 주소를 바꿀 수 있다.

### 목록 검색 조건

| 쿼리 이름 | 타입 | 예시 | 처리 |
|---|---|---|---|
| `country` | string | `일본` | 앞뒤 공백을 제거한 뒤 국가·지역 이름의 부분 일치 검색 |
| `days` | 양의 정수 | `7` | 사용 일수와 정확히 일치 |
| `dataMb` | 양의 정수 | `5000` | 데이터 제공량과 정확히 일치 |
| `simType` | ESIM 또는 USIM | `ESIM` | SIM 종류와 정확히 일치 |

모든 조건은 선택이며 여러 조건을 함께 보내면 모두 만족하는 상품을 반환한다. 결과가 없으면 `200`과 빈 배열 `[]`을 반환한다. 잘못된 검색 조건은 페이지에서 오류 안내로 표시한다.

### 응답 상태

| HTTP 상태 | 발생 조건 |
|---|---|
| 200 | 목록 또는 상세 조회 성공. 목록의 빈 결과도 포함한다. |
| 400 | 정수 변환 실패, 0 이하의 사용 일수·용량, 지원하지 않는 SIM 종류 |
| 404 | 존재하지 않는 상품 상세 조회 |
| 502 또는 504 | Gateway의 Service 연결 실패 또는 응답 대기 시간 초과 |

Gateway를 거친 실제 API 응답에는 `X-Request-Id`를 포함한다. 데이터 조회 실패와 결제·발급의 업무 상태는 별개로 다룬다.

## 7 회원과 인증

### 회원 응답 Member

| 필드 | JSON 타입 | 의미 |
|---|---|---|
| `id` | string | 서버에서 발급하는 UUID |
| `email` | string | 앞뒤 공백 제거·소문자 변환 후 유일한 이메일 |
| `displayName` | string | 이름, 앞뒤 공백 제거 후 2~60자 |

| 필드 | JSON 타입 | 의미 |
|---|---|---|
| `role` | string | USER 또는 ADMIN. 회원가입으로 생성되는 계정은 USER |
| `createdAt` | string | 가입 시각, UTC ISO 8601 |

비밀번호는 가입 시 12~128자다. DB에는 무작위 16바이트 salt를 사용한 PBKDF2-HMAC-SHA256 600,000회 해시와 알고리즘 식별자만 저장한다. 평문·해시는 응답에 포함하지 않는다. 이메일 중복은 DB UNIQUE 제약으로 차단하며 동시 요청도 한 건만 생성한다.

### 공개 인증 API

| 기능 | 요청 | 성공 | 실패 |
|---|---|---|---|
| CSRF 토큰 | GET `/api/auth/csrf` | 200 `{headerName, token}` | 연결 실패 |
| 회원가입 | POST `/api/auth/signup` JSON `{email, displayName, password}` | 201 Member | 400 입력 오류, 409 중복 이메일 |
| 로그인 | POST `/api/auth/login` form `{email, password}` | 200 Member | 401 동일한 자격 증명 오류문 |

### 로그인 후 API

| 기능 | 요청 | 성공 | 인증 실패 |
|---|---|---|---|
| 본인 정보 | GET `/api/me` | 200 Member | 401 |
| 로그아웃 | POST `/api/auth/logout` | 204 | CSRF 오류 시 403 |

모든 POST 요청 전에 동일한 쿠키 세션으로 CSRF API를 호출하고, 응답의 `headerName`인 `X-CSRF-TOKEN` 헤더에 `token`을 넣는다. CSRF 토큰이 없거나 다른 세션의 토큰이면 403이다. 로그인·로그아웃 후에는 기존 토큰을 재사용하지 않고 다시 조회한다. 회원가입은 자동 로그인하지 않는다.

로그인 요청의 Content-Type은 `application/x-www-form-urlencoded`다. 회원가입만 `application/json`이다. 로그인 필터가 인증 후 세션 ID를 교체하고 로그아웃 시 세션을 폐기한다. 쿠키 `ALPHA_SESSION`은 HttpOnly, SameSite=Lax이며 브라우저 저장소에 토큰을 보관하지 않는다. 세션은 PostgreSQL에 저장하고, 마지막 접근 후 30분 동안 요청이 없으면 만료한다. Service 재시작 후에도 만료 전 세션은 유지된다.

브라우저는 동일 출처의 `/api/**`를 호출한다. Next.js rewrite가 Gateway로 전달하고 Gateway가 Service로 전달한다. 화면의 `/mypage/**`는 로그인 확인 후 표시하며, 실제 데이터의 인증·권한 판정은 Service가 수행한다. `/api/admin/**`는 ADMIN만 허용하지만 현재 운영 API 자체는 구현하지 않았다. 기존 주문·SIM·관리자 화면에는 여전히 예시 데이터만 표시한다.

### DB 테이블과 권한

| 테이블 | 역할 | 주요 제약 |
|---|---|---|
| `members` | 회원 | UUID PK, 이메일 UNIQUE, 역할 USER 기본값 |
| `plans` | 요금제 | ID PK, 양수 일수·용량, 비음수 가격, KRW 고정 |
| `spring_session` | 로그인·CSRF 세션 | 세션 ID UNIQUE, 만료·실행자 인덱스 |
| `spring_session_attributes` | 세션 속성 | 세션 FK, 세션 삭제 시 함께 삭제 |

`alpha_media_app`은 요금제·회원 조회, 회원 일반 컬럼 입력, 세션 읽기·쓰기에만 권한이 있다. 가격이나 회원 역할 변경은 허용하지 않는다. `alpha_media_owner`는 Flyway 마이그레이션에 사용한다. 두 계정 모두 슈퍼유저가 아니며 비밀번호는 Git에서 제외한 `backend/service/.env` 또는 환경변수로 제공한다.

SQL은 `backend/database/migration`에서 버전 관리한다. Service 시작 시 Flyway가 미적용 버전만 실행하며 초기 요금제 3건도 첫 마이그레이션에 포함된다. 실행 방법은 [DB 안내](../backend/database/README.md)에 정리한다.

## 8 추가 설계가 필요한 데이터

| 영역 | 이후 정할 내용 |
|---|---|
| 회원·권한 | 이메일 소유 확인, 비밀번호 재설정, 로그인 시도 제한, 주문 소유권과 운영자 기능 |
| 주문·결제·환불 | 주문 금액·통화, 만료 시각, 멱등키, 결제 시도·환불 식별자, 상태 전이와 중복 처리 |
| SIM·외부 연동 | 발급 요청·결과 식별자, ICCID, 설치 정보, 공급사 상태와 콜백 형식 |
| DB | 주문·결제·발급·환불 테이블과 트랜잭션·멱등성 제약 |

## 관련 코드

- [상품 API 데이터 형식](../backend/service/src/service/Plan.java)
- [상품 조회 API](../backend/service/src/service/PlanController.java)
- [프론트엔드 상품 조회](../frontend/lib/plans.ts)
- [주문과 SIM 화면 예시 데이터](../frontend/lib/preview-data.ts)
- [서비스 기획서](product-plan.md)
