package service;

import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.util.Assert;

@Service
public class WebhookSecurity {
    private final Map<String,List<Key>> keys=new LinkedHashMap<>();
    private final JdbcTemplate jdbc;
    private final RequestRateLimits security;
    public WebhookSecurity(Environment env,JdbcTemplate jdbc,RequestRateLimits security) {
        this.jdbc=jdbc; this.security=security;
        if (env.getProperty("payment.mock-enabled",Boolean.class,false)) configure(env,"PG","PG_WEBHOOK","payment.webhook-secret");
        if (env.getProperty("issuance.mock-enabled",Boolean.class,false)) configure(env,"SUPPLIER","SUPPLIER_WEBHOOK","issuance.webhook-secret");
    }
    private void configure(Environment env,String source,String prefix,String secretProperty) {
        String id=env.getProperty(prefix+"_KEY_ID",source.toLowerCase(Locale.ROOT)+"-v1");
        String secret=env.getProperty(secretProperty,"");
        var list=new ArrayList<Key>(); list.add(key(source,id,secret,null));
        String oldId=env.getProperty(prefix+"_PREVIOUS_KEY_ID","");
        String oldSecret=env.getProperty(prefix+"_PREVIOUS_SECRET","");
        String until=env.getProperty(prefix+"_PREVIOUS_VALID_UNTIL","");
        if (!oldId.isEmpty() || !oldSecret.isEmpty() || !until.isEmpty()) {
            Assert.isTrue(!oldId.equals(id) && !until.isEmpty(),"Previous webhook key requires a different ID and expiry");
            list.add(key(source,oldId,oldSecret,Instant.parse(until)));
        }
        keys.put(source,List.copyOf(list));
    }
    private Key key(String source,String id,String secret,Instant until) {
        Assert.isTrue(id.matches("[A-Za-z0-9_-]{1,64}") && secret.length()>=32,"Webhook key ID or secret is invalid");
        String fingerprint=RecoveryTargets.hash(secret);
        UUID history=UUID.nameUUIDFromBytes((source+":"+id+":"+fingerprint+":"+until).getBytes(StandardCharsets.UTF_8));
        return new Key(source,id,secret,until,history,fingerprint);
    }
    // Sign each delivery now; a delayed event keeps its original business timestamp.
    String[] headers(String source,byte[] body) {
        Key key=keys.get(source).getFirst(); String time=Long.toString(Instant.now().getEpochSecond());
        return new String[]{"X-Key-Id",key.id(),"X-Signature-Timestamp",time,"X-Signature",PgSignature.sign(body,key.secret(),source,key.id(),time)};
    }
    Verified verify(String source,byte[] body,HttpServletRequest request) {
        String id=single(request,"X-Key-Id"), timestamp=single(request,"X-Signature-Timestamp"), signature=single(request,"X-Signature");
        Key key=keys.getOrDefault(source,List.of()).stream().filter(k->k.id().equals(id)).findFirst().orElse(null);
        Instant now=Instant.now(), signed;
        if (key==null) throw reject(source,"UNKNOWN_KEY");
        if (key.until()!=null && !now.isBefore(key.until())) throw reject(source,"EXPIRED_KEY");
        try {
            if (timestamp==null || !timestamp.matches("[0-9]{1,12}")) throw new IllegalArgumentException();
            signed=Instant.ofEpochSecond(Long.parseLong(timestamp));
        } catch (RuntimeException invalid) { throw reject(source,"INVALID_TIMESTAMP"); }
        if (signed.isBefore(now.minusSeconds(300)) || signed.isAfter(now.plusSeconds(5))) throw reject(source,"STALE_SIGNATURE");
        if (!PgSignature.verify(body,signature,key.secret(),source,id,timestamp)) throw reject(source,"INVALID_SIGNATURE");
        return new Verified(key,signed);
    }
    private String single(HttpServletRequest request,String name) {
        var headers=Collections.list(request.getHeaders(name)); return headers.size()==1?headers.getFirst():null;
    }
    private OrderService.OrderException reject(String source,String reason) {
        try { security.record(source,reason); }
        catch (org.springframework.dao.DataAccessException failure) {
            org.slf4j.LoggerFactory.getLogger(WebhookSecurity.class).warn("Webhook rejection count could not be stored");
        }
        return new OrderService.OrderException(401,"INVALID_SIGNATURE","웹훅 서명 또는 검증 허용 기간이 올바르지 않습니다.");
    }
    @org.springframework.context.event.EventListener(org.springframework.boot.context.event.ApplicationReadyEvent.class)
    public void recordConfiguration() {
        keys.values().forEach(list->list.forEach(this::recordKey));
    }
    private void recordKey(Key key) {
        jdbc.update("""
            INSERT INTO webhook_key_history(id,source,key_id,fingerprint,valid_until) VALUES(?,?,?,?,?)
            ON CONFLICT(id) DO NOTHING
            """,key.history(),key.source(),key.id(),key.fingerprint(),key.until()==null?null:Timestamp.from(key.until()));
    }
    // Called within the inbox transaction, never acknowledge evidence that was not committed.
    void record(UUID inbound,Verified verified) {
        Key key=verified.key();
        recordKey(key);
        jdbc.update("""
            INSERT INTO inbound_verifications(inbound_id,key_history_id,signed_at) VALUES(?,?,?)
            ON CONFLICT(inbound_id,key_history_id) DO NOTHING
            """,inbound,key.history(),Timestamp.from(verified.signedAt()));
    }
    public List<Map<String,Object>> configuration() {
        return keys.values().stream().flatMap(List::stream).map(key->{
            Map<String,Object> row=new LinkedHashMap<>(); row.put("source",key.source()); row.put("keyId",key.id());
            row.put("validUntil",key.until()); row.put("expired",key.until()!=null && !Instant.now().isBefore(key.until())); return row;
        }).toList();
    }
    public List<Map<String,Object>> history() {
        return jdbc.queryForList("SELECT source,key_id,valid_until,recorded_at FROM webhook_key_history ORDER BY recorded_at DESC LIMIT 50");
    }
    record Key(String source,String id,String secret,Instant until,UUID history,String fingerprint) {
        @Override public String toString() { return source+":"+id; }
    }
    record Verified(Key key,Instant signedAt) {}
}
