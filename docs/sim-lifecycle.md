# SIM 설치·개통·만료 추적

## 상태와 신호

- `ISSUED`: 발급 완료, 공급사 `RELEASED`.
- `QR_VIEWED`: 고객이 활성화 정보를 명시적으로 열람했다. 설치 여부는 확정하지 않는다.
- `INSTALLED`: 공급사 `INSTALLED`를 콜백 또는 조회로 확인했다.
- `ACTIVE`: 공급사 `ENABLED`, 최초 개통 시각과 요금제 일수로 만료를 계산한다.
- `EXPIRED`: 최초 개통 시각 + 24시간 × 요금제 일수가 지났다.
- `DELETED`: 공급사 프로필 삭제. 과거 설치·개통 시각은 보존한다.

설치·개통을 되돌리거나 최초 개통 시각을 변경하지 않는다. 새 시나리오는 새 주문과 SIM으로 시작한다. 현재 환불은 기존 정책대로 발급 실패·SIM 미생성 주문만 허용한다.

## API 연결

```text
내 SIM 상세 → Gateway → Service의 본인 소유권·CSRF 검사
  → 모의 공급사 프로필 상태 변경
    → 지연·중복·누락 설정을 가진 영속 콜백 작업
      → Gateway /webhooks/supplier/profiles → HMAC 검사 → 상태 반영

Service 조회 워커 → 공급사 프로필 조회 → 같은 상태 반영 경로
Service 만료 워커 → 개통 기준 만료 처리
```

- `GET /api/sims/{id}/tracking`: 현재 상태·확인 시각·최근 상태 이력.
- `POST /api/sims/{id}/activation-view`: 활성화 정보 열람. 중복 호출은 열람 이력 한 건으로 처리한다.
- `POST /api/sims/{id}/simulation`: `Idempotency-Key` UUID와 아래 본문을 사용한다.

```json
{
  "state": "ENABLED",
  "activatedAt": "2026-05-01T15:20:00Z",
  "callbackDelayMs": 2000,
  "callbackCopies": 3
}
```

`state`는 `RELEASED / INSTALLED / ENABLED / DELETED`다. 최초 `ENABLED`에만 UTC 개통 시각을 입력한다. 나머지 상태에서는 `activatedAt`을 null로 보낸다. 지연은 0~60,000ms, 전송 횟수는 0~20회다. 0회는 누락이다. 같은 키의 같은 요청은 기존 이벤트를 돌려주고, 내용이 달라지면 409다.

내부 공급사는 별도 API 키로 인증하는 `GET /internal/mock-supplier/profiles/{iccid}`, `POST /internal/mock-supplier/profiles/{iccid}/simulate`를 제공한다. 브라우저에는 이 키를 보내지 않는다.

## 정합성·복구

- 공급사 이벤트 ID는 유일하며 동일 ID의 다른 본문은 거절한다. 같은 버전의 다른 이벤트도 거절한다.
- 늦은 이전 버전은 상태를 되돌리지 않고 현재 상태를 유지한 이력으로 남긴다.
- 설치·개통 시각은 최초 확인 후 고정한다. 프로필을 삭제해도 설치 증거를 지우지 않는다.
- 시연 요청 성공 후 약 5초 안에 조회 작업을 예약한다. 평상시 조회 간격은 미설치·설치 5초, 사용 중 60초, 만료 후 1시간이다. 삭제 상태는 주기 조회를 멈춘다.
- 조회 실패 시 기존 상태를 유지하고 오류를 표시하며 30초 후 재조회한다. HTTP 통신 중에는 DB 트랜잭션을 유지하지 않는다.
- 콜백 전송은 연속 실패 시 총 6회 시도 후 중단한다. DB에 작업과 lease를 저장해 재시작·다중 워커 중복 실행을 방어한다.
- 서버 만료 처리는 한 번의 이력으로 저장한다. 절전으로 워커가 멈췄어도 조회 응답은 이미 지난 만료 시각을 `EXPIRED`로 표시한다.
- PostgreSQL의 마이크로초 정밀도에 맞춰 시각을 정규화한 후 해시를 계산한다.

## 시연

1. 고객으로 로그인해 주문·결제 후 `내 SIM → SIM 상세`로 이동한다.
2. 공급사 상태를 `INSTALLED`로 바꾸고 지연·전송 횟수를 조절한다. 동시 2회 전송과 동일 키 재전송도 가능하다.
3. `ENABLED`로 바꾸면 최초 UTC 개통 시각, UTC·KST 만료 시각과 남은 시간이 표시된다.
4. 콜백을 0회로 설정해 조회 복구와 이력의 `LOOKUP` 출처를 확인한다.
5. 즉시 만료를 시연하려면 새 SIM을 바로 `ENABLED`로 바꾸고 요금제 일수보다 오래된 개통 시각을 입력한다. 이미 설치한 뒤에는 설치 시각보다 과거로 개통할 수 없다.

7일 요금제의 `2026-05-01T15:20:00Z` 개통은 `2026-05-08T15:20:00Z`, KST `2026-05-09 00:20`에 만료된다. 여행 시작일은 계산에 사용하지 않는다.

## 검증·배포 범위

`npm run test:tracking`은 격리된 임시 PostgreSQL과 서버에서 검증한 뒤 종료·정리한다. `npm run test:orders`는 기존 흐름을 포함한 전체 회귀 테스트다. 테스트용 임시 DB는 앱 개발용 로컬 DB 설정과 분리된다.

배포 대상은 Git `develop`, Vercel의 develop Preview, Render의 `alpha-media-develop-gateway`·`alpha-media-develop-service`, Neon의 `develop` 브랜치다. V8 마이그레이션은 Preview Service의 Flyway가 개발 DB에만 적용한다. 운영의 `main`과 Neon `production`은 변경하지 않는다.
