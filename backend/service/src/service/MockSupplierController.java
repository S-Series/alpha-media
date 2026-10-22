package service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;
import jakarta.validation.Valid;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/internal/mock-supplier/orders")
@ConditionalOnProperty(name = "issuance.mock-enabled", havingValue = "true")
public class MockSupplierController {
    private final MockSupplierService supplier;
    private final IssuanceSettings settings;
    public MockSupplierController(MockSupplierService supplier, IssuanceSettings settings) { this.supplier = supplier; this.settings = settings; }
    @PostMapping
    ResponseEntity<SupplierResult> submit(@RequestHeader(value = "Authorization", required = false) String auth,
            @Valid @RequestBody MockSupplierService.Request request) {
        authorize(auth); return ResponseEntity.accepted().body(supplier.submit(request));
    }
    @GetMapping("/{id}")
    SupplierResult lookup(@RequestHeader(value = "Authorization", required = false) String auth, @PathVariable UUID id) {
        authorize(auth); return supplier.lookup(id);
    }
    @GetMapping("/{id}/stats")
    MockSupplierService.Stats stats(@RequestHeader(value = "Authorization", required = false) String auth, @PathVariable UUID id) {
        authorize(auth); return supplier.stats(id);
    }
    private void authorize(String supplied) {
        if (supplied == null || !MessageDigest.isEqual(("Bearer " + settings.apiKey()).getBytes(StandardCharsets.UTF_8),
                supplied.getBytes(StandardCharsets.UTF_8))) throw new OrderService.OrderException(401, "INVALID_SUPPLIER_KEY", "공급사 인증이 필요합니다.");
    }
}
