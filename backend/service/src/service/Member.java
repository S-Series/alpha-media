package service;

import java.time.Instant;
import java.util.UUID;

// passwordHash는 인증 내부에서만 사용한다. API에는 View만 반환한다.
public record Member(UUID id, String username, String displayName, String passwordHash,
        String role, Instant createdAt) {

    public View view() {
        return new View(id, username, displayName, role, createdAt);
    }

    public record View(UUID id, String username, String displayName, String role, Instant createdAt) {
    }
}
