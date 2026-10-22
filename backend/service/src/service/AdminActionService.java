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
    private final OrderConflicts conflicts;
    private final RefundBalance balance;
    private final RefundProtection protection;
    public AdminActionService(OrderRepository orders, IssuanceRepository jobs, RefundRepository refunds,
            AdminActionRepository actions, JdbcTemplate jdbc, ObjectMapper mapper, PaymentSettings paymentSettings,
            IssuanceSettings issuanceSettings, OrderConflicts conflicts,RefundBalance balance,RefundProtection protection) {
        this.orders=orders; this.jobs=jobs; this.refunds=refunds; this.actions=actions; this.jdbc=jdbc;
        this.mapper=mapper; this.paymentSettings=paymentSettings; this.issuanceSettings=issuanceSettings; this.conflicts=conflicts; this.balance=balance; this.protection=protection;
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
        conflicts.requireClear(order.id());
        if (!java.util.List.of("PAID","PARTIALLY_REFUNDED","REFUND_PROCESSING").contains(order.status()))
            throw new OrderException(409,"ACTION_NOT_ALLOWED","환불 가능한 결제 상태가 아닙니다.");
        var job=jobs.find(order.id()).orElseThrow(()->new OrderException(409,"ISSUANCE_NOT_FAILED","발급 결과를 먼저 확인해 주세요."));
        job=jobs.lock(job.id());
        var profile=jobs.profile(order.id());
        if (!job.id().equals(request.issuanceId()) || !("FAILED".equals(job.status()) && profile.isEmpty() || "ISSUED".equals(job.status()) && profile.isPresent()))
            throw new OrderException(409,"ISSUANCE_NOT_FAILED","현재 발급 결과가 확정되어야 합니다.");
        if (profile.isPresent()) {
            if (!issuanceSettings.mockEnabled()) throw new OrderException(409,"SUPPLIER_HOLD_UNSUPPORTED","원자적 미사용 차단을 지원하는 공급사만 환불할 수 있습니다.");
            if (profile.get().installedAt()!=null || profile.get().activatedAt()!=null)
                throw new OrderException(409,"SIM_ALREADY_USED","설치 또는 개통된 SIM은 일반 환불할 수 없습니다.");
        }
        if (order.amount() <= 0) throw new OrderException(409,"NO_REFUND_AMOUNT","환불할 결제 금액이 없습니다.");
        var payments = jdbc.queryForList("SELECT id FROM payment_attempts WHERE order_id=? AND status='APPROVED' FOR UPDATE",order.id());
        if (payments.size()!=1) throw new OrderException(409,"PAYMENT_NOT_APPROVED","승인된 결제를 확인해야 합니다.");
        UUID payment=(UUID)payments.getFirst().get("id");
        long available=balance.summary(order.id()).available();
        long amount=request.amount()==null?available:request.amount().longValueExact();
        if (amount<=0 || amount>available)
            throw new OrderException(409,"REFUND_BALANCE_EXCEEDED","확정 환불액과 진행 중 예약액을 제외한 잔액을 초과했습니다.");
        Refund refund = refunds.insert(order,payment,request.scenario(),amount);
        if (profile.isPresent()) {
            refunds.save(refund.id(),"WAITING_GUARD",null,null,0);
            protection.hold(refund,profile.get().iccid(),request.holdScenario()==null?RefundProtection.Scenario.SUCCESS:request.holdScenario(),
                request.cleanupScenario()==null?RefundProtection.Scenario.SUCCESS:request.cleanupScenario());
        }
        jdbc.update("UPDATE orders SET status='REFUND_PROCESSING',updated_at=clock_timestamp() WHERE id=?",order.id());
        var action = actions.insert(order.id(),actor,key,hash,"REFUND",request.reason(),null,refund.id());
        actions.event(action.id(),"REQUESTED",order.status()+"_TO_REFUND_PROCESSING");
        return new Receipt(action,false);
    }

    private Issuance eligible(Order order, UUID expectedIssuanceId) {
        conflicts.requireClear(order.id());
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
