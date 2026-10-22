package service;

import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

public record Order(UUID id, String planId, String planName, String country, int days, int dataMb,
        String simType, LocalDate travelStartDate, long amount, String currency, String status,
        Instant createdAt, Instant expiresAt, Instant updatedAt) {
}
