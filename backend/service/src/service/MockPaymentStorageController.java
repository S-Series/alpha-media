package service;

import java.util.UUID;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class MockPaymentStorageController {
    private final MockPaymentStorageService service;
    private final MemberRepository members;
    public MockPaymentStorageController(MockPaymentStorageService service,MemberRepository members) { this.service=service; this.members=members; }

    @PostMapping("/api/admin/orders/{orderId}/mock-payment-storage")
    ResponseEntity<MockPaymentStorageService.Receipt> change(Authentication auth,@PathVariable UUID orderId,
            @RequestHeader("Idempotency-Key") UUID key,@Valid @RequestBody Request request) {
        var receipt=service.change(members.findByUsername(auth.getName()).orElseThrow().id(),orderId,key,request.action(),request.reason());
        return ResponseEntity.status(receipt.replayed()?200:201).header("Cache-Control","no-store")
            .header("Idempotency-Replayed",Boolean.toString(receipt.replayed())).body(receipt);
    }
    public record Request(@NotNull MockPaymentStorageService.Kind action,@NotBlank @Size(max=300) String reason) {}
}
