package service;

import java.time.Instant;
import java.util.UUID;

public record SimProfile(UUID id, UUID orderId, UUID issuanceId, String supplierOrderNo,
        String iccid, String activationCode, String installStatus, Instant issuedAt,
        Instant qrViewedAt, Instant installedAt, Instant activatedAt, Instant expiresAt,
        String supplierState, long supplierRevision, Instant lastSyncedAt, String syncError) {
    public SimProfile {
        if ("ACTIVE".equals(installStatus) && expiresAt!=null && !Instant.now().isBefore(expiresAt)) installStatus="EXPIRED";
    }
}
