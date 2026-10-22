package service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/internal/mock-pg/payments")
@ConditionalOnProperty(name = "payment.mock-enabled", havingValue = "true")
public class MockPgController {
    private final MockPgService pg;
    private final PaymentSettings settings;

    public MockPgController(MockPgService pg, PaymentSettings settings) { this.pg = pg; this.settings = settings; }

    @PostMapping("/approve")
    PgResult approve(@RequestHeader(value = "Authorization", required = false) String auth,
            @Valid @RequestBody MockPgService.Approval request) throws InterruptedException {
        authorize(auth);
        var reply = pg.approve(request);
        // PG 원장이 커밋된 뒤에 응답만 늦춘다. 업무 서버는 승인 여부를 모르는 타임아웃을 겪는다.
        if (reply.loseResponse()) Thread.sleep(settings.httpTimeoutMs() * 2L + 250);
        return reply.result();
    }

    @GetMapping("/{id}")
    PgResult lookup(@RequestHeader(value = "Authorization", required = false) String auth, @PathVariable UUID id) {
        authorize(auth); return pg.lookup(id);
    }

    @GetMapping("/{id}/stats")
    MockPgService.Stats stats(@RequestHeader(value = "Authorization", required = false) String auth, @PathVariable UUID id) {
        authorize(auth); return pg.stats(id);
    }

    @PostMapping("/{id}/cancel")
    MockPgService.Cancellation cancel(@RequestHeader(value = "Authorization", required = false) String auth,
            @PathVariable UUID id, @RequestHeader("Idempotency-Key") UUID key, @Valid @RequestBody Cancel request) {
        authorize(auth); return pg.cancel(id, key, request.amount());
    }

    private void authorize(String supplied) {
        byte[] expected = ("Bearer " + settings.apiKey()).getBytes(StandardCharsets.UTF_8);
        if (supplied == null || !MessageDigest.isEqual(expected, supplied.getBytes(StandardCharsets.UTF_8))) {
            throw new OrderService.OrderException(401, "INVALID_PG_KEY", "모의 PG 인증이 필요합니다.");
        }
    }

    public record Cancel(@Min(1) long amount) {}
}
