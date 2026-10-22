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
    private final OrderConflicts conflicts;

    public PaymentTransitions(OrderRepository orders, PaymentRepository payments, PaymentSettings settings, ObjectMapper mapper,
            IssuanceRepository issuances, OrderConflicts conflicts) {
        this.orders = orders; this.payments = payments; this.settings = settings; this.mapper = mapper; this.issuances = issuances; this.conflicts=conflicts;
    }

    @Transactional(noRollbackFor=OrderConflicts.ConflictException.class)
    public void resultForClaim(PgResult result, PaymentRepository.Claim claim, String source) {
        orders.lock(claim.payment().orderId());
        var current=payments.lock(claim.payment().id());
        if (!payments.ownsLease(current.id(),claim.token())) return;
        if (!result.matches(current)) throw conflicts.reject(current.orderId(),"PAYMENT",current.id(),"PG_RESULT_MISMATCH",
            "PG_"+source,current.status(),result.status(),hash(result));
        result(result,claim.token(),source);
    }

    @Transactional
    public boolean mayApprove(PaymentRepository.Claim claim) {
        var order=orders.lock(claim.payment().orderId());
        var payment=payments.lock(claim.payment().id());
        if (!payments.ownsLease(claim.payment().id(),claim.token())) return false;
        if (conflicts.blocked(claim.payment().orderId())) {
            uncertain(claim,true,"ORDER_RESULT_CONFLICT"); return false;
        }
        if (payment.executionRound()>1 && !order.expiresAt().isAfter(java.time.Instant.now())) {
            uncertain(claim,true,"ORDER_PAYMENT_DEADLINE_PASSED"); return false;
        }
        return true;
    }

    @Transactional(noRollbackFor=OrderConflicts.ConflictException.class)
    public void result(PgResult result, UUID token, String source) {
        orders.historyContext(null,"PG_"+source,null);
        if (result == null || result.orderId() == null || result.paymentId() == null) {
            throw new OrderException(400, "INVALID_PG_RESULT", "PG 응답 형식이 올바르지 않습니다.");
        }
        // 사용자 접수와 동일하게 주문 → 결제 순서로 잠가 교착을 피한다.
        var referenced=payments.findById(result.paymentId()).orElseThrow(
                () -> new OrderException(404, "PAYMENT_NOT_FOUND", "PG 결과의 결제 시도를 찾을 수 없습니다."));
        Order order=orders.lock(referenced.orderId());
        PaymentAttempt payment = payments.lock(result.paymentId());
        if (token != null && !payments.ownsLease(payment.id(), token)) return;
        if (!result.matches(payment)) throw conflicts.reject(order.id(),"PAYMENT",payment.id(),"PG_RESULT_MISMATCH",
            "PG_"+source,payment.status(),result.status(),hash(result));
        boolean terminal = "APPROVED".equals(payment.status()) || "DECLINED".equals(payment.status());
        if (terminal && (!payment.status().equals(result.status())
                || !java.util.Objects.equals(payment.pgTransactionId(), result.transactionId()))) {
            throw conflicts.reject(order.id(),"PAYMENT",payment.id(),"PG_RESULT_CONFLICT",
                "PG_"+source,payment.status(),result.status(),hash(result));
        }
        if (!terminal && !"PAYMENT_PROCESSING".equals(order.status())) {
            throw new OrderException(409, "ORDER_STATE_CONFLICT", "주문 상태를 확인해야 합니다.");
        }
        conflicts.requireClear(order.id());
        if (result.transactionId()!=null) {
            conflicts.lockExternal("PG_TRANSACTION:"+result.transactionId());
            if (payments.transactionUsedByAnother(result.transactionId(),payment.id())) {
                throw conflicts.reject(order.id(),"PAYMENT",payment.id(),"PG_TRANSACTION_CONFLICT",
                    "PG_"+source,payment.status(),result.status(),hash(result));
            }
        }
        boolean fresh;
        try { fresh=payments.recordEvent(result, hash(result), "LOOKUP".equals(source)?"RESPONSE":source); }
        catch (OrderException e) {
            if (!"EVENT_CONFLICT".equals(e.code)) throw e;
            throw conflicts.reject(order.id(),"PAYMENT",payment.id(),e.code,"PG_"+source,payment.status(),result.status(),hash(result));
        }
        if (!fresh || terminal) return;
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
        boolean review = forceReview || current.roundAttemptCount() >= PaymentRepository.MAX_ROUND_ATTEMPTS;
        payments.defer(current.id(), review, review && !forceReview ? "RETRY_LIMIT_REACHED" : error,
                settings.retryDelay(current.roundAttemptCount()));
    }

    private String hash(PgResult result) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(mapper.writeValueAsString(result).getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException exception) { throw new IllegalStateException(exception); }
    }
}
