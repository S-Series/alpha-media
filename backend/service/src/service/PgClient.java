package service;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Optional;

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
