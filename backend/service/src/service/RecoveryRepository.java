package service;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import com.fasterxml.jackson.annotation.JsonIgnore;

@Repository
public class RecoveryRepository {
    private final JdbcTemplate jdbc;
    public RecoveryRepository(JdbcTemplate jdbc) { this.jdbc=jdbc; }
    private static final String SELECT="SELECT a.*,m.username FROM recovery_actions a JOIN members m ON m.id=a.actor_id";
    private static final RowMapper<Action> MAPPER=(r,i)->new Action(r.getObject("id",UUID.class),r.getObject("order_id",UUID.class),
        r.getString("username"),r.getObject("actor_id",UUID.class),r.getString("kind"),RecoveryTargets.Kind.valueOf(r.getString("target")),
        r.getObject("target_id",UUID.class),r.getString("reason"),r.getString("expected_version"),r.getObject("evidence_id",UUID.class),
        r.getString("status"),r.getString("outcome"),r.getInt("attempt_count"),r.getInt("from_round"),r.getObject("to_round",Integer.class),
        r.getString("external_status"),r.getString("external_reference"),r.getString("evidence_hash"),r.getString("result_version"),
        r.getTimestamp("created_at").toInstant(),instant(r.getTimestamp("checked_at")),r.getString("last_error"),
        r.getString("payload_hash"),r.getObject("lease_token",UUID.class),r.getString("work_version"));
    Optional<Action> find(UUID orderId,UUID key) {
        return jdbc.query(SELECT+" WHERE a.order_id=? AND a.idempotency_key=?",MAPPER,orderId,key).stream().findFirst();
    }
    Optional<Action> findById(UUID id) { return jdbc.query(SELECT+" WHERE a.id=?",MAPPER,id).stream().findFirst(); }
    Action lock(UUID id) { return jdbc.query(SELECT+" WHERE a.id=? FOR UPDATE OF a",MAPPER,id).getFirst(); }
    boolean active(RecoveryTargets.Kind target,UUID id) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM recovery_actions WHERE target=? AND target_id=? AND status IN ('QUEUED','PROCESSING','RETRY'))",
            Boolean.class,target.name(),id));
    }
    Action insert(UUID order,UUID actor,UUID key,String hash,String kind,RecoveryTargets.Snapshot before,String reason,UUID evidence,String version) {
        var target=before.view(); UUID id=UUID.randomUUID(); boolean resume="RESUME".equals(kind);
        jdbc.update("""
            INSERT INTO recovery_actions(id,order_id,actor_id,idempotency_key,payload_hash,kind,target,target_id,
                expected_version,work_version,reason,before_snapshot,evidence_id,from_round,to_round,status,outcome,result_version,checked_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?,?,?,?,?,CASE WHEN ? THEN clock_timestamp() ELSE NULL END)
            """,id,order,actor,key,hash,kind,target.kind().name(),target.id(),target.version(),version,reason,before.json(),evidence,
            target.executionRound(),resume?target.executionRound()+1:null,resume?"SUCCEEDED":"QUEUED",resume?"RESUMED":null,resume?version:null,resume);
        return findById(id).orElseThrow();
    }
    Optional<Claim> claim(long leaseMs) {
        return jdbc.query("""
            WITH due AS (
                SELECT id,attempt_count>=3 AS exhausted FROM recovery_actions WHERE
                    (status IN ('QUEUED','RETRY') AND next_attempt_at<=clock_timestamp())
                    OR (status='PROCESSING' AND lease_until<=clock_timestamp())
                ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
            ), claimed AS (UPDATE recovery_actions a SET status='PROCESSING',attempt_count=attempt_count+CASE WHEN due.exhausted THEN 0 ELSE 1 END,
                lease_token=?,lease_until=clock_timestamp()+(? * INTERVAL '1 millisecond')
            FROM due WHERE a.id=due.id RETURNING a.*,due.exhausted)
            SELECT c.*,m.username FROM claimed c JOIN members m ON m.id=c.actor_id
            """,(r,i)->new Claim(MAPPER.mapRow(r,i),r.getBoolean("exhausted")),UUID.randomUUID(),leaseMs).stream().findFirst();
    }
    boolean owns(Action current,Action claim) { return "PROCESSING".equals(current.status()) && claim.leaseToken().equals(current.leaseToken()); }
    void finish(Action claim,String status,String outcome,String error,String externalStatus,String reference,String hash,String version) {
        jdbc.update("""
            UPDATE recovery_actions SET status=?,outcome=?,last_error=?,external_status=?,external_reference=?,evidence_hash=?,
                result_version=?,checked_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
            WHERE id=? AND status='PROCESSING' AND lease_token=?
            """,status,outcome,error,externalStatus,reference,hash,version,claim.id(),claim.leaseToken());
    }
    void failed(Action claim,String error,boolean permanent,long delay) {
        jdbc.update("""
            UPDATE recovery_actions SET status=CASE WHEN ? OR attempt_count>=3 THEN 'REVIEW_REQUIRED' ELSE 'RETRY' END,
                last_error=?,lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+(? * INTERVAL '1 millisecond')
            WHERE id=? AND status='PROCESSING' AND lease_token=?
            """,permanent,error,delay,claim.id(),claim.leaseToken());
    }
    List<Action> list(UUID order) { return jdbc.query(SELECT+" WHERE a.order_id=? ORDER BY a.created_at DESC,a.id DESC LIMIT 100",MAPPER,order); }
    private static Instant instant(Timestamp value) { return value==null?null:value.toInstant(); }
    record Claim(Action action,boolean exhausted) {}
    public record Action(UUID id,UUID orderId,String actor,@JsonIgnore UUID actorId,String kind,RecoveryTargets.Kind target,UUID targetId,
        String reason,String expectedVersion,UUID evidenceId,String status,String outcome,int attemptCount,int fromRound,Integer toRound,
        String externalStatus,String externalReference,String evidenceHash,String resultVersion,Instant createdAt,Instant checkedAt,String lastError,
        @JsonIgnore String payloadHash,@JsonIgnore UUID leaseToken,@JsonIgnore String workVersion) {}
}
