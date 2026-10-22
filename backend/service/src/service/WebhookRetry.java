package service;

import java.net.http.HttpResponse;

final class WebhookRetry {
    static long delay(HttpResponse<?> response) {
        if (response.statusCode()!=429 && response.statusCode()!=503) return 0;
        try {
            long seconds=Long.parseLong(response.headers().firstValue("Retry-After").orElse("1"));
            return Math.clamp(seconds,1,300)*1000;
        } catch (NumberFormatException invalid) { return 1000; }
    }
}
