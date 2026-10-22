package service;

import java.time.Instant;
import java.util.Set;
import java.util.UUID;

public record ProfileSignal(UUID eventId, UUID requestId, UUID orderId, String iccid, String state,
        long revision, Instant observedAt, Instant installedAt, Instant activatedAt) {
    public ProfileSignal {
        // PostgreSQL stores microseconds; normalize before hashing or replay comparison.
        if (observedAt!=null) observedAt=observedAt.truncatedTo(java.time.temporal.ChronoUnit.MICROS);
        if (installedAt!=null) installedAt=installedAt.truncatedTo(java.time.temporal.ChronoUnit.MICROS);
        if (activatedAt!=null) activatedAt=activatedAt.truncatedTo(java.time.temporal.ChronoUnit.MICROS);
    }
    static ProfileSignal parse(tools.jackson.databind.ObjectMapper mapper,byte[] body) {
        var tree=mapper.readTree(body);
        var revision=tree==null?null:tree.get("revision");
        if (revision==null || !revision.isIntegralNumber() || !revision.canConvertToLong()) throw new IllegalArgumentException("Invalid profile revision");
        return mapper.treeToValue(tree,ProfileSignal.class);
    }
    boolean valid() {
        if (eventId==null || requestId==null || orderId==null || !SupplierResult.validIccid(iccid)
                || state==null || !Set.of("RELEASED","INSTALLED","ENABLED","DELETED").contains(state)
                || revision<1 || observedAt==null || observedAt.isAfter(Instant.now().plusSeconds(5))) return false;
        if (installedAt!=null && installedAt.isAfter(observedAt)) return false;
        if (activatedAt!=null && (installedAt==null || activatedAt.isBefore(installedAt) || activatedAt.isAfter(observedAt))) return false;
        return switch (state) {
            case "RELEASED" -> installedAt==null && activatedAt==null;
            case "INSTALLED" -> installedAt!=null && activatedAt==null;
            case "ENABLED" -> installedAt!=null && activatedAt!=null;
            default -> true;
        };
    }
}
