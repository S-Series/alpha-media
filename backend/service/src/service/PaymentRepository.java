package service;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

@Repository
public class PaymentRepository {
    static final RowMapper<PaymentAttempt> MAPPER = (r, i) -> new PaymentAttempt(
            r.getObject("id", UUID.class), r.getObject("order_id", UUID.class), r.getLong("amount"),
            r.getString("currency"), PaymentAttempt.Scenario.valueOf(r.getString("scenario")),
            r.getInt("webhook_copies"), r.getInt("webhook_delay_ms"), r.getString("status"),
            r.getString("pg_transaction_id"), r.getString("decline_code"), r.getString("last_error"),
            r.getInt("attempt_count"), new IssuanceSimulation(IssuanceSimulation.Scenario.valueOf(r.getString("supplier_scenario")),
                r.getInt("supplier_callback_copies"), r.getInt("supplier_callback_delay_ms")), r.getTimestamp("next_attempt_at").toInstant(),
            r.getTimestamp("created_at").toInstant(), r.getTimestamp("updated_at").toInstant());
    private final JdbcTemplate jdbc;

    public PaymentRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    Optional<PaymentAttempt> find(UUID orderId, UUID id) {
        return jdbc.query("SELECT * FROM payment_attempts WHERE order_id=? AND id=?", MAPPER, orderId, id)
                .stream().findFirst();
    }

    Optional<PaymentAttempt> findByKey(UUID orderId, UUID key) {
        return jdbc.query("SELECT * FROM payment_attempts WHERE order_id=? AND idempotency_key=?",
                MAPPER, orderId, key).stream().findFirst();
    }

    List<PaymentAttempt> list(UUID orderId) {
        return jdbc.query("SELECT * FROM payment_attempts WHERE order_id=? ORDER BY created_at DESC, id DESC LIMIT 20",
                MAPPER, orderId);
    }

    PaymentAttempt insert(Order order, UUID key, PaymentController.Request request) {
        return jdbc.query("""
                INSERT INTO payment_attempts (id, order_id, idempotency_key, amount, currency,
                    scenario, webhook_copies, webhook_delay_ms, supplier_scenario, supplier_callback_copies,
                    supplier_callback_delay_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                RETURNING *
                """, MAPPER, UUID.randomUUID(), order.id(), key, order.amount(), order.currency(),
                request.scenario().name(), request.webhookCopies(), request.webhookDelayMs(), request.issuanceOrDefault().scenario().name(),
                request.issuanceOrDefault().callbackCopies(), request.issuanceOrDefault().callbackDelayMs()).getFirst();
    }

    Optional<Claim> claim(int leaseMs) {
        // 선점만 커밋한다. PG 통신 동안 DB 잠금을 보유하지 않는다.
        return jdbc.query("""
                WITH due AS (
                    SELECT id FROM payment_attempts
                    WHERE (status IN ('QUEUED','UNKNOWN') AND next_attempt_at <= clock_timestamp())
                       OR (status='PROCESSING' AND lease_until <= clock_timestamp())
                    ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
                )
                UPDATE payment_attempts p SET status='PROCESSING', lease_token=?,
                    lease_until=clock_timestamp() + (? * INTERVAL '1 millisecond'),
                    attempt_count=attempt_count+1, updated_at=clock_timestamp()
                WHERE p.id IN (SELECT id FROM due) RETURNING p.*
                """, (r, i) -> new Claim(MAPPER.mapRow(r, i), r.getObject("lease_token", UUID.class)),
                UUID.randomUUID(), leaseMs).stream().findFirst();
    }

    PaymentAttempt lock(UUID id) {
        return jdbc.query("SELECT * FROM payment_attempts WHERE id=? FOR UPDATE", MAPPER, id).getFirst();
    }

    boolean ownsLease(UUID id, UUID token) {
        return Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT status='PROCESSING' AND lease_token=? FROM payment_attempts WHERE id=?", Boolean.class, token, id));
    }

    void complete(UUID id, PgResult result) {
        jdbc.update("""
                UPDATE payment_attempts SET status=?, pg_transaction_id=?, decline_code=?, last_error=NULL,
                    lease_until=NULL, lease_token=NULL, updated_at=clock_timestamp() WHERE id=?
                """, result.status(), result.transactionId(), result.declineCode(), id);
    }

    void defer(UUID id, boolean review, String error, long delayMs) {
        jdbc.update("""
                UPDATE payment_attempts SET status=?, last_error=?, lease_until=NULL, lease_token=NULL,
                    next_attempt_at=clock_timestamp() + (? * INTERVAL '1 millisecond'),
                    updated_at=clock_timestamp() WHERE id=?
                """, review ? "REVIEW_REQUIRED" : "UNKNOWN", error, delayMs, id);
    }

    boolean recordEvent(PgResult result, String hash, String source) {
        int inserted = jdbc.update("""
                INSERT INTO payment_events(event_id,payment_id,payload_hash,source) VALUES(?,?,?,?)
                ON CONFLICT(event_id) DO NOTHING
                """, result.eventId(), result.paymentId(), hash, source);
        if (inserted == 1) return true;
        String existing = jdbc.queryForObject("SELECT payload_hash FROM payment_events WHERE event_id=?", String.class, result.eventId());
        if (!hash.equals(existing)) throw new OrderService.OrderException(409, "EVENT_CONFLICT", "같은 이벤트의 내용이 다릅니다.");
        return false;
    }

    record Claim(PaymentAttempt payment, UUID token) {}
}
