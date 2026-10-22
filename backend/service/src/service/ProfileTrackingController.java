package service;

import java.io.IOException;
import java.util.UUID;
import jakarta.validation.Valid;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/sims/{id}")
public class ProfileTrackingController {
    private final ProfileTrackingService tracking;
    private final MemberRepository members;
    private final ObjectProvider<SupplierClient> supplier;
    private final org.springframework.jdbc.core.JdbcTemplate jdbc;
    public ProfileTrackingController(ProfileTrackingService tracking,MemberRepository members,ObjectProvider<SupplierClient> supplier,org.springframework.jdbc.core.JdbcTemplate jdbc) {
        this.tracking=tracking; this.members=members; this.supplier=supplier; this.jdbc=jdbc;
    }
    @GetMapping("/tracking")
    ProfileTrackingService.View view(Authentication auth,@PathVariable UUID id) { return tracking.view(owner(auth),id); }
    @PostMapping("/activation-view")
    ProfileTrackingService.View viewed(Authentication auth,@PathVariable UUID id) {
        UUID owner=owner(auth); tracking.viewed(owner,id); return tracking.view(owner,id);
    }
    @PostMapping("/simulation")
    ProfileSignal simulate(Authentication auth,@PathVariable UUID id,@RequestHeader("Idempotency-Key") UUID key,
            @Valid @RequestBody MockProfileService.Change change) {
        var profile=tracking.owned(owner(auth),id);
        var client=supplier.getIfAvailable();
        if (client==null) throw new OrderService.OrderException(503,"SUPPLIER_DISABLED","모의 공급사가 비활성화되어 있습니다.");
        try {
            var result=client.simulate(profile.iccid(),key,change);
            jdbc.update("UPDATE sim_profiles SET next_sync_at=LEAST(next_sync_at,clock_timestamp()+INTERVAL '5 seconds') WHERE id=?",profile.id());
            return result;
        }
        catch (IOException e) { throw new OrderService.OrderException(504,"SUPPLIER_RESULT_UNKNOWN","접수 결과가 불명확합니다. 같은 요청 키와 조건으로 다시 확인해 주세요."); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new OrderService.OrderException(503,"SUPPLIER_INTERRUPTED","공급사 확인이 중단됐습니다. 같은 요청으로 다시 확인해 주세요."); }
        catch (SupplierClient.InvalidResult e) { throw new OrderService.OrderException(502,"SUPPLIER_INVALID_RESULT","공급사 응답을 확인할 수 없습니다."); }
    }
    private UUID owner(Authentication auth) { return members.findByUsername(auth.getName()).orElseThrow().id(); }
}
