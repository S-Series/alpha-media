package service;

import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.ObjectMapper;

@Service
@ConditionalOnProperty(name="issuance.mock-enabled",havingValue="true")
public class MockRefundProtectionService {
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    public MockRefundProtectionService(JdbcTemplate jdbc,ObjectMapper mapper) { this.jdbc=jdbc; this.mapper=mapper; }
    RefundProtection.Result lookup(String iccid,UUID operation) {
        return jdbc.query("SELECT o.body FROM mock_supplier_hold_operations o JOIN mock_supplier_holds h ON h.refund_id=o.refund_id WHERE o.id=? AND h.iccid=?",
            (r,i)->mapper.readValue(r.getString(1),RefundProtection.Result.class),operation,iccid).stream().findFirst()
            .orElseThrow(()->new OrderService.OrderException(404,"HOLD_NOT_FOUND","공급사 차단 처리 기록이 없습니다."));
    }
    @Transactional
    public Reply execute(String iccid,UUID operation,RefundProtection.Request request) {
        if (request==null || request.refundId()==null || request.orderId()==null || request.scenario()==null || request.phase()==null
                || !java.util.List.of("HOLD","RELEASE","TERMINATE").contains(request.phase())) throw invalid();
        var profiles=jdbc.query("SELECT * FROM mock_supplier_profiles WHERE iccid=? FOR UPDATE",MockProfileService.SIGNAL,iccid);
        if (profiles.isEmpty()) throw new OrderService.OrderException(503,"SUPPLIER_PROFILE_PENDING","공급사 프로필 생성 확인 중입니다.");
        if (!profiles.getFirst().orderId().equals(request.orderId())) throw invalid();
        var profile=profiles.getFirst();
        var previous=jdbc.queryForList("SELECT * FROM mock_supplier_hold_operations WHERE id=? OR (refund_id=? AND phase=?)",operation,request.refundId(),request.phase());
        if (!previous.isEmpty()) {
            var old=previous.getFirst();
            var result=mapper.readValue((String)old.get("body"),RefundProtection.Result.class);
            if (!operation.equals(old.get("id")) || !request.refundId().equals(result.refundId()) || !iccid.equals(result.iccid())
                    || !request.orderId().equals(result.orderId()) || !request.phase().equals(result.phase()) || !request.scenario().name().equals(old.get("scenario"))) throw invalid();
            return new Reply(result,false);
        }
        if (request.scenario()==RefundProtection.Scenario.UNAVAILABLE) throw new OrderService.OrderException(503,"HOLD_UNAVAILABLE","공급사 차단 처리 장애입니다.");
        String state;
        if ("HOLD".equals(request.phase())) {
            boolean terminated=Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM mock_supplier_holds WHERE iccid=? AND state='TERMINATED')",Boolean.class,iccid));
            state=profile.installedAt()==null && profile.activatedAt()==null && ("RELEASED".equals(profile.state()) || terminated)?"BLOCKED":"REJECTED";
            jdbc.update("INSERT INTO mock_supplier_holds(refund_id,order_id,iccid,state) VALUES(?,?,?,?)",request.refundId(),request.orderId(),iccid,state);
        } else {
            var holds=jdbc.queryForList("SELECT * FROM mock_supplier_holds WHERE refund_id=?",request.refundId());
            if (holds.isEmpty() || !iccid.equals(holds.getFirst().get("iccid")) || !"BLOCKED".equals(holds.getFirst().get("state"))) throw invalid();
            state="TERMINATE".equals(request.phase())?"TERMINATED":"RELEASED";
            jdbc.update("UPDATE mock_supplier_holds SET state=? WHERE refund_id=?",state,request.refundId());
            if ("TERMINATED".equals(state)) {
                jdbc.update("UPDATE mock_supplier_profiles SET state='DELETED',revision=revision+1,event_id=?,observed_at=clock_timestamp() WHERE iccid=?",UUID.randomUUID(),iccid);
                profile=jdbc.query("SELECT * FROM mock_supplier_profiles WHERE iccid=?",MockProfileService.SIGNAL,iccid).getFirst();
            }
        }
        var result=new RefundProtection.Result(operation,request.refundId(),request.orderId(),iccid,request.phase(),state,profile);
        jdbc.update("INSERT INTO mock_supplier_hold_operations(id,refund_id,phase,scenario,body) VALUES(?,?,?,?,?)",
            operation,request.refundId(),request.phase(),request.scenario().name(),mapper.writeValueAsString(result));
        return new Reply(result,request.scenario()==RefundProtection.Scenario.RESPONSE_LOST);
    }
    private static OrderService.OrderException invalid() { return new OrderService.OrderException(409,"HOLD_REQUEST_CONFLICT","공급사 차단 식별자·상태를 확인해야 합니다."); }
    record Reply(RefundProtection.Result result,boolean loseResponse) {}
}
