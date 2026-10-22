package service;

import java.util.UUID;
import tools.jackson.databind.ObjectMapper;

public record PgResult(UUID eventId, UUID paymentId, UUID orderId, long amount, String currency,
        String status, String transactionId, String declineCode) {
    static PgResult parse(ObjectMapper mapper, byte[] body) {
        var tree = mapper.readTree(body);
        var amount = tree == null ? null : tree.get("amount");
        // 정수 금액을 소수에서 잘라 읽으면 다른 금액의 통지를 승인할 수 있다.
        if (amount == null || !amount.isIntegralNumber() || !amount.canConvertToLong()) {
            throw new IllegalArgumentException("PG amount must be an exact integer");
        }
        return mapper.treeToValue(tree, PgResult.class);
    }
    boolean matches(PaymentAttempt payment) {
        return eventId != null && payment.id().equals(paymentId) && payment.orderId().equals(orderId)
                && payment.amount() == amount && payment.currency().equals(currency)
                && (("APPROVED".equals(status) && transactionId != null && !transactionId.isBlank()
                        && transactionId.length() <= 120 && declineCode == null)
                    || ("DECLINED".equals(status) && transactionId == null
                        && "MOCK_CARD_DECLINED".equals(declineCode)));
    }
}
