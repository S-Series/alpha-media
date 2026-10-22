package service;

import java.time.Instant;
import java.util.UUID;

public record Refund(UUID id, UUID orderId, UUID paymentId, long amount, String currency, Scenario scenario,
    String status, int attemptCount, int executionRound, int roundAttemptCount,
    UUID pgCancellationId, String lastError, Instant createdAt, Instant updatedAt) {
    public enum Scenario { SUCCESS, RESPONSE_LOST, UNAVAILABLE, DECLINED }
}
