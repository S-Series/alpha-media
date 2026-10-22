package service;

import java.net.URI;
import java.util.UUID;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/admin/scenarios")
public class ScenarioController {
    private final ScenarioService scenarios;
    private final MemberRepository members;
    public ScenarioController(ScenarioService scenarios,MemberRepository members) { this.scenarios=scenarios;this.members=members; }
    @GetMapping("/options")
    ResponseEntity<ScenarioService.Options> options(Authentication auth) {
        actor(auth);
        return ResponseEntity.ok().header("Cache-Control","no-store").body(scenarios.options());
    }
    @PostMapping
    ResponseEntity<ScenarioService.Generation> create(Authentication auth,@RequestHeader("Idempotency-Key") UUID key,
            @Valid @RequestBody Request request) {
        var result=scenarios.create(actor(auth),key,request);
        return ResponseEntity.status(result.replayed()?200:201).location(URI.create("/api/admin/scenarios/"+key))
            .header("Idempotency-Replayed",Boolean.toString(result.replayed())).header("Cache-Control","no-store").body(result.generation());
    }
    @GetMapping("/{id}")
    ResponseEntity<ScenarioService.Generation> detail(Authentication auth,@PathVariable UUID id) {
        actor(auth);
        return ResponseEntity.ok().header("Cache-Control","no-store").body(scenarios.detail(id));
    }
    private Member actor(Authentication auth) {
        var member=members.findByUsername(auth.getName()).orElseThrow();
        if (!"ADMIN".equals(member.role())) throw new OrderService.OrderException(403,"FORBIDDEN","운영자 권한이 필요합니다.");
        return member;
    }
    public record Request(@NotNull ScenarioService.Scenario scenario,@NotBlank @Size(max=32) String customer,
            @NotBlank @Size(max=64) String planId) {}
}
