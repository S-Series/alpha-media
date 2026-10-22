package service;

import java.io.IOException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.util.Assert;

@Component
public class ReconciliationWorker {
    private static final Logger LOG=LoggerFactory.getLogger(ReconciliationWorker.class);
    private final ReconciliationRepository runs;
    private final ReconciliationService service;
    private final ReconciliationProcessor processor;
    private final IncidentRepository incidents;
    private final boolean schedule;
    private final long leaseMs,retryMs;
    public ReconciliationWorker(ReconciliationRepository runs,ReconciliationService service,ReconciliationProcessor processor,IncidentRepository incidents,
            @Value("${reconciliation.schedule-enabled:true}") boolean schedule,@Value("${reconciliation.lease-ms:30000}") long leaseMs,
            @Value("${reconciliation.retry-base-ms:1000}") long retryMs) {
        Assert.isTrue(leaseMs>=1000 && retryMs>=100,"Invalid reconciliation retry settings");
        this.runs=runs; this.service=service; this.processor=processor; this.incidents=incidents;
        this.schedule=schedule; this.leaseMs=leaseMs; this.retryMs=retryMs;
    }
    @Scheduled(fixedDelayString="${reconciliation.worker-delay-ms:1000}",initialDelayString="${reconciliation.worker-delay-ms:1000}")
    public void tick() {
        if (!service.available()) return;
        try {
            if (schedule) service.schedule();
            var page=runs.claimPage(leaseMs);
            if (page.isPresent()) {
                var claim=page.get();
                try {
                    if (claim.exhausted()) runs.pageFailed(claim,"RECONCILIATION_QUERY_LIMIT",true,0);
                    else service.savePage(claim,service.fetchPage(claim));
                } catch (Exception e) { runs.pageFailed(claim,code(e),permanent(e),delay(claim.pageAttemptCount())); }
            }
            var next=runs.claimItem(leaseMs);
            if (next.isPresent()) {
                var item=next.get();
                try {
                    if (item.exhausted()) runs.itemFailed(item,"RECONCILIATION_QUERY_LIMIT",true,0,incidents);
                    else processor.complete(item,processor.lookup(item));
                } catch (Exception e) { runs.itemFailed(item,code(e),permanent(e),delay(item.attemptCount()),incidents); }
            }
            runs.finishRuns();
        } catch (RuntimeException e) { LOG.warn("Reconciliation will resume from its persisted checkpoint ({})",e.getClass().getSimpleName()); }
    }
    private String code(Exception e) {
        if (e instanceof InterruptedException) { Thread.currentThread().interrupt(); return "RECONCILIATION_INTERRUPTED"; }
        if (e instanceof IOException) return "RECONCILIATION_PROVIDER_UNAVAILABLE";
        if (e instanceof PgClient.InvalidResult || e instanceof SupplierClient.InvalidResult) return "RECONCILIATION_INVALID_PROVIDER_RESULT";
        if (e instanceof OrderService.OrderException order) return order.code;
        return "RECONCILIATION_STORAGE_UNKNOWN";
    }
    private boolean permanent(Exception e) { return e instanceof PgClient.InvalidResult || e instanceof SupplierClient.InvalidResult
        || (e instanceof OrderService.OrderException order && order.status>=400 && order.status<500); }
    private long delay(int count) { return Math.min(30000,retryMs*(1L<<Math.min(5,Math.max(0,count-1)))); }
}
