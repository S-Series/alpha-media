package service;

import java.util.concurrent.ThreadLocalRandom;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.util.Assert;

@Component
public class InboundEventWorker {
    private static final Logger LOG=LoggerFactory.getLogger(InboundEventWorker.class);
    private final InboundEventRepository events;
    private final InboundEventProcessor processor;
    private final long leaseMs,retryBaseMs;
    public InboundEventWorker(InboundEventRepository events,InboundEventProcessor processor,
            @Value("${webhook.lease-ms:30000}") long leaseMs,
            @Value("${webhook.retry-base-ms:1000}") long retryBaseMs) {
        Assert.isTrue(leaseMs>=1000 && retryBaseMs>=100,"Invalid webhook retry intervals");
        this.events=events; this.processor=processor; this.leaseMs=leaseMs; this.retryBaseMs=retryBaseMs;
    }
    @Scheduled(fixedDelayString="${webhook.worker-delay-ms:500}",initialDelayString="${webhook.worker-delay-ms:500}")
    public void tick() {
        var next=events.claim(leaseMs);
        if (next.isEmpty()) return;
        var claim=next.get();
        if (claim.exhausted()) { failed(claim,true,"WEBHOOK_RETRY_LIMIT_REACHED",503); return; }
        try { processor.process(claim); }
        catch (OrderService.OrderException error) {
            failed(claim,error.status>=400 && error.status<500 && error.status!=404,error.code,error.status);
        } catch (InboundPayloadCodec.UnreadablePayload error) {
            failed(claim,true,"INBOUND_PAYLOAD_UNREADABLE",500);
        } catch (RuntimeException error) {
            failed(claim,false,"INBOUND_PROCESSING_FAILED",503);
        }
    }
    private void failed(InboundEventRepository.Claim claim,boolean permanent,String code,int status) {
        long base=Math.min(30000L,retryBaseMs*(1L<<Math.min(5,Math.max(0,claim.event().attemptCount()-1))));
        try { events.failed(claim,permanent,code,status,base+ThreadLocalRandom.current().nextLong(base/5+1)); }
        catch (RuntimeException unavailable) {
            LOG.warn("Webhook {} will recover after lease expiry ({})",claim.event().id(),unavailable.getClass().getSimpleName());
        }
    }
}
