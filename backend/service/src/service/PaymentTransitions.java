package service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.ObjectMapper;

import service.OrderService.OrderException;

@Service
public class PaymentTransitions {
    private final OrderRepository orders;
    private final PaymentRepository payments;
    private final PaymentSettings settings;
    private final ObjectMapper mapper;
    private final IssuanceRepository issuances;

    public PaymentTransitions(OrderRepository orders, PaymentRepository payments, PaymentSettings settings, ObjectMapper mapper,
            IssuanceRepository issuances) {
        this.orders = orders; this.payments = payments; this.settings = settings; this.mapper = mapper; this.issuances = issuances;
    }

    @Transactional
    public void result(PgResult result, UUID token, String source) {
        orders.historyContext(null,"PG_"+source,null);
        if (result == null || result.orderId() == null || result.paymentId() == null) {
            throw new OrderException(400, "INVALID_PG_RESULT", "PG 응답 형식이 올바르지 않습니다.");
        }
        // 사용자 접수와 동일하게 주문 → 결제 순서로 잠가 교착을 피한다.
        Order order;
        try { order = orders.lock(result.orderId()); }
        catch (java.util.NoSuchElementException exception) {
            throw new OrderException(404, "ORDER_NOT_FOUND", "PG 결과의 주문을 찾을 수 없습니다.");
        }
        payments.find(order.id(), result.paymentId()).orElseThrow(
                () -> new OrderException(404, "PAYMENT_NOT_FOUND", "PG 결과의 결제 시도를 찾을 수 없습니다."));
        PaymentAttempt payment = payments.lock(result.paymentId());
        if (token != null && !payments.ownsLease(payment.id(), token)) return;
        if (!result.matches(payment)) throw new OrderException(409, "PG_RESULT_MISMATCH", "PG 식별자·금액·통화·결과가 일치하지 않습니다.");
        boolean terminal = "APPROVED".equals(payment.status()) || "DECLINED".equals(payment.status());
        if (terminal && (!payment.status().equals(result.status())
                || !java.util.Objects.equals(payment.pgTransactionId(), result.transactionId()))) {
            throw new OrderException(409, "PG_RESULT_CONFLICT", "이미 확정된 결제 결과와 다릅니다.");
        }
        if (!terminal && !"PAYMENT_PROCESSING".equals(order.status())) {
            throw new OrderException(409, "ORDER_STATE_CONFLICT", "주문 상태를 확인해야 합니다.");
        }
        if (!payments.recordEvent(result, hash(result), "LOOKUP".equals(source)?"RESPONSE":source) || terminal) return;
        payments.complete(payment.id(), result);
        orders.finishPayment(order.id(), "APPROVED".equals(result.status()));
        // 결제 완료와 발급 작업을 함께 커밋해 브라우저 종료·서버 재시작에도 작업을 잃지 않는다.
        if ("APPROVED".equals(result.status())) issuances.enqueue(payment);
    }

    @Transactional
    public void uncertain(PaymentRepository.Claim claim, boolean forceReview, String error) {
        orders.historyContext(null,"PG_WORKER",error);
        orders.lock(claim.payment().orderId());
        PaymentAttempt current = payments.lock(claim.payment().id());
        if (!payments.ownsLease(current.id(), claim.token())) return;
        boolean review = forceReview || current.attemptCount() >= 6;
        payments.defer(current.id(), review, review && !forceReview ? "RETRY_LIMIT_REACHED" : error,
                settings.retryDelay(current.attemptCount()));
    }

    private String hash(PgResult result) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(mapper.writeValueAsString(result).getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException exception) { throw new IllegalStateException(exception); }
    }
}
