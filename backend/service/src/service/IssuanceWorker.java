package service;

import java.io.IOException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "issuance.mock-enabled", havingValue = "true")
public class IssuanceWorker {
    private static final Logger LOG = LoggerFactory.getLogger(IssuanceWorker.class);
    private final IssuanceRepository jobs;
    private final IssuanceService transitions;
    private final IssuanceSettings settings;
    private final SupplierClient supplier;
    public IssuanceWorker(IssuanceRepository jobs, IssuanceService transitions, IssuanceSettings settings, SupplierClient supplier) {
        this.jobs = jobs; this.transitions = transitions; this.settings = settings; this.supplier = supplier;
    }
    @Scheduled(fixedDelayString = "${issuance.worker-delay-ms}", initialDelayString = "${issuance.worker-delay-ms}")
    public void tick() {
        jobs.recoverPaidOrders();
        var claimed = jobs.claim(settings.leaseMs());
        if (claimed.isEmpty()) return;
        var claim = claimed.get();
        try {
            // 접수 응답을 잃었어도 같은 요청번호를 조회한다. 새 공급사 주문을 만들지 않는다.
            var result = claim.issuance().checkCount() > 1 ? supplier.lookup(claim.issuance()).orElse(null) : null;
            if (result == null) result = supplier.submit(claim.issuance());
            if (!claim.issuance().id().equals(result.requestId()) || !claim.issuance().orderId().equals(result.orderId())) {
                throw new SupplierClient.InvalidResult();
            }
            if ("ACCEPTED".equals(result.status()) && claim.issuance().checkCount() >= 6) {
                transitions.uncertain(claim, true, "SUPPLIER_PENDING_TOO_LONG"); return;
            }
            transitions.result(result, claim.token(), result.revision() == 1 ? "ACCEPTANCE" : "LOOKUP");
        } catch (IOException exception) {
            transitions.uncertain(claim, false, "SUPPLIER_RESULT_UNKNOWN");
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt(); transitions.uncertain(claim, false, "SUPPLIER_INTERRUPTED");
        } catch (SupplierClient.InvalidResult | OrderService.OrderException | org.springframework.dao.DataIntegrityViolationException exception) {
            transitions.uncertain(claim, true, "SUPPLIER_RESULT_REQUIRES_REVIEW");
        } catch (RuntimeException exception) {
            LOG.warn("Issuance {} will recover after lease expiry ({})", claim.issuance().id(), exception.getClass().getSimpleName());
        }
    }
}
