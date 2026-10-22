package service;

import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
public class RequestSecurityController {
    private final RequestRateLimits rates;
    private final WebhookSecurity webhooks;
    public RequestSecurityController(RequestRateLimits rates,WebhookSecurity webhooks) { this.rates=rates; this.webhooks=webhooks; }
    @GetMapping("/api/admin/request-security")
    ResponseEntity<?> get() {
        return ResponseEntity.ok().header("Cache-Control","no-store")
            .body(Map.of("requests",rates.snapshot(),"webhookKeys",webhooks.configuration(),"keyHistory",webhooks.history(),"signatureMaxAgeSeconds",300,"signatureFutureSeconds",5));
    }
}
