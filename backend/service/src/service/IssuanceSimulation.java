package service;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;

public record IssuanceSimulation(@NotNull Scenario scenario,
        @NotNull @Min(0) @Max(20) Integer callbackCopies,
        @NotNull @Min(0) @Max(60000) Integer callbackDelayMs) {
    public enum Scenario { SUCCEED, FAIL }
    static IssuanceSimulation defaults() { return new IssuanceSimulation(Scenario.SUCCEED, 1, 2000); }
}
