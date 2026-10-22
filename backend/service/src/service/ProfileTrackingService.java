package service;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.ObjectMapper;
import static service.MockProfileService.time;

@Service
public class ProfileTrackingService {
    private final JdbcTemplate jdbc;
    private final IssuanceRepository profiles;
    private final OrderRepository orders;
    private final ObjectMapper mapper;
    public ProfileTrackingService(JdbcTemplate jdbc,IssuanceRepository profiles,OrderRepository orders,ObjectMapper mapper) {
        this.jdbc=jdbc; this.profiles=profiles; this.orders=orders; this.mapper=mapper;
    }
    SimProfile owned(UUID owner,UUID id) {
        return profiles.profileForMember(owner,id).orElseThrow(()->new OrderService.OrderException(404,"SIM_NOT_FOUND","SIM을 찾을 수 없습니다."));
    }
    View view(UUID owner,UUID id) {
        var profile=owned(owner,id);
        var events=jdbc.query("SELECT * FROM sim_profile_events WHERE profile_id=? ORDER BY received_at DESC,event_id DESC LIMIT 100",
            (r,i)->new Event(r.getObject("event_id",UUID.class),r.getString("source"),r.getString("from_status"),r.getString("to_status"),
                r.getTimestamp("occurred_at").toInstant(),r.getTimestamp("received_at").toInstant()),id);
        return new View(profile,events);
    }
    @Transactional
    public void viewed(UUID owner,UUID id) {
        orders.historyContext(owner,"QR_VIEW",null);
        var profile=owned(owner,id); orders.lock(profile.orderId());
        var current=jdbc.query("SELECT * FROM sim_profiles WHERE id=? FOR UPDATE",IssuanceRepository.PROFILE,id).getFirst();
        if (current.qrViewedAt()!=null) return;
        String next="ISSUED".equals(current.installStatus())?"QR_VIEWED":current.installStatus();
        jdbc.update("UPDATE sim_profiles SET qr_viewed_at=clock_timestamp(),install_status=? WHERE id=?",next,id);
        event(UUID.randomUUID(),id,null,null,"QR_VIEW",current.installStatus(),next,Instant.now());
    }
    @Transactional
    public void apply(ProfileSignal signal,String source,UUID lease) {
        orders.historyContext(null,"PROFILE_"+source,null);
        if (signal==null || !signal.valid()) throw new OrderService.OrderException(400,"INVALID_PROFILE_SIGNAL","프로필 신호 형식이 올바르지 않습니다.");
        try { orders.lock(signal.orderId()); }
        catch (java.util.NoSuchElementException e) { throw new OrderService.OrderException(404,"ORDER_NOT_FOUND","프로필 신호의 주문이 없습니다."); }
        var found=jdbc.queryForList("SELECT * FROM sim_profiles WHERE issuance_id=? FOR UPDATE",signal.requestId());
        if (found.isEmpty()) throw new OrderService.OrderException(404,"SIM_NOT_FOUND","발급된 SIM을 확인할 수 없습니다.");
        var row=found.getFirst(); UUID id=(UUID)row.get("id");
        if (!signal.orderId().equals(row.get("order_id")) || !signal.iccid().equals(row.get("iccid")))
            throw new OrderService.OrderException(409,"PROFILE_MISMATCH","공급사 프로필 식별자가 일치하지 않습니다.");
        if (lease!=null && !lease.equals(row.get("sync_lease_token"))) return;
        String hash=MockProfileService.hash(mapper.writeValueAsBytes(signal));
        var oldEvent=jdbc.queryForList("SELECT payload_hash,profile_id FROM sim_profile_events WHERE event_id=?",signal.eventId());
        if (!oldEvent.isEmpty() && (!hash.equals(oldEvent.getFirst().get("payload_hash")) || !id.equals(oldEvent.getFirst().get("profile_id"))))
            throw new OrderService.OrderException(409,"PROFILE_EVENT_CONFLICT","같은 이벤트의 내용이 다릅니다.");
        long revision=((Number)row.get("supplier_revision")).longValue();
        String previous=(String)row.get("install_status");
        if (signal.revision()<revision) {
            if (oldEvent.isEmpty()) event(signal.eventId(),id,hash,signal.revision(),source,previous,previous,signal.observedAt());
            return;
        }
        if (signal.revision()==revision && !hash.equals(row.get("supplier_payload_hash")))
            throw new OrderService.OrderException(409,"PROFILE_REVISION_CONFLICT","같은 버전의 공급사 상태가 다릅니다.");
        String oldState=(String)row.get("supplier_state");
        if (oldState!=null && !MockProfileService.allowed(oldState,signal.state()))
            throw new OrderService.OrderException(409,"PROFILE_STATE_REGRESSION","공급사 설치 상태를 되돌릴 수 없습니다.");
        var activated=(java.sql.Timestamp)row.get("activated_at");
        var installed=(java.sql.Timestamp)row.get("installed_at");
        if ((activated!=null && !activated.toInstant().equals(signal.activatedAt()))
                || (installed!=null && !installed.toInstant().equals(signal.installedAt())))
            throw new OrderService.OrderException(409,"PROFILE_TIME_CONFLICT","이미 확인된 설치·개통 시각이 다릅니다.");
        int days=jdbc.queryForObject("SELECT days FROM orders WHERE id=?",Integer.class,signal.orderId());
        Instant expires=signal.activatedAt()==null?null:signal.activatedAt().plus(Duration.ofDays(days));
        String next=switch(signal.state()) {
            case "INSTALLED" -> "INSTALLED";
            case "ENABLED" -> expires.isAfter(Instant.now())?"ACTIVE":"EXPIRED";
            case "DELETED" -> "DELETED";
            default -> row.get("qr_viewed_at")==null?"ISSUED":"QR_VIEWED";
        };
        if (oldEvent.isEmpty()) event(signal.eventId(),id,hash,signal.revision(),source,previous,next,signal.observedAt());
        long interval="EXPIRED".equals(next)?3600000:"ACTIVE".equals(next)?60000:5000;
        jdbc.update("""
            UPDATE sim_profiles SET install_status=?,supplier_state=?,supplier_revision=?,supplier_payload_hash=?,
                installed_at=?,activated_at=?,expires_at=?,last_synced_at=clock_timestamp(),sync_error=NULL,
                next_sync_at=clock_timestamp()+(? * INTERVAL '1 millisecond'),sync_lease_token=NULL,sync_lease_until=NULL WHERE id=?
            """,next,signal.state(),signal.revision(),hash,time(signal.installedAt()),time(signal.activatedAt()),time(expires),interval,id);
    }
    @Transactional
    public void expire() {
        var due=jdbc.query("SELECT * FROM sim_profiles WHERE install_status='ACTIVE' AND expires_at<=clock_timestamp() LIMIT 50 FOR UPDATE SKIP LOCKED",
            IssuanceRepository.PROFILE);
        for (var profile:due) {
            jdbc.update("UPDATE sim_profiles SET install_status='EXPIRED',next_sync_at=clock_timestamp()+INTERVAL '1 hour' WHERE id=?",profile.id());
            event(UUID.randomUUID(),profile.id(),null,null,"EXPIRY","ACTIVE","EXPIRED",profile.expiresAt());
        }
    }
    private void event(UUID event,UUID id,String hash,Long revision,String source,String from,String to,Instant at) {
        jdbc.update("""
            INSERT INTO sim_profile_events(event_id,profile_id,payload_hash,revision,source,from_status,to_status,occurred_at)
            VALUES(?,?,?,?,?,?,?,?)
            """,event,id,hash,revision,source,from,to,time(at));
    }
    public record Event(UUID id,String source,String fromStatus,String toStatus,Instant occurredAt,Instant receivedAt) {}
    public record View(SimProfile profile,List<Event> events) {}
}
