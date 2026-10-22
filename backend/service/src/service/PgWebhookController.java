package service;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.ObjectMapper;

@RestController
@ConditionalOnProperty(name = "payment.mock-enabled", havingValue = "true")
public class PgWebhookController {
    private final PaymentTransitions transitions;
    private final PaymentSettings settings;
    private final ObjectMapper mapper;

    public PgWebhookController(PaymentTransitions transitions, PaymentSettings settings, ObjectMapper mapper) {
        this.transitions = transitions; this.settings = settings; this.mapper = mapper;
    }

    @PostMapping("/webhooks/pg")
    ResponseEntity<Void> receive(@RequestBody byte[] body, @RequestHeader(value = "X-Signature", required = false) String signature) {
        if (body.length > 16384) throw new OrderService.OrderException(413, "BODY_TOO_LARGE", "PG 통지가 너무 큽니다.");
        if (!PgSignature.verify(body, signature, settings.webhookSecret())) {
            throw new OrderService.OrderException(401, "INVALID_SIGNATURE", "PG 통지 서명이 올바르지 않습니다.");
        }
        PgResult result;
        try { result = PgResult.parse(mapper, body); }
        catch (RuntimeException exception) { throw new OrderService.OrderException(400, "INVALID_PG_RESULT", "PG 통지 형식이 올바르지 않습니다."); }
        transitions.result(result, null, "WEBHOOK");
        return ResponseEntity.ok().header("Cache-Control", "no-store").build();
    }
}
