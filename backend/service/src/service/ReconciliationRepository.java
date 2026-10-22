package service;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import com.fasterxml.jackson.annotation.JsonIgnore;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

@Repository
public class ReconciliationRepository {
    private final JdbcTemplate jdbc;
    public ReconciliationRepository(JdbcTemplate jdbc) { this.jdbc=jdbc; }
    private static final String COUNTS="(SELECT count(*) FROM reconciliation_items i WHERE i.run_id=r.id) item_count,"
        +"(SELECT count(*) FROM reconciliation_items i WHERE i.run_id=r.id AND i.status IN ('SUCCEEDED','REVIEW_REQUIRED','STALE')) processed_count,"
        +"(SELECT count(*) FROM reconciliation_items i WHERE i.run_id=r.id AND (i.status='REVIEW_REQUIRED' OR i.outcome='OPEN_INCIDENT')) issue_count";
    private static final String SELECT="SELECT r.*,false AS exhausted,m.username,"+COUNTS+" FROM reconciliation_runs r LEFT JOIN members m ON m.id=r.actor_id";
    private static final RowMapper<Run> RUN=(r,n)->new Run(r.getObject("id",UUID.class),r.getString("mode"),r.getString("status"),
        r.getString("username"),r.getString("reason"),r.getTimestamp("from_at").toInstant(),r.getTimestamp("to_at").toInstant(),
        r.getString("phase"),r.getInt("page_count"),r.getLong("item_count"),r.getLong("processed_count"),r.getLong("issue_count"),
        r.getInt("attempt_count"),r.getString("last_error"),r.getTimestamp("created_at").toInstant(),instant(r.getTimestamp("completed_at")),
        r.getString("cursor_key"),instant(r.getTimestamp("cursor_time")),r.getObject("cursor_id",UUID.class),r.getObject("lease_token",UUID.class),
        r.getInt("page_attempt_count"),r.getString("payload_hash"),r.getBoolean("exhausted"));
    private static final RowMapper<Item> ITEM=(r,n)->new Item(r.getObject("id",UUID.class),r.getObject("run_id",UUID.class),r.getString("kind"),
        r.getObject("target_id",UUID.class),r.getObject("order_id",UUID.class),r.getString("status"),r.getString("outcome"),r.getInt("attempt_count"),
        r.getString("last_error"),r.getString("external_status"),r.getString("external_reference"),r.getString("evidence_hash"),
        instant(r.getTimestamp("checked_at")),r.getObject("lease_token",UUID.class),r.getBoolean("exhausted"));
    Run get(UUID id) {
        return jdbc.query(SELECT+" WHERE r.id=?",RUN,id).stream().findFirst().orElseThrow(
            ()->new OrderService.OrderException(404,"RECONCILIATION_NOT_FOUND","대사 작업을 찾을 수 없습니다."));
    }
    Run lock(UUID id) { jdbc.queryForList("SELECT id FROM reconciliation_runs WHERE id=? FOR UPDATE",id); return get(id); }
    Optional<Run> byKey(UUID key) { return jdbc.query(SELECT+" WHERE r.idempotency_key=?",RUN,key).stream().findFirst(); }
    List<Run> list() { return jdbc.query(SELECT+" ORDER BY r.created_at DESC,r.id DESC LIMIT 50",RUN); }
    Instant lastSuccessfulAt() { return instant(jdbc.queryForObject("SELECT max(last_successful_at) FROM reconciliation_schedule",Timestamp.class)); }
    boolean active(String mode) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM reconciliation_runs WHERE mode=? AND status IN ('QUEUED','SCANNING','PROCESSING'))",Boolean.class,mode));
    }
    void lockMode(String mode) { jdbc.queryForMap("SELECT pg_advisory_xact_lock(hashtextextended(?,0))","RECONCILIATION:"+mode); }
    void lockKey(UUID key) { jdbc.queryForMap("SELECT pg_advisory_xact_lock(hashtextextended(?,0))","RECONCILIATION_REQUEST:"+key); }
    Run insert(UUID key,String hash,String mode,UUID actor,String reason,Instant from,Instant to) {
        UUID id=UUID.randomUUID();
        jdbc.update("INSERT INTO reconciliation_runs(id,idempotency_key,payload_hash,mode,actor_id,reason,from_at,to_at) VALUES(?,?,?,?,?,?,?,?)",
            id,key,hash,mode,actor,reason,ts(from),ts(to)); return get(id);
    }
    Optional<Run> claimPage(long leaseMs) {
        // Return the claimed snapshot; a second read could accidentally borrow a newer lease token.
        return jdbc.query("""
            WITH due AS (SELECT id,page_attempt_count>=3 AS exhausted FROM reconciliation_runs WHERE status IN ('QUEUED','SCANNING')
                AND next_attempt_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
                ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED),
            claimed AS (UPDATE reconciliation_runs r SET status='SCANNING',
                attempt_count=attempt_count+CASE WHEN page_attempt_count<3 THEN 1 ELSE 0 END,
                page_attempt_count=LEAST(3,page_attempt_count+1),lease_token=?,lease_until=clock_timestamp()+(? * INTERVAL '1 millisecond')
                FROM due WHERE r.id=due.id RETURNING r.*,due.exhausted)
            SELECT r.*,m.username,
            """+COUNTS+" FROM claimed r LEFT JOIN members m ON m.id=r.actor_id",RUN,UUID.randomUUID(),leaseMs).stream().findFirst();
    }
    boolean owns(Run current,Run claim) { return "SCANNING".equals(current.status()) && claim.leaseToken().equals(current.leaseToken()); }
    void add(UUID run,String kind,UUID target,UUID order) {
        jdbc.update("INSERT INTO reconciliation_items(id,run_id,kind,target_id,order_id) VALUES(?,?,?,?,?) ON CONFLICT(run_id,kind,target_id) DO NOTHING",
            UUID.randomUUID(),run,kind,target,order);
    }
    void advance(Run run,String phase,String cursorKey,Instant cursorTime,UUID cursorId) {
        jdbc.update("""
            UPDATE reconciliation_runs SET phase=?,cursor_key=?,cursor_time=?,cursor_id=?,page_count=page_count+1,
                page_attempt_count=0,last_error=NULL,lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp(),
                status=CASE WHEN ?='DONE' THEN 'PROCESSING' ELSE 'SCANNING' END WHERE id=? AND lease_token=?
            """,phase,cursorKey,ts(cursorTime),cursorId,phase,run.id(),run.leaseToken());
    }
    void pageFailed(Run run,String code,boolean permanent,long delay) {
        jdbc.update("""
            UPDATE reconciliation_runs SET status=CASE WHEN ? OR page_attempt_count>=3 THEN 'REVIEW_REQUIRED' ELSE 'SCANNING' END,
                last_error=?,lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+(? * INTERVAL '1 millisecond'),
                completed_at=CASE WHEN ? OR page_attempt_count>=3 THEN clock_timestamp() ELSE NULL END
            WHERE id=? AND lease_token=? AND status='SCANNING'
            """,permanent,code,delay,permanent,run.id(),run.leaseToken());
    }
    Optional<Item> claimItem(long leaseMs) {
        return jdbc.query("""
            WITH due AS (SELECT id,attempt_count>=3 AS exhausted FROM reconciliation_items
                WHERE (status IN ('QUEUED','RETRY') AND next_attempt_at<=clock_timestamp())
                    OR (status='PROCESSING' AND lease_until<=clock_timestamp())
                ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
            UPDATE reconciliation_items i SET status='PROCESSING',attempt_count=attempt_count+CASE WHEN due.exhausted THEN 0 ELSE 1 END,
                lease_token=?,lease_until=clock_timestamp()+(? * INTERVAL '1 millisecond')
                FROM due WHERE i.id=due.id RETURNING i.*,due.exhausted
            """,ITEM,UUID.randomUUID(),leaseMs).stream().findFirst();
    }
    Item lockItem(UUID id) { return jdbc.query("SELECT *,false AS exhausted FROM reconciliation_items WHERE id=? FOR UPDATE",ITEM,id).getFirst(); }
    boolean owns(Item current,Item claim) { return "PROCESSING".equals(current.status()) && claim.leaseToken().equals(current.leaseToken()); }
    void finish(Item item,UUID order,String outcome,String error,String externalStatus,String reference,String hash) {
        jdbc.update("""
            UPDATE reconciliation_items SET order_id=?,status=CASE WHEN ?='STALE_TARGET' THEN 'STALE' ELSE 'SUCCEEDED' END,
                outcome=?,last_error=?,external_status=?,external_reference=?,evidence_hash=?,checked_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
            WHERE id=? AND lease_token=?
            """,order,outcome,outcome,error,externalStatus,reference,hash,item.id(),item.leaseToken());
    }
    @Transactional
    public void itemFailed(Item item,String code,boolean permanent,long delay,IncidentRepository incidents) {
        var current=lockItem(item.id()); if (!owns(current,item)) return;
        boolean stop=permanent || current.attemptCount()>=3;
        jdbc.update("""
            UPDATE reconciliation_items SET status=?,last_error=?,lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+(? * INTERVAL '1 millisecond'),
                checked_at=CASE WHEN ? THEN clock_timestamp() ELSE checked_at END WHERE id=? AND lease_token=?
            """,stop?"REVIEW_REQUIRED":"RETRY",code,delay,stop,item.id(),item.leaseToken());
        if (stop) incidents.open(item.orderId(),item.kind(),item.targetId(),"RECONCILIATION_QUERY_FAILED",null,RecoveryTargets.hash(code));
    }
    @Transactional
    public void finishRuns() {
        var completed=jdbc.queryForList("""
            UPDATE reconciliation_runs r SET status=CASE WHEN EXISTS(SELECT 1 FROM reconciliation_items i WHERE i.run_id=r.id AND i.status IN ('REVIEW_REQUIRED','STALE'))
                THEN 'REVIEW_REQUIRED' ELSE 'SUCCEEDED' END,completed_at=clock_timestamp()
            WHERE r.status='PROCESSING' AND NOT EXISTS(SELECT 1 FROM reconciliation_items i WHERE i.run_id=r.id AND i.status IN ('QUEUED','PROCESSING','RETRY'))
            RETURNING mode,status,completed_at
            """);
        for (var row:completed) if ("SUCCEEDED".equals(row.get("status")))
            jdbc.update("UPDATE reconciliation_schedule SET last_successful_at=? WHERE mode=?",row.get("completed_at"),row.get("mode"));
    }
    List<Item> items(UUID run,int page,int size) { return jdbc.query("SELECT *,false AS exhausted FROM reconciliation_items WHERE run_id=? ORDER BY id LIMIT ? OFFSET ?",ITEM,run,size+1,(long)page*size); }
    static Timestamp ts(Instant value) { return value==null?null:Timestamp.from(value); }
    private static Instant instant(Timestamp value) { return value==null?null:value.toInstant(); }
    public record Run(UUID id,String mode,String status,String actor,String reason,Instant fromAt,Instant toAt,String phase,
        int pageCount,long itemCount,long processedCount,long issueCount,int attemptCount,String lastError,Instant createdAt,Instant completedAt,
        @JsonIgnore String cursorKey,Instant cursorTime,UUID cursorId,@JsonIgnore UUID leaseToken,@JsonIgnore int pageAttemptCount,@JsonIgnore String payloadHash,@JsonIgnore boolean exhausted) {}
    public record Item(UUID id,UUID runId,String kind,UUID targetId,UUID orderId,String status,String outcome,int attemptCount,String lastError,
        String externalStatus,String externalReference,String evidenceHash,Instant checkedAt,@JsonIgnore UUID leaseToken,@JsonIgnore boolean exhausted) {}
}
