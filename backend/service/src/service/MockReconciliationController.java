package service;

import java.util.UUID;
import jakarta.validation.Validator;
import jakarta.validation.constraints.*;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@RestController
@RequestMapping("/api/admin/orders/{orderId}/reconciliation-demo")
public class MockReconciliationController {
    private final MockReconciliationService service;
    private final MemberRepository members;
    private final ObjectMapper mapper;
    private final Validator validator;
    public MockReconciliationController(MockReconciliationService service,MemberRepository members,ObjectMapper mapper,Validator validator) {
        this.service=service; this.members=members; this.mapper=mapper; this.validator=validator;
    }
    @GetMapping
    ResponseEntity<MockReconciliationService.View> view(@PathVariable UUID orderId) {
        return ResponseEntity.ok().header("Cache-Control","no-store").body(service.view(orderId));
    }
    @PostMapping
    ResponseEntity<MockReconciliationService.Receipt> create(Authentication auth,@PathVariable UUID orderId,
            @RequestHeader("Idempotency-Key") UUID key,@RequestBody JsonNode body) {
        // Reject fractional controls before Jackson can truncate them into integers.
        if (body==null || !body.isObject()) throw invalid();
        for (String name:new String[]{"copies","delayMs"}) {
            var number=body.get(name);
            if (number==null || !number.isIntegralNumber() || !number.canConvertToInt()) throw invalid();
        }
        Request request;
        try { request=mapper.treeToValue(body,Request.class); }
        catch (RuntimeException error) { throw invalid(); }
        if (!validator.validate(request).isEmpty()) throw invalid();
        var result=service.create(members.findByUsername(auth.getName()).orElseThrow().id(),orderId,key,request);
        return ResponseEntity.status(result.replayed()?200:201).header("Cache-Control","no-store")
            .header("Idempotency-Replayed",Boolean.toString(result.replayed())).body(result);
    }
    private static OrderService.OrderException invalid() {
        return new OrderService.OrderException(400,"INVALID_REQUEST","시연 종류·사유·정수형 전송 횟수와 지연을 확인해 주세요.");
    }
    public record Request(@NotNull MockReconciliationService.Kind kind,@NotBlank @Size(max=300) String reason,
        @Min(1) @Max(20) int copies,@Min(0) @Max(60000) int delayMs) {}
}
