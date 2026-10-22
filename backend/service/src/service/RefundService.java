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
    public RefundService(OrderRepository orders,RefundRepository refunds,AdminActionRepository actions,JdbcTemplate jdbc,PaymentSettings settings,OrderConflicts conflicts) {
        this.orders=orders; this.refunds=refunds; this.actions=actions; this.jdbc=jdbc; this.settings=settings; this.conflicts=conflicts;
    }
    @Transactional(noRollbackFor=OrderConflicts.ConflictException.class)
    public void complete(RefundRepository.Claim claim,MockPgService.Cancellation result) {
        orders.historyContext(null,"PG_CANCEL_RESULT",null);
        Order order=orders.lock(claim.refund().orderId());
        Refund current=refunds.lock(claim.refund().id());
        if (!refunds.owns(current.id(),claim.token())) return;
        if (result==null || result.id()==null || !current.paymentId().equals(result.paymentId())
                || !current.id().equals(result.idempotencyKey()) || current.amount()!=result.amount()
                || current.amount()!=result.cancelledTotal() || !"REFUND_PROCESSING".equals(order.status())) {
            throw conflicts.reject(order.id(),"REFUND",current.id(),"PG_CANCEL_MISMATCH","PG_CANCEL_RESULT",
                current.status(),"SUCCEEDED",String.valueOf(result));
        }
        conflicts.requireClear(order.id());
        conflicts.lockExternal("PG_CANCELLATION:"+result.id());
        if (Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM refunds WHERE pg_cancellation_id=? AND id<>?)",
                Boolean.class,result.id(),current.id()))) {
            throw conflicts.reject(order.id(),"REFUND",current.id(),"PG_CANCEL_REFERENCE_CONFLICT","PG_CANCEL_RESULT",
                current.status(),"SUCCEEDED",String.valueOf(result));
        }
        refunds.save(current.id(),"SUCCEEDED",result.id(),null,0);
        jdbc.update("UPDATE orders SET status='REFUNDED',updated_at=clock_timestamp() WHERE id=?",order.id());
        actions.refundEvent(current.id(),"SUCCEEDED","REFUND_PROCESSING_TO_REFUNDED");
    }
    @Transactional
    public boolean mayCancel(RefundRepository.Claim claim) {
        orders.lock(claim.refund().orderId());
        refunds.lock(claim.refund().id());
        if (!refunds.owns(claim.refund().id(),claim.token())) return false;
        if (conflicts.blocked(claim.refund().orderId())) {
            uncertain(claim,true,"ORDER_RESULT_CONFLICT"); return false;
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
    }
}
