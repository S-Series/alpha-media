package service;

import java.util.UUID;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import service.OrderService.OrderException;

@Service
@ConditionalOnProperty(name = "payment.mock-enabled", havingValue = "true")
public class MockPgService {
    static final RowMapper<PgResult> RESULT = (r, i) -> new PgResult(r.getObject("event_id", UUID.class),
            r.getObject("payment_id", UUID.class), r.getObject("order_id", UUID.class), r.getLong("amount"),
            r.getString("currency"), r.getString("status"), r.getString("transaction_id"), r.getString("decline_code"));
    private final JdbcTemplate jdbc;

    public MockPgService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Transactional
    public ApprovalReply approve(Approval request) {
        boolean approved = request.scenario() != PaymentAttempt.Scenario.DECLINE;
        int inserted = jdbc.update("""
                INSERT INTO mock_pg_payments(payment_id,order_id,amount,currency,scenario,event_id,status,
                    transaction_id,decline_code,approval_executions,webhook_copies,webhook_delay_ms,webhook_next_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ? > 0
                    THEN clock_timestamp() + (? * INTERVAL '1 millisecond') ELSE NULL END)
                ON CONFLICT(payment_id) DO NOTHING
                """, request.paymentId(), request.orderId(), request.amount(), request.currency(), request.scenario().name(),
                UUID.randomUUID(), approved ? "APPROVED" : "DECLINED", approved ? "mock_" + UUID.randomUUID() : null,
                approved ? null : "MOCK_CARD_DECLINED", approved ? 1 : 0, request.webhookCopies(), request.webhookDelayMs(),
                request.webhookCopies(), request.webhookDelayMs());
        var stored = jdbc.queryForMap("SELECT * FROM mock_pg_payments WHERE payment_id=? FOR UPDATE", request.paymentId());
        if (!request.orderId().equals(stored.get("order_id")) || request.amount() != ((Number) stored.get("amount")).longValue()
                || !request.currency().equals(stored.get("currency")) || !request.scenario().name().equals(stored.get("scenario"))
                || request.webhookCopies() != ((Number) stored.get("webhook_copies")).intValue()
                || request.webhookDelayMs() != ((Number) stored.get("webhook_delay_ms")).intValue()) {
            throw new OrderException(409, "PG_IDEMPOTENCY_CONFLICT", "같은 결제번호의 PG 요청 내용이 다릅니다.");
        }
        if (inserted == 0) jdbc.update("UPDATE mock_pg_payments SET approval_requests=approval_requests+1 WHERE payment_id=?", request.paymentId());
        return new ApprovalReply(lookup(request.paymentId()), inserted == 1 && request.scenario() == PaymentAttempt.Scenario.RESPONSE_LOST);
    }

    public PgResult lookup(UUID id) {
        return jdbc.query("SELECT * FROM mock_pg_payments WHERE payment_id=?", RESULT, id).stream().findFirst()
                .orElseThrow(() -> new OrderException(404, "PG_PAYMENT_NOT_FOUND", "PG 결제 기록이 없습니다."));
    }

    public Stats stats(UUID id) {
        return jdbc.query("SELECT * FROM mock_pg_payments WHERE payment_id=?", (r, i) -> new Stats(
                r.getInt("approval_requests"), r.getInt("approval_executions"), r.getLong("cancelled_amount"),
                r.getInt("webhook_sent"), r.getInt("webhook_failures")), id).stream().findFirst()
                .orElseThrow(() -> new OrderException(404, "PG_PAYMENT_NOT_FOUND", "PG 결제 기록이 없습니다."));
    }

    @Transactional
    public CancelReply cancel(UUID id, UUID key, long amount, Refund.Scenario scenario) {
        var rows = jdbc.queryForList("SELECT * FROM mock_pg_payments WHERE payment_id=? FOR UPDATE", id);
        if (rows.isEmpty()) throw new OrderException(404, "PG_PAYMENT_NOT_FOUND", "PG 결제 기록이 없습니다.");
        var original = rows.getFirst();
        var existing = jdbc.query("SELECT * FROM mock_pg_cancellations WHERE payment_id=? AND idempotency_key=?",
                CANCELLATION, id, key);
        if (!existing.isEmpty()) {
            if (existing.getFirst().amount() != amount) throw new OrderException(409, "PG_CANCEL_CONFLICT", "같은 취소 키의 금액이 다릅니다.");
            String storedScenario=jdbc.queryForObject("SELECT scenario FROM mock_pg_cancellations WHERE payment_id=? AND idempotency_key=?",String.class,id,key);
            if (!scenario.name().equals(storedScenario)) throw new OrderException(409,"PG_CANCEL_CONFLICT","같은 취소 키의 시연 조건이 다릅니다.");
            return new CancelReply(existing.getFirst(),false);
        }
        var rejected=jdbc.query("SELECT * FROM mock_pg_cancel_rejections WHERE payment_id=? AND idempotency_key=?",REJECTION,id,key);
        if (!rejected.isEmpty()) {
            if (scenario!=Refund.Scenario.DECLINED || rejected.getFirst().amount()!=amount) throw new OrderException(409,"PG_CANCEL_CONFLICT","같은 취소 키의 조건이 다릅니다.");
            return new CancelReply(rejected.getFirst(),false);
        }
        if (scenario==Refund.Scenario.UNAVAILABLE && !Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT EXISTS(SELECT 1 FROM mock_pg_outage_releases WHERE payment_id=? AND refund_id=?)",Boolean.class,id,key)))
            throw new OrderException(503,"MOCK_CANCEL_UNAVAILABLE","모의 PG 취소 장애입니다.");
        long total = ((Number) original.get("cancelled_amount")).longValue();
        long approved = ((Number) original.get("amount")).longValue();
        if (!"APPROVED".equals(original.get("status")) || amount <= 0 || amount > approved - total) {
            throw new OrderException(409, "PG_CANCEL_NOT_ALLOWED", "취소 가능한 잔액을 확인해 주세요.");
        }
        if (scenario==Refund.Scenario.DECLINED) {
            var result=jdbc.query("INSERT INTO mock_pg_cancel_rejections(id,payment_id,idempotency_key,amount,cancelled_total,scenario) VALUES(?,?,?,?,?,?) RETURNING *",
                REJECTION,UUID.randomUUID(),id,key,amount,total,scenario.name()).getFirst();
            return new CancelReply(result,false);
        }
        jdbc.update("UPDATE mock_pg_payments SET cancelled_amount=cancelled_amount+? WHERE payment_id=?", amount, id);
        var result=jdbc.query("""
                INSERT INTO mock_pg_cancellations(id,payment_id,idempotency_key,amount,cancelled_total,scenario)
                VALUES(?,?,?,?,?,?) RETURNING *
                """, CANCELLATION,UUID.randomUUID(), id, key, amount, total + amount,scenario.name()).getFirst();
        return new CancelReply(result,scenario==Refund.Scenario.RESPONSE_LOST);
    }

    static final RowMapper<Cancellation> CANCELLATION=(r,i) -> new Cancellation(r.getObject("id",UUID.class),
        r.getObject("payment_id",UUID.class),r.getObject("idempotency_key",UUID.class),r.getLong("amount"),r.getLong("cancelled_total"));
    static final RowMapper<Cancellation> REJECTION=(r,i)->new Cancellation(r.getObject("id",UUID.class),r.getObject("payment_id",UUID.class),
        r.getObject("idempotency_key",UUID.class),r.getLong("amount"),r.getLong("cancelled_total"),"DECLINED");
    public Cancellation cancellation(UUID id,UUID key) {
        var rejected=jdbc.query("SELECT * FROM mock_pg_cancel_rejections WHERE payment_id=? AND idempotency_key=?",REJECTION,id,key);
        if (!rejected.isEmpty()) return rejected.getFirst();
        return jdbc.query("SELECT * FROM mock_pg_cancellations WHERE payment_id=? AND idempotency_key=?",CANCELLATION,id,key)
            .stream().findFirst().orElseThrow(() -> new OrderException(404,"PG_CANCELLATION_NOT_FOUND","PG 취소 기록이 없습니다."));
    }

    public record Approval(@NotNull UUID paymentId, @NotNull UUID orderId, @Min(0) long amount,
            @NotNull @Pattern(regexp = "KRW") String currency, @NotNull PaymentAttempt.Scenario scenario,
            @Min(0) @Max(20) int webhookCopies, @Min(0) @Max(60000) int webhookDelayMs) {}
    public record ApprovalReply(PgResult result, boolean loseResponse) {}
    public record Stats(int approvalRequests, int approvalExecutions, long cancelledAmount, int webhookSent, int webhookFailures) {}
    public record Cancellation(UUID id, UUID paymentId, UUID idempotencyKey, long amount, long cancelledTotal,String status) {
        public Cancellation(UUID id,UUID paymentId,UUID idempotencyKey,long amount,long cancelledTotal) { this(id,paymentId,idempotencyKey,amount,cancelledTotal,"SUCCEEDED"); }
    }
    public record CancelReply(Cancellation result,boolean loseResponse) {}
}
