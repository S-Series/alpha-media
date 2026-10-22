package service;

import java.util.UUID;
import tools.jackson.databind.ObjectMapper;

public record SupplierResult(UUID eventId, UUID requestId, UUID orderId, String supplierOrderNo,
        String status, int revision, String iccid, String activationCode, String reason) {
    static SupplierResult parse(ObjectMapper mapper, byte[] body) {
        var tree = mapper.readTree(body);
        var revision = tree == null ? null : tree.get("revision");
        if (revision == null || !revision.isIntegralNumber() || !revision.canConvertToInt()) {
            throw new IllegalArgumentException("Invalid supplier revision");
        }
        return mapper.treeToValue(tree, SupplierResult.class);
    }

    boolean valid() {
        if (eventId == null || requestId == null || orderId == null || supplierOrderNo == null
                || supplierOrderNo.isBlank() || supplierOrderNo.length() > 100) return false;
        return switch (status == null ? "" : status) {
            case "ACCEPTED" -> revision == 1 && iccid == null && activationCode == null && reason == null;
            case "ISSUED" -> revision == 2 && validIccid(iccid) && activationCode != null
                    && activationCode.startsWith("LPA:1$") && activationCode.length() <= 200 && reason == null;
            case "FAILED" -> revision == 2 && iccid == null && activationCode == null
                    && "MOCK_ISSUANCE_FAILED".equals(reason);
            default -> false;
        };
    }

    static boolean validIccid(String value) {
        if (value == null || !value.matches("[0-9]{19,20}")) return false;
        int sum = 0;
        boolean doubleDigit = false;
        for (int i = value.length() - 1; i >= 0; i--) {
            int digit = value.charAt(i) - '0';
            if (doubleDigit) { digit *= 2; if (digit > 9) digit -= 9; }
            sum += digit; doubleDigit = !doubleDigit;
        }
        return sum % 10 == 0;
    }
}
