package service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.UUID;

import jakarta.annotation.PreDestroy;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

@Component
@ConditionalOnProperty(name = "payment.mock-enabled", havingValue = "true")
public class MockPgWebhookWorker {
    private final JdbcTemplate jdbc;
    private final PaymentSettings settings;
    private final ObjectMapper mapper;
    private final HttpClient http;
    private final WebhookSecurity signatures;

    public MockPgWebhookWorker(JdbcTemplate jdbc, PaymentSettings settings, ObjectMapper mapper, WebhookSecurity signatures) {
        this.jdbc = jdbc; this.settings = settings; this.mapper = mapper;
        this.signatures=signatures;
        http = HttpClient.newBuilder().connectTimeout(Duration.ofMillis(settings.httpTimeoutMs()))
                .followRedirects(HttpClient.Redirect.NEVER).build();
    }

    @Scheduled(fixedDelayString = "${payment.worker-delay-ms}", initialDelayString = "${payment.worker-delay-ms}")
    public void tick() {
        UUID token = UUID.randomUUID();
        var claimed = jdbc.query("""
                WITH due AS (
                    SELECT payment_id FROM mock_pg_payments WHERE webhook_next_at <= clock_timestamp()
                    AND webhook_sent < webhook_copies AND webhook_failures < 6
                    ORDER BY webhook_next_at LIMIT 1 FOR UPDATE SKIP LOCKED
                )
                UPDATE mock_pg_payments SET webhook_lease_token=?,
                    webhook_next_at=clock_timestamp() + (? * INTERVAL '1 millisecond')
                WHERE payment_id IN (SELECT payment_id FROM due) RETURNING *
                """, MockPgService.RESULT, token, settings.leaseMs());
        if (claimed.isEmpty()) return;
        PgResult result = claimed.getFirst();
        boolean delivered = false;
        long retryAfter=0;
        try {
            byte[] body = mapper.writeValueAsBytes(result);
            var request = HttpRequest.newBuilder(URI.create(settings.webhookUrl()))
                    .timeout(Duration.ofMillis(settings.httpTimeoutMs()))
                    .header("Content-Type", "application/json")
                    .headers(signatures.headers("PG",body))
                    .POST(HttpRequest.BodyPublishers.ofByteArray(body)).build();
            var response=http.send(request, HttpResponse.BodyHandlers.discarding());
            int status=response.statusCode(); retryAfter=WebhookRetry.delay(response);
            delivered = status >= 200 && status < 300;
        } catch (InterruptedException exception) { Thread.currentThread().interrupt(); }
        catch (Exception exception) { /* 영속 작업에 실패를 남겨 제한된 횟수만 다시 보낸다. */ }
        if (delivered) {
            jdbc.update("""
                    UPDATE mock_pg_payments SET webhook_sent=webhook_sent+1, webhook_failures=0,
                        webhook_next_at=CASE WHEN webhook_sent+1 < webhook_copies THEN clock_timestamp() ELSE NULL END,
                        webhook_lease_token=NULL WHERE payment_id=? AND webhook_lease_token=?
                    """, result.paymentId(), token);
        } else {
            jdbc.update("""
                    UPDATE mock_pg_payments SET webhook_failures=webhook_failures+1,
                        webhook_next_at=CASE WHEN webhook_failures+1 >= 6 THEN NULL ELSE clock_timestamp()
                            + (GREATEST(?,LEAST(30000, ? * POWER(2,webhook_failures))) * INTERVAL '1 millisecond') END,
                        webhook_lease_token=NULL WHERE payment_id=? AND webhook_lease_token=?
                    """, retryAfter, settings.retryBaseMs(), result.paymentId(), token);
        }
    }

    @PreDestroy
    void close() { http.shutdownNow(); }
}
