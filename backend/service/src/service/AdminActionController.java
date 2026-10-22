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
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/admin/orders/{orderId}")
public class AdminActionController {
    private final AdminActionService service;
    private final MemberRepository members;
    public AdminActionController(AdminActionService service, MemberRepository members) { this.service=service; this.members=members; }
    @PostMapping("/issuance-retries")
    ResponseEntity<AdminActionService.Receipt> retry(Authentication auth,@PathVariable UUID orderId,
            @RequestHeader("Idempotency-Key") UUID key,@Valid @RequestBody Retry request) {
        return response(service.retry(actor(auth),orderId,key,request));
    }
    @PostMapping("/refunds")
    ResponseEntity<AdminActionService.Receipt> refund(Authentication auth,@PathVariable UUID orderId,
            @RequestHeader("Idempotency-Key") UUID key,@Valid @RequestBody RefundRequest request) {
        return response(service.refund(actor(auth),orderId,key,request));
    }
    private UUID actor(Authentication auth) { return members.findByUsername(auth.getName()).orElseThrow().id(); }
    private ResponseEntity<AdminActionService.Receipt> response(AdminActionService.Receipt result) {
        return ResponseEntity.status(result.replayed()?200:202).header("Cache-Control","no-store")
            .header("Idempotency-Replayed",Boolean.toString(result.replayed())).body(result);
    }
    public record Retry(@NotNull UUID issuanceId,@NotBlank @Size(max=300) String reason,@NotNull @Valid IssuanceSimulation simulation) {}
    @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    public record RefundRequest(@NotNull UUID issuanceId,@NotBlank @Size(max=300) String reason,@NotNull Refund.Scenario scenario,
        @jakarta.validation.constraints.DecimalMin("1") @jakarta.validation.constraints.Digits(integer=18,fraction=0) java.math.BigDecimal amount,RefundProtection.Scenario holdScenario,RefundProtection.Scenario cleanupScenario) {
        public RefundRequest(UUID issuanceId,String reason,Refund.Scenario scenario) { this(issuanceId,reason,scenario,null,null,null); }
    }
}
