package service;

import java.time.Instant;
import java.util.UUID;

public record Issuance(UUID id, UUID orderId, IssuanceSimulation simulation, String status,
        String supplierOrderNo, int revision, int checkCount, String lastError, Instant createdAt, Instant updatedAt) {}
