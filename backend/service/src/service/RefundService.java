package service;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import service.OrderService.OrderException;

@Service
public class RefundService {
    private final OrderRepository orders;
    private final RefundRepository refunds;
    private final AdminActionRepository actions;
    private final JdbcTemplate jdbc;
    private final PaymentSettings settings;
    private final OrderConflicts conflicts;
    private final RefundBalance balance;
    private final RefundProtection protection;
    private final IncidentRepository incidents;
    public RefundService(OrderRepository orders,RefundRepository refunds,AdminActionRepository actions,JdbcTemplate jdbc,PaymentSettings settings,OrderConflicts conflicts,RefundBalance balance,RefundProtection protection,IncidentRepository incidents) {
        this.orders=orders; this.refunds=refunds; this.actions=actions; this.jdbc=jdbc; this.settings=settings; this.conflicts=conflicts; this.balance=balance; this.protection=protection; this.incidents=incidents;
    }
    @Transactional(noRollbackFor=OrderConflicts.ConflictException.class)
    public void complete(RefundRepository.Claim claim,MockPgService.Cancellation result) {
        orders.historyContext(null,"PG_CANCEL_RESULT",null);
        Order order=orders.lock(claim.refund().orderId());
        Refund current=refunds.lock(claim.refund().id());
        if (!refunds.owns(current.id(),claim.token())) return;
        apply(order,current,result);
    }
    @Transactional(noRollbackFor=OrderConflicts.ConflictException.class)
    public void reconcile(Refund refund,MockPgService.Cancellation result) {
        Order order=orders.lock(refund.orderId());
        Refund current=refunds.lock(refund.id());
        apply(order,current,result);
    }
    private void apply(Order order,Refund current,MockPgService.Cancellation result) {
        if (result==null || result.id()==null || !current.paymentId().equals(result.paymentId())
                || !current.id().equals(result.idempotencyKey()) || current.amount()!=result.amount()
                || result.cancelledTotal()<0 || result.cancelledTotal()>order.amount()
                || !java.util.List.of("SUCCEEDED","DECLINED").contains(java.util.Objects.toString(result.status(),""))
                || ("SUCCEEDED".equals(result.status()) && result.cancelledTotal()<current.amount())
                || (java.util.List.of("SUCCEEDED","FAILED").contains(current.status()) && !("SUCCEEDED".equals(result.status())?"SUCCEEDED":"FAILED").equals(current.status()))
                || !protection.ready(current.id())) {
            throw conflicts.reject(order.id(),"REFUND",current.id(),"PG_CANCEL_MISMATCH","PG_CANCEL_RESULT",
                current.status(),"SUCCEEDED",String.valueOf(result));
        }
        conflicts.requireClear(order.id());
        balance.lock(current.paymentId());
        if ("FAILED".equals(current.status()) || "SUCCEEDED".equals(current.status())) {
            if (!java.util.Objects.equals(current.pgCancellationId(),"SUCCEEDED".equals(result.status())?result.id():null)) throw new PgClient.InvalidResult();
            return;
        }
        if ("DECLINED".equals(result.status())) {
            refunds.save(current.id(),"FAILED",null,"PG_CANCEL_DECLINED",0);
            protection.cleanup(current,false);
            balance.refresh(order.id());
            incidents.resolve("REFUND",current.id(),null);
            actions.refundEvent(current.id(),"FAILED","PG_CANCEL_DECLINED");
            return;
        }
        conflicts.lockExternal("PG_CANCELLATION:"+result.id());
        if (Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM refunds WHERE pg_cancellation_id=? AND id<>?)",
                Boolean.class,result.id(),current.id()))) {
            throw conflicts.reject(order.id(),"REFUND",current.id(),"PG_CANCEL_REFERENCE_CONFLICT","PG_CANCEL_RESULT",
                current.status(),"SUCCEEDED",String.valueOf(result));
        }
        balance.record(result);
        refunds.save(current.id(),"SUCCEEDED",result.id(),null,0);
        protection.cleanup(current,true);
        balance.refresh(order.id());
        incidents.resolve("REFUND",current.id(),null);
        actions.refundEvent(current.id(),"SUCCEEDED","PG_CANCEL_CONFIRMED");
    }
    @Transactional
    public boolean mayCancel(RefundRepository.Claim claim) {
        orders.lock(claim.refund().orderId());
        refunds.lock(claim.refund().id());
        if (!refunds.owns(claim.refund().id(),claim.token())) return false;
        if (conflicts.blocked(claim.refund().orderId())) {
            uncertain(claim,true,"ORDER_RESULT_CONFLICT"); return false;
        }
        balance.lock(claim.refund().paymentId());
        if (!protection.ready(claim.refund().id()) || balance.summary(claim.refund().orderId()).overReserved()) {
            uncertain(claim,true,"REFUND_RESERVATION_CONFLICT"); return false;
        }
        return true;
    }
    @Transactional
    public void uncertain(RefundRepository.Claim claim,boolean forceReview,String error) {
        orders.historyContext(null,"REFUND_WORKER",error);
        orders.lock(claim.refund().orderId());
        Refund current=refunds.lock(claim.refund().id());
        if (!refunds.owns(current.id(),claim.token())) return;
        boolean stop=forceReview || current.roundAttemptCount()>=RefundRepository.MAX_ROUND_ATTEMPTS;
        String status=stop?"REVIEW_REQUIRED":"UNKNOWN";
        refunds.save(current.id(),status,null,error,settings.retryDelay(current.roundAttemptCount()));
        actions.refundEvent(current.id(),status,error);
        if (stop) incidents.open(current.orderId(),"REFUND",current.id(),"REFUND_RESULT_UNKNOWN",null,null);
    }
}
