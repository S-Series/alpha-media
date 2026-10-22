package service;

import java.util.List;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

// Gateway가 전달한 /api/plans 요청을 받아 JSON 응답을 만든다.
@RestController
@RequestMapping("/api/plans")
public class PlanController {

    private final PlanService planService;

    // Spring이 @Service로 등록한 PlanService 객체를 생성자에 전달한다.
    public PlanController(PlanService planService) {
        this.planService = planService;
    }

    @GetMapping
    public List<Plan> list(
            @RequestParam(required = false) String country,
            @RequestParam(required = false) Integer days,
            @RequestParam(required = false) Integer dataMb,
            @RequestParam(required = false) Plan.SimType simType) {
        if ((days != null && days <= 0) || (dataMb != null && dataMb <= 0)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        }
        return planService.findAll(country, days, dataMb, simType);
    }

    @GetMapping("/{planId}")
    public Plan detail(@PathVariable String planId) {
        return planService.findById(planId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
    }
}
