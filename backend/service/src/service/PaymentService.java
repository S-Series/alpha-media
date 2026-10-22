package service;

import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import service.OrderService.OrderException;

@Service
public class PaymentService {
    private final OrderRepository orders;
    private final PaymentRepository payments;
    private final PaymentSettings settings;

    public PaymentService(OrderRepository orders, PaymentRepository payments, PaymentSettings settings) {
        this.orders = orders; this.payments = payments; this.settings = settings;
    }

    @Transactional
    public Acceptance accept(UUID memberId, UUID orderId, UUID key, PaymentController.Request request) {
        orders.historyContext(memberId,"PAYMENT_REQUEST",null);
        Order order = orders.lock(memberId, orderId).orElseThrow(() -> new OrderException(404, "ORDER_NOT_FOUND", "주문을 찾을 수 없습니다."));
        var existing = payments.findByKey(orderId, key);
        if (existing.isPresent()) {
            PaymentAttempt p = existing.get();
            if (p.scenario() != request.scenario() || p.webhookCopies() != request.webhookCopies()
                    || p.webhookDelayMs() != request.webhookDelayMs() || !p.issuance().equals(request.issuanceOrDefault())) {
                throw new OrderException(409, "IDEMPOTENCY_CONFLICT", "같은 요청 키에 다른 결제 조건을 사용할 수 없습니다.");
            }
            return new Acceptance(p, true);
        }
        if (!settings.mockEnabled()) throw new OrderException(503, "PAYMENTS_UNAVAILABLE", "모의 결제가 활성화되지 않았습니다.");
        if (!"PENDING_PAYMENT".equals(order.status())) {
            throw new OrderException(409, "ORDER_NOT_PAYABLE", "만료·결제 확인 중·결제 완료 주문은 새 결제를 시작할 수 없습니다.");
        }
        if (!orders.startPayment(orderId)) throw new OrderException(409, "ORDER_EXPIRED", "주문이 만료됐습니다.");
        return new Acceptance(payments.insert(order, key, request), false);
    }

    public List<PaymentAttempt> list(UUID memberId, UUID orderId) {
        owned(memberId, orderId); return payments.list(orderId);
    }

    public PaymentAttempt detail(UUID memberId, UUID orderId, UUID paymentId) {
        owned(memberId, orderId);
        return payments.find(orderId, paymentId).orElseThrow(() -> new OrderException(404, "PAYMENT_NOT_FOUND", "결제 시도를 찾을 수 없습니다."));
    }

    private void owned(UUID memberId, UUID orderId) {
        orders.findById(memberId, orderId).orElseThrow(() -> new OrderException(404, "ORDER_NOT_FOUND", "주문을 찾을 수 없습니다."));
    }

    public record Acceptance(PaymentAttempt payment, boolean replayed) {}
}
