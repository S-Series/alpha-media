package service;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

@Component
@ConditionalOnProperty(name = "issuance.mock-enabled", havingValue = "true")
public class SupplierClient {
    private final IssuanceSettings settings;
    private final ObjectMapper mapper;
    private final String gatewayToken;
    private final HttpClient http;
    public SupplierClient(IssuanceSettings settings, ObjectMapper mapper, @Value("${INTERNAL_GATEWAY_TOKEN:}") String gatewayToken) {
        this.settings = settings; this.mapper = mapper; this.gatewayToken = gatewayToken;
        http = HttpClient.newBuilder().connectTimeout(Duration.ofMillis(settings.httpTimeoutMs())).followRedirects(HttpClient.Redirect.NEVER).build();
    }
    SupplierResult submit(Issuance job) throws IOException, InterruptedException {
        return send(HttpRequest.newBuilder(URI.create(settings.baseUrl() + "/orders"))
            .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(
                new MockSupplierService.Request(job.id(), job.orderId(), job.simulation())))), false).orElseThrow();
    }
    Optional<SupplierResult> lookup(Issuance job) throws IOException, InterruptedException {
        return lookup(job.id());
    }
    Optional<SupplierResult> lookup(UUID requestId) throws IOException,InterruptedException {
        if (requestId==null) throw new IllegalArgumentException("Supplier request ID is required");
        return send(HttpRequest.newBuilder(URI.create(settings.baseUrl()+"/orders/"+requestId)).GET(),true);
    }
    ExternalLedger.Page orderLedger(Instant from,Instant to,Instant afterTime,UUID afterId,int limit) throws IOException,InterruptedException {
        var path="/ledger/orders"+ExternalLedger.query(from,to,afterTime,afterId,limit);
        var response=http.send(HttpRequest.newBuilder(URI.create(settings.baseUrl()+path)).timeout(Duration.ofMillis(settings.httpTimeoutMs()))
            .header("Authorization","Bearer "+settings.apiKey()).header("X-Gateway-Token",gatewayToken).GET().build(),HttpResponse.BodyHandlers.ofString());
        if (response.statusCode()>=500) throw new IOException("SUPPLIER_LEDGER_UNAVAILABLE");
        if (response.statusCode()!=200) throw new InvalidResult();
        try {
            return ExternalLedger.validate(mapper.readValue(response.body(),ExternalLedger.Page.class),from,to,afterTime,afterId,limit,"SUPPLIER");
        } catch (RuntimeException e) { throw new InvalidResult(); }
    }
    List<ExternalLedger.Entry> ordersForOrder(UUID orderId) throws IOException,InterruptedException {
        if (orderId==null) throw new IllegalArgumentException("Order ID is required");
        var response=http.send(HttpRequest.newBuilder(URI.create(settings.baseUrl()+"/ledger/orders/by-order/"+orderId))
            .timeout(Duration.ofMillis(settings.httpTimeoutMs())).header("Authorization","Bearer "+settings.apiKey())
            .header("X-Gateway-Token",gatewayToken).GET().build(),HttpResponse.BodyHandlers.ofString());
        if (response.statusCode()>=500) throw new IOException("SUPPLIER_LEDGER_UNAVAILABLE");
        if (response.statusCode()!=200) throw new InvalidResult();
        try {
            return ExternalLedger.validateOrders(java.util.Arrays.asList(mapper.readValue(response.body(),ExternalLedger.Entry[].class)),orderId);
        } catch (RuntimeException e) { throw new InvalidResult(); }
    }
    ProfileSignal profile(String iccid) throws IOException,InterruptedException {
        return profileRequest(HttpRequest.newBuilder(URI.create(settings.baseUrl()+"/profiles/"+iccid)).GET());
    }
    ProfileSignal simulate(String iccid,java.util.UUID key,MockProfileService.Change change) throws IOException,InterruptedException {
        return profileRequest(HttpRequest.newBuilder(URI.create(settings.baseUrl()+"/profiles/"+iccid+"/simulate"))
            .header("Content-Type","application/json").header("Idempotency-Key",key.toString())
            .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(change))));
    }
    private ProfileSignal profileRequest(HttpRequest.Builder request) throws IOException,InterruptedException {
        var response=http.send(request.timeout(Duration.ofMillis(settings.httpTimeoutMs()))
            .header("Authorization","Bearer "+settings.apiKey()).header("X-Gateway-Token",gatewayToken).build(),HttpResponse.BodyHandlers.ofByteArray());
        if (response.statusCode()>=500) throw new IOException("SUPPLIER_UNAVAILABLE");
        if (response.statusCode()==400) throw new OrderService.OrderException(400,"INVALID_PROFILE_CHANGE","공급사 상태·개통 시각을 확인해 주세요. 개통 시각은 설치 시각 이후여야 합니다.");
        if (response.statusCode()==409) throw new OrderService.OrderException(409,"PROFILE_SIMULATION_CONFLICT","시연 상태를 되돌리거나 개통 시각·기존 요청 조건을 변경할 수 없습니다.");
        if (response.statusCode()!=200) throw new InvalidResult();
        try {
            var result=ProfileSignal.parse(mapper,response.body());
            if (result==null || !result.valid()) throw new InvalidResult();
            return result;
        } catch (RuntimeException exception) { throw new InvalidResult(); }
    }
    private Optional<SupplierResult> send(HttpRequest.Builder request, boolean allowMissing) throws IOException, InterruptedException {
        var response = http.send(request.timeout(Duration.ofMillis(settings.httpTimeoutMs()))
            .header("Authorization", "Bearer " + settings.apiKey()).header("X-Gateway-Token", gatewayToken).build(),
            HttpResponse.BodyHandlers.ofByteArray());
        if (allowMissing && response.statusCode() == 404) return Optional.empty();
        if (response.statusCode() >= 500) throw new IOException("SUPPLIER_UNAVAILABLE");
        if (response.statusCode()!=200 && !(response.statusCode()==202 && !allowMissing)) throw new InvalidResult();
        try {
            SupplierResult result = SupplierResult.parse(mapper, response.body());
            if (result == null || !result.valid()) throw new InvalidResult();
            return Optional.of(result);
        } catch (RuntimeException exception) { throw new InvalidResult(); }
    }
    @PreDestroy void close() { http.shutdownNow(); }
    static class InvalidResult extends RuntimeException {}
}
