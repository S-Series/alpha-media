package service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;
import jakarta.validation.Valid;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/internal/mock-supplier/profiles/{iccid}")
@ConditionalOnProperty(name="issuance.mock-enabled",havingValue="true")
public class MockProfileController {
    private final MockProfileService profiles;
    private final IssuanceSettings settings;
    public MockProfileController(MockProfileService profiles,IssuanceSettings settings) { this.profiles=profiles; this.settings=settings; }
    @GetMapping
    ProfileSignal lookup(@PathVariable String iccid,@RequestHeader(value="Authorization",required=false) String auth) {
        authorize(auth); return profiles.lookup(iccid);
    }
    @PostMapping("/simulate")
    ProfileSignal simulate(@PathVariable String iccid,@RequestHeader(value="Authorization",required=false) String auth,
            @RequestHeader("Idempotency-Key") UUID key,@Valid @RequestBody MockProfileService.Change change) {
        authorize(auth); return profiles.simulate(iccid,key,change);
    }
    private void authorize(String auth) {
        if (auth==null || !MessageDigest.isEqual(("Bearer "+settings.apiKey()).getBytes(StandardCharsets.UTF_8),auth.getBytes(StandardCharsets.UTF_8)))
            throw new OrderService.OrderException(401,"INVALID_SUPPLIER_KEY","공급사 인증이 필요합니다.");
    }
}
