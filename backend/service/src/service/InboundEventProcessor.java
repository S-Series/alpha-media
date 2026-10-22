package service;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.ObjectMapper;

@Service
public class InboundEventProcessor {
    private final InboundEventRepository events;
    private final InboundPayloadCodec codec;
    private final ObjectMapper mapper;
    private final PaymentTransitions payments;
    private final IssuanceService issuances;
    private final ProfileTrackingService profiles;
    public InboundEventProcessor(InboundEventRepository events,InboundPayloadCodec codec,ObjectMapper mapper,
            PaymentTransitions payments,IssuanceService issuances,ProfileTrackingService profiles) {
        this.events=events; this.codec=codec; this.mapper=mapper;
        this.payments=payments; this.issuances=issuances; this.profiles=profiles;
    }

    @Transactional
    public void process(InboundEventRepository.Claim claim) {
        var event=events.lock(claim.event().id());
        if (!"PROCESSING".equals(event.status()) || !claim.token().equals(event.leaseToken())) return;
        byte[] body=codec.decrypt(event);
        try {
            switch (event.source()) {
                case "PG" -> payments.result(PgResult.parse(mapper,body),null,"WEBHOOK");
                case "SUPPLIER" -> issuances.result(SupplierResult.parse(mapper,body),null,"CALLBACK");
                case "PROFILE" -> profiles.apply(ProfileSignal.parse(mapper,body),"CALLBACK",null);
                default -> throw new IllegalStateException("Unsupported inbox source");
            }
        } catch (OrderConflicts.ConflictException conflict) {
            // The domain allows this exception to commit; keep its incident and inbox status together.
            events.review(event.id(),claim.token(),conflict.code,conflict.status);
            return;
        }
        // A failure here also rolls back the domain changes and their downstream jobs.
        events.processed(event.id(),claim.token());
    }
}
