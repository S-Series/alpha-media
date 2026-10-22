package service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import service.OrderService.OrderException;

@RestController
public class MockLedgerController {
    private final JdbcTemplate jdbc;
    private final PaymentSettings payment;
    private final IssuanceSettings issuance;
    public MockLedgerController(JdbcTemplate jdbc,PaymentSettings payment,IssuanceSettings issuance) {
        this.jdbc=jdbc; this.payment=payment; this.issuance=issuance;
    }

    @GetMapping("/internal/mock-pg/ledger/payments")
    ExternalLedger.Page payments(@RequestHeader(value="Authorization",required=false) String auth,
            @RequestParam @DateTimeFormat(iso=DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam @DateTimeFormat(iso=DateTimeFormat.ISO.DATE_TIME) Instant to,
            @RequestParam(required=false) @DateTimeFormat(iso=DateTimeFormat.ISO.DATE_TIME) Instant afterTime,
            @RequestParam(required=false) UUID afterId,@RequestParam(defaultValue="100") int limit) {
        authorize(payment.mockEnabled(),payment.apiKey(),auth);
        return page("mock_pg_payments p","p.payment_id","p.order_id","p.payment_id","p.created_at",from,to,afterTime,afterId,limit);
    }

    @GetMapping("/internal/mock-pg/ledger/cancellations")
    ExternalLedger.Page cancellations(@RequestHeader(value="Authorization",required=false) String auth,
            @RequestParam @DateTimeFormat(iso=DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam @DateTimeFormat(iso=DateTimeFormat.ISO.DATE_TIME) Instant to,
            @RequestParam(required=false) @DateTimeFormat(iso=DateTimeFormat.ISO.DATE_TIME) Instant afterTime,
            @RequestParam(required=false) UUID afterId,@RequestParam(defaultValue="100") int limit) {
        authorize(payment.mockEnabled(),payment.apiKey(),auth);
        return page("mock_pg_cancellations c JOIN mock_pg_payments p ON p.payment_id=c.payment_id",
            "c.id","p.order_id","c.payment_id","c.created_at",from,to,afterTime,afterId,limit);
    }

    @GetMapping("/internal/mock-supplier/ledger/orders")
    ExternalLedger.Page orders(@RequestHeader(value="Authorization",required=false) String auth,
            @RequestParam @DateTimeFormat(iso=DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam @DateTimeFormat(iso=DateTimeFormat.ISO.DATE_TIME) Instant to,
            @RequestParam(required=false) @DateTimeFormat(iso=DateTimeFormat.ISO.DATE_TIME) Instant afterTime,
            @RequestParam(required=false) UUID afterId,@RequestParam(defaultValue="100") int limit) {
        authorize(issuance.mockEnabled(),issuance.apiKey(),auth);
        return page("mock_supplier_orders s","s.request_id","s.order_id","NULL::uuid","s.ledger_updated_at",from,to,afterTime,afterId,limit);
    }

    @GetMapping("/internal/mock-supplier/ledger/orders/by-order/{orderId}")
    List<ExternalLedger.Entry> ordersForOrder(@RequestHeader(value="Authorization",required=false) String auth,@PathVariable UUID orderId) {
        authorize(issuance.mockEnabled(),issuance.apiKey(),auth);
        var rows=jdbc.query("SELECT request_id,order_id,ledger_updated_at FROM mock_supplier_orders WHERE order_id=? ORDER BY ledger_updated_at,request_id LIMIT 1001",
            (r,i)->new ExternalLedger.Entry(r.getObject("request_id",UUID.class),r.getObject("order_id",UUID.class),null,
                r.getTimestamp("ledger_updated_at").toInstant()),orderId);
        if (rows.size()>1000) throw new OrderException(409,"SUPPLIER_LEDGER_TOO_LARGE","공급사 요청 기록이 조회 한도를 초과하여 별도 확인이 필요합니다.");
        return rows;
    }

    @GetMapping("/internal/mock-pg/ledger/payments/{id}")
    @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    public ExternalLedger.PaymentSnapshot financial(@RequestHeader(value="Authorization",required=false) String auth,@PathVariable UUID id) {
        authorize(payment.mockEnabled(),payment.apiKey(),auth);
        var rows=jdbc.query("SELECT * FROM mock_pg_payments WHERE payment_id=?",MockPgService.RESULT,id);
        if (rows.isEmpty()) throw new OrderException(404,"PG_PAYMENT_NOT_FOUND","PG 결제 기록이 없습니다.");
        long total=jdbc.queryForObject("SELECT cancelled_amount FROM mock_pg_payments WHERE payment_id=?",Long.class,id);
        var cancellations=jdbc.query("SELECT * FROM mock_pg_cancellations WHERE payment_id=? ORDER BY created_at,id LIMIT 1001",MockPgService.CANCELLATION,id);
        if (cancellations.size()>1000) throw new OrderException(409,"PG_LEDGER_TOO_LARGE","취소 기록이 조회 한도를 초과하여 별도 확인이 필요합니다.");
        var times=new java.util.LinkedHashMap<UUID,Instant>();
        jdbc.query("SELECT id,created_at FROM mock_pg_cancellations WHERE payment_id=? ORDER BY created_at,id",
            (org.springframework.jdbc.core.RowCallbackHandler) row->times.put(row.getObject("id",UUID.class),row.getTimestamp("created_at").toInstant()),id);
        return new ExternalLedger.PaymentSnapshot(rows.getFirst(),total,cancellations,times);
    }

    private ExternalLedger.Page page(String table,String id,String order,String paymentId,String at,
            Instant from,Instant to,Instant afterTime,UUID afterId,int limit) {
        try { ExternalLedger.range(from,to,afterTime,afterId,limit); }
        catch (IllegalArgumentException e) { throw new OrderException(400,"INVALID_LEDGER_RANGE","원장 조회 기간·커서·페이지 크기를 확인해 주세요."); }
        var rows=jdbc.query("SELECT "+id+" AS id,"+order+" AS order_id,"+paymentId+" AS payment_id,"+at+" AS occurred_at FROM "+table
            +" WHERE "+at+">=? AND "+at+"<? AND (?::timestamptz IS NULL OR ("+at+","+id+")>(?::timestamptz,?::uuid))"
            +" ORDER BY "+at+","+id+" LIMIT ?",
            (r,i)->new ExternalLedger.Entry(r.getObject("id",UUID.class),r.getObject("order_id",UUID.class),r.getObject("payment_id",UUID.class),
                r.getTimestamp("occurred_at").toInstant()),Timestamp.from(from),Timestamp.from(to),
            afterTime==null?null:Timestamp.from(afterTime),afterTime==null?null:Timestamp.from(afterTime),afterId,limit+1);
        boolean more=rows.size()>limit; var items=rows.stream().limit(limit).toList();
        var last=more?items.getLast():null;
        return new ExternalLedger.Page(items,last==null?null:last.occurredAt(),last==null?null:last.id());
    }
    private static void authorize(boolean enabled,String key,String supplied) {
        if (!enabled) throw new OrderException(404,"MOCK_PROVIDER_DISABLED","모의 사업자가 활성화되지 않았습니다.");
        if (supplied==null || !MessageDigest.isEqual(("Bearer "+key).getBytes(StandardCharsets.UTF_8),supplied.getBytes(StandardCharsets.UTF_8)))
            throw new OrderException(401,"INVALID_PROVIDER_KEY","모의 사업자 인증이 필요합니다.");
    }
}
