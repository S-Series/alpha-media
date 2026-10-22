package service;

import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.ObjectMapper;
import service.OrderService.OrderException;

@Service
public class IssuanceService {
    private final OrderRepository orders;
    private final IssuanceRepository jobs;
    private final IssuanceSettings settings;
    private final ObjectMapper mapper;
    private final AdminActionRepository actions;
    private final OrderConflicts conflicts;
    public IssuanceService(OrderRepository orders, IssuanceRepository jobs, IssuanceSettings settings, ObjectMapper mapper,AdminActionRepository actions, OrderConflicts conflicts) {
        this.orders = orders; this.jobs = jobs; this.settings = settings; this.mapper = mapper; this.actions=actions; this.conflicts=conflicts;
    }

    public View view(UUID memberId, UUID orderId) {
        orders.findById(memberId, orderId).orElseThrow(() -> new OrderException(404, "ORDER_NOT_FOUND", "주문을 찾을 수 없습니다."));
        conflicts.requireClear(orderId);
        return forOrder(orderId);
    }
    View forOrder(UUID orderId) { return new View(jobs.find(orderId).orElse(null), jobs.profile(orderId).orElse(null)); }
    public List<SimProfile> profiles(UUID memberId) { return jobs.profiles(memberId); }
    public SimProfile profile(UUID memberId, UUID id) {
        var profile=jobs.profileForMember(memberId, id).orElseThrow(() -> new OrderException(404, "SIM_NOT_FOUND", "SIM을 찾을 수 없습니다."));
        conflicts.requireClear(profile.orderId());
        return profile;
    }

    @Transactional(noRollbackFor=OrderConflicts.ConflictException.class)
    public void resultForClaim(SupplierResult result, IssuanceRepository.Claim claim, String source) {
        orders.lock(claim.issuance().orderId());
        var current=jobs.lock(claim.issuance().id());
        if (!jobs.owns(current.id(),claim.token())) return;
        if (result==null || !result.valid()) throw new SupplierClient.InvalidResult();
        if (!current.id().equals(result.requestId()) || !current.orderId().equals(result.orderId())) {
            throw conflicts.reject(current.orderId(),"ISSUANCE",current.id(),"SUPPLIER_RESULT_MISMATCH",
                "SUPPLIER_"+source,current.status(),result.status(),hash(result));
        }
        result(result,claim.token(),source);
    }

    @Transactional(noRollbackFor=OrderConflicts.ConflictException.class)
    public void result(SupplierResult result, UUID token, String source) {
        orders.historyContext(null,"SUPPLIER_"+source,null);
        if (result == null || !result.valid()) throw new OrderException(400, "INVALID_SUPPLIER_RESULT", "공급사 결과 형식이 올바르지 않습니다.");
        var referenced=jobs.findById(result.requestId()).orElseThrow(()->new OrderException(404,"ISSUANCE_NOT_FOUND","발급 요청을 찾을 수 없습니다."));
        Order order=orders.lock(referenced.orderId());
        Issuance job = jobs.lock(result.requestId());
        if (!job.orderId().equals(result.orderId())
                || (job.supplierOrderNo() != null && !job.supplierOrderNo().equals(result.supplierOrderNo()))) {
            throw conflicts.reject(order.id(),"ISSUANCE",job.id(),"SUPPLIER_RESULT_MISMATCH",
                "SUPPLIER_"+source,job.status(),result.status(),hash(result));
        }
        if (token != null && !jobs.owns(job.id(), token)) return;
        boolean terminal = List.of("ISSUED", "FAILED").contains(job.status());
        if (!terminal && (!"PAID".equals(order.status()) || !jobs.find(order.id()).map(j -> j.id().equals(job.id())).orElse(false))) {
            throw new OrderException(409,"SUPPLIER_RESULT_MISMATCH","현재 처리 중인 발급 요청이 아닙니다.");
        }
        if (terminal && result.revision() >= job.revision()) {
            if (!job.status().equals(result.status())) throw conflicts.reject(order.id(),"ISSUANCE",job.id(),"SUPPLIER_RESULT_CONFLICT",
                "SUPPLIER_"+source,job.status(),result.status(),hash(result));
            if ("ISSUED".equals(job.status())) {
                var profile = jobs.profile(order.id()).orElseThrow();
                if (!profile.iccid().equals(result.iccid()) || !profile.activationCode().equals(result.activationCode())) {
                    throw conflicts.reject(order.id(),"ISSUANCE",job.id(),"SUPPLIER_PROFILE_CONFLICT",
                        "SUPPLIER_"+source,job.status(),result.status(),hash(result));
                }
            }
        }
        conflicts.requireClear(order.id());
        conflicts.lockExternal("SUPPLIER_ORDER:"+result.supplierOrderNo());
        if (result.iccid()!=null) conflicts.lockExternal("SUPPLIER_ICCID:"+result.iccid());
        if (jobs.supplierReferenceUsedByAnother(result)) {
            throw conflicts.reject(order.id(),"ISSUANCE",job.id(),"SUPPLIER_REFERENCE_CONFLICT",
                "SUPPLIER_"+source,job.status(),result.status(),hash(result));
        }
        boolean newEvent;
        try { newEvent=jobs.event(result,hash(result),source); }
        catch (OrderException e) {
            if (!"SUPPLIER_EVENT_CONFLICT".equals(e.code)) throw e;
            throw conflicts.reject(order.id(),"ISSUANCE",job.id(),e.code,"SUPPLIER_"+source,job.status(),result.status(),hash(result));
        }
        // 늦게 도착한 접수 통지로 발급 완료·실패를 되돌리지 않는다.
        if (terminal || result.revision() < job.revision()) return;
        if (!newEvent && token==null) return;
        if ("ACCEPTED".equals(result.status())) {
            jobs.save(job.id(), "WAITING_CALLBACK", result.supplierOrderNo(), 1, null, settings.pollMs());
            jobs.confirmed(job.id(),true);
        } else if (newEvent) {
            if ("ISSUED".equals(result.status())) jobs.insertProfile(result);
            jobs.save(job.id(), result.status(), result.supplierOrderNo(), 2, result.reason(), settings.pollMs());
            jobs.confirmed(job.id(),false);
            actions.issuanceEvent(job.id(),result.status(),result.reason());
        }
    }

    @Transactional
    public void uncertain(IssuanceRepository.Claim claim, boolean review, String reason) {
        orders.historyContext(null,"ISSUANCE_WORKER",reason);
        orders.lock(claim.issuance().orderId());
        Issuance current = jobs.lock(claim.issuance().id());
        if (!jobs.owns(current.id(), claim.token())) return;
        boolean stop = review || current.consecutiveFailures() >= 6;
        jobs.save(current.id(), stop ? "REVIEW_REQUIRED" : "WAITING_CALLBACK", current.supplierOrderNo(),
            current.revision(), stop && !review ? "SUPPLIER_RETRY_LIMIT_REACHED" : reason, settings.pollMs());
        if (stop) actions.issuanceEvent(current.id(),"REVIEW_REQUIRED",reason);
    }

    @Transactional
    public boolean reserveSubmission(IssuanceRepository.Claim claim) {
        orders.lock(claim.issuance().orderId());
        var current=jobs.lock(claim.issuance().id());
        if (!jobs.owns(current.id(),claim.token())) return false;
        if (conflicts.blocked(current.orderId())) {
            uncertain(claim,true,"ORDER_RESULT_CONFLICT"); return false;
        }
        if (!jobs.reserveSubmission(current.id())) {
            uncertain(claim,true,"SUPPLIER_SUBMISSION_LIMIT_REACHED"); return false;
        }
        return true;
    }

    private String hash(SupplierResult result) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(mapper.writeValueAsBytes(result))); }
        catch (java.security.NoSuchAlgorithmException exception) { throw new IllegalStateException(exception); }
    }
    public record View(Issuance issuance, SimProfile profile) {}
}
