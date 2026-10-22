package service;

import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

@Repository
public class RefundRepository {
    private final JdbcTemplate jdbc;
    public RefundRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    private static final RowMapper<Refund> MAPPER = (r,i) -> new Refund(r.getObject("id",UUID.class),
        r.getObject("order_id",UUID.class),r.getObject("payment_id",UUID.class),r.getLong("amount"),r.getString("currency"),
        Refund.Scenario.valueOf(r.getString("scenario")),r.getString("status"),r.getInt("attempt_count"),
        r.getObject("pg_cancellation_id",UUID.class),r.getString("last_error"),
        r.getTimestamp("created_at").toInstant(),r.getTimestamp("updated_at").toInstant());
    Optional<Refund> find(UUID orderId) {
        return jdbc.query("SELECT * FROM refunds WHERE order_id=?",MAPPER,orderId).stream().findFirst();
    }
    Refund insert(Order order, UUID paymentId, Refund.Scenario scenario) {
        return jdbc.query("""
            INSERT INTO refunds(id,order_id,payment_id,amount,currency,scenario) VALUES(?,?,?,?,?,?) RETURNING *
            """,MAPPER,UUID.randomUUID(),order.id(),paymentId,order.amount(),order.currency(),scenario.name()).getFirst();
    }
    Refund lock(UUID id) { return jdbc.query("SELECT * FROM refunds WHERE id=? FOR UPDATE",MAPPER,id).getFirst(); }
    Optional<Claim> claim(int leaseMs) {
        return jdbc.query("""
            WITH due AS (
                SELECT id FROM refunds WHERE (status IN ('REQUESTED','UNKNOWN') AND next_attempt_at<=clock_timestamp())
                    OR (status='PROCESSING' AND lease_until<=clock_timestamp())
                ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
            ) UPDATE refunds SET status='PROCESSING',attempt_count=attempt_count+1,lease_token=?,
                lease_until=clock_timestamp()+(? * INTERVAL '1 millisecond'),updated_at=clock_timestamp()
                WHERE id IN (SELECT id FROM due) RETURNING *
            """,(r,i) -> new Claim(MAPPER.mapRow(r,i),r.getObject("lease_token",UUID.class)),UUID.randomUUID(),leaseMs)
            .stream().findFirst();
    }
    boolean owns(UUID id, UUID token) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT status='PROCESSING' AND lease_token=? FROM refunds WHERE id=?",Boolean.class,token,id));
    }
    void save(UUID id, String status, UUID cancellationId, String error, long delayMs) {
        jdbc.update("""
            UPDATE refunds SET status=?,pg_cancellation_id=?,last_error=?,lease_token=NULL,lease_until=NULL,
                next_attempt_at=clock_timestamp()+(? * INTERVAL '1 millisecond'),updated_at=clock_timestamp() WHERE id=?
            """,status,cancellationId,error,delayMs,id);
    }
    record Claim(Refund refund, UUID token) {}
}
