package service;

import java.net.URI;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.util.Assert;

@ConfigurationProperties("issuance")
public record IssuanceSettings(boolean mockEnabled, String baseUrl, String webhookUrl, String apiKey,
        String webhookSecret, int httpTimeoutMs, int leaseMs, int pollMs, int workerDelayMs, int completionDelayMs) {
    public IssuanceSettings {
        if (mockEnabled) {
            Assert.isTrue(apiKey != null && apiKey.length() >= 32, "SUPPLIER_API_KEY requires 32 characters");
            Assert.isTrue(webhookSecret != null && webhookSecret.length() >= 32, "SUPPLIER_WEBHOOK_SECRET requires 32 characters");
            Assert.isTrue(httpTimeoutMs >= 100 && leaseMs > 2L * httpTimeoutMs, "Issuance lease is too short");
            Assert.isTrue(pollMs >= 100 && workerDelayMs >= 50 && completionDelayMs >= 0, "Invalid issuance intervals");
            for (String value : new String[] { baseUrl, webhookUrl }) {
                URI uri = URI.create(value);
                Assert.isTrue(("http".equals(uri.getScheme()) || "https".equals(uri.getScheme()))
                    && uri.getHost() != null && uri.getUserInfo() == null && uri.getFragment() == null
                    && uri.getQuery() == null, "Invalid supplier URL");
            }
        }
    }
}
