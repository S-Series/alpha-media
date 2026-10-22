package service;

import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class RefundBalance {
    private final JdbcTemplate jdbc;
    public RefundBalance(JdbcTemplate jdbc) { this.jdbc=jdbc; }
    void lock(UUID payment) { jdbc.queryForList("SELECT id FROM payment_attempts WHERE id=? FOR UPDATE",payment); }
    public Summary summary(UUID order) {
        long approved=jdbc.queryForObject("SELECT COALESCE(sum(amount),0) FROM payment_attempts WHERE order_id=? AND status='APPROVED'",Long.class,order);
        long confirmed=jdbc.queryForObject("SELECT COALESCE(sum(l.amount),0) FROM refund_ledger l JOIN payment_attempts p ON p.id=l.payment_id WHERE p.order_id=?",Long.class,order);
        long reserved=jdbc.queryForObject("SELECT COALESCE(sum(amount),0) FROM refunds WHERE order_id=? AND status NOT IN ('SUCCEEDED','FAILED')",Long.class,order);
        return new Summary(approved,confirmed,reserved,Math.max(0,approved-confirmed-reserved),confirmed+reserved>approved);
    }
    void record(MockPgService.Cancellation result) {
        lock(result.paymentId());
        jdbc.update("INSERT INTO refund_ledger(id,payment_id,request_id,amount) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING",
            result.id(),result.paymentId(),result.idempotencyKey(),result.amount());
        var row=jdbc.queryForMap("SELECT * FROM refund_ledger WHERE id=?",result.id());
        if (!result.paymentId().equals(row.get("payment_id")) || !result.idempotencyKey().equals(row.get("request_id"))
                || result.amount()!=((Number)row.get("amount")).longValue()) throw new PgClient.InvalidResult();
    }
    void refresh(UUID order) {
        var value=summary(order);
        String status=value.reserved()>0?"REFUND_PROCESSING":value.confirmed()==value.approved()?"REFUNDED":value.confirmed()>0?"PARTIALLY_REFUNDED":"PAID";
        jdbc.update("UPDATE orders SET status=?,updated_at=clock_timestamp() WHERE id=? AND status<>?",status,order,status);
    }
    public record Summary(long approved,long confirmed,long reserved,long available,boolean overReserved) {}
}
