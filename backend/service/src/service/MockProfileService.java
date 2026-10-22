package service;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.HexFormat;
import java.util.UUID;
import java.security.MessageDigest;
import jakarta.validation.constraints.*;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.ObjectMapper;

@Service
@ConditionalOnProperty(name="issuance.mock-enabled",havingValue="true")
public class MockProfileService {
    static final RowMapper<ProfileSignal> SIGNAL=(r,i)->new ProfileSignal(r.getObject("event_id",UUID.class),
        r.getObject("request_id",UUID.class),r.getObject("order_id",UUID.class),r.getString("iccid"),r.getString("state"),
        r.getLong("revision"),r.getTimestamp("observed_at").toInstant(),instant(r,"installed_at"),instant(r,"activated_at"));
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    public MockProfileService(JdbcTemplate jdbc,ObjectMapper mapper) { this.jdbc=jdbc; this.mapper=mapper; }
    void ensureIssued() {
        jdbc.update("""
            INSERT INTO mock_supplier_profiles(iccid,request_id,order_id,event_id)
            SELECT iccid,request_id,order_id,gen_random_uuid() FROM mock_supplier_orders WHERE status='ISSUED'
            ON CONFLICT(iccid) DO NOTHING
            """);
    }
    ProfileSignal lookup(String iccid) {
        return jdbc.query("SELECT * FROM mock_supplier_profiles WHERE iccid=?",SIGNAL,iccid).stream().findFirst()
            .orElseThrow(()->new OrderService.OrderException(404,"SUPPLIER_PROFILE_NOT_FOUND","공급사 프로필이 없습니다."));
    }
    @Transactional
    public ProfileSignal simulate(String iccid,UUID key,Change change) {
        var old=jdbc.query("SELECT * FROM mock_supplier_profiles WHERE iccid=? FOR UPDATE",SIGNAL,iccid).stream().findFirst()
            .orElseThrow(()->new OrderService.OrderException(404,"SUPPLIER_PROFILE_NOT_FOUND","공급사 프로필이 없습니다."));
        String hash=hash(mapper.writeValueAsBytes(change));
        var prior=jdbc.queryForList("SELECT payload_hash,body FROM mock_profile_notifications WHERE iccid=? AND idempotency_key=?",iccid,key);
        if (!prior.isEmpty()) {
            if (!hash.equals(prior.getFirst().get("payload_hash"))) throw new OrderService.OrderException(409,"PROFILE_SIMULATION_CONFLICT","같은 요청 키의 시연 조건이 다릅니다.");
            return mapper.readValue((String)prior.getFirst().get("body"),ProfileSignal.class);
        }
        String state=change.state().name();
        if (!allowed(old.state(),state)) throw new OrderService.OrderException(409,"PROFILE_STATE_REGRESSION","설치·개통 상태는 되돌릴 수 없습니다. 다른 SIM으로 새 시연을 시작해 주세요.");
        Instant now=Instant.now().truncatedTo(java.time.temporal.ChronoUnit.MICROS), installed=old.installedAt(), activated=old.activatedAt();
        if ("ENABLED".equals(state)) {
            Instant requested=change.activatedAt()==null?null:change.activatedAt().truncatedTo(java.time.temporal.ChronoUnit.MICROS);
            if (requested==null || (activated!=null && !activated.equals(requested)))
                throw new OrderService.OrderException(409,"ACTIVATION_TIME_FIXED","개통 시각은 최초 개통 때 정하고 이후에는 변경할 수 없습니다.");
            activated=requested;
            if (installed==null) installed=activated;
            if (activated.isBefore(installed)) throw new OrderService.OrderException(400,"INVALID_ACTIVATION_TIME","개통 시각은 설치 시각 이후여야 합니다.");
        } else if (change.activatedAt()!=null) {
            throw new OrderService.OrderException(400,"INVALID_ACTIVATION_TIME","개통 상태에서만 UTC 개통 시각을 입력해 주세요.");
        }
        if ("INSTALLED".equals(state) && installed==null) installed=now;
        var signal=new ProfileSignal(UUID.randomUUID(),old.requestId(),old.orderId(),iccid,state,old.revision()+1,now,installed,activated);
        if (!signal.valid()) throw new OrderService.OrderException(400,"INVALID_PROFILE_SIGNAL","공급사 상태 또는 시각이 올바르지 않습니다.");
        jdbc.update("UPDATE mock_supplier_profiles SET state=?,revision=?,event_id=?,observed_at=?,installed_at=?,activated_at=? WHERE iccid=?",
            state,signal.revision(),signal.eventId(),time(now),time(installed),time(activated),iccid);
        jdbc.update("""
            INSERT INTO mock_profile_notifications(event_id,iccid,idempotency_key,payload_hash,body,callback_copies,callback_delay_ms,next_attempt_at)
            VALUES(?,?,?,?,?,?,?,CASE WHEN ?>0 THEN clock_timestamp()+(? * INTERVAL '1 millisecond') END)
            """,signal.eventId(),iccid,key,hash,mapper.writeValueAsString(signal),change.callbackCopies(),change.callbackDelayMs(),
            change.callbackCopies(),change.callbackDelayMs());
        return signal;
    }
    static boolean allowed(String old,String next) {
        return old.equals(next) || switch(old) {
            case "RELEASED" -> true;
            case "INSTALLED" -> "ENABLED".equals(next) || "DELETED".equals(next);
            case "ENABLED" -> "DELETED".equals(next);
            default -> false;
        };
    }
    static Timestamp time(Instant value) { return value==null?null:Timestamp.from(value); }
    private static Instant instant(java.sql.ResultSet row,String column) throws java.sql.SQLException {
        var value=row.getTimestamp(column); return value==null?null:value.toInstant();
    }
    static String hash(byte[] value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value)); }
        catch (java.security.NoSuchAlgorithmException exception) { throw new IllegalStateException(exception); }
    }
    public enum State { RELEASED,INSTALLED,ENABLED,DELETED }
    public record Change(@NotNull State state,@PastOrPresent Instant activatedAt,
        @NotNull @Min(0) @Max(60000) Integer callbackDelayMs,@NotNull @Min(0) @Max(20) Integer callbackCopies) {}
}
