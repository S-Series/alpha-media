package service;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

@Repository
public class AdminActionRepository {
    private final JdbcTemplate jdbc;
    public AdminActionRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    private static final RowMapper<Action> MAPPER = (r, i) -> new Action(r.getObject("id", UUID.class),
        r.getObject("order_id", UUID.class), r.getString("username"), r.getString("type"), r.getString("reason"),
        r.getObject("issuance_id", UUID.class), r.getObject("refund_id", UUID.class),
        r.getTimestamp("created_at").toInstant(), r.getString("payload_hash"));
    private static final String SELECT = "SELECT a.*,m.username FROM admin_actions a JOIN members m ON m.id=a.actor_id";
    Optional<Action> find(UUID orderId, UUID key) {
        return jdbc.query(SELECT + " WHERE a.order_id=? AND a.idempotency_key=?", MAPPER, orderId, key).stream().findFirst();
    }
    Action insert(UUID orderId, UUID actorId, UUID key, String hash, String type, String reason, UUID issuanceId, UUID refundId) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO admin_actions(id,order_id,actor_id,idempotency_key,payload_hash,type,reason,issuance_id,refund_id)
            VALUES(?,?,?,?,?,?,?,?,?)
            """, id, orderId, actorId, key, hash, type, reason, issuanceId, refundId);
        return find(orderId, key).orElseThrow();
    }
    void event(UUID actionId, String status, String detail) {
        jdbc.update("INSERT INTO admin_action_events(id,action_id,status,detail) VALUES(?,?,?,?)", UUID.randomUUID(), actionId, status, detail);
    }
    void issuanceEvent(UUID issuanceId, String status, String detail) {
        jdbc.update("""
            INSERT INTO admin_action_events(id,action_id,status,detail)
            SELECT gen_random_uuid(),id,?,? FROM admin_actions WHERE issuance_id=?
            """, status, detail, issuanceId);
    }
    void refundEvent(UUID refundId, String status, String detail) {
        jdbc.update("""
            INSERT INTO admin_action_events(id,action_id,status,detail)
            SELECT gen_random_uuid(),id,?,? FROM admin_actions WHERE refund_id=?
            """, status, detail, refundId);
    }
    List<Action> list(UUID orderId) {
        return jdbc.query(SELECT + " WHERE a.order_id=? ORDER BY a.created_at DESC,a.id DESC LIMIT 100", MAPPER, orderId);
    }
    List<Event> events(UUID orderId) {
        return jdbc.query("""
            SELECT e.* FROM admin_action_events e JOIN (
                SELECT id FROM admin_actions WHERE order_id=? ORDER BY created_at DESC,id DESC LIMIT 100
            ) a ON a.id=e.action_id ORDER BY e.created_at,e.id
            """, (r,i) -> new Event(r.getObject("id",UUID.class), r.getObject("action_id",UUID.class),
                r.getString("status"),r.getString("detail"),r.getTimestamp("created_at").toInstant()), orderId);
    }
    public record Action(UUID id, UUID orderId, String actor, String type, String reason, UUID issuanceId,
        UUID refundId, Instant createdAt, @com.fasterxml.jackson.annotation.JsonIgnore String payloadHash) {}
    public record Event(UUID id, UUID actionId, String status, String detail, Instant createdAt) {}
}
