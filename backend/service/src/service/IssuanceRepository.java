package service;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

@Repository
public class IssuanceRepository {
    static final RowMapper<Issuance> MAPPER = (r, i) -> new Issuance(r.getObject("id", UUID.class),
        r.getObject("order_id", UUID.class), new IssuanceSimulation(
            IssuanceSimulation.Scenario.valueOf(r.getString("scenario")), r.getInt("callback_copies"), r.getInt("callback_delay_ms")),
        r.getString("status"), r.getString("supplier_order_no"), r.getInt("revision"), r.getInt("check_count"),
        r.getString("last_error"), r.getTimestamp("created_at").toInstant(), r.getTimestamp("updated_at").toInstant());
    static final RowMapper<SimProfile> PROFILE = (r, i) -> new SimProfile(r.getObject("id", UUID.class),
        r.getObject("order_id", UUID.class), r.getObject("issuance_id", UUID.class), r.getString("supplier_order_no"),
        r.getString("iccid"), r.getString("activation_code"), r.getString("install_status"), r.getTimestamp("issued_at").toInstant(),
        instant(r,"qr_viewed_at"),instant(r,"installed_at"),instant(r,"activated_at"),instant(r,"expires_at"),
        r.getString("supplier_state"),r.getLong("supplier_revision"),instant(r,"last_synced_at"),r.getString("sync_error"));
    private static java.time.Instant instant(java.sql.ResultSet row,String column) throws java.sql.SQLException {
        var value=row.getTimestamp(column); return value==null?null:value.toInstant();
    }
    private final JdbcTemplate jdbc;
    public IssuanceRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    void enqueue(PaymentAttempt payment) {
        var config = payment.issuance();
        jdbc.update("""
            INSERT INTO issuance_jobs(id,order_id,scenario,callback_copies,callback_delay_ms)
            VALUES(?,?,?,?,?) ON CONFLICT(order_id) WHERE is_current DO NOTHING
            """, UUID.randomUUID(), payment.orderId(), config.scenario().name(), config.callbackCopies(), config.callbackDelayMs());
    }

    void recoverPaidOrders() {
        // 이전 버전 서버와 배포가 겹쳐 생긴 미등록 작업도 중복 없이 복구한다.
        jdbc.update("""
            INSERT INTO issuance_jobs(id,order_id,scenario,callback_copies,callback_delay_ms)
            SELECT gen_random_uuid(),p.order_id,p.supplier_scenario,p.supplier_callback_copies,p.supplier_callback_delay_ms
            FROM payment_attempts p JOIN orders o ON o.id=p.order_id
            WHERE p.status='APPROVED' AND o.status='PAID'
                AND NOT EXISTS (SELECT 1 FROM issuance_jobs j WHERE j.order_id=o.id)
            ORDER BY p.created_at LIMIT 100 ON CONFLICT(order_id) WHERE is_current DO NOTHING
            """);
    }

    Optional<Issuance> find(UUID orderId) {
        return jdbc.query("SELECT * FROM issuance_jobs WHERE order_id=? AND is_current", MAPPER, orderId).stream().findFirst();
    }
    Issuance lock(UUID id) {
        return jdbc.query("SELECT * FROM issuance_jobs WHERE id=? FOR UPDATE", MAPPER, id).stream().findFirst()
            .orElseThrow(() -> new OrderService.OrderException(404, "ISSUANCE_NOT_FOUND", "발급 요청을 찾을 수 없습니다."));
    }
    Optional<Claim> claim(int leaseMs) {
        return jdbc.query("""
            WITH due AS (
                SELECT id FROM issuance_jobs WHERE
                    (status IN ('QUEUED','WAITING_CALLBACK') AND next_check_at<=clock_timestamp())
                    OR (status='PROCESSING' AND lease_until<=clock_timestamp())
                ORDER BY next_check_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
            ) UPDATE issuance_jobs SET status='PROCESSING',lease_token=?,
                lease_until=clock_timestamp()+(? * INTERVAL '1 millisecond'),check_count=check_count+1,
                updated_at=clock_timestamp() WHERE id IN (SELECT id FROM due) RETURNING *
            """, (r, i) -> new Claim(MAPPER.mapRow(r, i), r.getObject("lease_token", UUID.class)),
            UUID.randomUUID(), leaseMs).stream().findFirst();
    }
    boolean owns(UUID id, UUID token) {
        return Boolean.TRUE.equals(jdbc.queryForObject(
            "SELECT status='PROCESSING' AND lease_token=? FROM issuance_jobs WHERE id=?", Boolean.class, token, id));
    }
    void save(UUID id, String status, String supplierNo, int revision, String error, int pollMs) {
        jdbc.update("""
            UPDATE issuance_jobs SET status=?,supplier_order_no=COALESCE(?,supplier_order_no),revision=?,last_error=?,
                lease_token=NULL,lease_until=NULL,next_check_at=clock_timestamp()+(? * INTERVAL '1 millisecond'),
                updated_at=clock_timestamp() WHERE id=?
            """, status, supplierNo, revision, error, pollMs, id);
    }
    boolean event(SupplierResult result, String hash, String source) {
        if (jdbc.update("""
            INSERT INTO issuance_events(event_id,issuance_id,payload_hash,source,status) VALUES(?,?,?,?,?)
            ON CONFLICT(event_id) DO NOTHING
            """, result.eventId(), result.requestId(), hash, source, result.status()) == 1) return true;
        String old = jdbc.queryForObject("SELECT payload_hash FROM issuance_events WHERE event_id=?", String.class, result.eventId());
        if (!hash.equals(old)) throw new OrderService.OrderException(409, "SUPPLIER_EVENT_CONFLICT", "같은 콜백의 내용이 다릅니다.");
        return false;
    }
    void insertProfile(SupplierResult result) {
        jdbc.update("""
            INSERT INTO sim_profiles(id,order_id,issuance_id,supplier_order_no,iccid,activation_code)
            VALUES(?,?,?,?,?,?)
            """, UUID.randomUUID(), result.orderId(), result.requestId(), result.supplierOrderNo(), result.iccid(), result.activationCode());
    }
    Optional<SimProfile> profile(UUID orderId) {
        return jdbc.query("SELECT * FROM sim_profiles WHERE order_id=?", PROFILE, orderId).stream().findFirst();
    }
    List<SimProfile> profiles(UUID memberId) {
        return jdbc.query("""
            SELECT p.* FROM sim_profiles p JOIN orders o ON o.id=p.order_id WHERE o.member_id=?
            ORDER BY p.issued_at DESC,p.id DESC LIMIT 100
            """, PROFILE, memberId);
    }
    Optional<SimProfile> profileForMember(UUID memberId, UUID profileId) {
        return jdbc.query("""
            SELECT p.* FROM sim_profiles p JOIN orders o ON o.id=p.order_id WHERE o.member_id=? AND p.id=?
            """, PROFILE, memberId, profileId).stream().findFirst();
    }
    record Claim(Issuance issuance, UUID token) {}
}
