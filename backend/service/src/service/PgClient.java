package service;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

@Component
@ConditionalOnProperty(name = "payment.mock-enabled", havingValue = "true")
public class PgClient {
    private final PaymentSettings settings;
    private final ObjectMapper mapper;
    private final String gatewayToken;
    private final HttpClient http;

    public PgClient(PaymentSettings settings, ObjectMapper mapper,
            @Value("${INTERNAL_GATEWAY_TOKEN:}") String gatewayToken) {
        this.settings = settings; this.mapper = mapper; this.gatewayToken = gatewayToken;
        http = HttpClient.newBuilder().connectTimeout(Duration.ofMillis(settings.httpTimeoutMs()))
                .followRedirects(HttpClient.Redirect.NEVER).build();
    }

    PgResult approve(PaymentAttempt p) throws IOException, InterruptedException {
        var request = HttpRequest.newBuilder(URI.create(settings.pgBaseUrl() + "/payments/approve"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(new MockPgService.Approval(
                        p.id(), p.orderId(), p.amount(), p.currency(), p.scenario(), p.webhookCopies(), p.webhookDelayMs()))));
        return send(request, false).orElseThrow();
    }

    Optional<PgResult> lookup(PaymentAttempt p) throws IOException, InterruptedException {
        return send(HttpRequest.newBuilder(URI.create(settings.pgBaseUrl() + "/payments/" + p.id())).GET(), true);
    }

    ExternalLedger.Page paymentLedger(Instant from,Instant to,Instant afterTime,UUID afterId,int limit) throws IOException,InterruptedException {
        return ledger("payments","PAYMENT",from,to,afterTime,afterId,limit);
    }
    ExternalLedger.Page cancellationLedger(Instant from,Instant to,Instant afterTime,UUID afterId,int limit) throws IOException,InterruptedException {
        return ledger("cancellations","CANCELLATION",from,to,afterTime,afterId,limit);
    }
    private ExternalLedger.Page ledger(String path,String source,Instant from,Instant to,Instant afterTime,UUID afterId,int limit)
            throws IOException,InterruptedException {
        var response=readLedger("/ledger/"+path+ExternalLedger.query(from,to,afterTime,afterId,limit));
        if (response.statusCode()!=200) throw new InvalidResult();
        try {
            return ExternalLedger.validate(mapper.readValue(response.body(),ExternalLedger.Page.class),from,to,afterTime,afterId,limit,source);
        } catch (RuntimeException e) { throw new InvalidResult(); }
    }
    Optional<ExternalLedger.PaymentSnapshot> financial(UUID paymentId) throws IOException,InterruptedException {
        if (paymentId==null) throw new IllegalArgumentException("Payment ID is required");
        var response=readLedger("/ledger/payments/"+paymentId);
        if (response.statusCode()==404) return Optional.empty();
        if (response.statusCode()!=200) throw new InvalidResult();
        try {
            var tree=mapper.readTree(response.body());
            var total=tree==null?null:tree.get("cancelledTotal");
            if (total==null || !total.isIntegralNumber() || !total.canConvertToLong()) throw new InvalidResult();
            var payment=tree.get("payment");
            if (payment==null) throw new InvalidResult();
            PgResult.parse(mapper,mapper.writeValueAsBytes(payment));
            var cancellations=tree.get("cancellations");
            if (cancellations==null || !cancellations.isArray() || cancellations.size()>1000) throw new InvalidResult();
            for (var item:cancellations) for (String field:new String[]{"amount","cancelledTotal"}) {
                var value=item.get(field);
                if (value==null || !value.isIntegralNumber() || !value.canConvertToLong()) throw new InvalidResult();
            }
            return Optional.of(ExternalLedger.validate(mapper.treeToValue(tree,ExternalLedger.PaymentSnapshot.class),paymentId));
        } catch (RuntimeException e) { throw new InvalidResult(); }
    }
    private HttpResponse<String> readLedger(String path) throws IOException,InterruptedException {
        var response=http.send(HttpRequest.newBuilder(URI.create(settings.pgBaseUrl()+path))
            .timeout(Duration.ofMillis(settings.httpTimeoutMs())).header("Authorization","Bearer "+settings.apiKey())
            .header("X-Gateway-Token",gatewayToken).GET().build(),HttpResponse.BodyHandlers.ofString());
        if (response.statusCode()>=500) throw new IOException("PG_LEDGER_UNAVAILABLE");
        return response;
    }

    MockPgService.Cancellation cancel(Refund refund) throws IOException, InterruptedException {
        return cancellation(HttpRequest.newBuilder(URI.create(settings.pgBaseUrl()+"/payments/"+refund.paymentId()+"/cancel"))
            .header("Content-Type","application/json").header("Idempotency-Key",refund.id().toString())
            .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(new MockPgController.Cancel(refund.amount(),refund.scenario())))),false).orElseThrow();
    }
    Optional<MockPgService.Cancellation> lookupCancellation(Refund refund) throws IOException, InterruptedException {
        return cancellation(HttpRequest.newBuilder(URI.create(settings.pgBaseUrl()+"/payments/"+refund.paymentId()+"/cancellations/"+refund.id())).GET(),true);
    }
    private Optional<MockPgService.Cancellation> cancellation(HttpRequest.Builder request,boolean allowMissing) throws IOException,InterruptedException {
        var response=http.send(request.timeout(Duration.ofMillis(settings.httpTimeoutMs()))
            .header("Authorization","Bearer "+settings.apiKey()).header("X-Gateway-Token",gatewayToken).build(),HttpResponse.BodyHandlers.ofString());
        if (allowMissing && response.statusCode()==404) return Optional.empty();
        if (response.statusCode()>=500) throw new IOException("PG_CANCEL_UNAVAILABLE");
        if (response.statusCode()!=200) throw new InvalidResult();
        try {
            var tree=mapper.readTree(response.body());
            for (String field:new String[]{"amount","cancelledTotal"}) {
                var value=tree.get(field);
                if (value==null || !value.isIntegralNumber() || !value.canConvertToLong()) throw new InvalidResult();
            }
            return Optional.of(mapper.treeToValue(tree,MockPgService.Cancellation.class));
        } catch (RuntimeException exception) { throw new InvalidResult(); }
    }

    private Optional<PgResult> send(HttpRequest.Builder request, boolean allowMissing) throws IOException, InterruptedException {
        var response = http.send(request.timeout(Duration.ofMillis(settings.httpTimeoutMs()))
                .header("Authorization", "Bearer " + settings.apiKey()).header("X-Gateway-Token", gatewayToken).build(),
                HttpResponse.BodyHandlers.ofString());
        if (allowMissing && response.statusCode() == 404) return Optional.empty();
        if (response.statusCode() >= 500) throw new IOException("PG_UNAVAILABLE");
        if (response.statusCode() != 200) throw new InvalidResult();
        try {
            PgResult parsed = PgResult.parse(mapper, response.body().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            if (parsed == null) throw new InvalidResult();
            return Optional.of(parsed);
        }
        catch (RuntimeException exception) { throw new InvalidResult(); }
    }

    @PreDestroy
    void close() { http.shutdownNow(); }

    static class InvalidResult extends RuntimeException {}
}
