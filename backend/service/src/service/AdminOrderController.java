package service;

import java.time.LocalDate;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/admin/orders")
public class AdminOrderController {
    private final OrderRepository orders;
    private final PaymentRepository payments;
    private final IssuanceService issuances;

    public AdminOrderController(OrderRepository orders, PaymentRepository payments, IssuanceService issuances) {
        this.orders = orders; this.payments = payments; this.issuances = issuances;
    }

    @GetMapping
    ResponseEntity<Page> list(@RequestParam(defaultValue = "0") int page, @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String status, @RequestParam(required = false) String simType,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to,
            @RequestParam(defaultValue = "false") boolean needsReview) {
        if (page < 0 || size < 1 || size > 100 || (status != null && !Set.of(
                "PENDING_PAYMENT", "PAYMENT_PROCESSING", "PAID", "EXPIRED").contains(status))
                || (simType != null && !Set.of("ESIM", "USIM").contains(simType))
                || (from != null && to != null && from.isAfter(to))) {
            throw new OrderService.OrderException(400, "INVALID_FILTER", "페이지·상태·기간 필터를 확인해 주세요.");
        }
        var rows = orders.findAllForAdmin(page, size, status, simType, from, to, needsReview);
        return ResponseEntity.ok().header("Cache-Control", "no-store")
                .body(new Page(rows.stream().limit(size).toList(), page, size, rows.size() > size));
    }

    @GetMapping("/{orderId}")
    ResponseEntity<Detail> detail(@PathVariable UUID orderId) {
        var order = orders.findForAdmin(orderId).orElseThrow(
                () -> new OrderService.OrderException(404, "ORDER_NOT_FOUND", "주문을 찾을 수 없습니다."));
        return ResponseEntity.ok().header("Cache-Control", "no-store").body(new Detail(order, payments.list(orderId), issuances.forOrder(orderId)));
    }

    public record Page(List<OrderRepository.AdminOrder> items, int page, int size, boolean hasNext) {}
    public record Detail(OrderRepository.AdminOrder order, List<PaymentAttempt> payments, IssuanceService.View issuance) {}
}
