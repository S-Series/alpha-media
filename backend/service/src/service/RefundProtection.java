package service;

import java.util.UUID;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

@Repository
public class RefundProtection {
    static final int LIMIT=6;
    enum Scenario { SUCCESS, RESPONSE_LOST, UNAVAILABLE }
    public record Job(UUID id,UUID orderId,UUID refundId,String iccid,String phase,Scenario scenario,Scenario cleanupScenario,
        String status,int attemptCount,int roundAttemptCount,int executionRound,String lastError,@com.fasterxml.jackson.annotation.JsonIgnore UUID leaseToken) {}
    public record Result(UUID operationId,UUID refundId,UUID orderId,String iccid,String phase,String state,ProfileSignal profile) {}
    public record Request(UUID refundId,UUID orderId,String phase,Scenario scenario) {}
    static final RowMapper<Job> ROW=(r,i)->new Job(r.getObject("id",UUID.class),r.getObject("order_id",UUID.class),r.getObject("refund_id",UUID.class),
        r.getString("iccid"),r.getString("phase"),Scenario.valueOf(r.getString("scenario")),Scenario.valueOf(r.getString("cleanup_scenario")),
        r.getString("status"),r.getInt("attempt_count"),r.getInt("round_attempt_count"),r.getInt("execution_round"),r.getString("last_error"),r.getObject("lease_token",UUID.class));
    private final JdbcTemplate jdbc;
    public RefundProtection(JdbcTemplate jdbc) { this.jdbc=jdbc; }
    Job get(UUID id) { return jdbc.query("SELECT * FROM refund_protection_jobs WHERE id=?",ROW,id).getFirst(); }
    public List<Job> list(UUID order) { return jdbc.query("SELECT * FROM refund_protection_jobs WHERE order_id=? ORDER BY created_at,id",ROW,order); }
    void hold(Refund refund,String iccid,Scenario scenario,Scenario cleanup) { enqueue(refund,iccid,"HOLD",scenario,cleanup); }
    void cleanup(Refund refund,boolean succeeded) {
        jdbc.query("SELECT * FROM refund_protection_jobs WHERE refund_id=? AND phase='HOLD' AND status='SUCCEEDED'",ROW,refund.id())
            .forEach(j->enqueue(refund,j.iccid(),succeeded?"TERMINATE":"RELEASE",j.cleanupScenario(),j.cleanupScenario()));
    }
    private void enqueue(Refund refund,String iccid,String phase,Scenario scenario,Scenario cleanup) {
        jdbc.update("""
            INSERT INTO refund_protection_jobs(id,order_id,refund_id,iccid,phase,scenario,cleanup_scenario) VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(refund_id,phase) DO NOTHING
            """,UUID.randomUUID(),refund.orderId(),refund.id(),iccid,phase,scenario.name(),cleanup.name());
    }
    boolean ready(UUID refund) {
        return !Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM refund_protection_jobs WHERE refund_id=? AND phase='HOLD' AND status<>'SUCCEEDED')",Boolean.class,refund));
    }
    boolean owns(Job job) { return Boolean.TRUE.equals(jdbc.queryForObject("SELECT status='PROCESSING' AND lease_token=? FROM refund_protection_jobs WHERE id=?",Boolean.class,job.leaseToken(),job.id())); }
    record Claim(Job job,boolean exhausted) {}
    Optional<Claim> claim(int lease) {
        return jdbc.query("""
            WITH due AS (SELECT id,round_attempt_count>=6 AS exhausted FROM refund_protection_jobs
                WHERE (status IN ('QUEUED','UNKNOWN') AND next_attempt_at<=clock_timestamp()) OR (status='PROCESSING' AND lease_until<=clock_timestamp())
                ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
            UPDATE refund_protection_jobs j SET status='PROCESSING',lease_token=?,lease_until=clock_timestamp()+(? * INTERVAL '1 millisecond'),
                attempt_count=attempt_count+CASE WHEN round_attempt_count<? THEN 1 ELSE 0 END,
                round_attempt_count=round_attempt_count+CASE WHEN round_attempt_count<? THEN 1 ELSE 0 END,updated_at=clock_timestamp()
            FROM due WHERE j.id=due.id RETURNING j.*,due.exhausted
            """,(r,i)->new Claim(ROW.mapRow(r,i),r.getBoolean("exhausted")),UUID.randomUUID(),lease,LIMIT,LIMIT).stream().findFirst();
    }
    void finish(Job job,String status,String error,long delay) {
        jdbc.update("""
            UPDATE refund_protection_jobs SET status=?,last_error=?,lease_token=NULL,lease_until=NULL,
                next_attempt_at=clock_timestamp()+(? * INTERVAL '1 millisecond'),updated_at=clock_timestamp() WHERE id=?
            """,status,error,delay,job.id());
    }
}
