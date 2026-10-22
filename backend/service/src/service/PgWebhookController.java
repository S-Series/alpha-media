package service;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.ObjectMapper;

@RestController
@ConditionalOnProperty(name = "payment.mock-enabled", havingValue = "true")
public class PgWebhookController {
    private final InboundEventService inbox;
    private final WebhookSecurity security;
    private final ObjectMapper mapper;

    public PgWebhookController(InboundEventService inbox, WebhookSecurity security, ObjectMapper mapper) {
        this.inbox = inbox; this.security = security; this.mapper = mapper;
    }

    @PostMapping("/webhooks/pg")
    ResponseEntity<InboundEventService.Receipt> receive(@RequestBody byte[] body, HttpServletRequest request) {
        if (body.length > 16384) throw new OrderService.OrderException(413, "BODY_TOO_LARGE", "PG 통지가 너무 큽니다.");
        var verified=security.verify("PG",body,request);
        PgResult result;
        try { result = PgResult.parse(mapper, body); }
        catch (RuntimeException exception) { throw new OrderService.OrderException(400, "INVALID_PG_RESULT", "PG 통지 형식이 올바르지 않습니다."); }
        if (result.eventId()==null || result.paymentId()==null || result.orderId()==null)
            throw new OrderService.OrderException(400,"INVALID_PG_RESULT","PG 통지 식별자가 올바르지 않습니다.");
        var receipt=inbox.accept("PG",result,body,verified);
        if (receipt.conflict()) throw new OrderService.OrderException(409,"INBOUND_EVENT_CONFLICT","같은 이벤트의 내용이 달라 처리를 보류했습니다.");
        return ResponseEntity.status(receipt.replayed()?200:202).header("Cache-Control", "no-store").body(receipt);
    }
}
