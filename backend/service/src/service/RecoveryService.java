package service;

import java.io.IOException;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.ObjectMapper;
import service.OrderService.OrderException;

@Service
public class RecoveryService {
    static final int MAX_ROUNDS=3;
    private final RecoveryRepository actions;
    private final RecoveryTargets targets;
    private final OrderRepository orders;
    private final PaymentRepository payments;
    private final IssuanceRepository jobs;
    private final RefundRepository refunds;
    private final InboundEventRepository inbox;
    private final PaymentTransitions paymentResults;
    private final IssuanceService issuanceResults;
    private final RefundService refundResults;
    private final OrderConflicts conflicts;
    private final ObjectProvider<PgClient> pg;
    private final ObjectProvider<SupplierClient> supplier;
    private final InboundPayloadCodec codec;
    private final ObjectMapper mapper;
    private final JdbcTemplate jdbc;
    public RecoveryService(RecoveryRepository actions,RecoveryTargets targets,OrderRepository orders,PaymentRepository payments,
            IssuanceRepository jobs,RefundRepository refunds,InboundEventRepository inbox,PaymentTransitions paymentResults,
            IssuanceService issuanceResults,RefundService refundResults,OrderConflicts conflicts,ObjectProvider<PgClient> pg,
            ObjectProvider<SupplierClient> supplier,InboundPayloadCodec codec,ObjectMapper mapper,JdbcTemplate jdbc) {
        this.actions=actions; this.targets=targets; this.orders=orders; this.payments=payments; this.jobs=jobs; this.refunds=refunds;
        this.inbox=inbox; this.paymentResults=paymentResults; this.issuanceResults=issuanceResults; this.refundResults=refundResults;
        this.conflicts=conflicts; this.pg=pg; this.supplier=supplier; this.codec=codec; this.mapper=mapper; this.jdbc=jdbc;
    }

    @Transactional
    public Receipt reconcile(UUID actor,UUID order,UUID key,RecoveryController.Query request) {
        var before=targets.read(order,request.target(),request.targetId(),true);
        String hash=hash("RECONCILE",request);
        var old=actions.find(order,key);
        if (old.isPresent()) return replay(old.get(),hash);
        version(before,request.expectedVersion());
        if (!"REVIEW_REQUIRED".equals(before.view().status()) && !conflicts.blocked(order))
            throw error("RECOVERY_NOT_REQUIRED","확인 필요 상태의 건만 재조회할 수 있습니다.");
        enabled(request.target(),request.targetId());
        if (actions.active(request.target(),request.targetId())) throw error("RECOVERY_IN_PROGRESS","이미 재조회 중입니다. 기존 조치 결과를 확인해 주세요.");
        // Consumes this screen version even if the read-only lookup completes before a competing click.
        jdbc.update("UPDATE "+RecoveryTargets.table(request.target())+" SET recovery_revision=recovery_revision+1 WHERE id=?",request.targetId());
        var work=targets.read(order,request.target(),request.targetId(),false);
        return new Receipt(actions.insert(order,actor,key,hash,"RECONCILE",before,request.reason().trim(),null,work.view().version()),false);
    }

    @Transactional
    public Receipt resume(UUID actor,UUID order,UUID key,RecoveryController.Resume request) {
        var before=targets.read(order,request.target(),request.targetId(),true);
        String hash=hash("RESUME",request);
        var old=actions.find(order,key);
        if (old.isPresent()) return replay(old.get(),hash);
        version(before,request.expectedVersion());
        conflicts.requireClear(order);
        if (!"REVIEW_REQUIRED".equals(before.view().status())) throw error("RECOVERY_NOT_REQUIRED","자동 처리 중이거나 이미 완료된 건은 재개할 수 없습니다.");
        if (actions.active(request.target(),request.targetId())) throw error("RECOVERY_IN_PROGRESS","재조회가 완료된 뒤 재개해 주세요.");
        if (before.view().executionRound()>=MAX_ROUNDS) throw error("RECOVERY_ROUND_LIMIT","최초 포함 3개 실행 회차를 모두 사용했습니다. 사업자 확인이 필요합니다.");
        var evidence=actions.findById(request.evidenceId()).orElseThrow(()->error("RECOVERY_EVIDENCE_REQUIRED","재조회 근거를 확인해 주세요."));
        if (!evidence.orderId().equals(order) || evidence.target()!=request.target() || !evidence.targetId().equals(request.targetId())
                || !"RECONCILE".equals(evidence.kind()) || !"SUCCEEDED".equals(evidence.status())
                || !List.of("RESUME_ALLOWED","REPLAY_ALLOWED").contains(Objects.toString(evidence.outcome(),""))
                || !before.view().version().equals(evidence.resultVersion()))
            throw error("RECOVERY_EVIDENCE_REQUIRED","현재 대상·상태에 맞는 재조회 근거가 필요합니다.");
        if (evidence.checkedAt()==null || evidence.checkedAt().isBefore(Instant.now().minusSeconds(60)))
            throw error("RECOVERY_EVIDENCE_EXPIRED","조회 후 60초가 지났습니다. 외부 결과를 다시 조회해 주세요.");
        enabled(request.target(),request.targetId());
        if (!safeToResume(order,request.target(),request.targetId()))
            throw error("RECOVERY_UNSAFE","현재 주문·제공 상태에서는 재개할 수 없습니다.");
        if (request.target()==RecoveryTargets.Kind.INBOUND) {
            var event=inbox.lock(request.targetId());
            if (!replayable(event)) throw error("RECOVERY_UNSAFE","내용 충돌·영구 오류가 있는 웹훅은 재처리할 수 없습니다.");
            codec.decrypt(event); // Detect a changed encryption key before granting another round.
        }
        orders.historyContext(actor,"ADMIN_RESUME",request.reason().trim());
        String reset=switch(request.target()) {
            case PAYMENT -> "status='QUEUED',round_attempt_count=0,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()";
            case REFUND -> "status='REQUESTED',round_attempt_count=0,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()";
            case ISSUANCE -> "status='QUEUED',consecutive_failures=0,round_submission_count=0,waiting_since=NULL,next_check_at=clock_timestamp(),updated_at=clock_timestamp()";
            case INBOUND -> "status='PENDING',round_attempt_count=0,error_status=NULL,next_attempt_at=clock_timestamp()";
        };
        jdbc.update("UPDATE "+RecoveryTargets.table(request.target())+" SET "+reset
            +",execution_round=execution_round+1,last_error=NULL,lease_token=NULL,lease_until=NULL WHERE id=?",request.targetId());
        String after=targets.read(order,request.target(),request.targetId(),false).view().version();
        return new Receipt(actions.insert(order,actor,key,hash,"RESUME",before,request.reason().trim(),evidence.id(),after),false);
    }

    // No database transaction is held while the provider is contacted. These calls only read existing IDs.
    Observation lookup(RecoveryRepository.Action action) throws IOException,InterruptedException {
        var current=targets.read(action.orderId(),action.target(),action.targetId(),false);
        if (!current.view().version().equals(action.workVersion())) return new Observation(null,"STALE",null);
        Object result=switch(action.target()) {
            case PAYMENT -> pgClient().lookup(payments.findById(action.targetId()).orElseThrow()).orElse(null);
            case ISSUANCE -> supplierClient().lookup(jobs.findById(action.targetId()).orElseThrow()).orElse(null);
            case REFUND -> pgClient().lookupCancellation(refunds.find(action.orderId()).orElseThrow()).orElse(null);
            case INBOUND -> lookupInbox(inbox.find(action.targetId()).orElseThrow());
        };
        if (result==null) return new Observation(null,"NOT_FOUND",null);
        if (result instanceof PgResult payment) return new Observation(payment,payment.status(),payment.transactionId());
        if (result instanceof SupplierResult issuance) return new Observation(issuance,issuance.status(),issuance.supplierOrderNo());
        if (result instanceof MockPgService.Cancellation refund) return new Observation(refund,"SUCCEEDED",refund.id()==null?null:refund.id().toString());
        var profile=(ProfileSignal)result;
        return new Observation(profile,profile.state(),profile.iccid());
    }
    private Object lookupInbox(InboundEventRepository.Event event) throws IOException,InterruptedException {
        return switch(event.source()) {
            case "PG" -> { var payment=payments.findById(event.targetId()); yield payment.isEmpty()?null:pgClient().lookup(payment.get()).orElse(null); }
            case "SUPPLIER" -> { var issuance=jobs.findById(event.targetId()); yield issuance.isEmpty()?null:supplierClient().lookup(issuance.get()).orElse(null); }
            case "PROFILE" -> { var profile=jobs.profile(event.orderId()); yield profile.isEmpty()?null:supplierClient().profile(profile.get().iccid()); }
            default -> throw new IllegalStateException("Unsupported inbox source");
        };
    }

    @Transactional
    public void complete(RecoveryRepository.Action claim,Observation observation) {
        var action=actions.lock(claim.id());
        if (!actions.owns(action,claim)) return;
        var current=targets.read(action.orderId(),action.target(),action.targetId(),true);
        if (!current.view().version().equals(action.workVersion())) {
            actions.finish(action,"STALE","STALE_TARGET","STALE_RECOVERY_TARGET",null,null,null,current.view().version()); return;
        }
        String evidence=observation.payload()==null?null:RecoveryTargets.hash(mapper.writeValueAsString(observation.payload()));
        String outcome;
        try {
            if (conflicts.blocked(action.orderId())) outcome="BLOCKED";
            else outcome=apply(action,observation);
        } catch (OrderConflicts.ConflictException conflict) {
            // Domain conflict records must commit with this blocked lookup result.
            outcome="BLOCKED";
        }
        String version=targets.read(action.orderId(),action.target(),action.targetId(),false).view().version();
        actions.finish(action,"SUCCEEDED",outcome,"BLOCKED".equals(outcome)?"RECOVERY_UNSAFE":null,
            bounded(observation.status(),32),bounded(observation.reference(),120),evidence,version);
    }
    private String apply(RecoveryRepository.Action action,Observation observation) {
        if (action.target()==RecoveryTargets.Kind.INBOUND) {
            var event=inbox.lock(action.targetId());
            if (!replayable(event) || observation.payload()==null || !safeToResume(action.orderId(),action.target(),action.targetId())) return "BLOCKED";
            Object original=switch(event.source()) {
                case "PG" -> PgResult.parse(mapper,codec.decrypt(event));
                case "SUPPLIER" -> SupplierResult.parse(mapper,codec.decrypt(event));
                case "PROFILE" -> ProfileSignal.parse(mapper,codec.decrypt(event));
                default -> throw new IllegalStateException("Unsupported inbox source");
            };
            return RecoveryTargets.hash(mapper.writeValueAsString(original)).equals(RecoveryTargets.hash(mapper.writeValueAsString(observation.payload())))
                ?"REPLAY_ALLOWED":"BLOCKED";
        }
        if (observation.payload()==null)
            return safeToResume(action.orderId(),action.target(),action.targetId())?"RESUME_ALLOWED":"BLOCKED";
        switch(action.target()) {
            case PAYMENT -> {
                var result=(PgResult)observation.payload();
                var payment=payments.lock(action.targetId());
                if (!result.matches(payment)) throw conflicts.reject(action.orderId(),"PAYMENT",payment.id(),"PG_RESULT_MISMATCH",
                    "ADMIN_RECONCILE",payment.status(),result.status(),mapper.writeValueAsString(result));
                paymentResults.result(result,null,"LOOKUP");
            }
            case ISSUANCE -> {
                var result=(SupplierResult)observation.payload();
                var job=jobs.lock(action.targetId());
                if (!result.valid() || !job.id().equals(result.requestId()) || !job.orderId().equals(result.orderId())
                        || (job.supplierOrderNo()!=null && !job.supplierOrderNo().equals(result.supplierOrderNo())))
                    throw conflicts.reject(action.orderId(),"ISSUANCE",job.id(),"SUPPLIER_RESULT_MISMATCH","ADMIN_RECONCILE",
                        job.status(),result.status(),mapper.writeValueAsString(result));
                if ("ACCEPTED".equals(result.status())) return safeToResume(action.orderId(),action.target(),action.targetId())?"RESUME_ALLOWED":"BLOCKED";
                issuanceResults.result(result,null,"LOOKUP");
            }
            case REFUND -> refundResults.reconcile(refunds.find(action.orderId()).orElseThrow(),(MockPgService.Cancellation)observation.payload());
            default -> throw new IllegalStateException("Unsupported recovery target");
        }
        return "APPLIED";
    }
    private boolean safeToResume(UUID orderId,RecoveryTargets.Kind target,UUID id) {
        Order order=orders.lock(orderId);
        return switch(target) {
            case PAYMENT -> "PAYMENT_PROCESSING".equals(order.status()) && order.expiresAt().isAfter(Instant.now());
            case ISSUANCE -> "PAID".equals(order.status()) && jobs.find(orderId).map(job->job.id().equals(id)).orElse(false)
                && jobs.profile(orderId).isEmpty() && refunds.find(orderId).isEmpty();
            case REFUND -> "REFUND_PROCESSING".equals(order.status()) && jobs.profile(orderId).isEmpty()
                && jobs.find(orderId).map(job->"FAILED".equals(job.status())).orElse(false)
                && refunds.find(orderId).map(refund->refund.id().equals(id)).orElse(false)
                && payments.list(orderId).stream().anyMatch(payment->"APPROVED".equals(payment.status()));
            case INBOUND -> inbox.find(id).map(this::replayable).orElse(false);
        };
    }
    private boolean replayable(InboundEventRepository.Event event) {
        return event.conflictingPayloadHash()==null && "REVIEW_REQUIRED".equals(event.status())
            && List.of("INBOUND_PROCESSING_FAILED","WEBHOOK_RETRY_LIMIT_REACHED","PAYMENT_NOT_FOUND","ISSUANCE_NOT_FOUND","SIM_NOT_FOUND","ORDER_NOT_FOUND")
                .contains(Objects.toString(event.lastError(),""));
    }
    private void enabled(RecoveryTargets.Kind kind,UUID id) {
        if (kind==RecoveryTargets.Kind.PAYMENT || kind==RecoveryTargets.Kind.REFUND) pgClient();
        else if (kind==RecoveryTargets.Kind.ISSUANCE) supplierClient();
        else if ("PG".equals(inbox.find(id).orElseThrow().source())) pgClient(); else supplierClient();
    }
    private PgClient pgClient() {
        var client=pg.getIfAvailable(); if (client==null) throw new OrderException(503,"PG_DISABLED","PG 조회가 비활성화되어 있습니다."); return client;
    }
    private SupplierClient supplierClient() {
        var client=supplier.getIfAvailable(); if (client==null) throw new OrderException(503,"SUPPLIER_DISABLED","공급사 조회가 비활성화되어 있습니다."); return client;
    }
    private void version(RecoveryTargets.Snapshot value,String expected) {
        if (!value.view().version().equals(expected)) throw error("STALE_RECOVERY_TARGET","화면 이후 상태나 조치가 변경되었습니다. 최신 상태를 확인해 주세요.");
    }
    private String hash(String kind,Object request) { return RecoveryTargets.hash(mapper.writeValueAsString(new Object[]{kind,request})); }
    private Receipt replay(RecoveryRepository.Action action,String hash) {
        if (!action.payloadHash().equals(hash)) throw error("RECOVERY_KEY_CONFLICT","같은 요청 키의 조치 내용이 다릅니다.");
        return new Receipt(action,true);
    }
    private static String bounded(String value,int length) { return value==null?null:value.substring(0,Math.min(length,value.length())); }
    private static OrderException error(String code,String message) { return new OrderException(409,code,message); }
    record Observation(Object payload,String status,String reference) {}
    public record Receipt(RecoveryRepository.Action action,boolean replayed) {}
}
