package service;

import org.springframework.http.ResponseEntity;
import org.springframework.dao.DataAccessException;
import org.springframework.transaction.TransactionException;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class MonitoringController {
    private final MonitoringService monitoring;
    public MonitoringController(MonitoringService monitoring) { this.monitoring=monitoring; }
    @GetMapping("/api/admin/monitoring")
    ResponseEntity<?> snapshot() {
        try { return ResponseEntity.ok().header("Cache-Control","no-store").body(monitoring.snapshot()); }
        catch (DataAccessException | TransactionException unavailable) {
            return ResponseEntity.status(503).header("Cache-Control","no-store")
                .body(new ApiError("MONITORING_UNAVAILABLE","감시 데이터를 조회하지 못했습니다. 현재 정상 여부를 확인할 수 없습니다."));
        }
    }
}
