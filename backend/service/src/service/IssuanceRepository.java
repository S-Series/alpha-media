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
        r.getString("last_error"), r.getTimestamp("created_at").toInstant(), r.getTimestamp("updated_at").toInstant(),
        r.getInt("execution_round"),r.getInt("consecutive_failures"),r.getInt("submission_count"),instant(r,"waiting_since"));
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

    Optional<Issuance> find(UUID orderId) {
        return jdbc.query("SELECT * FROM issuance_jobs WHERE order_id=? AND is_current", MAPPER, orderId).stream().findFirst();
    }
    Optional<Issuance> findById(UUID id) {
        return jdbc.query("SELECT * FROM issuance_jobs WHERE id=?",MAPPER,id).stream().findFirst();
    }
    Issuance lock(UUID id) {
        return jdbc.query("SELECT * FROM issuance_jobs WHERE id=? FOR UPDATE", MAPPER, id).stream().findFirst()
            .orElseThrow(() -> new OrderService.OrderException(404, "ISSUANCE_NOT_FOUND", "발급 요청을 찾을 수 없습니다."));
    }
    Optional<Claim> claim(int leaseMs) {
        return jdbc.query("""
            WITH due AS (
                SELECT id,consecutive_failures>=6 AS failed_limit,
                    COALESCE(waiting_since<=clock_timestamp()-INTERVAL '2 minutes',false) AS waiting_expired
                FROM issuance_jobs WHERE
                    (status IN ('QUEUED','WAITING_CALLBACK') AND next_check_at<=clock_timestamp())
                    OR (status='PROCESSING' AND lease_until<=clock_timestamp())
                ORDER BY next_check_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
            ) UPDATE issuance_jobs j SET status='PROCESSING',lease_token=?,
                lease_until=clock_timestamp()+(? * INTERVAL '1 millisecond'),
                check_count=check_count+CASE WHEN due.failed_limit OR due.waiting_expired THEN 0 ELSE 1 END,
                consecutive_failures=consecutive_failures+CASE WHEN due.failed_limit OR due.waiting_expired THEN 0 ELSE 1 END,
                updated_at=clock_timestamp() FROM due WHERE j.id=due.id
                RETURNING j.*,due.failed_limit,due.waiting_expired
            """, (r, i) -> new Claim(MAPPER.mapRow(r, i), r.getObject("lease_token", UUID.class),
                r.getBoolean("waiting_expired")?"SUPPLIER_PENDING_TOO_LONG":r.getBoolean("failed_limit")?"SUPPLIER_RETRY_LIMIT_REACHED":null),
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
    void confirmed(UUID id, boolean accepted) {
        jdbc.update("""
            UPDATE issuance_jobs SET consecutive_failures=0,
                waiting_since=CASE WHEN ? THEN COALESCE(waiting_since,clock_timestamp()) ELSE waiting_since END
            WHERE id=?
            """,accepted,id);
        if (accepted) jdbc.update("UPDATE issuance_jobs SET next_check_at=LEAST(next_check_at,waiting_since+INTERVAL '2 minutes') WHERE id=?",id);
    }
    boolean reserveSubmission(UUID id) {
        return jdbc.update("UPDATE issuance_jobs SET submission_count=submission_count+1,round_submission_count=round_submission_count+1 WHERE id=? AND round_submission_count<6",id)==1;
    }
    boolean supplierReferenceUsedByAnother(SupplierResult result) {
        return Boolean.TRUE.equals(jdbc.queryForObject("""
            SELECT EXISTS(SELECT 1 FROM issuance_jobs WHERE supplier_order_no=? AND id<>?)
                OR EXISTS(SELECT 1 FROM sim_profiles WHERE iccid=? AND issuance_id<>?)
            """,Boolean.class,result.supplierOrderNo(),result.requestId(),result.iccid(),result.requestId()));
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
                AND NOT EXISTS (SELECT 1 FROM order_conflicts c WHERE c.order_id=o.id)
            ORDER BY p.issued_at DESC,p.id DESC LIMIT 100
            """, PROFILE, memberId);
    }
    Optional<SimProfile> profileForMember(UUID memberId, UUID profileId) {
        return jdbc.query("""
            SELECT p.* FROM sim_profiles p JOIN orders o ON o.id=p.order_id WHERE o.member_id=? AND p.id=?
            """, PROFILE, memberId, profileId).stream().findFirst();
    }
    record Claim(Issuance issuance, UUID token, String stopReason) {}
}
