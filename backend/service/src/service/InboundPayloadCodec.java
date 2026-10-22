package service;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.util.Assert;

@Component
public class InboundPayloadCodec {
    private final SecretKeySpec key;
    private final SecureRandom random = new SecureRandom();
    public InboundPayloadCodec(@Value("${webhook.inbox-encryption-key:}") String encoded,
            PaymentSettings payment, IssuanceSettings issuance) {
        byte[] bytes = encoded.isBlank() ? null : Base64.getDecoder().decode(encoded);
        Assert.isTrue(bytes == null || bytes.length == 32, "WEBHOOK_INBOX_ENCRYPTION_KEY must be 32 base64-encoded bytes");
        Assert.isTrue(bytes != null || (!payment.mockEnabled() && !issuance.mockEnabled()),
                "WEBHOOK_INBOX_ENCRYPTION_KEY is required when mock webhooks are enabled");
        key = bytes == null ? null : new SecretKeySpec(bytes, "AES");
    }
    byte[] encrypt(String source, UUID eventId, byte[] body) {
        byte[] nonce = new byte[12]; random.nextBytes(nonce);
        try {
            byte[] encrypted = cipher(Cipher.ENCRYPT_MODE, source, eventId, nonce).doFinal(body);
            byte[] stored = new byte[13 + encrypted.length]; stored[0] = 1;
            System.arraycopy(nonce, 0, stored, 1, 12);
            System.arraycopy(encrypted, 0, stored, 13, encrypted.length);
            return stored;
        } catch (GeneralSecurityException e) { throw new IllegalStateException("Cannot protect webhook payload", e); }
    }
    byte[] decrypt(InboundEventRepository.Event event) {
        byte[] stored = event.body();
        if (stored.length < 29 || stored[0] != 1 || key == null) throw new UnreadablePayload();
        try {
            return cipher(Cipher.DECRYPT_MODE, event.source(), event.eventId(), Arrays.copyOfRange(stored, 1, 13))
                    .doFinal(stored, 13, stored.length - 13);
        } catch (GeneralSecurityException e) { throw new UnreadablePayload(); }
    }
    private Cipher cipher(int mode, String source, UUID eventId, byte[] nonce) throws GeneralSecurityException {
        if (key == null) throw new GeneralSecurityException("Inbox encryption key is unavailable");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(mode, key, new GCMParameterSpec(128, nonce));
        cipher.updateAAD((source + ":" + eventId).getBytes(StandardCharsets.UTF_8));
        return cipher;
    }
    static class UnreadablePayload extends RuntimeException {}
}
