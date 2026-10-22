package service;

import java.time.Instant;
import java.util.UUID;

public record PaymentAttempt(UUID id, UUID orderId, long amount, String currency, Scenario scenario,
        int webhookCopies, int webhookDelayMs, String status, String pgTransactionId,
        String declineCode, String lastError, int attemptCount, int executionRound, int roundAttemptCount,
        IssuanceSimulation issuance, Instant nextAttemptAt,
        Instant createdAt, Instant updatedAt) {
    public enum Scenario { APPROVE, DECLINE, RESPONSE_LOST }
}
