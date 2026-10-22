package service;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

@Repository
public class InboundEventRepository {
    static final int MAX_ATTEMPTS = 6;
    private static final RowMapper<Event> MAPPER = (r,i) -> new Event(r.getObject("id",UUID.class),
        r.getString("source"),r.getObject("event_id",UUID.class),r.getObject("target_id",UUID.class),
        r.getObject("order_id",UUID.class),r.getBytes("body"),r.getString("payload_hash"),
        r.getString("status"),r.getInt("attempt_count"),r.getObject("lease_token",UUID.class));
    private final JdbcTemplate jdbc;

    public InboundEventRepository(JdbcTemplate jdbc) { this.jdbc=jdbc; }

    Optional<Event> insert(String source,UUID eventId,UUID targetId,UUID orderId,byte[] body,String hash) {
        return jdbc.query("""
            INSERT INTO inbound_events(id,source,event_id,target_id,order_id,body,payload_hash)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(source,event_id) DO NOTHING RETURNING *
            """,MAPPER,UUID.randomUUID(),source,eventId,targetId,orderId,body,hash).stream().findFirst();
    }
    Event lock(UUID id) {
        return jdbc.query("SELECT * FROM inbound_events WHERE id=? FOR UPDATE",MAPPER,id).getFirst();
    }
    Event lockByKey(String source,UUID eventId) {
        return jdbc.query("SELECT * FROM inbound_events WHERE source=? AND event_id=? FOR UPDATE",MAPPER,source,eventId).getFirst();
    }
    void duplicate(UUID id) {
        jdbc.update("UPDATE inbound_events SET receive_count=receive_count+1,last_received_at=clock_timestamp() WHERE id=?",id);
    }
    void conflict(UUID id,String hash) {
        jdbc.update("""
            UPDATE inbound_events SET status='REVIEW_REQUIRED',last_error='INBOUND_EVENT_CONFLICT',error_status=409,
                conflicting_payload_hash=COALESCE(conflicting_payload_hash,?),next_attempt_at=NULL,
                lease_token=NULL,lease_until=NULL WHERE id=?
            """,hash,id);
    }

    Optional<Claim> claim(long leaseMs) {
        // Reserve the attempt before processing; a crash consumes the same durable budget.
        return jdbc.query("""
            WITH due AS (
                SELECT id,attempt_count>=? AS exhausted FROM inbound_events
                WHERE (status IN ('PENDING','RETRY') AND next_attempt_at<=clock_timestamp())
                    OR (status='PROCESSING' AND lease_until<=clock_timestamp())
                ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
            ) UPDATE inbound_events e SET status='PROCESSING',lease_token=?,
                lease_until=clock_timestamp()+(? * INTERVAL '1 millisecond'),
                attempt_count=e.attempt_count + CASE WHEN due.exhausted THEN 0 ELSE 1 END
                FROM due WHERE e.id=due.id RETURNING e.*,due.exhausted
            """,(r,i) -> new Claim(MAPPER.mapRow(r,i),r.getObject("lease_token",UUID.class),r.getBoolean("exhausted")),
            MAX_ATTEMPTS,UUID.randomUUID(),leaseMs).stream().findFirst();
    }
    void processed(UUID id,UUID token) {
        jdbc.update("""
            UPDATE inbound_events SET status='PROCESSED',processed_at=clock_timestamp(),last_error=NULL,error_status=NULL,
                next_attempt_at=NULL,lease_token=NULL,lease_until=NULL WHERE id=? AND status='PROCESSING' AND lease_token=?
            """,id,token);
    }
    void review(UUID id,UUID token,String code,int errorStatus) {
        jdbc.update("""
            UPDATE inbound_events SET status='REVIEW_REQUIRED',last_error=?,error_status=?,next_attempt_at=NULL,
                lease_token=NULL,lease_until=NULL WHERE id=? AND status='PROCESSING' AND lease_token=?
            """,code,errorStatus,id,token);
    }
    void failed(Claim claim,boolean permanent,String code,int errorStatus,long delayMs) {
        jdbc.update("""
            UPDATE inbound_events SET status=CASE WHEN ? OR attempt_count>=? THEN 'REVIEW_REQUIRED' ELSE 'RETRY' END,
                last_error=?,error_status=?,next_attempt_at=CASE WHEN ? OR attempt_count>=? THEN NULL
                    ELSE clock_timestamp()+(? * INTERVAL '1 millisecond') END,
                lease_token=NULL,lease_until=NULL WHERE id=? AND status='PROCESSING' AND lease_token=?
            """,permanent,MAX_ATTEMPTS,code,errorStatus,permanent,MAX_ATTEMPTS,delayMs,claim.event().id(),claim.token());
    }
    List<View> forOrder(UUID orderId) {
        return jdbc.query("""
            SELECT id,source,event_id,status,attempt_count,receive_count,received_at,last_received_at,
                processed_at,next_attempt_at,last_error,error_status
            FROM inbound_events WHERE order_id=? ORDER BY received_at DESC,id LIMIT 100
            """,(r,i) -> new View(r.getObject("id",UUID.class),r.getString("source"),r.getObject("event_id",UUID.class),
                r.getString("status"),r.getInt("attempt_count"),r.getInt("receive_count"),r.getTimestamp("received_at").toInstant(),
                r.getTimestamp("last_received_at").toInstant(),instant(r.getTimestamp("processed_at")),
                instant(r.getTimestamp("next_attempt_at")),r.getString("last_error"),r.getObject("error_status",Integer.class)),orderId);
    }
    private static Instant instant(Timestamp value) { return value==null?null:value.toInstant(); }

    record Event(UUID id,String source,UUID eventId,UUID targetId,UUID orderId,byte[] body,String payloadHash,
        String status,int attemptCount,UUID leaseToken) {}
    record Claim(Event event,UUID token,boolean exhausted) {}
    public record View(UUID id,String source,UUID eventId,String status,int attemptCount,int receiveCount,
        Instant receivedAt,Instant lastReceivedAt,Instant processedAt,Instant nextAttemptAt,String lastError,Integer errorStatus) {}
}
