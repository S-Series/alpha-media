package service;

import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import jakarta.annotation.PreDestroy;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name="issuance.mock-enabled",havingValue="true")
public class MockProfileNotificationWorker {
    private final JdbcTemplate jdbc;
    private final IssuanceSettings settings;
    private final HttpClient http;
    public MockProfileNotificationWorker(JdbcTemplate jdbc,IssuanceSettings settings) {
        this.jdbc=jdbc; this.settings=settings;
        http=HttpClient.newBuilder().connectTimeout(Duration.ofMillis(settings.httpTimeoutMs())).followRedirects(HttpClient.Redirect.NEVER).build();
    }
    @Scheduled(fixedDelayString="${issuance.worker-delay-ms}",initialDelayString="${issuance.worker-delay-ms}")
    public void tick() {
        UUID token=UUID.randomUUID();
        var due=jdbc.queryForList("""
            WITH due AS (SELECT event_id FROM mock_profile_notifications WHERE next_attempt_at<=clock_timestamp()
                AND callback_sent<callback_copies AND callback_failures<6 ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED)
            UPDATE mock_profile_notifications SET lease_token=?,next_attempt_at=clock_timestamp()+(? * INTERVAL '1 millisecond')
            WHERE event_id IN (SELECT event_id FROM due) RETURNING *
            """,token,settings.leaseMs());
        if (due.isEmpty()) return;
        var row=due.getFirst(); boolean delivered=false;
        try {
            byte[] body=((String)row.get("body")).getBytes(StandardCharsets.UTF_8);
            var request=HttpRequest.newBuilder(URI.create(settings.webhookUrl()+"/profiles")).timeout(Duration.ofMillis(settings.httpTimeoutMs()))
                .header("Content-Type","application/json").header("X-Signature",PgSignature.sign(body,settings.webhookSecret()))
                .POST(HttpRequest.BodyPublishers.ofByteArray(body)).build();
            int status=http.send(request,HttpResponse.BodyHandlers.discarding()).statusCode();
            delivered=status>=200 && status<300;
        } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        catch (Exception e) { /* Durable notification retries are bounded below. */ }
        if (delivered) jdbc.update("""
            UPDATE mock_profile_notifications SET callback_sent=callback_sent+1,callback_failures=0,lease_token=NULL,
                next_attempt_at=CASE WHEN callback_sent+1<callback_copies THEN clock_timestamp() END WHERE event_id=? AND lease_token=?
            """,row.get("event_id"),token);
        else jdbc.update("""
            UPDATE mock_profile_notifications SET callback_failures=callback_failures+1,lease_token=NULL,
                next_attempt_at=CASE WHEN callback_failures+1<6 THEN clock_timestamp()
                    +(LEAST(30000,1000*POWER(2,callback_failures))*INTERVAL '1 millisecond') END WHERE event_id=? AND lease_token=?
            """,row.get("event_id"),token);
    }
    @PreDestroy void close() { http.shutdownNow(); }
}
