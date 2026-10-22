package service;

import java.net.URI;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.util.Assert;

@ConfigurationProperties("payment")
public record PaymentSettings(boolean mockEnabled, String pgBaseUrl, String webhookUrl,
        String apiKey, String webhookSecret, int httpTimeoutMs, int leaseMs, int retryBaseMs, int workerDelayMs) {
    public PaymentSettings {
        if (mockEnabled) {
            Assert.isTrue(apiKey != null && apiKey.length() >= 32, "MOCK_PG_API_KEY requires 32 characters");
            Assert.isTrue(webhookSecret != null && webhookSecret.length() >= 32, "PG_WEBHOOK_SECRET requires 32 characters");
            Assert.isTrue(httpTimeoutMs >= 100 && leaseMs > 2L * httpTimeoutMs,
                    "Payment lease must exceed two HTTP timeouts");
            Assert.isTrue(retryBaseMs >= 100 && workerDelayMs >= 50, "Payment intervals are too short");
            for (String url : new String[] { pgBaseUrl, webhookUrl }) {
                URI uri = URI.create(url);
                Assert.isTrue(("http".equals(uri.getScheme()) || "https".equals(uri.getScheme()))
                        && uri.getHost() != null && uri.getUserInfo() == null && uri.getFragment() == null
                        && uri.getQuery() == null, "Payment URL must be an HTTP(S) address without credentials");
            }
        }
    }

    long retryDelay(int count) {
        return Math.min(30000L, retryBaseMs * (1L << Math.min(Math.max(0, count - 1), 5)));
    }
}
