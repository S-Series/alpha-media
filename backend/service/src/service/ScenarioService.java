package service;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import service.OrderService.OrderException;

@Service
public class ScenarioService {
    public enum Scenario { PENDING_PAYMENT, ISSUANCE_FAILED, ISSUED, REFUNDED, REFUND_REVIEW_REQUIRED }
    private final JdbcTemplate jdbc;
    private final OrderService orders;
    private final OrderRepository orderRows;
    private final PaymentService payments;
    private final IssuanceRepository issuances;
    private final RefundRepository refunds;
    private final AdminActionService actions;
    private final MemberRepository members;
    private final PlanRepository plans;
    private final PaymentSettings pg;
    private final IssuanceSettings supplier;
    public ScenarioService(JdbcTemplate jdbc,OrderService orders,OrderRepository orderRows,PaymentService payments,
            IssuanceRepository issuances,RefundRepository refunds,AdminActionService actions,MemberRepository members,
            PlanRepository plans,PaymentSettings pg,IssuanceSettings supplier) {
        this.jdbc=jdbc;this.orders=orders;this.orderRows=orderRows;this.payments=payments;this.issuances=issuances;
        this.refunds=refunds;this.actions=actions;this.members=members;this.plans=plans;this.pg=pg;this.supplier=supplier;
    }
    private void enabled() {
        if (!pg.mockEnabled() || !supplier.mockEnabled()) throw new OrderException(503,"SCENARIOS_DISABLED","모의 PG와 공급사를 켠 환경에서만 시연 데이터를 생성할 수 있습니다.");
    }
    public Options options() {
        enabled();
        var customers=jdbc.query("SELECT username,display_name FROM members WHERE role='USER' AND username IN ('customer1','customer2') ORDER BY username",
            (r,i)->new Customer(r.getString("username"),r.getString("display_name")));
        return new Options(customers,plans.findAll(null,null,null,Plan.SimType.ESIM).stream().filter(p->p.price()>0).toList());
    }
    @Transactional
    public Receipt create(Member actor,UUID key,ScenarioController.Request request) {
        enabled();
        if (Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM scenario_generations WHERE id=?)",Boolean.class,key)))
            return replay(actor,key,request);
        var customer=members.findByUsername(request.customer()).filter(m->"USER".equals(m.role())
            && List.of("customer1","customer2").contains(m.username())).orElseThrow(()->new OrderException(400,"INVALID_DEMO_CUSTOMER","고객 1 또는 고객 2를 선택하세요."));
        var plan=plans.findById(request.planId()).orElseThrow(()->new OrderException(404,"PLAN_NOT_FOUND","상품을 찾을 수 없습니다."));
        if (plan.simType()!=Plan.SimType.ESIM || plan.price()<=0) throw new OrderException(400,"INVALID_DEMO_PLAN","유료 eSIM 상품을 선택하세요.");
        // The unique request ID is reserved in the same transaction as the order and payment intake.
        int inserted=jdbc.update("INSERT INTO scenario_generations(id,actor_id,customer_id,plan_id,scenario) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
            key,actor.id(),customer.id(),plan.id(),request.scenario().name());
        if (inserted==0) return replay(actor,key,request);
        var order=orders.createScenario(actor.id(),customer.id(),key,plan.id(),LocalDate.now(ZoneId.of("Asia/Seoul"))).order();
        jdbc.update("UPDATE scenario_generations SET order_id=? WHERE id=?",order.id(),key);
        if (request.scenario()==Scenario.PENDING_PAYMENT) finish(key,"READY",null);
        else {
            var issue=request.scenario()==Scenario.ISSUED?IssuanceSimulation.Scenario.SUCCEED:IssuanceSimulation.Scenario.FAIL;
            payments.acceptScenario(actor.id(),customer.id(),order.id(),key,
                new PaymentController.Request(PaymentAttempt.Scenario.APPROVE,1,0,new IssuanceSimulation(issue,1,0)));
        }
        return new Receipt(detail(key),false);
    }
    private Receipt replay(Member actor,UUID key,ScenarioController.Request request) {
        var existing=detail(key);
        if (!actor.username().equals(existing.createdBy()) || !MemberRepository.normalizeUsername(request.customer()).equals(existing.customer())
                || !request.planId().equals(existing.planId()) || request.scenario()!=existing.scenario())
            throw new OrderException(409,"SCENARIO_KEY_CONFLICT","같은 생성 요청 키에 다른 운영자·고객·상품·시나리오를 사용할 수 없습니다.");
        return new Receipt(existing,true);
    }
    @Transactional
    public void advance() {
        if (!pg.mockEnabled() || !supplier.mockEnabled()) return;
        var due=jdbc.query("SELECT id FROM scenario_generations WHERE status='GENERATING' AND next_check_at<=clock_timestamp() ORDER BY next_check_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
            (r,i)->r.getObject("id",UUID.class));
        if (due.isEmpty()) return;
        var generation=detail(due.getFirst());
        var order=orderRows.lock(generation.orderId());
        if (generation.createdAt().plusSeconds(600).isBefore(Instant.now())) { finish(generation.id(),"FAILED","GENERATION_TIMEOUT");return; }
        jdbc.update("UPDATE scenario_generations SET next_check_at=clock_timestamp()+INTERVAL '1 second' WHERE id=?",generation.id());
        var actor=members.findByUsername(generation.createdBy()).orElse(null);
        if (actor==null || !"ADMIN".equals(actor.role())) { finish(generation.id(),"FAILED","OPERATOR_UNAVAILABLE");return; }
        var job=issuances.find(order.id()).orElse(null);
        var refund=refunds.find(order.id()).orElse(null);
        boolean hasSim=issuances.profile(order.id()).isPresent();
        if ("PAYMENT_PROCESSING".equals(order.status()) && !"REVIEW_REQUIRED".equals(generation.paymentStatus())) return;
        if ("PAID".equals(order.status()) && job!=null && List.of("QUEUED","PROCESSING","WAITING_CALLBACK").contains(job.status()) && refund==null) return;
        if (generation.scenario()==Scenario.ISSUED && "PAID".equals(order.status()) && job!=null
                && "ISSUED".equals(job.status()) && hasSim && refund==null) { finish(generation.id(),"READY",null);return; }
        if (generation.scenario()==Scenario.ISSUANCE_FAILED && "PAID".equals(order.status()) && job!=null
                && "FAILED".equals(job.status()) && !hasSim && refund==null) { finish(generation.id(),"READY",null);return; }
        if (generation.scenario()==Scenario.REFUNDED || generation.scenario()==Scenario.REFUND_REVIEW_REQUIRED) {
            if (refund==null && "PAID".equals(order.status()) && job!=null && "FAILED".equals(job.status()) && !hasSim) {
                actions.refund(actor.id(),order.id(),generation.id(),new AdminActionController.RefundRequest(job.id(),
                    "시나리오 데이터 생성: "+generation.scenario(),generation.scenario()==Scenario.REFUNDED?Refund.Scenario.SUCCESS:Refund.Scenario.UNAVAILABLE));
                return;
            }
            if (refund!=null) {
                if (generation.scenario()==Scenario.REFUNDED && "SUCCEEDED".equals(refund.status()) && "REFUNDED".equals(order.status())
                        || generation.scenario()==Scenario.REFUND_REVIEW_REQUIRED && "REVIEW_REQUIRED".equals(refund.status()) && "REFUND_PROCESSING".equals(order.status())) {
                    finish(generation.id(),"READY",null);return;
                }
                if (List.of("REQUESTED","PROCESSING","UNKNOWN").contains(refund.status())) return;
            }
        }
        finish(generation.id(),"FAILED","SCENARIO_STATE_CHANGED");
    }
    private void finish(UUID id,String status,String error) {
        jdbc.update("UPDATE scenario_generations SET status=?,last_error=?,updated_at=clock_timestamp() WHERE id=?",status,error,id);
    }
    public Generation detail(UUID id) {
        return jdbc.query("""
            SELECT g.id,g.scenario,g.plan_id,g.order_id,g.status,g.last_error,g.created_at,g.updated_at,
                a.username AS created_by,c.username AS customer,
                CASE WHEN o.status='PENDING_PAYMENT' AND o.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE o.status END AS order_status,
                p.status AS payment_status,j.status AS issuance_status,r.status AS refund_status,s.id AS sim_id
            FROM scenario_generations g JOIN members a ON a.id=g.actor_id JOIN members c ON c.id=g.customer_id
            LEFT JOIN orders o ON o.id=g.order_id
            LEFT JOIN LATERAL (SELECT status FROM payment_attempts WHERE order_id=g.order_id ORDER BY created_at DESC,id DESC LIMIT 1) p ON TRUE
            LEFT JOIN issuance_jobs j ON j.order_id=g.order_id AND j.is_current
            LEFT JOIN LATERAL (SELECT * FROM refunds WHERE order_id=g.order_id ORDER BY created_at DESC,id DESC LIMIT 1) r ON TRUE LEFT JOIN sim_profiles s ON s.order_id=g.order_id
            WHERE g.id=?
            """,MAPPER,id).stream().findFirst().orElseThrow(()->new OrderException(404,"GENERATION_NOT_FOUND","생성 요청을 찾을 수 없습니다. 처음 요청 키로 접수를 다시 확인하세요."));
    }
    private static final RowMapper<Generation> MAPPER=(r,i)->new Generation(r.getObject("id",UUID.class),Scenario.valueOf(r.getString("scenario")),
        r.getString("created_by"),r.getString("customer"),r.getString("plan_id"),r.getObject("order_id",UUID.class),r.getString("status"),r.getString("last_error"),
        r.getString("order_status"),r.getString("payment_status"),r.getString("issuance_status"),r.getString("refund_status"),r.getObject("sim_id",UUID.class),
        r.getTimestamp("created_at").toInstant(),r.getTimestamp("updated_at").toInstant());
    public record Customer(String username,String displayName) {}
    public record Options(List<Customer> customers,List<Plan> plans) {}
    public record Receipt(Generation generation,boolean replayed) {}
    public record Generation(UUID id,Scenario scenario,String createdBy,String customer,String planId,UUID orderId,String status,String lastError,
        String orderStatus,String paymentStatus,String issuanceStatus,String refundStatus,UUID simId,Instant createdAt,Instant updatedAt) {}
}
