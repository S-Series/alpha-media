package service;

import java.io.IOException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.util.Assert;

@Component
public class RecoveryWorker {
    private static final Logger LOG=LoggerFactory.getLogger(RecoveryWorker.class);
    private final RecoveryRepository actions;
    private final RecoveryService service;
    private final long leaseMs,retryMs;
    private final MonitoringService monitoring;
    public RecoveryWorker(RecoveryRepository actions,RecoveryService service,MonitoringService monitoring,
            @Value("${recovery.lease-ms:30000}") long leaseMs,@Value("${recovery.retry-base-ms:1000}") long retryMs) {
        Assert.isTrue(leaseMs>=1000 && retryMs>=100,"Invalid recovery retry intervals");
        this.monitoring=monitoring;
        this.actions=actions; this.service=service; this.leaseMs=leaseMs; this.retryMs=retryMs;
    }
    @Scheduled(fixedDelayString="${recovery.worker-delay-ms:500}",initialDelayString="${recovery.worker-delay-ms:500}")
    public void tick() {
        monitoring.pulse("RECOVERY");
        var next=actions.claim(leaseMs);
        if (next.isEmpty()) return;
        var claim=next.get(); var action=claim.action();
        if (claim.exhausted()) { failed(action,"RECOVERY_QUERY_LIMIT",true); return; }
        try { service.complete(action,service.lookup(action)); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); failed(action,"RECOVERY_QUERY_INTERRUPTED",false); }
        catch (IOException e) { failed(action,"RECOVERY_PROVIDER_UNAVAILABLE",false); }
        catch (PgClient.InvalidResult | SupplierClient.InvalidResult e) { failed(action,"RECOVERY_INVALID_PROVIDER_RESULT",true); }
        catch (InboundPayloadCodec.UnreadablePayload e) { failed(action,"INBOUND_PAYLOAD_UNREADABLE",true); }
        catch (OrderService.OrderException e) { failed(action,e.code,e.status>=400 && e.status<500); }
        catch (RuntimeException e) { failed(action,"RECOVERY_STORAGE_UNKNOWN",false); }
    }
    private void failed(RecoveryRepository.Action action,String code,boolean permanent) {
        try { actions.failed(action,code,permanent,Math.min(30000,retryMs*(1L<<Math.min(5,Math.max(0,action.attemptCount()-1))))); }
        catch (RuntimeException e) { LOG.warn("Recovery {} will recover after lease expiry ({})",action.id(),e.getClass().getSimpleName()); }
    }
}
