package service;

import java.util.List;
import java.util.Optional;

import org.springframework.stereotype.Service;

@Service
public class PlanService {

    private final PlanRepository repository;

    public PlanService(PlanRepository repository) {
        this.repository = repository;
    }

    public List<Plan> findAll(String country, Integer days, Integer dataMb, Plan.SimType simType) {
        return repository.findAll(country, days, dataMb, simType);
    }

    public Optional<Plan> findById(String planId) {
        return repository.findById(planId);
    }
}
