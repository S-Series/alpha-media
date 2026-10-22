package service;

import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

@Repository
public class OrderRepository {

    // 워커가 멈춰 있어도 DB 시각으로 만료된 주문을 결제 대기로 반환하지 않는다.
    private static final String SELECT = """
            SELECT *, CASE WHEN status = 'PENDING_PAYMENT' AND expires_at <= statement_timestamp()
                THEN 'EXPIRED' ELSE status END AS effective_status FROM orders
            """;
    private static final RowMapper<Order> MAPPER = (row, index) -> new Order(
            row.getObject("id", UUID.class), row.getString("plan_id"), row.getString("plan_name"),
            row.getString("country"), row.getInt("days"), row.getInt("data_mb"), row.getString("sim_type"),
            row.getObject("travel_start_date", LocalDate.class), row.getLong("amount"),
            row.getString("currency"), row.getString("effective_status"), row.getTimestamp("created_at").toInstant(),
            row.getTimestamp("expires_at").toInstant(), row.getTimestamp("updated_at").toInstant());

    private final JdbcTemplate jdbc;

    private static final String INSTALL_STATUS = "CASE WHEN sp.install_status='ACTIVE' AND sp.expires_at<=statement_timestamp() THEN 'EXPIRED' ELSE COALESCE(sp.install_status,'NOT_ISSUED') END";
    private static final String ADMIN_SELECT = "SELECT o.*, m.username AS customer_username, j.status AS issuance_status, j.last_error AS issuance_error, "
            + "COALESCE(pay.status,'NOT_STARTED') AS payment_status, " + INSTALL_STATUS + " AS install_status, sp.last_synced_at,sp.sync_error FROM ("
            + SELECT + ") o JOIN members m ON m.id=o.member_id LEFT JOIN issuance_jobs j ON j.order_id=o.id AND j.is_current "
            + "LEFT JOIN sim_profiles sp ON sp.order_id=o.id LEFT JOIN LATERAL (SELECT status FROM payment_attempts WHERE order_id=o.id ORDER BY created_at DESC,id DESC LIMIT 1) pay ON TRUE";
    private static final RowMapper<AdminOrder> ADMIN_MAPPER = (r,i) -> new AdminOrder(MAPPER.mapRow(r,i),r.getString("customer_username"),
            r.getString("issuance_status"),r.getString("issuance_error"),r.getString("payment_status"),r.getString("install_status"),
            r.getTimestamp("last_synced_at")==null?null:r.getTimestamp("last_synced_at").toInstant(),r.getString("sync_error"));

    public OrderRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public Optional<Order> findByKey(UUID memberId, UUID key) {
        return jdbc.query(SELECT + " WHERE member_id = ? AND idempotency_key = ?", MAPPER, memberId, key)
                .stream().findFirst();
    }

    public Optional<Order> findById(UUID memberId, UUID orderId) {
        return jdbc.query(SELECT + " WHERE member_id = ? AND id = ?", MAPPER, memberId, orderId)
                .stream().findFirst();
    }

    Optional<Order> lock(UUID memberId, UUID orderId) {
        return jdbc.query(SELECT + " WHERE member_id=? AND id=? FOR UPDATE", MAPPER, memberId, orderId)
                .stream().findFirst();
    }

    Order lock(UUID orderId) {
        return jdbc.query(SELECT + " WHERE id=? FOR UPDATE", MAPPER, orderId).getFirst();
    }

    boolean startPayment(UUID orderId) {
        // 잠금을 기다린 시간도 포함해 실제 갱신 시점에 유효 기한을 검사한다.
        return jdbc.update("""
                UPDATE orders SET status='PAYMENT_PROCESSING', updated_at=clock_timestamp()
                WHERE id=? AND status='PENDING_PAYMENT' AND expires_at > clock_timestamp()
                """, orderId) == 1;
    }

    void finishPayment(UUID orderId, boolean approved) {
        jdbc.update("""
                UPDATE orders SET status=CASE WHEN ? THEN 'PAID'
                    WHEN expires_at > clock_timestamp() THEN 'PENDING_PAYMENT' ELSE 'EXPIRED' END,
                    updated_at=clock_timestamp() WHERE id=? AND status='PAYMENT_PROCESSING'
                """, approved, orderId);
    }

    public List<Order> findAll(UUID memberId, int page, int size) {
        return jdbc.query(SELECT + " WHERE member_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
                MAPPER, memberId, size + 1, (long) page * size);
    }

    List<AdminOrder> findAllForAdmin(int page, int size, String status, String simType,
            LocalDate from, LocalDate to, boolean needsReview, String paymentStatus, String issuanceStatus, String installStatus) {
        var zone = java.time.ZoneId.of("Asia/Seoul");
        var start = from == null ? null : java.sql.Timestamp.from(from.atStartOfDay(zone).toInstant());
        var end = to == null ? null : java.sql.Timestamp.from(to.plusDays(1).atStartOfDay(zone).toInstant());
        return jdbc.query(ADMIN_SELECT + """
                 WHERE (?::varchar IS NULL OR o.effective_status=?)
                    AND (?::varchar IS NULL OR o.sim_type=?)
                    AND (?::timestamptz IS NULL OR o.created_at>=?)
                    AND (?::timestamptz IS NULL OR o.created_at<?)
                    AND (?::varchar IS NULL OR COALESCE(pay.status,'NOT_STARTED')=?)
                    AND (?::varchar IS NULL OR COALESCE(j.status,'NOT_STARTED')=?)
                    AND (?::varchar IS NULL OR %s=?)
                    AND (NOT ? OR EXISTS (SELECT 1 FROM payment_attempts p WHERE p.order_id=o.id
                        AND p.status IN ('UNKNOWN','REVIEW_REQUIRED'))
                        OR sp.sync_error IS NOT NULL
                        OR EXISTS (SELECT 1 FROM refunds r WHERE r.order_id=o.id AND r.status='REVIEW_REQUIRED')
                        OR (o.effective_status='PAID' AND EXISTS (SELECT 1 FROM issuance_jobs j WHERE j.order_id=o.id AND j.is_current
                            AND (j.status IN ('FAILED','REVIEW_REQUIRED') OR
                                (j.status IN ('QUEUED','PROCESSING','WAITING_CALLBACK') AND j.created_at<clock_timestamp()-INTERVAL '2 minutes')))))
                 ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?
                """.formatted(INSTALL_STATUS), ADMIN_MAPPER,
                status, status, simType, simType, start, start, end, end,
                paymentStatus,paymentStatus,issuanceStatus,issuanceStatus,installStatus,installStatus,needsReview,size+1,(long)page*size);
    }

    Optional<AdminOrder> findForAdmin(UUID id) {
        return jdbc.query(ADMIN_SELECT + " WHERE o.id=?", ADMIN_MAPPER, id).stream().findFirst();
    }

    public record AdminOrder(Order order, String customerUsername, String issuanceStatus, String issuanceError,
        String paymentStatus,String installStatus,java.time.Instant lastSyncedAt,String syncError) {}

    void historyContext(UUID actor,String source,String reason) {
        jdbc.queryForMap("SELECT set_config('alpha.history_actor',?,true),set_config('alpha.history_source',?,true),set_config('alpha.history_reason',?,true)",
            actor==null?"":actor.toString(),source,reason==null?"":reason);
    }
    List<HistoryEvent> history(UUID orderId,Long before,int size) {
        return jdbc.query("""
            SELECT id::text AS history_id,* FROM order_history WHERE order_id=? AND (?::bigint IS NULL OR id<?)
            ORDER BY id DESC LIMIT ?
            """,(r,i)->new HistoryEvent(r.getString("history_id"),r.getString("target"),r.getObject("target_id",UUID.class),
                r.getString("from_status"),r.getString("to_status"),r.getString("actor"),r.getString("source"),r.getString("reason"),
                r.getTimestamp("recorded_at").toInstant()),orderId,before,before,size+1);
    }
    public record HistoryEvent(String id,String target,UUID targetId,String fromStatus,String toStatus,String actor,String source,String reason,java.time.Instant recordedAt) {}

    public boolean isPast(LocalDate travelStartDate) {
        return Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT ?::date < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date",
                Boolean.class, travelStartDate));
    }

    public Optional<Order> insert(UUID memberId, UUID key, String planId, LocalDate travelStartDate) {
        // 가격과 상품 조건은 클라이언트 입력 대신 같은 SQL에서 상품 테이블을 읽어 고정한다.
        // 충돌 시 기존 행을 수정하지 않는다. 다음 SELECT가 먼저 커밋된 주문을 읽는다.
        return jdbc.query("""
                INSERT INTO orders (id, member_id, idempotency_key, plan_id, plan_name,
                    country, days, data_mb, sim_type, travel_start_date, amount, currency)
                SELECT ?, ?, ?, id, name, country, days, data_mb, sim_type, ?, price, currency
                FROM plans WHERE id = ? AND sim_type = 'ESIM'
                ON CONFLICT (member_id, idempotency_key) DO NOTHING
                RETURNING *, status AS effective_status
                """, MAPPER, UUID.randomUUID(), memberId, key, travelStartDate, planId).stream().findFirst();
    }

    public int expireDueOrders() {
        // 여러 인스턴스가 실행돼도 서로 잠근 주문을 기다리지 않고 최대 100건씩 처리한다.
        return jdbc.update("""
                WITH due AS (
                    SELECT id FROM orders WHERE status = 'PENDING_PAYMENT'
                        AND expires_at <= statement_timestamp()
                    ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
                )
                UPDATE orders SET status = 'EXPIRED', updated_at = statement_timestamp()
                WHERE id IN (SELECT id FROM due)
                """);
    }
}
