package service;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import tools.jackson.databind.ObjectMapper;

@RestController
@ConditionalOnProperty(name = "issuance.mock-enabled", havingValue = "true")
public class SupplierWebhookController {
    private final IssuanceService service;
    private final IssuanceSettings settings;
    private final ObjectMapper mapper;
    private final ProfileTrackingService tracking;
    public SupplierWebhookController(IssuanceService service, IssuanceSettings settings, ObjectMapper mapper,ProfileTrackingService tracking) {
        this.service = service; this.settings = settings; this.mapper = mapper; this.tracking=tracking;
    }
    @PostMapping("/webhooks/supplier")
    ResponseEntity<Void> receive(@RequestBody byte[] body, @RequestHeader(value = "X-Signature", required = false) String signature) {
        if (body.length > 16384) throw new OrderService.OrderException(413, "BODY_TOO_LARGE", "공급사 콜백이 너무 큽니다.");
        if (!PgSignature.verify(body, signature, settings.webhookSecret())) {
            throw new OrderService.OrderException(401, "INVALID_SIGNATURE", "공급사 서명이 올바르지 않습니다.");
        }
        SupplierResult result;
        try { result = SupplierResult.parse(mapper, body); }
        catch (RuntimeException exception) { throw new OrderService.OrderException(400, "INVALID_SUPPLIER_RESULT", "공급사 콜백 형식이 올바르지 않습니다."); }
        service.result(result, null, "CALLBACK");
        return ResponseEntity.ok().header("Cache-Control", "no-store").build();
    }
    @PostMapping("/webhooks/supplier/profiles")
    ResponseEntity<Void> profile(@RequestBody byte[] body,@RequestHeader(value="X-Signature",required=false) String signature) {
        if (body.length>16384) throw new OrderService.OrderException(413,"BODY_TOO_LARGE","프로필 콜백이 너무 큽니다.");
        if (!PgSignature.verify(body,signature,settings.webhookSecret())) throw new OrderService.OrderException(401,"INVALID_SIGNATURE","공급사 서명이 올바르지 않습니다.");
        ProfileSignal signal;
        try { signal=ProfileSignal.parse(mapper,body); }
        catch (RuntimeException e) { throw new OrderService.OrderException(400,"INVALID_PROFILE_SIGNAL","프로필 콜백 형식이 올바르지 않습니다."); }
        tracking.apply(signal,"CALLBACK",null);
        return ResponseEntity.ok().header("Cache-Control","no-store").build();
    }
}
