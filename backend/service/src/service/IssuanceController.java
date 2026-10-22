package service;

import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class IssuanceController {
    private final IssuanceService service;
    private final MemberRepository members;
    public IssuanceController(IssuanceService service, MemberRepository members) { this.service = service; this.members = members; }
    @GetMapping("/orders/{orderId}/issuance")
    ResponseEntity<IssuanceService.View> view(Authentication auth, @PathVariable UUID orderId) {
        return ResponseEntity.ok().header("Cache-Control", "no-store").body(service.view(memberId(auth), orderId));
    }
    @GetMapping("/sims")
    ResponseEntity<List<SimProfile>> profiles(Authentication auth) {
        return ResponseEntity.ok().header("Cache-Control", "no-store").body(service.profiles(memberId(auth)));
    }
    @GetMapping("/sims/{id}")
    ResponseEntity<SimProfile> profile(Authentication auth, @PathVariable UUID id) {
        return ResponseEntity.ok().header("Cache-Control", "no-store").body(service.profile(memberId(auth), id));
    }
    private UUID memberId(Authentication auth) { return members.findByUsername(auth.getName()).orElseThrow().id(); }
}
