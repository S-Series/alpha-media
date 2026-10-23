package service;

import java.util.UUID;
import java.math.BigDecimal;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Digits;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/admin/orders/{orderId}/concurrency-demos")
public class AdminConcurrencyController {
    private final AdminConcurrencyService demos;
    private final MemberRepository members;
    public AdminConcurrencyController(AdminConcurrencyService demos,MemberRepository members) { this.demos=demos;this.members=members; }
    @PostMapping
    ResponseEntity<AdminConcurrencyService.View> create(Authentication auth,@PathVariable UUID orderId,
            @RequestHeader("Idempotency-Key") UUID key,@Valid @RequestBody Request request) {
        return response(demos.create(actor(auth),orderId,key,request));
    }
    @GetMapping("/{demoId}")
    ResponseEntity<AdminConcurrencyService.View> view(Authentication auth,@PathVariable UUID orderId,@PathVariable UUID demoId) {
        return response(demos.view(actor(auth),orderId,demoId));
    }
    @PostMapping("/{demoId}/join")
    ResponseEntity<AdminConcurrencyService.View> join(Authentication auth,@PathVariable UUID orderId,@PathVariable UUID demoId) {
        return response(demos.join(actor(auth),orderId,demoId));
    }
    @PostMapping("/{demoId}/start")
    ResponseEntity<AdminConcurrencyService.View> start(Authentication auth,@PathVariable UUID orderId,@PathVariable UUID demoId) {
        return response(demos.start(actor(auth),orderId,demoId));
    }
    private Member actor(Authentication auth) { return members.findByUsername(auth.getName()).orElseThrow(); }
    private ResponseEntity<AdminConcurrencyService.View> response(AdminConcurrencyService.View value) {
        return ResponseEntity.ok().header("Cache-Control","no-store").body(value);
    }
    public record Request(@NotNull UUID issuanceId,@NotNull AdminConcurrencyService.Mode mode,
            @NotNull AdminConcurrencyService.KeyMode keyMode,@NotBlank @Size(max=300) String reason,
            @DecimalMin("1") @Digits(integer=18,fraction=0) BigDecimal firstAmount,
            @DecimalMin("1") @Digits(integer=18,fraction=0) BigDecimal secondAmount) {}
}
