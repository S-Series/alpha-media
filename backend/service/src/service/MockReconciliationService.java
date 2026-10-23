package service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.annotation.Isolation;
import service.OrderService.OrderException;

@Service
public class MockReconciliationService {
    private final JdbcTemplate jdbc;
    private final OrderRepository orders;
    private final OrderConflicts conflicts;
    private final IssuanceRepository jobs;
    private final PaymentRepository payments;
    private final ObjectProvider<MockPgService> pg;
    private static final String SELECT="SELECT d.*,m.username AS actor FROM mock_reconciliation_demos d JOIN members m ON m.id=d.actor_id";
    private static final RowMapper<Demo> MAPPER=(r,i)->new Demo(r.getObject("id",UUID.class),r.getObject("payment_id",UUID.class),
        Kind.valueOf(r.getString("kind")),r.getString("actor"),r.getString("reason"),r.getObject("event_id",UUID.class),
        r.getObject("cancellation_id",UUID.class),r.getLong("amount"),r.getInt("copies"),r.getInt("delay_ms"),r.getString("status"),
        r.getInt("sent_count"),r.getInt("attempt_count"),r.getString("last_error"),r.getTimestamp("created_at").toInstant());
    public MockReconciliationService(JdbcTemplate jdbc,OrderRepository orders,OrderConflicts conflicts,
            IssuanceRepository jobs,PaymentRepository payments,ObjectProvider<MockPgService> pg) {
        this.jdbc=jdbc; this.orders=orders; this.conflicts=conflicts; this.jobs=jobs; this.payments=payments; this.pg=pg;
    }
    private void exists(UUID order) {
        if (orders.findForAdmin(order).isEmpty()) throw new OrderException(404,"ORDER_NOT_FOUND","주문을 찾을 수 없습니다.");
    }
    @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    public View view(UUID order) {
        exists(order);
        var demos=jdbc.query(SELECT+" WHERE d.order_id=? ORDER BY d.created_at,d.id",MAPPER,order);
        var ledger=jdbc.query("SELECT payment_id,status,amount,cancelled_amount FROM mock_pg_payments WHERE order_id=? ORDER BY created_at,payment_id",
            (r,i)->new Ledger(r.getObject("payment_id",UUID.class),r.getString("status"),r.getLong("amount"),r.getLong("cancelled_amount")),order);
        var incidents=jdbc.query("SELECT id,code,status FROM incidents WHERE order_id=? ORDER BY first_seen_at DESC,id LIMIT 50",
            (r,i)->new Incident(r.getObject("id",UUID.class),r.getString("code"),r.getString("status")),order);
        return new View(demos,ledger,incidents,Instant.now());
    }
    @Transactional
    public Receipt create(UUID actor,UUID orderId,UUID key,MockReconciliationController.Request request) {
        var mock=pg.getIfAvailable();
        if (mock==null) throw new OrderException(503,"MOCK_PG_DISABLED","모의 PG 환경에서만 실행할 수 있습니다.");
        exists(orderId); var order=orders.lock(orderId);
        var old=jdbc.query(SELECT+" WHERE d.order_id=? AND d.idempotency_key=?",MAPPER,orderId,key);
        if (!old.isEmpty()) {
            var demo=old.getFirst();
            if (demo.kind()!=request.kind() || !demo.reason().equals(request.reason().trim())
                    || demo.copies()!=request.copies() || demo.delayMs()!=request.delayMs())
                throw new OrderException(409,"IDEMPOTENCY_CONFLICT","같은 요청 키의 시연 조건·사유가 다릅니다.");
            return new Receipt(demo,true);
        }
        var same=jdbc.query(SELECT+" WHERE d.order_id=? AND d.kind=?",MAPPER,orderId,request.kind().name());
        if (!same.isEmpty()) return new Receipt(same.getFirst(),true);
        if (Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM mock_reconciliation_demos WHERE order_id=?)",Boolean.class,orderId)))
            throw new OrderException(409,"DEMO_ALREADY_CREATED","이 주문에는 이미 다른 시연이 있습니다. 새 발급 실패 주문을 생성하세요.");
        conflicts.requireClear(orderId);
        if (!"PAID".equals(order.status()) || jobs.find(orderId).filter(j->"FAILED".equals(j.status())).isEmpty()
                || jobs.profile(orderId).isPresent() || Boolean.TRUE.equals(jdbc.queryForObject(
                    "SELECT EXISTS(SELECT 1 FROM refunds WHERE order_id=?)",Boolean.class,orderId)))
            throw new OrderException(409,"DEMO_ORDER_NOT_ELIGIBLE","환불 이력이 없는 결제 완료·발급 실패 주문에서 실행하세요.");
        if (request.kind()==Kind.EXTERNAL_CANCELLATION && (request.copies()!=1 || request.delayMs()!=0))
            throw new OrderException(400,"INVALID_DEMO_OPTIONS","외부 취소는 전송 1회·지연 0으로 지정하세요.");
        var payment=payments.list(orderId).stream().filter(p->"APPROVED".equals(p.status())).findFirst().orElseThrow(
            ()->new OrderException(409,"MOCK_APPROVAL_REQUIRED","승인 기록이 필요합니다."));
        var external=mock.lookup(payment.id());
        if (!external.matches(payment) || !"APPROVED".equals(external.status()) || mock.stats(payment.id()).cancelledAmount()!=0)
            throw new OrderException(409,"MOCK_APPROVAL_REQUIRED","취소 이력이 없는 동일 모의 PG 승인이 필요합니다.");
        UUID id=UUID.randomUUID(),event=UUID.randomUUID(),cancellation=null;
        boolean cancel=request.kind()==Kind.EXTERNAL_CANCELLATION;
        // Mutate only the mock provider's ledger. Normal reconciliation discovers this cancellation later.
        if (cancel) cancellation=mock.cancel(payment.id(),id,payment.amount(),Refund.Scenario.SUCCESS).result().id();
        jdbc.update("""
            INSERT INTO mock_reconciliation_demos(id,order_id,payment_id,kind,actor_id,idempotency_key,reason,event_id,
                cancellation_id,amount,copies,delay_ms,status,next_attempt_at,delivered_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ? THEN NULL ELSE clock_timestamp()+(? * INTERVAL '1 millisecond') END,
                CASE WHEN ? THEN clock_timestamp() ELSE NULL END)
            """,id,orderId,payment.id(),request.kind().name(),actor,key,request.reason().trim(),event,cancellation,payment.amount(),
            request.copies(),request.delayMs(),cancel?"DELIVERED":"PENDING",cancel,request.delayMs(),cancel);
        return new Receipt(jdbc.query(SELECT+" WHERE d.id=?",MAPPER,id).getFirst(),false);
    }
    public enum Kind { CONFLICTING_DECLINE, EXTERNAL_CANCELLATION }
    public record Demo(UUID id,UUID paymentId,Kind kind,String actor,String reason,UUID eventId,UUID cancellationId,long amount,
        int copies,int delayMs,String status,int sentCount,int attemptCount,String lastError,Instant createdAt) {}
    public record Ledger(UUID paymentId,String status,long amount,long cancelledAmount) {}
    public record Incident(UUID id,String code,String status) {}
    public record View(List<Demo> demos,List<Ledger> ledger,List<Incident> incidents,Instant checkedAt) {}
    public record Receipt(Demo demo,boolean replayed) {}
}
