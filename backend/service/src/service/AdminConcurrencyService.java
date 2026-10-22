package service;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import jakarta.annotation.PreDestroy;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import service.OrderService.OrderException;

@Service
public class AdminConcurrencyService {
    public enum Mode { REFUND_REFUND, RETRY_RETRY, REFUND_RETRY }
    public enum KeyMode { SEPARATE, SHARED }
    private final Map<UUID,Round> rounds=new ConcurrentHashMap<>();
    private final ExecutorService executor=Executors.newFixedThreadPool(4);
    private final Semaphore slots=new Semaphore(2);
    private final AdminActionService actions;
    private final MemberRepository members;
    private final JdbcTemplate jdbc;
    private final PaymentSettings payment;
    private final IssuanceSettings issuance;
    public AdminConcurrencyService(AdminActionService actions,MemberRepository members,JdbcTemplate jdbc,
            PaymentSettings payment,IssuanceSettings issuance) {
        this.actions=actions;this.members=members;this.jdbc=jdbc;this.payment=payment;this.issuance=issuance;
    }
    public View create(Member actor,UUID orderId,UUID key,AdminConcurrencyController.Request request) {
        enabled();
        if (request.mode()==Mode.REFUND_RETRY && request.keyMode()==KeyMode.SHARED)
            throw new OrderException(400,"INVALID_DEMO_MODE","서로 다른 조치는 각각 다른 요청 키를 사용하세요.");
        Round round;
        synchronized(rounds) {
            round=rounds.get(key);
            if (round!=null) {
                if (round.expiresAt.isBefore(Instant.now())) throw new OrderException(404,"DEMO_NOT_FOUND","시연 번호가 만료됐습니다. 새 시연을 준비하세요.");
                if (!round.orderId.equals(orderId) || !round.creator.equals(actor.id()) || !round.request.equals(request))
                    throw new OrderException(409,"DEMO_KEY_CONFLICT","같은 시연 키에 다른 설정을 사용할 수 없습니다.");
            } else {
                rounds.values().removeIf(r -> r.expiresAt.isBefore(Instant.now()) && r.finished());
                if (rounds.size()>=100) throw new OrderException(429,"DEMO_CAPACITY","시연 대기 공간이 가득 찼습니다. 만료 후 다시 시도하세요.");
                boolean eligible=Boolean.TRUE.equals(jdbc.queryForObject("""
                    SELECT EXISTS(SELECT 1 FROM orders o JOIN issuance_jobs j ON j.order_id=o.id AND j.is_current
                        WHERE o.id=? AND o.status='PAID' AND j.id=? AND j.status='FAILED'
                        AND NOT EXISTS(SELECT 1 FROM refunds WHERE order_id=o.id)
                        AND NOT EXISTS(SELECT 1 FROM sim_profiles WHERE order_id=o.id))
                    """,Boolean.class,orderId,request.issuanceId()));
                if (!eligible) throw new OrderException(409,"DEMO_NOT_ELIGIBLE","현재 발급 실패가 확정되고 SIM·환불이 없는 주문을 선택하세요.");
                round=new Round(orderId,key,actor.id(),request);
                round.add(actor);
                rounds.put(key,round);
            }
        }
        return snapshot(round,actor);
    }
    public View view(Member actor,UUID orderId,UUID id) { return snapshot(find(orderId,id),actor); }
    public View join(Member actor,UUID orderId,UUID id) {
        Round round=find(orderId,id);
        synchronized(round) {
            if (round.people.stream().noneMatch(p -> p.actorId.equals(actor.id()))) {
                if (round.started || round.people.size()==2) throw new OrderException(409,"DEMO_FULL","다른 운영자 두 명이 이미 참가했습니다.");
                round.add(actor);
            }
        }
        return snapshot(round,actor);
    }
    public View start(Member actor,UUID orderId,UUID id) {
        Round round=find(orderId,id);
        synchronized(round) {
            if (round.people.stream().noneMatch(p -> p.actorId.equals(actor.id())))
                throw new OrderException(403,"DEMO_PARTICIPANT_REQUIRED","참가한 운영자만 시연을 실행할 수 있습니다.");
            if (!round.started) {
                if (round.people.size()!=2) throw new OrderException(409,"SECOND_OPERATOR_REQUIRED","서로 다른 운영자 두 명이 참가해야 합니다.");
                if (!slots.tryAcquire()) throw new OrderException(429,"DEMO_BUSY","다른 시연을 처리 중입니다. 잠시 후 다시 시도하세요.");
                round.started=true;
                var gate=new CyclicBarrier(2);
                try {
                    // The barrier is outside business transactions; only the normal action service takes the order lock.
                    var first=CompletableFuture.runAsync(()->execute(round,round.people.get(0),gate),executor);
                    var second=CompletableFuture.runAsync(()->execute(round,round.people.get(1),gate),executor);
                    CompletableFuture.allOf(first,second).whenComplete((unused,error)->slots.release());
                } catch (RejectedExecutionException e) { gate.reset();slots.release();throw new OrderException(503,"DEMO_STOPPING","서버 종료 중입니다. 주문 상태를 다시 확인하세요."); }
            }
        }
        return snapshot(round,actor);
    }
    private void execute(Round round,Person person,CyclicBarrier gate) {
        Instant startedAt=null;Result result;
        try {
            gate.await(5,TimeUnit.SECONDS);
            startedAt=Instant.now();
            var member=members.findByUsername(person.username).orElseThrow(()->new OrderException(403,"OPERATOR_UNAVAILABLE","운영자 계정을 확인할 수 없습니다."));
            if (!member.id().equals(person.actorId) || !"ADMIN".equals(member.role()))
                throw new OrderException(403,"OPERATOR_UNAVAILABLE","운영자 권한이 변경됐습니다.");
            var request=round.request;
            var receipt="REFUND".equals(person.operation)
                ? actions.refund(person.actorId,round.orderId,person.key,new AdminActionController.RefundRequest(request.issuanceId(),request.reason(),Refund.Scenario.SUCCESS))
                : actions.retry(person.actorId,round.orderId,person.key,new AdminActionController.Retry(request.issuanceId(),request.reason(),IssuanceSimulation.defaults()));
            result=new Result(receipt.replayed()?200:202,receipt.replayed()?"REPLAYED":"ACCEPTED",
                receipt.replayed()?"기존 조치를 반환했습니다.":"조치를 접수했습니다.",receipt.action().id(),receipt.action().actor(),receipt.replayed(),startedAt,Instant.now());
        } catch (OrderException e) {
            result=new Result(e.status,e.code,e.getMessage(),null,null,false,startedAt,Instant.now());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();result=new Result(503,"DEMO_INTERRUPTED","시연이 중단됐습니다. 주문 상태를 확인하세요.",null,null,false,startedAt,Instant.now());
        } catch (BrokenBarrierException | TimeoutException e) {
            result=new Result(503,"DEMO_START_TIMEOUT","두 조치를 함께 시작하지 못했습니다.",null,null,false,startedAt,Instant.now());
        } catch (RuntimeException e) {
            result=new Result(500,"RESULT_UNKNOWN","접수 결과가 불명확합니다. 실제 주문·조치 이력을 확인하세요.",null,null,false,startedAt,Instant.now());
        }
        synchronized(round) { person.result=result; }
    }
    private Round find(UUID orderId,UUID id) {
        enabled();Round round=rounds.get(id);
        if (round==null || !round.orderId.equals(orderId) || round.expiresAt.isBefore(Instant.now()))
            throw new OrderException(404,"DEMO_NOT_FOUND","시연 번호가 없거나 10분이 지났습니다. 주문 상태를 확인하고 새 시연을 준비하세요.");
        return round;
    }
    private void enabled() {
        if (!payment.mockEnabled() || !issuance.mockEnabled()) throw new OrderException(503,"DEMO_DISABLED","모의 PG·공급사를 모두 켠 환경에서만 시연할 수 있습니다.");
    }
    private View snapshot(Round round,Member actor) {
        List<Participant> participants;boolean started;
        synchronized(round) {
            participants=round.people.stream().map(p->new Participant(p.username,p.operation,p.key,p.result)).toList();started=round.started;
        }
        UUID second=participants.size()==2?participants.get(1).key():null;
        var stats=jdbc.queryForObject("""
            WITH a AS (SELECT refund_id,issuance_id FROM admin_actions WHERE order_id=? AND idempotency_key IN (?::uuid,?::uuid))
            SELECT (SELECT count(*) FROM a) AS action_count,
                (SELECT count(*) FROM refunds WHERE id IN (SELECT refund_id FROM a)) AS refund_count,
                (SELECT count(*) FROM issuance_jobs WHERE id IN (SELECT issuance_id FROM a)) AS retry_count,
                (SELECT count(*) FROM sim_profiles WHERE order_id=?) AS profile_count,
                (SELECT count(*) FROM mock_pg_cancellations WHERE idempotency_key IN (SELECT refund_id FROM a)) AS cancellation_count,
                (SELECT COALESCE(sum(amount),0) FROM mock_pg_cancellations WHERE idempotency_key IN (SELECT refund_id FROM a)) AS cancelled_amount,
                (SELECT count(*) FROM mock_supplier_orders WHERE request_id IN (SELECT issuance_id FROM a)) AS supplier_orders,
                (SELECT COALESCE(sum(issue_executions),0) FROM mock_supplier_orders WHERE request_id IN (SELECT issuance_id FROM a)) AS supplier_issues,
                (SELECT status FROM refunds WHERE id IN (SELECT refund_id FROM a) LIMIT 1) AS refund_status,
                (SELECT status FROM issuance_jobs WHERE id IN (SELECT issuance_id FROM a) LIMIT 1) AS issuance_status,
                (SELECT amount FROM orders WHERE id=?) AS order_amount
            """,(r,i)->new Stats(r.getLong("action_count"),r.getLong("refund_count"),r.getLong("retry_count"),r.getLong("profile_count"),
                r.getLong("cancellation_count"),r.getLong("cancelled_amount"),r.getLong("supplier_orders"),r.getLong("supplier_issues"),
                r.getString("refund_status"),r.getString("issuance_status"),r.getLong("order_amount")),
            round.orderId,participants.getFirst().key(),second,round.orderId,round.orderId);
        String phase=phase(started,participants,stats,round.request.keyMode());
        return new View(round.id,round.orderId,round.request,round.expiresAt,phase,
            participants.stream().anyMatch(p->p.username().equals(actor.username())),participants,stats,Instant.now());
    }
    private String phase(boolean started,List<Participant> people,Stats s,KeyMode keyMode) {
        if (!started) return people.size()==2?"READY":"WAITING";
        if (people.stream().anyMatch(p->p.result()==null)) return "RUNNING";
        if (people.stream().anyMatch(p->p.result().status()>=500)) return "REVIEW_REQUIRED";
        if (s.actionCount()==0) return "BLOCKED";
        long accepted=people.stream().filter(p->p.result().status()==202).count();
        long replayed=people.stream().filter(p->p.result().status()==200 && p.result().replayed()).count();
        long conflicts=people.stream().filter(p->p.result().status()==409).count();
        if (s.actionCount()!=1 || accepted!=1 || (keyMode==KeyMode.SHARED ? replayed!=1 : conflicts!=1)
                || s.refundCount()+s.retryCount()!=1 || (s.refundCount()>0 && s.profileCount()>0)) return "INVARIANT_FAILED";
        if ("REVIEW_REQUIRED".equals(s.refundStatus()) || Set.of("FAILED","REVIEW_REQUIRED").contains(Objects.toString(s.issuanceStatus(),""))) return "REVIEW_REQUIRED";
        if (s.refundCount()==1 && "SUCCEEDED".equals(s.refundStatus()))
            return s.pgCancellations()==1 && s.cancelledAmount()==s.orderAmount() && s.retryCount()==0?"PASSED":"INVARIANT_FAILED";
        if (s.retryCount()==1 && "ISSUED".equals(s.issuanceStatus()))
            return s.refundCount()==0 && s.profileCount()==1 && s.supplierOrders()==1 && s.supplierIssues()==1 && s.pgCancellations()==0?"PASSED":"INVARIANT_FAILED";
        return "PROCESSING";
    }
    @PreDestroy void close() { executor.shutdownNow(); }
    private static class Round {
        final UUID orderId,id,creator,sharedKey=UUID.randomUUID();
        final AdminConcurrencyController.Request request;
        final Instant expiresAt=Instant.now().plusSeconds(600);
        final List<Person> people=new ArrayList<>();
        boolean started;
        Round(UUID orderId,UUID id,UUID creator,AdminConcurrencyController.Request request) { this.orderId=orderId;this.id=id;this.creator=creator;this.request=request; }
        void add(Member actor) {
            String operation=request.mode()==Mode.RETRY_RETRY || (request.mode()==Mode.REFUND_RETRY && !people.isEmpty())?"ISSUANCE_RETRY":"REFUND";
            people.add(new Person(actor.id(),actor.username(),operation,request.keyMode()==KeyMode.SHARED?sharedKey:UUID.randomUUID()));
        }
        synchronized boolean finished() { return !started || people.stream().allMatch(p->p.result!=null); }
    }
    private static class Person {
        final UUID actorId,key;final String username,operation;Result result;
        Person(UUID actorId,String username,String operation,UUID key) { this.actorId=actorId;this.username=username;this.operation=operation;this.key=key; }
    }
    public record Result(int status,String code,String message,UUID actionId,String appliedBy,boolean replayed,Instant startedAt,Instant finishedAt) {}
    public record Participant(String username,String operation,UUID key,Result result) {}
    public record Stats(long actionCount,long refundCount,long retryCount,long profileCount,long pgCancellations,long cancelledAmount,
        long supplierOrders,long supplierIssues,String refundStatus,String issuanceStatus,long orderAmount) {}
    public record View(UUID id,UUID orderId,AdminConcurrencyController.Request request,Instant expiresAt,String phase,
        boolean participating,List<Participant> participants,Stats stats,Instant checkedAt) {}
}
