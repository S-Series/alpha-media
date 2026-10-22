package service;

import java.time.Instant;
import java.util.UUID;

public record SimProfile(UUID id, UUID orderId, UUID issuanceId, String supplierOrderNo,
        String iccid, String activationCode, String installStatus, Instant issuedAt) {}
