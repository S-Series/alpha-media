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

    public PaymentWorker(PaymentRepository payments, PaymentTransitions transitions, PaymentSettings settings, PgClient pg) {
        this.payments = payments; this.transitions = transitions; this.settings = settings; this.pg = pg;
    }

    @Scheduled(fixedDelayString = "${payment.worker-delay-ms}", initialDelayString = "${payment.worker-delay-ms}")
    public void tick() {
        var next = payments.claim(settings.leaseMs());
        if (next.isEmpty()) return;
        var claim = next.get();
        try {
            PgResult result = null;
            // 타임아웃·재시작 후에는 기존 결제의 조회부터 한다. 새 결제번호를 만들지 않는다.
            if (claim.payment().attemptCount() > 1) result = pg.lookup(claim.payment()).orElse(null);
            if (result == null) {
                if (claim.payment().attemptCount() > 6) {
                    transitions.uncertain(claim, true, "RETRY_LIMIT_REACHED"); return;
                }
                result = pg.approve(claim.payment());
            }
            if (result == null || !result.matches(claim.payment())) throw new PgClient.InvalidResult();
            transitions.result(result, claim.token(), "RESPONSE");
        } catch (IOException exception) {
            transitions.uncertain(claim, false, "PG_RESPONSE_UNKNOWN");
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            transitions.uncertain(claim, false, "PG_INTERRUPTED");
        } catch (PgClient.InvalidResult | OrderService.OrderException
                | org.springframework.dao.DataIntegrityViolationException exception) {
            transitions.uncertain(claim, true, "PG_RESULT_REQUIRES_REVIEW");
        } catch (RuntimeException exception) {
            // DB 장애 시 lease가 만료된 뒤 재선점한다. 로그에 외부 본문·키를 남기지 않는다.
            LOG.warn("Payment {} will be recovered after its lease expires ({})", claim.payment().id(), exception.getClass().getSimpleName());
        }
    }
}
