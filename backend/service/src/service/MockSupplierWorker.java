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
@ConditionalOnProperty(name = "issuance.mock-enabled", havingValue = "true")
public class MockSupplierWorker {
    private final JdbcTemplate jdbc;
    private final IssuanceSettings settings;
    private final ObjectMapper mapper;
    private final HttpClient http;
    public MockSupplierWorker(JdbcTemplate jdbc, IssuanceSettings settings, ObjectMapper mapper) {
        this.jdbc = jdbc; this.settings = settings; this.mapper = mapper;
        http = HttpClient.newBuilder().connectTimeout(Duration.ofMillis(settings.httpTimeoutMs())).followRedirects(HttpClient.Redirect.NEVER).build();
    }
    @Scheduled(fixedDelayString = "${issuance.worker-delay-ms}", initialDelayString = "${issuance.worker-delay-ms}")
    public void tick() {
        jdbc.update("""
            WITH due AS (SELECT request_id FROM mock_supplier_orders WHERE status='ACCEPTED' AND ready_at<=clock_timestamp()
                ORDER BY ready_at LIMIT 10 FOR UPDATE SKIP LOCKED)
            UPDATE mock_supplier_orders SET status=CASE WHEN scenario='SUCCEED' THEN 'ISSUED' ELSE 'FAILED' END,
                issue_executions=CASE WHEN scenario='SUCCEED' THEN 1 ELSE 0 END,
                callback_next_at=CASE WHEN callback_copies>0 THEN clock_timestamp()+(callback_delay_ms * INTERVAL '1 millisecond') END
            WHERE request_id IN (SELECT request_id FROM due)
            """);
        UUID token = UUID.randomUUID();
        var claimed = jdbc.query("""
            WITH due AS (SELECT request_id FROM mock_supplier_orders WHERE callback_next_at<=clock_timestamp()
                AND callback_sent<callback_copies AND callback_failures<6
                ORDER BY callback_next_at LIMIT 1 FOR UPDATE SKIP LOCKED)
            UPDATE mock_supplier_orders SET callback_lease_token=?,callback_next_at=clock_timestamp()+(? * INTERVAL '1 millisecond')
            WHERE request_id IN (SELECT request_id FROM due) RETURNING *
            """, MockSupplierService.RESULT, token, settings.leaseMs());
        if (claimed.isEmpty()) return;
        var result = claimed.getFirst();
        boolean delivered = false;
        try {
            byte[] body = mapper.writeValueAsBytes(result);
            var request = HttpRequest.newBuilder(URI.create(settings.webhookUrl())).timeout(Duration.ofMillis(settings.httpTimeoutMs()))
                .header("Content-Type", "application/json").header("X-Signature", PgSignature.sign(body, settings.webhookSecret()))
                .POST(HttpRequest.BodyPublishers.ofByteArray(body)).build();
            delivered = http.send(request, HttpResponse.BodyHandlers.discarding()).statusCode() == 200;
        } catch (InterruptedException exception) { Thread.currentThread().interrupt(); }
        catch (Exception exception) { /* 전송 실패는 원장에 남겨 제한된 횟수만 재시도한다. */ }
        if (delivered) {
            jdbc.update("""
                UPDATE mock_supplier_orders SET callback_sent=callback_sent+1,callback_failures=0,
                    callback_next_at=CASE WHEN callback_sent+1<callback_copies THEN clock_timestamp() END,
                    callback_lease_token=NULL WHERE request_id=? AND callback_lease_token=?
                """, result.requestId(), token);
        } else {
            jdbc.update("""
                UPDATE mock_supplier_orders SET callback_failures=callback_failures+1,
                    callback_next_at=CASE WHEN callback_failures+1<6 THEN clock_timestamp()
                        +(LEAST(30000,? * POWER(2,callback_failures)) * INTERVAL '1 millisecond') END,
                    callback_lease_token=NULL WHERE request_id=? AND callback_lease_token=?
                """, settings.pollMs(), result.requestId(), token);
        }
    }
    @PreDestroy void close() { http.shutdownNow(); }
}
