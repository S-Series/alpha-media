package service;

import java.io.IOException;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "payment.mock-enabled", havingValue = "true")
public class PaymentWorker {
    private static final Logger LOG = LoggerFactory.getLogger(PaymentWorker.class);
    private final PaymentRepository payments;
    private final PaymentTransitions transitions;
    private final PaymentSettings settings;
    private final PgClient pg;
    private final OrderConflicts conflicts;
    private final MonitoringService monitoring;

    public PaymentWorker(PaymentRepository payments, PaymentTransitions transitions, PaymentSettings settings, PgClient pg,
            OrderConflicts conflicts, MonitoringService monitoring) {
        this.monitoring=monitoring;
        this.payments = payments; this.transitions = transitions; this.settings = settings; this.pg = pg; this.conflicts = conflicts;
    }

    @Scheduled(fixedDelayString = "${payment.worker-delay-ms}", initialDelayString = "${payment.worker-delay-ms}")
    public void tick() {
        monitoring.pulse("PAYMENT");
        var next = payments.claim(settings.leaseMs());
        if (next.isEmpty()) return;
        var claim = next.get();
        // 마지막 실행 뒤 DB 반영에 실패해도 저장된 한도를 넘겨 PG를 호출하지 않는다.
        if (claim.exhausted()) {
            uncertain(claim, true, "RETRY_LIMIT_REACHED");
            return;
        }
        try {
            if (conflicts.blocked(claim.payment().orderId())) {
                uncertain(claim, true, "ORDER_RESULT_CONFLICT");
                return;
            }
            PgResult result = null;
            // 타임아웃·재시작 후에는 기존 결제의 조회부터 한다. 새 결제번호를 만들지 않는다.
            if (claim.payment().attemptCount() > 1) result = pg.lookup(claim.payment()).orElse(null);
            String source=result==null?"RESPONSE":"LOOKUP";
            if (result == null) {
                if (!transitions.mayApprove(claim)) return;
                result = pg.approve(claim.payment());
            }
            if (result == null) throw new PgClient.InvalidResult();
            transitions.resultForClaim(result, claim, source);
        } catch (IOException exception) {
            uncertain(claim, false, "PG_RESPONSE_UNKNOWN");
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            uncertain(claim, false, "PG_INTERRUPTED");
        } catch (PgClient.InvalidResult | OrderService.OrderException
                | org.springframework.dao.DataIntegrityViolationException exception) {
            uncertain(claim, true, "PG_RESULT_REQUIRES_REVIEW");
        } catch (RuntimeException exception) {
            // 결과 반영 트랜잭션이 끝난 뒤 별도 트랜잭션으로 불명 상태를 기록한다.
            uncertain(claim, false, "PAYMENT_RESULT_STORAGE_UNKNOWN");
        }
    }

    private void uncertain(PaymentRepository.Claim claim, boolean review, String error) {
        try {
            transitions.uncertain(claim, review, error);
        } catch (RuntimeException exception) {
            // 이것도 저장되지 않으면 lease 만료 후 다시 한도부터 검사한다.
            LOG.warn("Payment {} will be recovered after its lease expires ({})", claim.payment().id(), exception.getClass().getSimpleName());
        }
    }
}
