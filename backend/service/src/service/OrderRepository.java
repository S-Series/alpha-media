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

    private static final String ADMIN_SELECT = "SELECT o.*, m.username AS customer_username FROM ("
            + SELECT + ") o JOIN members m ON m.id=o.member_id";

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
            LocalDate from, LocalDate to, boolean needsReview) {
        var zone = java.time.ZoneId.of("Asia/Seoul");
        var start = from == null ? null : java.sql.Timestamp.from(from.atStartOfDay(zone).toInstant());
        var end = to == null ? null : java.sql.Timestamp.from(to.plusDays(1).atStartOfDay(zone).toInstant());
        return jdbc.query(ADMIN_SELECT + """
                 WHERE (?::varchar IS NULL OR o.effective_status=?)
                    AND (?::varchar IS NULL OR o.sim_type=?)
                    AND (?::timestamptz IS NULL OR o.created_at>=?)
                    AND (?::timestamptz IS NULL OR o.created_at<?)
                    AND (NOT ? OR EXISTS (SELECT 1 FROM payment_attempts p WHERE p.order_id=o.id
                        AND p.status IN ('UNKNOWN','REVIEW_REQUIRED')))
                 ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?
                """, (r, i) -> new AdminOrder(MAPPER.mapRow(r, i), r.getString("customer_username")),
                status, status, simType, simType, start, start, end, end, needsReview, size + 1, (long) page * size);
    }

    Optional<AdminOrder> findForAdmin(UUID id) {
        return jdbc.query(ADMIN_SELECT + " WHERE o.id=?", (r, i) ->
                new AdminOrder(MAPPER.mapRow(r, i), r.getString("customer_username")), id).stream().findFirst();
    }

    public record AdminOrder(Order order, String customerUsername) {}

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
