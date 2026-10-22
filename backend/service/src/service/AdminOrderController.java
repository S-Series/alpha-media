package service;

import java.time.LocalDate;
import java.time.Instant;
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
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.annotation.Isolation;

@RestController
@RequestMapping("/api/admin/orders")
public class AdminOrderController {
    private final OrderRepository orders;
    private final PaymentRepository payments;
    private final IssuanceService issuances;
    private final RefundRepository refunds;
    private final AdminActionRepository actions;
    private final OrderConflicts conflicts;
    private final InboundEventRepository inboundEvents;
    private final RecoveryRepository recoveryActions;
    private final RecoveryTargets recoveryTargets;

    public AdminOrderController(OrderRepository orders, PaymentRepository payments, IssuanceService issuances,
            RefundRepository refunds,AdminActionRepository actions,OrderConflicts conflicts,InboundEventRepository inboundEvents,
            RecoveryRepository recoveryActions,RecoveryTargets recoveryTargets) {
        this.orders = orders; this.payments = payments; this.issuances = issuances; this.refunds=refunds; this.actions=actions; this.conflicts=conflicts;
        this.inboundEvents=inboundEvents;
        this.recoveryActions=recoveryActions; this.recoveryTargets=recoveryTargets;
    }

    @GetMapping
    ResponseEntity<Page> list(@RequestParam(defaultValue = "0") int page, @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String status, @RequestParam(required = false) String simType,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to,
            @RequestParam(defaultValue = "false") boolean needsReview,
            @RequestParam(required = false) String paymentStatus,
            @RequestParam(required = false) String issuanceStatus,
            @RequestParam(required = false) String installStatus) {
        if (page < 0 || size < 1 || size > 100 || (status != null && !Set.of(
                "PENDING_PAYMENT", "PAYMENT_PROCESSING", "PAID", "EXPIRED","REFUND_PROCESSING","REFUNDED").contains(status))
                || (simType != null && !Set.of("ESIM", "USIM").contains(simType))
                || (paymentStatus!=null && !Set.of("NOT_STARTED","QUEUED","PROCESSING","UNKNOWN","APPROVED","DECLINED","REVIEW_REQUIRED").contains(paymentStatus))
                || (issuanceStatus!=null && !Set.of("NOT_STARTED","QUEUED","PROCESSING","WAITING_CALLBACK","ISSUED","FAILED","REVIEW_REQUIRED").contains(issuanceStatus))
                || (installStatus!=null && !Set.of("NOT_ISSUED","ISSUED","QR_VIEWED","INSTALLED","ACTIVE","EXPIRED","DELETED").contains(installStatus))
                || (from != null && to != null && from.isAfter(to))) {
            throw new OrderService.OrderException(400, "INVALID_FILTER", "페이지·상태·기간 필터를 확인해 주세요.");
        }
        var rows = orders.findAllForAdmin(page,size,status,simType,from,to,needsReview,paymentStatus,issuanceStatus,installStatus);
        return ResponseEntity.ok().header("Cache-Control", "no-store")
                .body(new Page(rows.stream().limit(size).toList(),page,size,rows.size()>size,Instant.now()));
    }

    @GetMapping("/{orderId}")
    @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    ResponseEntity<Detail> detail(@PathVariable UUID orderId) {
        var order = orders.findForAdmin(orderId).orElseThrow(
                () -> new OrderService.OrderException(404, "ORDER_NOT_FOUND", "주문을 찾을 수 없습니다."));
        return ResponseEntity.ok().header("Cache-Control", "no-store").body(new Detail(order, payments.list(orderId), issuances.forOrder(orderId),
            refunds.find(orderId).orElse(null),actions.list(orderId),actions.events(orderId),timeline(orderId,null,50),Instant.now(),conflicts.list(orderId),inboundEvents.forOrder(orderId),
            recoveryTargets.list(orderId),recoveryActions.list(orderId)));
    }

    @GetMapping("/{orderId}/history")
    ResponseEntity<HistoryPage> history(@PathVariable UUID orderId,@RequestParam(required=false) Long before,
            @RequestParam(defaultValue="50") int size) {
        if ((before!=null && before<=0) || size<1 || size>100) throw new OrderService.OrderException(400,"INVALID_HISTORY_PAGE","이력 페이지를 확인해 주세요.");
        orders.findForAdmin(orderId).orElseThrow(()->new OrderService.OrderException(404,"ORDER_NOT_FOUND","주문을 찾을 수 없습니다."));
        return ResponseEntity.ok().header("Cache-Control","no-store").body(timeline(orderId,before,size));
    }
    private HistoryPage timeline(UUID orderId,Long before,int size) {
        var rows=orders.history(orderId,before,size);var items=rows.stream().limit(size).toList();
        return new HistoryPage(items,rows.size()>size?items.getLast().id():null,Instant.now());
    }
    public record HistoryPage(List<OrderRepository.HistoryEvent> items,String nextBefore,Instant checkedAt) {}
    public record Page(List<OrderRepository.AdminOrder> items,int page,int size,boolean hasNext,Instant checkedAt) {}
    public record Detail(OrderRepository.AdminOrder order, List<PaymentAttempt> payments, IssuanceService.View issuance,
        Refund refund,List<AdminActionRepository.Action> actions,List<AdminActionRepository.Event> actionEvents,HistoryPage timeline,Instant checkedAt,
        List<OrderConflicts.Conflict> conflicts,List<InboundEventRepository.View> inboundEvents,
        List<RecoveryTargets.View> recoveryTargets,List<RecoveryRepository.Action> recoveryActions) {}
}
