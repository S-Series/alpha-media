package service;

import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.ObjectMapper;
import service.OrderService.OrderException;

@Service
public class AdminActionService {
    private final OrderRepository orders;
    private final IssuanceRepository jobs;
    private final RefundRepository refunds;
    private final AdminActionRepository actions;
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final PaymentSettings paymentSettings;
    private final IssuanceSettings issuanceSettings;
    public AdminActionService(OrderRepository orders, IssuanceRepository jobs, RefundRepository refunds,
            AdminActionRepository actions, JdbcTemplate jdbc, ObjectMapper mapper, PaymentSettings paymentSettings,
            IssuanceSettings issuanceSettings) {
        this.orders=orders; this.jobs=jobs; this.refunds=refunds; this.actions=actions; this.jdbc=jdbc;
        this.mapper=mapper; this.paymentSettings=paymentSettings; this.issuanceSettings=issuanceSettings;
    }

    @Transactional
    public Receipt retry(UUID actor, UUID orderId, UUID key, AdminActionController.Retry request) {
        orders.historyContext(actor,"ADMIN_RETRY",request.reason());
        Order order = lock(orderId);
        String hash = hash("ISSUANCE_RETRY",request);
        var existing = actions.find(orderId,key);
        if (existing.isPresent()) return replay(existing.get(),hash);
        if (!issuanceSettings.mockEnabled()) throw new OrderException(503,"SUPPLIER_DISABLED","모의 공급사가 활성화되지 않았습니다.");
        Issuance previous = eligible(order,request.issuanceId());
        UUID id = UUID.randomUUID();
        jdbc.update("UPDATE issuance_jobs SET is_current=FALSE WHERE id=?",previous.id());
        var simulation = request.simulation();
        jdbc.update("INSERT INTO issuance_jobs(id,order_id,scenario,callback_copies,callback_delay_ms) VALUES(?,?,?,?,?)",
            id,order.id(),simulation.scenario().name(),simulation.callbackCopies(),simulation.callbackDelayMs());
        var action = actions.insert(order.id(),actor,key,hash,"ISSUANCE_RETRY",request.reason(),id,null);
        actions.event(action.id(),"QUEUED","FAILED_TO_QUEUED");
        return new Receipt(action,false);
    }

    @Transactional
    public Receipt refund(UUID actor, UUID orderId, UUID key, AdminActionController.RefundRequest request) {
        orders.historyContext(actor,"ADMIN_REFUND",request.reason());
        Order order = lock(orderId);
        String hash = hash("REFUND",request);
        var existing = actions.find(orderId,key);
        if (existing.isPresent()) return replay(existing.get(),hash);
        if (!paymentSettings.mockEnabled()) throw new OrderException(503,"PG_DISABLED","모의 PG가 활성화되지 않았습니다.");
        eligible(order,request.issuanceId());
        if (order.amount() <= 0) throw new OrderException(409,"NO_REFUND_AMOUNT","환불할 결제 금액이 없습니다.");
        var payments = jdbc.queryForList("SELECT id FROM payment_attempts WHERE order_id=? AND status='APPROVED'",order.id());
        if (payments.size()!=1) throw new OrderException(409,"PAYMENT_NOT_APPROVED","승인된 결제를 확인해야 합니다.");
        Refund refund = refunds.insert(order,(UUID)payments.getFirst().get("id"),request.scenario());
        jdbc.update("UPDATE orders SET status='REFUND_PROCESSING',updated_at=clock_timestamp() WHERE id=?",order.id());
        var action = actions.insert(order.id(),actor,key,hash,"REFUND",request.reason(),null,refund.id());
        actions.event(action.id(),"REQUESTED","PAID_TO_REFUND_PROCESSING");
        return new Receipt(action,false);
    }

    private Issuance eligible(Order order, UUID expectedIssuanceId) {
        if (!"PAID".equals(order.status()) || refunds.find(order.id()).isPresent()) {
            throw new OrderException(409,"ACTION_NOT_ALLOWED","결제 완료 상태이며 환불 접수가 없는 주문만 처리할 수 있습니다.");
        }
        Issuance current = jobs.find(order.id()).orElseThrow(() -> new OrderException(409,"ISSUANCE_NOT_FAILED","발급 실패가 확정되지 않았습니다."));
        current = jobs.lock(current.id());
        if (!current.id().equals(expectedIssuanceId) || !"FAILED".equals(current.status()) || jobs.profile(order.id()).isPresent()) {
            throw new OrderException(409,"ISSUANCE_NOT_FAILED","현재 발급 실패 건만 처리할 수 있습니다. 상태를 새로 확인해 주세요.");
        }
        return current;
    }
    private Order lock(UUID orderId) {
        try { return orders.lock(orderId); }
        catch (java.util.NoSuchElementException exception) { throw new OrderException(404,"ORDER_NOT_FOUND","주문을 찾을 수 없습니다."); }
    }
    private String hash(String type, Object request) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(mapper.writeValueAsBytes(new Object[]{type,request}))); }
        catch (java.security.NoSuchAlgorithmException exception) { throw new IllegalStateException(exception); }
    }
    private Receipt replay(AdminActionRepository.Action action, String hash) {
        if (!hash.equals(action.payloadHash())) throw new OrderException(409,"ACTION_KEY_CONFLICT","같은 요청 키의 조치 내용이 다릅니다.");
        return new Receipt(action,true);
    }
    public record Receipt(AdminActionRepository.Action action, boolean replayed) {}
}
