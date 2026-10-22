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
    public RefundService(OrderRepository orders,RefundRepository refunds,AdminActionRepository actions,JdbcTemplate jdbc,PaymentSettings settings) {
        this.orders=orders; this.refunds=refunds; this.actions=actions; this.jdbc=jdbc; this.settings=settings;
    }
    @Transactional
    public void complete(RefundRepository.Claim claim,MockPgService.Cancellation result) {
        orders.historyContext(null,"PG_CANCEL_RESULT",null);
        Order order=orders.lock(claim.refund().orderId());
        Refund current=refunds.lock(claim.refund().id());
        if (!refunds.owns(current.id(),claim.token())) return;
        if (result==null || result.id()==null || !current.paymentId().equals(result.paymentId())
                || !current.id().equals(result.idempotencyKey()) || current.amount()!=result.amount()
                || current.amount()!=result.cancelledTotal() || !"REFUND_PROCESSING".equals(order.status())) {
            throw new OrderException(409,"PG_CANCEL_MISMATCH","PG 환불 식별자·금액이 일치하지 않습니다.");
        }
        refunds.save(current.id(),"SUCCEEDED",result.id(),null,0);
        jdbc.update("UPDATE orders SET status='REFUNDED',updated_at=clock_timestamp() WHERE id=?",order.id());
        actions.refundEvent(current.id(),"SUCCEEDED","REFUND_PROCESSING_TO_REFUNDED");
    }
    @Transactional
    public void uncertain(RefundRepository.Claim claim,boolean forceReview,String error) {
        orders.historyContext(null,"REFUND_WORKER",error);
        orders.lock(claim.refund().orderId());
        Refund current=refunds.lock(claim.refund().id());
        if (!refunds.owns(current.id(),claim.token())) return;
        boolean stop=forceReview || current.attemptCount()>=3;
        String status=stop?"REVIEW_REQUIRED":"UNKNOWN";
        refunds.save(current.id(),status,null,error,settings.retryDelay(current.attemptCount()));
        actions.refundEvent(current.id(),status,error);
    }
}
