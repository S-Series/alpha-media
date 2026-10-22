package service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

final class PgSignature {
    static String sign(byte[] body, String secret, String source, String keyId, String timestamp) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            mac.update(("v1\n"+source+"\n"+keyId+"\n"+timestamp+"\n").getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(mac.doFinal(body));
        } catch (java.security.GeneralSecurityException exception) { throw new IllegalStateException(exception); }
    }

    static boolean verify(byte[] body, String supplied, String secret, String source, String keyId, String timestamp) {
        if (supplied == null || !supplied.matches("[0-9a-f]{64}")) return false;
        return MessageDigest.isEqual(sign(body, secret, source, keyId, timestamp).getBytes(StandardCharsets.US_ASCII), supplied.getBytes(StandardCharsets.US_ASCII));
    }
}
