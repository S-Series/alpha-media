package service;

import java.io.IOException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name="payment.mock-enabled",havingValue="true")
public class RefundWorker {
    private static final Logger LOG=LoggerFactory.getLogger(RefundWorker.class);
    private final RefundRepository refunds;
    private final RefundService transitions;
    private final PaymentSettings settings;
    private final PgClient pg;
    private final OrderConflicts conflicts;
    public RefundWorker(RefundRepository refunds,RefundService transitions,PaymentSettings settings,PgClient pg,OrderConflicts conflicts) {
        this.refunds=refunds; this.transitions=transitions; this.settings=settings; this.pg=pg; this.conflicts=conflicts;
    }
    @Scheduled(fixedDelayString="${payment.worker-delay-ms}",initialDelayString="${payment.worker-delay-ms}")
    public void tick() {
        var next=refunds.claim(settings.leaseMs());
        if (next.isEmpty()) return;
        var claim=next.get();
        if (claim.exhausted()) {
            uncertain(claim,true,"REFUND_RETRY_LIMIT_REACHED");
            return;
        }
        try {
            if (conflicts.blocked(claim.refund().orderId())) {
                uncertain(claim,true,"ORDER_RESULT_CONFLICT");
                return;
            }
            // 재시작과 응답 유실 뒤에도 같은 환불번호를 조회하고 취소한다.
            var result=pg.lookupCancellation(claim.refund()).orElse(null);
            if (result==null) {
                if (!transitions.mayCancel(claim)) return;
                result=pg.cancel(claim.refund());
            }
            transitions.complete(claim,result);
        } catch (IOException exception) {
            uncertain(claim,false,"PG_CANCEL_RESULT_UNKNOWN");
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt(); uncertain(claim,false,"PG_CANCEL_INTERRUPTED");
        } catch (PgClient.InvalidResult | OrderService.OrderException | org.springframework.dao.DataIntegrityViolationException exception) {
            uncertain(claim,true,"PG_CANCEL_REQUIRES_REVIEW");
        } catch (RuntimeException exception) {
            uncertain(claim,false,"REFUND_RESULT_STORAGE_UNKNOWN");
        }
    }
    private void uncertain(RefundRepository.Claim claim,boolean review,String error) {
        try {
            transitions.uncertain(claim,review,error);
        } catch (RuntimeException exception) {
            LOG.warn("Refund {} will recover after lease expiry ({})",claim.refund().id(),exception.getClass().getSimpleName());
        }
    }
}
