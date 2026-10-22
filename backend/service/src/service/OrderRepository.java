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

    public List<Order> findAll(UUID memberId, int page, int size) {
        return jdbc.query(SELECT + " WHERE member_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
                MAPPER, memberId, size + 1, (long) page * size);
    }

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
