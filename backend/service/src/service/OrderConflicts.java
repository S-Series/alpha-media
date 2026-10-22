package service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class OrderConflicts {
    private final JdbcTemplate jdbc;
    public OrderConflicts(JdbcTemplate jdbc) { this.jdbc=jdbc; }

    boolean blocked(UUID orderId) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM order_conflicts WHERE order_id=?)",Boolean.class,orderId));
    }
    void requireClear(UUID orderId) {
        if (blocked(orderId)) throw new OrderService.OrderException(409,"ORDER_UNDER_REVIEW","외부 결과가 충돌하여 자동 처리·재발급·환불을 보류했습니다.");
    }
    void lockExternal(String reference) {
        jdbc.queryForMap("SELECT pg_advisory_xact_lock(hashtextextended(?,0))",reference);
    }

    // Call under the order lock, before any business mutation. The caller commits this exception only.
    ConflictException reject(UUID orderId,String target,UUID targetId,String code,String source,
            String expected,String observed,String evidence) {
        jdbc.update("""
            INSERT INTO order_conflicts(id,order_id,target,target_id,code,source,expected_status,observed_status,payload_hash)
            VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(order_id,target,target_id,code,payload_hash) DO NOTHING
            """,UUID.randomUUID(),orderId,target,targetId,code,source,expected,
            observed==null?null:observed.substring(0,Math.min(32,observed.length())),hash(evidence));
        return new ConflictException(code);
    }
    List<Conflict> list(UUID orderId) {
        return jdbc.query("SELECT * FROM order_conflicts WHERE order_id=? ORDER BY recorded_at,id LIMIT 100",
            (r,i)->new Conflict(r.getObject("id",UUID.class),r.getObject("order_id",UUID.class),r.getString("target"),
                r.getObject("target_id",UUID.class),r.getString("code"),r.getString("source"),r.getString("expected_status"),
                r.getString("observed_status"),r.getTimestamp("recorded_at").toInstant()),orderId);
    }
    private String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    public record Conflict(UUID id,UUID orderId,String target,UUID targetId,String code,String source,
        String expectedStatus,String observedStatus,Instant recordedAt) {}
    public static class ConflictException extends OrderService.OrderException {
        ConflictException(String code) { super(409,code,"외부 결과가 기존 기록과 충돌하여 주문 조치를 보류했습니다."); }
    }
}
