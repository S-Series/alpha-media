package service;

import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.ObjectMapper;

@Service
public class InboundEventService {
    private final InboundEventRepository events;
    private final InboundPayloadCodec codec;
    private final ObjectMapper mapper;
    private final JdbcTemplate jdbc;
    private final OrderRepository orders;
    private final OrderConflicts conflicts;
    public InboundEventService(InboundEventRepository events, InboundPayloadCodec codec, ObjectMapper mapper,
            JdbcTemplate jdbc, OrderRepository orders, OrderConflicts conflicts) {
        this.events=events; this.codec=codec; this.mapper=mapper; this.jdbc=jdbc; this.orders=orders; this.conflicts=conflicts;
    }

    @Transactional
    public Receipt accept(String source, Object parsed, byte[] body) {
        UUID eventId, targetId;
        switch (parsed) {
            case PgResult result -> { eventId=result.eventId(); targetId=result.paymentId(); }
            case SupplierResult result -> { eventId=result.eventId(); targetId=result.requestId(); }
            case ProfileSignal signal -> { eventId=signal.eventId(); targetId=signal.requestId(); }
            default -> throw new IllegalArgumentException("Unsupported webhook");
        }
        String hash=hash(mapper.writeValueAsBytes(parsed));
        var inserted=events.insert(source,eventId,targetId,owner(source,targetId),codec.encrypt(source,eventId,body),hash);
        if (inserted.isPresent()) return receipt(inserted.get(),false,false);
        // Keep inbox -> order lock ordering, including contradictory duplicate deliveries.
        var existing=events.lockByKey(source,eventId);
        events.duplicate(existing.id());
        if (existing.payloadHash().equals(hash)) return receipt(existing,true,false);
        events.conflict(existing.id(),hash);
        var targets=List.of(existing.targetId(),targetId).stream().distinct()
                .map(id -> new Target(id,owner(source,id))).filter(t -> t.orderId()!=null)
                .sorted(java.util.Comparator.comparing(Target::orderId).thenComparing(Target::id)).toList();
        for (var target:targets) {
            orders.lock(target.orderId());
            conflicts.reject(target.orderId(),switch(source) { case "PG" -> "PAYMENT"; case "PROFILE" -> "PROFILE"; default -> "ISSUANCE"; },
                    target.id(),"INBOUND_EVENT_CONFLICT",source+"_INBOX","RECEIVED","CONFLICT",
                    source+":"+eventId+":"+existing.payloadHash()+":"+hash);
        }
        // Return normally so the receipt and conflict survive the controller's HTTP 409.
        return new Receipt(existing.id(),source,eventId,"REVIEW_REQUIRED",true,true);
    }
    private UUID owner(String source,UUID targetId) {
        String table="PG".equals(source)?"payment_attempts":"issuance_jobs";
        return jdbc.query("SELECT order_id FROM "+table+" WHERE id=?",(r,i)->r.getObject(1,UUID.class),targetId)
                .stream().findFirst().orElse(null);
    }
    private Receipt receipt(InboundEventRepository.Event event,boolean replayed,boolean conflict) {
        return new Receipt(event.id(),event.source(),event.eventId(),event.status(),replayed,conflict);
    }
    private String hash(byte[] value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value)); }
        catch (java.security.NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    private record Target(UUID id,UUID orderId) {}
    public record Receipt(UUID id,String source,UUID eventId,String status,boolean replayed,
            @com.fasterxml.jackson.annotation.JsonIgnore boolean conflict) {}
}
