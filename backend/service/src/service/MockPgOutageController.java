package service;

import java.util.UUID;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class MockPgOutageController {
    private final MockPgOutageService service;
    private final MemberRepository members;
    public MockPgOutageController(MockPgOutageService service,MemberRepository members) { this.service=service; this.members=members; }

    @PostMapping("/api/admin/orders/{orderId}/refunds/{refundId}/mock-pg-outage-release")
    ResponseEntity<MockPgOutageService.Receipt> release(Authentication auth,@PathVariable UUID orderId,
            @PathVariable UUID refundId,@RequestHeader("Idempotency-Key") UUID key,@Valid @RequestBody Request request) {
        UUID actor=members.findByUsername(auth.getName()).orElseThrow().id();
        var receipt=service.release(actor,orderId,refundId,key,request.reason());
        return ResponseEntity.status(receipt.replayed()?200:201).header("Cache-Control","no-store")
            .header("Idempotency-Replayed",Boolean.toString(receipt.replayed())).body(receipt);
    }
    public record Request(@NotBlank @Size(max=300) String reason) {}
}
