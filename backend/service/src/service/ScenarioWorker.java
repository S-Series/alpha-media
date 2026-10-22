package service;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class ScenarioWorker {
    private final ScenarioService scenarios;
    public ScenarioWorker(ScenarioService scenarios) { this.scenarios=scenarios; }
    @Scheduled(fixedDelay=1000,initialDelay=1000)
    public void tick() { scenarios.advance(); }
}
