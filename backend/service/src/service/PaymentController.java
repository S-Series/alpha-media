package service;

import java.net.URI;
import java.util.List;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/orders/{orderId}/payment-attempts")
public class PaymentController {
    private final PaymentService payments;
    private final MemberRepository members;

    public PaymentController(PaymentService payments, MemberRepository members) {
        this.payments = payments; this.members = members;
    }

    @PostMapping
    ResponseEntity<PaymentAttempt> accept(Authentication auth, @PathVariable UUID orderId,
            @RequestHeader("Idempotency-Key") UUID key, @Valid @RequestBody Request request) {
        var result = payments.accept(memberId(auth), orderId, key, request);
        return ResponseEntity.status(result.replayed() ? 200 : 202)
                .location(URI.create("/api/orders/" + orderId + "/payment-attempts/" + result.payment().id()))
                .header("Cache-Control", "no-store").header("Idempotency-Replayed", Boolean.toString(result.replayed()))
                .body(result.payment());
    }

    @GetMapping
    ResponseEntity<List<PaymentAttempt>> list(Authentication auth, @PathVariable UUID orderId) {
        return ResponseEntity.ok().header("Cache-Control", "no-store").body(payments.list(memberId(auth), orderId));
    }

    @GetMapping("/{paymentId}")
    ResponseEntity<PaymentAttempt> detail(Authentication auth, @PathVariable UUID orderId, @PathVariable UUID paymentId) {
        return ResponseEntity.ok().header("Cache-Control", "no-store").body(payments.detail(memberId(auth), orderId, paymentId));
    }

    private UUID memberId(Authentication auth) { return members.findByUsername(auth.getName()).orElseThrow().id(); }

    public record Request(@NotNull PaymentAttempt.Scenario scenario, @NotNull @Min(0) @Max(20) Integer webhookCopies,
            @NotNull @Min(0) @Max(60000) Integer webhookDelayMs, @Valid IssuanceSimulation issuance) {
        IssuanceSimulation issuanceOrDefault() { return issuance == null ? IssuanceSimulation.defaults() : issuance; }
    }
}
