package service;

import java.io.IOException;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

@Component
@ConditionalOnProperty(name="issuance.mock-enabled",havingValue="true")
public class RefundProtectionWorker {
    private static final Logger LOG=LoggerFactory.getLogger(RefundProtectionWorker.class);
    private final RefundProtection jobs;
    private final RefundProtectionService transitions;
    private final SupplierClient supplier;
    private final IssuanceSettings supplierSettings;
    private final MonitoringService monitoring;
    public RefundProtectionWorker(RefundProtection jobs,RefundProtectionService transitions,SupplierClient supplier,MonitoringService monitoring,IssuanceSettings supplierSettings) {
        this.supplierSettings=supplierSettings; this.jobs=jobs; this.transitions=transitions; this.supplier=supplier; this.monitoring=monitoring;
    }
    @Scheduled(fixedDelayString="${payment.worker-delay-ms}",initialDelayString="${payment.worker-delay-ms}")
    public void tick() {
        monitoring.pulse("PROTECTION");
        var next=jobs.claim(supplierSettings.leaseMs()); if (next.isEmpty()) return;
        var job=next.get().job();
        try {
            if (next.get().exhausted()) { transitions.uncertain(job,true,"SUPPLIER_PROTECTION_RETRY_LIMIT"); return; }
            var result=supplier.protection(job,false).orElse(null);
            if (result==null) result=supplier.protection(job,true).orElseThrow();
            transitions.complete(job,result);
        } catch (InterruptedException e) { Thread.currentThread().interrupt(); uncertain(job,false,"SUPPLIER_PROTECTION_INTERRUPTED"); }
        catch (SupplierClient.InvalidResult e) { uncertain(job,true,"SUPPLIER_PROTECTION_MISMATCH"); }
        catch (IOException e) { uncertain(job,false,"SUPPLIER_PROTECTION_UNKNOWN"); }
        catch (RuntimeException e) { uncertain(job,false,"SUPPLIER_PROTECTION_STORAGE_UNKNOWN"); }
    }
    private void uncertain(RefundProtection.Job job,boolean stop,String error) {
        try { transitions.uncertain(job,stop,error); }
        catch (RuntimeException e) { LOG.warn("Protection {} will recover after lease expiry ({})",job.id(),e.getClass().getSimpleName()); }
    }
}
