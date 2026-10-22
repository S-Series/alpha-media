package service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import service.OrderService.OrderException;

@Repository
public class RecoveryTargets {
    public enum Kind { PAYMENT, ISSUANCE, REFUND, INBOUND, PROTECTION }
    private final JdbcTemplate jdbc;
    private final OrderRepository orders;
    public RecoveryTargets(JdbcTemplate jdbc,OrderRepository orders) { this.jdbc=jdbc; this.orders=orders; }

    Snapshot read(UUID orderId,Kind kind,UUID id,boolean lock) {
        String table=table(kind);
        if (lock) {
            // Inbox processing takes the receipt lock before its order lock too.
            if (kind==Kind.INBOUND) lockRow(table,orderId,id);
            try { orders.lock(orderId); }
            catch (java.util.NoSuchElementException e) { throw new OrderException(404,"ORDER_NOT_FOUND","주문을 찾을 수 없습니다."); }
            if (kind!=Kind.INBOUND) lockRow(table,orderId,id);
        }
        String attempts=kind==Kind.ISSUANCE?"check_count":"attempt_count";
        String roundAttempts=kind==Kind.ISSUANCE?"consecutive_failures":"round_attempt_count";
        // Delivery counts are not a business revision. Never put encrypted payloads in audit snapshots.
        String snapshot="jsonb_build_object('orderStatus',o.status,'orderUpdatedAt',o.updated_at,'conflicts',"
            +"(SELECT count(*) FROM order_conflicts c WHERE c.order_id=o.id),'target',"
            +"to_jsonb(t)-ARRAY['body','receive_count','received_at','last_received_at'])::text";
        var found=jdbc.query("SELECT t.status,t.execution_round,t."+attempts+" AS attempts,t."+roundAttempts
            +" AS round_attempts,t.last_error,"+snapshot+" AS snapshot FROM "+table+" t JOIN orders o ON o.id=t.order_id WHERE t.id=? AND t.order_id=?",
            (r,i)-> { String json=r.getString("snapshot"); return new Snapshot(new View(kind,id,r.getString("status"),hash(json),
                r.getInt("execution_round"),r.getInt("attempts"),r.getInt("round_attempts"),r.getString("last_error")),json); },id,orderId);
        if (found.isEmpty()) throw new OrderException(404,"RECOVERY_TARGET_NOT_FOUND","이 주문에 연결된 처리 대상을 찾을 수 없습니다.");
        return found.getFirst();
    }
    private void lockRow(String table,UUID order,UUID id) {
        if (jdbc.queryForList("SELECT id FROM "+table+" WHERE id=? AND order_id=? FOR UPDATE",id,order).isEmpty())
            throw new OrderException(404,"RECOVERY_TARGET_NOT_FOUND","이 주문에 연결된 처리 대상을 찾을 수 없습니다.");
    }
    List<View> list(UUID orderId) {
        var result=new ArrayList<View>();
        for (Kind kind:Kind.values()) {
            String current=kind==Kind.ISSUANCE?" AND is_current":"";
            String blocked=kind==Kind.INBOUND?"":" OR EXISTS(SELECT 1 FROM order_conflicts WHERE order_id=?)";
            Object[] args=kind==Kind.INBOUND?new Object[]{orderId}:new Object[]{orderId,orderId};
            var ids=jdbc.queryForList("SELECT id FROM "+table(kind)+" WHERE order_id=?"+current
                +" AND (status='REVIEW_REQUIRED'"+blocked+") ORDER BY id LIMIT 100",UUID.class,args);
            for (UUID id:ids) result.add(read(orderId,kind,id,false).view());
        }
        return result;
    }
    static String table(Kind kind) {
        return switch(kind) { case PAYMENT -> "payment_attempts"; case ISSUANCE -> "issuance_jobs";
            case PROTECTION -> "refund_protection_jobs"; case REFUND -> "refunds"; case INBOUND -> "inbound_events"; };
    }
    static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    record Snapshot(View view,String json) {}
    public record View(Kind kind,UUID id,String status,String version,int executionRound,int attemptCount,int roundAttemptCount,String lastError) {}
}
