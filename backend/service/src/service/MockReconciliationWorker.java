package service;

import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.UUID;
import jakarta.annotation.PreDestroy;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

@Component
@ConditionalOnProperty(name="payment.mock-enabled",havingValue="true")
public class MockReconciliationWorker {
    private final JdbcTemplate jdbc;
    private final PaymentSettings settings;
    private final WebhookSecurity signatures;
    private final ObjectMapper mapper;
    private final HttpClient http;
    public MockReconciliationWorker(JdbcTemplate jdbc,PaymentSettings settings,WebhookSecurity signatures,ObjectMapper mapper) {
        this.jdbc=jdbc; this.settings=settings; this.signatures=signatures; this.mapper=mapper;
        http=HttpClient.newBuilder().connectTimeout(Duration.ofMillis(settings.httpTimeoutMs())).followRedirects(HttpClient.Redirect.NEVER).build();
    }
    @Scheduled(fixedDelayString="${payment.worker-delay-ms}",initialDelayString="${payment.worker-delay-ms}")
    public void tick() {
        UUID token=UUID.randomUUID();
        var rows=jdbc.query("""
            WITH due AS (SELECT id,attempt_count>=copies+5 AS exhausted FROM mock_reconciliation_demos
                WHERE (status='PENDING' AND next_attempt_at<=clock_timestamp())
                   OR (status='SENDING' AND lease_until<=clock_timestamp())
                ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
            UPDATE mock_reconciliation_demos d SET status='SENDING',lease_token=?,
                lease_until=clock_timestamp()+(? * INTERVAL '1 millisecond'),
                attempt_count=attempt_count+CASE WHEN attempt_count<copies+5 THEN 1 ELSE 0 END
            FROM due WHERE d.id=due.id RETURNING d.*,due.exhausted
            """,(r,i)->new Delivery(r.getObject("id",UUID.class),new PgResult(r.getObject("event_id",UUID.class),
                r.getObject("payment_id",UUID.class),r.getObject("order_id",UUID.class),r.getLong("amount"),"KRW","DECLINED",null,"MOCK_CARD_DECLINED"),
                r.getInt("attempt_count"),r.getInt("copies"),r.getInt("sent_count"),r.getBoolean("exhausted")),token,settings.leaseMs());
        if (rows.isEmpty()) return;
        var job=rows.getFirst();
        // Claims consume a durable budget even if HTTP acknowledgement or completion persistence is lost.
        if (job.exhausted()) { finish(job,token,false,"DELIVERY_LIMIT",0); return; }
        boolean delivered=false; String error="DELIVERY_FAILED"; long retryAfter=0;
        try {
            byte[] body=mapper.writeValueAsBytes(job.result());
            var request=HttpRequest.newBuilder(URI.create(settings.webhookUrl())).timeout(Duration.ofMillis(settings.httpTimeoutMs()))
                .header("Content-Type","application/json").headers(signatures.headers("PG",body))
                .POST(HttpRequest.BodyPublishers.ofByteArray(body)).build();
            var response=http.send(request,HttpResponse.BodyHandlers.discarding());
            delivered=response.statusCode()>=200 && response.statusCode()<300;
            error="HTTP_"+response.statusCode(); retryAfter=WebhookRetry.delay(response);
        } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        catch (Exception e) { /* Same event ID is retried from the durable queue. */ }
        finish(job,token,delivered,error,retryAfter);
    }
    private void finish(Delivery job,UUID token,boolean delivered,String error,long retryAfter) {
        int sent=job.sent()+(delivered?1:0);
        String status=sent>=job.copies()?"DELIVERED":job.attempts()>=job.copies()+5?"REVIEW_REQUIRED":"PENDING";
        jdbc.update("""
            UPDATE mock_reconciliation_demos SET status=?,sent_count=?,last_error=?,lease_token=NULL,lease_until=NULL,
                next_attempt_at=CASE WHEN ?='PENDING' THEN clock_timestamp()+(? * INTERVAL '1 millisecond') ELSE NULL END,
                delivered_at=CASE WHEN ?='DELIVERED' THEN clock_timestamp() ELSE NULL END WHERE id=? AND lease_token=?
            """,status,sent,delivered?null:error,status,delivered?0:Math.max(retryAfter,settings.retryDelay(job.attempts())),status,job.id(),token);
    }
    @PreDestroy void close() { http.shutdownNow(); }
    private record Delivery(UUID id,PgResult result,int attempts,int copies,int sent,boolean exhausted) {}
}
