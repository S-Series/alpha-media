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
    public IssuanceService(OrderRepository orders, IssuanceRepository jobs, IssuanceSettings settings, ObjectMapper mapper) {
        this.orders = orders; this.jobs = jobs; this.settings = settings; this.mapper = mapper;
    }

    public View view(UUID memberId, UUID orderId) {
        orders.findById(memberId, orderId).orElseThrow(() -> new OrderException(404, "ORDER_NOT_FOUND", "주문을 찾을 수 없습니다."));
        return forOrder(orderId);
    }
    View forOrder(UUID orderId) { return new View(jobs.find(orderId).orElse(null), jobs.profile(orderId).orElse(null)); }
    public List<SimProfile> profiles(UUID memberId) { return jobs.profiles(memberId); }
    public SimProfile profile(UUID memberId, UUID id) {
        return jobs.profileForMember(memberId, id).orElseThrow(() -> new OrderException(404, "SIM_NOT_FOUND", "SIM을 찾을 수 없습니다."));
    }

    @Transactional
    public void result(SupplierResult result, UUID token, String source) {
        if (result == null || !result.valid()) throw new OrderException(400, "INVALID_SUPPLIER_RESULT", "공급사 결과 형식이 올바르지 않습니다.");
        Order order;
        try { order = orders.lock(result.orderId()); }
        catch (java.util.NoSuchElementException exception) { throw new OrderException(404, "ORDER_NOT_FOUND", "콜백의 주문을 찾을 수 없습니다."); }
        Issuance job = jobs.lock(result.requestId());
        if (!job.orderId().equals(order.id()) || !"PAID".equals(order.status())
                || (job.supplierOrderNo() != null && !job.supplierOrderNo().equals(result.supplierOrderNo()))) {
            throw new OrderException(409, "SUPPLIER_RESULT_MISMATCH", "공급사 결과의 주문·발급 요청이 일치하지 않습니다.");
        }
        if (token != null && !jobs.owns(job.id(), token)) return;
        boolean terminal = List.of("ISSUED", "FAILED").contains(job.status());
        if (terminal && result.revision() >= job.revision()) {
            if (!job.status().equals(result.status())) throw new OrderException(409, "SUPPLIER_RESULT_CONFLICT", "이미 확정된 발급 결과와 다릅니다.");
            if ("ISSUED".equals(job.status())) {
                var profile = jobs.profile(order.id()).orElseThrow();
                if (!profile.iccid().equals(result.iccid()) || !profile.activationCode().equals(result.activationCode())) {
                    throw new OrderException(409, "SUPPLIER_PROFILE_CONFLICT", "이미 발급된 프로필과 다릅니다.");
                }
            }
        }
        boolean newEvent = jobs.event(result, hash(result), source);
        // 늦게 도착한 접수 통지로 발급 완료·실패를 되돌리지 않는다.
        if (terminal || result.revision() < job.revision()) return;
        if ("ACCEPTED".equals(result.status())) {
            jobs.save(job.id(), "WAITING_CALLBACK", result.supplierOrderNo(), 1, null, settings.pollMs());
        } else if (newEvent) {
            if ("ISSUED".equals(result.status())) jobs.insertProfile(result);
            jobs.save(job.id(), result.status(), result.supplierOrderNo(), 2, result.reason(), settings.pollMs());
        }
    }

    @Transactional
    public void uncertain(IssuanceRepository.Claim claim, boolean review, String reason) {
        orders.lock(claim.issuance().orderId());
        Issuance current = jobs.lock(claim.issuance().id());
        if (!jobs.owns(current.id(), claim.token())) return;
        boolean stop = review || current.checkCount() >= 6;
        jobs.save(current.id(), stop ? "REVIEW_REQUIRED" : "WAITING_CALLBACK", current.supplierOrderNo(),
            current.revision(), stop && !review ? "SUPPLIER_RETRY_LIMIT_REACHED" : reason, settings.pollMs());
    }

    private String hash(SupplierResult result) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(mapper.writeValueAsBytes(result))); }
        catch (java.security.NoSuchAlgorithmException exception) { throw new IllegalStateException(exception); }
    }
    public record View(Issuance issuance, SimProfile profile) {}
}
