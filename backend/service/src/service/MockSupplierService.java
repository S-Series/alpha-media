package service;

import java.util.UUID;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@ConditionalOnProperty(name = "issuance.mock-enabled", havingValue = "true")
public class MockSupplierService {
    static final RowMapper<SupplierResult> RESULT = (r, i) -> {
        String status = r.getString("status");
        boolean accepted = "ACCEPTED".equals(status), issued = "ISSUED".equals(status);
        return new SupplierResult(r.getObject(accepted ? "accepted_event_id" : "result_event_id", UUID.class),
            r.getObject("request_id", UUID.class), r.getObject("order_id", UUID.class), r.getString("supplier_order_no"),
            status, accepted ? 1 : 2, issued ? r.getString("iccid") : null, issued ? r.getString("activation_code") : null,
            "FAILED".equals(status) ? "MOCK_ISSUANCE_FAILED" : null);
    };
    private final JdbcTemplate jdbc;
    private final IssuanceSettings settings;
    public MockSupplierService(JdbcTemplate jdbc, IssuanceSettings settings) { this.jdbc = jdbc; this.settings = settings; }

    @Transactional
    public SupplierResult submit(Request request) {
        var config = request.simulation();
        boolean success = config.scenario() == IssuanceSimulation.Scenario.SUCCEED;
        int inserted = jdbc.update("""
            INSERT INTO mock_supplier_orders(request_id,order_id,supplier_order_no,accepted_event_id,result_event_id,
                scenario,callback_copies,callback_delay_ms,iccid,activation_code,ready_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,clock_timestamp()+(? * INTERVAL '1 millisecond'))
            ON CONFLICT(request_id) DO NOTHING
            """, request.requestId(), request.orderId(), "supplier_" + request.requestId(), UUID.randomUUID(), UUID.randomUUID(),
            config.scenario().name(), config.callbackCopies(), config.callbackDelayMs(), success ? iccid(request.requestId()) : null,
            success ? "LPA:1$smdp.example$" + request.requestId() : null, settings.completionDelayMs());
        var old = jdbc.queryForMap("SELECT * FROM mock_supplier_orders WHERE request_id=? FOR UPDATE", request.requestId());
        if (!request.orderId().equals(old.get("order_id")) || !config.scenario().name().equals(old.get("scenario"))
                || config.callbackCopies() != ((Number) old.get("callback_copies")).intValue()
                || config.callbackDelayMs() != ((Number) old.get("callback_delay_ms")).intValue()) {
            throw new OrderService.OrderException(409, "SUPPLIER_IDEMPOTENCY_CONFLICT", "같은 발급 요청번호에 다른 조건을 사용할 수 없습니다.");
        }
        if (inserted == 0) jdbc.update("UPDATE mock_supplier_orders SET request_count=request_count+1 WHERE request_id=?", request.requestId());
        return lookup(request.requestId());
    }
    public SupplierResult lookup(UUID id) {
        return jdbc.query("SELECT * FROM mock_supplier_orders WHERE request_id=?", RESULT, id).stream().findFirst()
            .orElseThrow(() -> new OrderService.OrderException(404, "SUPPLIER_ORDER_NOT_FOUND", "공급사 발급 요청이 없습니다."));
    }
    public Stats stats(UUID id) {
        return jdbc.query("SELECT * FROM mock_supplier_orders WHERE request_id=?", (r, i) -> new Stats(
            r.getInt("request_count"), r.getInt("issue_executions"), r.getInt("callback_sent"), r.getInt("callback_failures")), id)
            .stream().findFirst().orElseThrow(() -> new OrderService.OrderException(404, "SUPPLIER_ORDER_NOT_FOUND", "공급사 발급 요청이 없습니다."));
    }
    private String iccid(UUID id) {
        String body = "8982" + String.format(java.util.Locale.ROOT, "%014d", Math.floorMod(id.getMostSignificantBits(), 100000000000000L));
        for (int digit = 0; digit <= 9; digit++) if (SupplierResult.validIccid(body + digit)) return body + digit;
        throw new IllegalStateException("ICCID check digit not found");
    }
    public record Request(@NotNull UUID requestId, @NotNull UUID orderId, @NotNull @Valid IssuanceSimulation simulation) {}
    public record Stats(int requestCount, int issueExecutions, int callbackSent, int callbackFailures) {}
}
