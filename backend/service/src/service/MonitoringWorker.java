package service;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;
import org.springframework.util.Assert;

@Component
public class MonitoringWorker {
    private static final Logger LOG=LoggerFactory.getLogger(MonitoringWorker.class);
    private final MonitoringService monitoring;
    private final long interval;
    // Do not share the scheduler that may be blocked by provider requests.
    private final ScheduledExecutorService executor=Executors.newSingleThreadScheduledExecutor(r->{
        Thread thread=new Thread(r,"operational-monitor"); thread.setDaemon(true); return thread;
    });
    public MonitoringWorker(MonitoringService monitoring,@Value("${monitoring.interval-ms:5000}") long interval) {
        Assert.isTrue(interval>=100 && interval<=15000,"Monitoring interval must be 100..15000 ms");
        this.monitoring=monitoring; this.interval=interval;
    }
    @EventListener(ApplicationReadyEvent.class)
    public void start() {
        if (monitoring.enabled()) executor.scheduleWithFixedDelay(()->{
            try { monitoring.scan(); }
            catch (RuntimeException error) { LOG.warn("Operational monitor could not complete ({})",error.getClass().getSimpleName()); }
        },0,interval,TimeUnit.MILLISECONDS);
    }
    @PreDestroy public void close() { executor.shutdownNow(); }
}
