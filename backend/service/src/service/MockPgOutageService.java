package service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import service.OrderService.OrderException;

@Service
public class MockPgOutageService {
    private final JdbcTemplate jdbc;
    private final PaymentSettings settings;
    private final OrderRepository orders;
    private final RefundRepository refunds;
    private final OrderConflicts conflicts;
    private static final String SELECT = "SELECT r.*,m.username AS actor FROM mock_pg_outage_releases r JOIN members m ON m.id=r.actor_id";
    private static final RowMapper<Release> MAPPER = (r,i) -> new Release(r.getObject("id",UUID.class),
        r.getObject("refund_id",UUID.class),r.getObject("payment_id",UUID.class),r.getString("actor"),
        r.getString("reason"),r.getTimestamp("created_at").toInstant());

    public MockPgOutageService(JdbcTemplate jdbc,PaymentSettings settings,OrderRepository orders,
            RefundRepository refunds,OrderConflicts conflicts) {
        this.jdbc=jdbc; this.settings=settings; this.orders=orders; this.refunds=refunds; this.conflicts=conflicts;
    }
    boolean enabled() { return settings.mockEnabled(); }
    List<Release> list(UUID orderId) {
        return jdbc.query(SELECT+" WHERE r.order_id=? ORDER BY r.created_at,r.id",MAPPER,orderId);
    }

    @Transactional
    public Receipt release(UUID actor,UUID orderId,UUID refundId,UUID key,String reason) {
        if (!enabled()) throw new OrderException(503,"MOCK_PG_DISABLED","모의 PG가 활성화된 환경에서만 장애를 해제할 수 있습니다.");
        if (orders.findForAdmin(orderId).isEmpty()) throw new OrderException(404,"ORDER_NOT_FOUND","주문을 찾을 수 없습니다.");
        orders.lock(orderId);
        var byKey=jdbc.query(SELECT+" WHERE r.order_id=? AND r.idempotency_key=?",MAPPER,orderId,key);
        if (!byKey.isEmpty()) {
            var old=byKey.getFirst();
            if (!old.refundId().equals(refundId) || !old.reason().equals(reason.trim()))
                throw new OrderException(409,"IDEMPOTENCY_CONFLICT","같은 장애 해제 요청 키의 대상·사유가 다릅니다.");
            return new Receipt(old,true);
        }
        var refund=refunds.findById(refundId).filter(r->r.orderId().equals(orderId))
            .orElseThrow(()->new OrderException(404,"REFUND_NOT_FOUND","이 주문의 환불을 찾을 수 없습니다."));
        refund=refunds.lock(refundId);
        var released=jdbc.query(SELECT+" WHERE r.refund_id=?",MAPPER,refundId);
        if (!released.isEmpty()) return new Receipt(released.getFirst(),true);
        conflicts.requireClear(orderId);
        if (refund.scenario()!=Refund.Scenario.UNAVAILABLE || !"REVIEW_REQUIRED".equals(refund.status()))
            throw new OrderException(409,"MOCK_OUTAGE_NOT_RELEASABLE","PG 장애 시연으로 확인 필요 상태가 된 환불만 해제할 수 있습니다.");
        boolean mockPayment=Boolean.TRUE.equals(jdbc.queryForObject(
            "SELECT EXISTS(SELECT 1 FROM mock_pg_payments WHERE payment_id=? AND order_id=? AND status='APPROVED')",
            Boolean.class,refund.paymentId(),orderId));
        if (!mockPayment) throw new OrderException(409,"MOCK_PAYMENT_REQUIRED","이 주문의 모의 PG 승인 기록이 필요합니다.");
        UUID id=UUID.randomUUID();
        jdbc.update("INSERT INTO mock_pg_outage_releases(id,order_id,refund_id,payment_id,actor_id,idempotency_key,reason) VALUES(?,?,?,?,?,?,?)",
            id,orderId,refundId,refund.paymentId(),actor,key,reason.trim());
        return new Receipt(jdbc.query(SELECT+" WHERE r.id=?",MAPPER,id).getFirst(),false);
    }
    public record Release(UUID id,UUID refundId,UUID paymentId,String actor,String reason,Instant createdAt) {}
    public record Receipt(Release release,boolean replayed) {}
}
