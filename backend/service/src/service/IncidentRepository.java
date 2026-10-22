package service;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

@Repository
public class IncidentRepository {
    private final JdbcTemplate jdbc;
    public IncidentRepository(JdbcTemplate jdbc) { this.jdbc=jdbc; }
    private static final String SELECT="SELECT i.*,m.username FROM incidents i LEFT JOIN members m ON m.id=i.actor_id";
    private static final RowMapper<Incident> MAPPER=(r,n)->new Incident(r.getObject("id",UUID.class),r.getObject("order_id",UUID.class),
        r.getString("kind"),r.getObject("target_id",UUID.class),r.getString("code"),r.getString("status"),r.getLong("version"),
        r.getString("username"),r.getString("reason"),r.getString("external_reference"),r.getString("evidence_hash"),
        r.getTimestamp("first_seen_at").toInstant(),r.getTimestamp("last_seen_at").toInstant(),instant(r.getTimestamp("resolved_at")));
    void open(UUID order,String kind,UUID target,String code,String reference,String hash) {
        jdbc.update("""
            INSERT INTO incidents(id,order_id,kind,target_id,code,external_reference,evidence_hash,reason)
            VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(kind,target_id,code) DO UPDATE SET
                order_id=COALESCE(incidents.order_id,EXCLUDED.order_id),last_seen_at=clock_timestamp(),
                status=CASE WHEN incidents.status='RESOLVED' THEN 'OPEN' ELSE incidents.status END,
                actor_id=CASE WHEN incidents.status='RESOLVED' THEN NULL ELSE incidents.actor_id END,
                reason=CASE WHEN incidents.status='RESOLVED' THEN EXCLUDED.reason ELSE incidents.reason END,
                version=incidents.version+CASE WHEN incidents.status='RESOLVED' OR incidents.evidence_hash IS DISTINCT FROM EXCLUDED.evidence_hash THEN 1 ELSE 0 END,
                external_reference=EXCLUDED.external_reference,evidence_hash=EXCLUDED.evidence_hash,resolved_at=NULL
            """,UUID.randomUUID(),order,kind,target,code,reference,hash,code);
    }
    void resolve(String kind,UUID target,String hash) {
        jdbc.update("""
            UPDATE incidents SET status='RESOLVED',version=version+1,actor_id=NULL,reason='EXTERNAL_AND_INTERNAL_STATE_VERIFIED',
                evidence_hash=?,resolved_at=clock_timestamp(),last_seen_at=clock_timestamp()
            WHERE kind=? AND target_id=? AND status<>'RESOLVED'
            """,hash,kind,target);
    }
    Incident get(UUID id) {
        return jdbc.query(SELECT+" WHERE i.id=?",MAPPER,id).stream().findFirst().orElseThrow(
            ()->new OrderService.OrderException(404,"INCIDENT_NOT_FOUND","운영 사건을 찾을 수 없습니다."));
    }
    List<Incident> list(String status,int page,int size) {
        return jdbc.query(SELECT+" WHERE (?::varchar IS NULL OR i.status=?) ORDER BY i.last_seen_at DESC,i.id DESC LIMIT ? OFFSET ?",
            MAPPER,status,status,size+1,(long)page*size);
    }
    List<Event> events(UUID id) {
        return jdbc.query("SELECT * FROM incident_events WHERE incident_id=? ORDER BY id DESC LIMIT 100",
            (r,n)->new Event(r.getString("id"),r.getString("status"),r.getString("actor"),r.getString("reason"),
                r.getString("evidence_hash"),r.getTimestamp("recorded_at").toInstant()),id);
    }
    @Transactional
    public Receipt investigate(UUID id,UUID actor,UUID key,long version,String reason) {
        jdbc.queryForList("SELECT id FROM incidents WHERE id=? FOR UPDATE",id);
        var current=get(id); String hash=RecoveryTargets.hash(version+":"+reason);
        var old=jdbc.queryForList("SELECT payload_hash FROM incident_actions WHERE incident_id=? AND idempotency_key=?",id,key);
        if (!old.isEmpty()) {
            if (!hash.equals(old.getFirst().get("payload_hash"))) throw error("INCIDENT_KEY_CONFLICT","같은 키의 조사 내용이 다릅니다.");
            return new Receipt(current,true);
        }
        if (current.version()!=version) throw error("STALE_INCIDENT","사건 상태가 변경되었습니다. 새로 조회해 주세요.");
        if ("RESOLVED".equals(current.status())) throw error("INCIDENT_ALREADY_RESOLVED","이미 정합성을 확인한 사건입니다.");
        jdbc.update("INSERT INTO incident_actions(id,incident_id,actor_id,idempotency_key,payload_hash,reason,expected_version) VALUES(?,?,?,?,?,?,?)",
            UUID.randomUUID(),id,actor,key,hash,reason,version);
        jdbc.update("UPDATE incidents SET status='INVESTIGATING',actor_id=?,reason=?,version=version+1 WHERE id=?",actor,reason,id);
        return new Receipt(get(id),false);
    }
    private static OrderService.OrderException error(String code,String message) { return new OrderService.OrderException(409,code,message); }
    private static Instant instant(Timestamp value) { return value==null?null:value.toInstant(); }
    public record Incident(UUID id,UUID orderId,String kind,UUID targetId,String code,String status,long version,String actor,String reason,
        String externalReference,String evidenceHash,Instant firstSeenAt,Instant lastSeenAt,Instant resolvedAt) {}
    public record Event(String id,String status,String actor,String reason,String evidenceHash,Instant recordedAt) {}
    public record Receipt(Incident incident,boolean replayed) {}
}
