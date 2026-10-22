package service;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import tools.jackson.databind.ObjectMapper;

@RestController
@ConditionalOnProperty(name = "issuance.mock-enabled", havingValue = "true")
public class SupplierWebhookController {
    private final InboundEventService inbox;
    private final IssuanceSettings settings;
    private final ObjectMapper mapper;
    public SupplierWebhookController(InboundEventService inbox, IssuanceSettings settings, ObjectMapper mapper) {
        this.inbox = inbox; this.settings = settings; this.mapper = mapper;
    }
    @PostMapping("/webhooks/supplier")
    ResponseEntity<InboundEventService.Receipt> receive(@RequestBody byte[] body, @RequestHeader(value = "X-Signature", required = false) String signature) {
        if (body.length > 16384) throw new OrderService.OrderException(413, "BODY_TOO_LARGE", "공급사 콜백이 너무 큽니다.");
        if (!PgSignature.verify(body, signature, settings.webhookSecret())) {
            throw new OrderService.OrderException(401, "INVALID_SIGNATURE", "공급사 서명이 올바르지 않습니다.");
        }
        SupplierResult result;
        try { result = SupplierResult.parse(mapper, body); }
        catch (RuntimeException exception) { throw new OrderService.OrderException(400, "INVALID_SUPPLIER_RESULT", "공급사 콜백 형식이 올바르지 않습니다."); }
        if (!result.valid()) throw new OrderService.OrderException(400,"INVALID_SUPPLIER_RESULT","공급사 콜백 형식이 올바르지 않습니다.");
        return accepted(inbox.accept("SUPPLIER",result,body));
    }
    @PostMapping("/webhooks/supplier/profiles")
    ResponseEntity<InboundEventService.Receipt> profile(@RequestBody byte[] body,@RequestHeader(value="X-Signature",required=false) String signature) {
        if (body.length>16384) throw new OrderService.OrderException(413,"BODY_TOO_LARGE","프로필 콜백이 너무 큽니다.");
        if (!PgSignature.verify(body,signature,settings.webhookSecret())) throw new OrderService.OrderException(401,"INVALID_SIGNATURE","공급사 서명이 올바르지 않습니다.");
        ProfileSignal signal;
        try { signal=ProfileSignal.parse(mapper,body); }
        catch (RuntimeException e) { throw new OrderService.OrderException(400,"INVALID_PROFILE_SIGNAL","프로필 콜백 형식이 올바르지 않습니다."); }
        if (!signal.valid()) throw new OrderService.OrderException(400,"INVALID_PROFILE_SIGNAL","프로필 콜백 형식이 올바르지 않습니다.");
        return accepted(inbox.accept("PROFILE",signal,body));
    }
    private ResponseEntity<InboundEventService.Receipt> accepted(InboundEventService.Receipt receipt) {
        if (receipt.conflict()) throw new OrderService.OrderException(409,"INBOUND_EVENT_CONFLICT","같은 이벤트의 내용이 달라 처리를 보류했습니다.");
        return ResponseEntity.status(receipt.replayed()?200:202).header("Cache-Control","no-store").body(receipt);
    }
}
