package service;

import java.util.UUID;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
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
public class RecoveryController {
    private final RecoveryService service;
    private final MemberRepository members;
    public RecoveryController(RecoveryService service,MemberRepository members) { this.service=service; this.members=members; }
    @PostMapping("/reconciliations")
    ResponseEntity<RecoveryService.Receipt> reconcile(Authentication auth,@PathVariable UUID orderId,
            @RequestHeader("Idempotency-Key") UUID key,@Valid @RequestBody Query request) {
        return response(service.reconcile(actor(auth),orderId,key,request));
    }
    @PostMapping("/recoveries")
    ResponseEntity<RecoveryService.Receipt> resume(Authentication auth,@PathVariable UUID orderId,
            @RequestHeader("Idempotency-Key") UUID key,@Valid @RequestBody Resume request) {
        return response(service.resume(actor(auth),orderId,key,request));
    }
    private UUID actor(Authentication auth) { return members.findByUsername(auth.getName()).orElseThrow().id(); }
    private ResponseEntity<RecoveryService.Receipt> response(RecoveryService.Receipt receipt) {
        return ResponseEntity.status(receipt.replayed()?200:202).header("Cache-Control","no-store")
            .header("Idempotency-Replayed",Boolean.toString(receipt.replayed())).body(receipt);
    }
    public record Query(@NotNull RecoveryTargets.Kind target,@NotNull UUID targetId,
        @NotBlank @Pattern(regexp="[a-f0-9]{64}") String expectedVersion,@NotBlank @Size(max=300) String reason) {}
    public record Resume(@NotNull RecoveryTargets.Kind target,@NotNull UUID targetId,
        @NotBlank @Pattern(regexp="[a-f0-9]{64}") String expectedVersion,@NotBlank @Size(max=300) String reason,@NotNull UUID evidenceId) {}
}
