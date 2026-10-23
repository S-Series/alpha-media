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
public class MockPaymentStorageService {
    private final JdbcTemplate jdbc;
    private final PaymentSettings settings;
    private final OrderRepository orders;
    private final OrderConflicts conflicts;
    private static final String SELECT="SELECT a.*,m.username AS actor FROM mock_payment_storage_actions a JOIN members m ON m.id=a.actor_id";
    private static final RowMapper<Action> MAPPER=(r,i)->new Action(r.getObject("id",UUID.class),
        Kind.valueOf(r.getString("action")),r.getString("actor"),r.getString("reason"),r.getTimestamp("created_at").toInstant());

    public MockPaymentStorageService(JdbcTemplate jdbc,PaymentSettings settings,OrderRepository orders,OrderConflicts conflicts) {
        this.jdbc=jdbc; this.settings=settings; this.orders=orders; this.conflicts=conflicts;
    }
    List<Action> list(UUID orderId) {
        return jdbc.query(SELECT+" WHERE a.order_id=? ORDER BY a.created_at,a.id",MAPPER,orderId);
    }
    List<PgPayment> payments(UUID orderId) {
        return jdbc.query("""
            SELECT payment_id,status,approval_executions FROM mock_pg_payments WHERE order_id=?
                AND EXISTS(SELECT 1 FROM mock_payment_storage_actions WHERE order_id=? AND action='ARM')
            ORDER BY created_at,payment_id
            """,(r,i)->new PgPayment(r.getObject("payment_id",UUID.class),r.getString("status"),r.getInt("approval_executions")),orderId,orderId);
    }

    @Transactional
    public Receipt change(UUID actor,UUID orderId,UUID key,Kind kind,String reason) {
        // Release remains available if mock processing was disabled while a fault was armed.
        if (kind==Kind.ARM && !settings.mockEnabled())
            throw new OrderException(503,"MOCK_PG_DISABLED","모의 PG 환경에서만 DB 반영 장애를 설정할 수 있습니다.");
        if (orders.findForAdmin(orderId).isEmpty()) throw new OrderException(404,"ORDER_NOT_FOUND","주문을 찾을 수 없습니다.");
        var order=orders.lock(orderId);
        var byKey=jdbc.query(SELECT+" WHERE a.order_id=? AND a.idempotency_key=?",MAPPER,orderId,key);
        if (!byKey.isEmpty()) {
            var old=byKey.getFirst();
            if (old.action()!=kind || !old.reason().equals(reason.trim()))
                throw new OrderException(409,"IDEMPOTENCY_CONFLICT","같은 요청 키의 조치·사유가 다릅니다.");
            return new Receipt(old,true);
        }
        var existing=list(orderId);
        var same=existing.stream().filter(a->a.action()==kind).findFirst();
        if (same.isPresent()) return new Receipt(same.get(),true);
        if (kind==Kind.ARM) {
            conflicts.requireClear(orderId);
            boolean attempted=Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM payment_attempts WHERE order_id=?)",Boolean.class,orderId));
            if (!"PENDING_PAYMENT".equals(order.status()) || !order.expiresAt().isAfter(Instant.now()) || attempted)
                throw new OrderException(409,"MOCK_STORAGE_NOT_ARMABLE","결제 시도가 없는 유효한 결제 대기 주문에서만 설정할 수 있습니다.");
        } else if (existing.isEmpty()) {
            throw new OrderException(409,"MOCK_STORAGE_NOT_ARMED","설정된 DB 반영 장애가 없습니다.");
        }
        UUID id=UUID.randomUUID();
        jdbc.update("INSERT INTO mock_payment_storage_actions(id,order_id,action,actor_id,idempotency_key,reason) VALUES(?,?,?,?,?,?)",
            id,orderId,kind.name(),actor,key,reason.trim());
        return new Receipt(jdbc.query(SELECT+" WHERE a.id=?",MAPPER,id).getFirst(),false);
    }
    public enum Kind { ARM, RELEASE }
    public record PgPayment(UUID paymentId,String status,int approvalExecutions) {}
    public record Action(UUID id,Kind action,String actor,String reason,Instant createdAt) {}
    public record Receipt(Action action,boolean replayed) {}
}
