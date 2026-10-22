package service;

import java.io.IOException;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.ObjectMapper;

@Service
public class ReconciliationProcessor {
    private final ReconciliationRepository runs;
    private final IncidentRepository incidents;
    private final RecoveryTargets targets;
    private final PaymentRepository payments;
    private final OrderRepository orders;
    private final IssuanceRepository jobs;
    private final RefundRepository refunds;
    private final RefundBalance balance;
    private final RefundProtection protection;
    private final RefundProtectionService protectionResults;
    private final PaymentTransitions paymentResults;
    private final IssuanceService issuanceResults;
    private final RefundService refundResults;
    private final OrderConflicts conflicts;
    private final ObjectProvider<PgClient> pg;
    private final ObjectProvider<SupplierClient> supplier;
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    public ReconciliationProcessor(ReconciliationRepository runs,IncidentRepository incidents,RecoveryTargets targets,PaymentRepository payments,
            OrderRepository orders,IssuanceRepository jobs,RefundRepository refunds,PaymentTransitions paymentResults,IssuanceService issuanceResults,
            RefundService refundResults,OrderConflicts conflicts,ObjectProvider<PgClient> pg,ObjectProvider<SupplierClient> supplier,JdbcTemplate jdbc,ObjectMapper mapper,RefundBalance balance,RefundProtection protection,RefundProtectionService protectionResults) {
        this.balance=balance; this.protection=protection; this.protectionResults=protectionResults; this.runs=runs; this.incidents=incidents; this.targets=targets; this.payments=payments; this.orders=orders; this.jobs=jobs; this.refunds=refunds;
        this.paymentResults=paymentResults; this.issuanceResults=issuanceResults; this.refundResults=refundResults; this.conflicts=conflicts;
        this.pg=pg; this.supplier=supplier; this.jdbc=jdbc; this.mapper=mapper;
    }
    private UUID internalOrder(String kind,UUID id) {
        var rows=jdbc.queryForList("SELECT order_id FROM "+RecoveryTargets.table(RecoveryTargets.Kind.valueOf(kind))+" WHERE id=?",UUID.class,id);
        return rows.isEmpty()?null:rows.getFirst();
    }
    Observation lookup(ReconciliationRepository.Item item) throws IOException,InterruptedException {
        UUID order=internalOrder(item.kind(),item.targetId());
        String version=order==null?null:targets.read(order,RecoveryTargets.Kind.valueOf(item.kind()),item.targetId(),false).view().version();
        Object payload; ExternalLedger.PaymentSnapshot funding=null; MockPgService.Cancellation cancellation=null;
        if ("PROTECTION".equals(item.kind())) {
            payload=supplier.getObject().protection(protection.get(item.targetId()),false).orElse(null);
        }
        else if ("ISSUANCE".equals(item.kind())) {
            payload=supplier.getObject().lookup(item.targetId()).orElse(null);
            if (order!=null) {
                var approved=payments.list(order).stream().filter(p->"APPROVED".equals(p.status())).findFirst();
                if (approved.isPresent()) funding=pg.getObject().financial(approved.get().id()).orElse(null);
            }
        }
        else {
            UUID payment=item.targetId();
            if ("REFUND".equals(item.kind())) {
                if (order==null) return new Observation(null,null,null,false,null,null);
                var refund=refunds.findById(item.targetId()).orElseThrow();
                payment=refund.paymentId(); cancellation=pg.getObject().lookupCancellation(refund).orElse(null);
            }
            payload=pg.getObject().financial(payment).orElse(null);
        }
        boolean externalFulfillment=payload instanceof ExternalLedger.PaymentSnapshot p && "APPROVED".equals(p.payment().status())
            && order!=null && jobs.find(order).isEmpty() && !supplier.getObject().ordersForOrder(order).isEmpty();
        return new Observation(order,version,payload,externalFulfillment,funding,cancellation);
    }
    @Transactional
    public void complete(ReconciliationRepository.Item claim,Observation observed) {
        var item=runs.lockItem(claim.id()); if (!runs.owns(item,claim)) return;
        UUID order=internalOrder(item.kind(),item.targetId());
        if (!Objects.equals(order,observed.order())) { runs.finish(item,order,"STALE_TARGET",null,null,null,null); return; }
        if (order!=null) {
            var current=targets.read(order,RecoveryTargets.Kind.valueOf(item.kind()),item.targetId(),true);
            if (!current.view().version().equals(observed.version())) { runs.finish(item,order,"STALE_TARGET",null,null,null,null); return; }
        }
        Object payload=observed.payload();
        String hash=payload==null?null:RecoveryTargets.hash(mapper.writeValueAsString(new Object[]{payload,observed.funding(),observed.cancellation()}));
        String status=payload instanceof ExternalLedger.PaymentSnapshot p?p.payment().status():payload instanceof SupplierResult s?s.status():payload instanceof RefundProtection.Result h?h.state():"NOT_FOUND";
        String reference=payload instanceof ExternalLedger.PaymentSnapshot p?p.payment().transactionId():payload instanceof SupplierResult s?s.supplierOrderNo():payload instanceof RefundProtection.Result h?h.operationId().toString():null;
        String code=null;
        orders.historyContext(null,"RECONCILIATION",null);
        try {
            if (payload instanceof ExternalLedger.PaymentSnapshot p && !recordCancellations(p)) {
                if (order!=null) conflicts.reject(order,"PAYMENT",p.payment().paymentId(),"PG_CANCEL_REFERENCE_CONFLICT","RECONCILIATION",null,"CANCELLED",hash);
                code="RESULT_CONFLICT";
            }
            else if (payload==null) code="PROVIDER_RECORD_MISSING";
            else if (order==null) code="ISSUANCE".equals(item.kind())?"ORPHAN_ISSUANCE":"ORPHAN_PAYMENT";
            else if (conflicts.blocked(order)) code="ORDER_RESULT_CONFLICT";
            else if (observed.externalFulfillment()) {
                conflicts.reject(order,"PAYMENT",((ExternalLedger.PaymentSnapshot)payload).payment().paymentId(),"MISSING_FULFILLMENT_LINK","RECONCILIATION",null,"ISSUED",hash);
                code="MISSING_FULFILLMENT_LINK";
            }
            else if (payload instanceof RefundProtection.Result hold) protectionResults.reconcile(protection.get(item.targetId()),hold);
            else if (payload instanceof ExternalLedger.PaymentSnapshot payment) {
                code=payment(item,order,payment);
                if (observed.cancellation()!=null && (code==null || "PROVIDER_PENDING".equals(code))) {
                    refundResults.reconcile(refunds.findById(item.targetId()).orElseThrow(),observed.cancellation());
                    code=consistent(order)?null:"INTERNAL_STATE_INCONSISTENT";
                }
            }
            else code=issuance(item,order,(SupplierResult)payload,observed.funding());
        } catch (OrderConflicts.ConflictException e) { code="RESULT_CONFLICT"; }
        // Only domain conflicts are caught here. Storage failures roll back business changes and item completion together.
        if (code!=null) incidents.open(order,item.kind(),item.targetId(),code,reference,hash);
        else incidents.resolve(item.kind(),item.targetId(),hash);
        runs.finish(item,order,code==null?"MATCHED":"OPEN_INCIDENT",code,status,reference,hash);
    }
    private String payment(ReconciliationRepository.Item item,UUID orderId,ExternalLedger.PaymentSnapshot snapshot) {
        var result=snapshot.payment();
        UUID paymentId="REFUND".equals(item.kind())?refunds.findById(item.targetId()).orElseThrow().paymentId():result.paymentId();
        var payment=payments.lock(paymentId); var order=orders.lock(orderId);
        if (!payment.id().equals(result.paymentId()) || !result.matches(payment))
            throw conflicts.reject(orderId,"PAYMENT",payment.id(),"PG_RESULT_MISMATCH","RECONCILIATION",payment.status(),result.status(),mapper.writeValueAsString(result));
        if (snapshot.cancelledTotal()>0) {
            if (!"APPROVED".equals(payment.status())) {
                conflicts.reject(orderId,"PAYMENT",payment.id(),"EXTERNAL_CANCELLATION_UNMATCHED","RECONCILIATION",payment.status(),"CANCELLED",mapper.writeValueAsString(snapshot));
                return "EXTERNAL_CANCELLATION_UNMATCHED";
            }
            boolean unmatched=false;
            for (var cancellation:snapshot.cancellations()) {
                var refund=refunds.findById(cancellation.idempotencyKey());
                if (refund.isEmpty() || !refund.get().orderId().equals(orderId)) {
                    balance.record(cancellation); unmatched=true;
                } else refundResults.reconcile(refund.get(),cancellation);
            }
            balance.refresh(orderId);
            if (unmatched || balance.summary(orderId).overReserved()) {
                conflicts.reject(orderId,"PAYMENT",payment.id(),"EXTERNAL_CANCELLATION_UNMATCHED","RECONCILIATION",payment.status(),"CANCELLED",mapper.writeValueAsString(snapshot));
                return "EXTERNAL_CANCELLATION_UNMATCHED";
            }
            return consistent(orderId)?null:"INTERNAL_STATE_INCONSISTENT";
        }
        if (refunds.list(orderId).stream().anyMatch(r->"SUCCEEDED".equals(r.status()))) return "INTERNAL_STATE_INCONSISTENT";
        if ("REFUND".equals(item.kind())) return "PROVIDER_PENDING";
        if ("APPROVED".equals(payment.status()) && jobs.find(orderId).isEmpty()) {
            conflicts.reject(orderId,"PAYMENT",payment.id(),"MISSING_FULFILLMENT_LINK","RECONCILIATION",payment.status(),result.status(),mapper.writeValueAsString(snapshot));
            return "MISSING_FULFILLMENT_LINK";
        }
        if (!List.of("APPROVED","DECLINED").contains(payment.status()) && !"PAYMENT_PROCESSING".equals(order.status())) return "INTERNAL_STATE_INCONSISTENT";
        paymentResults.result(result,null,"LOOKUP");
        if ("DECLINED".equals(result.status())) return declinedConsistent(orderId)?null:"INTERNAL_STATE_INCONSISTENT";
        return consistent(orderId)?null:"INTERNAL_STATE_INCONSISTENT";
    }
    private String issuance(ReconciliationRepository.Item item,UUID orderId,SupplierResult result,ExternalLedger.PaymentSnapshot funding) {
        var job=jobs.lock(item.targetId());
        if (!job.id().equals(result.requestId()) || !job.orderId().equals(result.orderId()) || !result.valid()
                || (job.supplierOrderNo()!=null && !job.supplierOrderNo().equals(result.supplierOrderNo())))
            throw conflicts.reject(orderId,"ISSUANCE",job.id(),"SUPPLIER_RESULT_MISMATCH","RECONCILIATION",job.status(),result.status(),mapper.writeValueAsString(result));
        if (funding==null) return "PROVIDER_RECORD_MISSING";
        var payment=payments.findById(funding.payment().paymentId());
        if (payment.isEmpty() || !payment.get().orderId().equals(orderId) || !funding.payment().matches(payment.get())
                || !"APPROVED".equals(funding.payment().status()) || !"APPROVED".equals(payment.get().status()) || !recordCancellations(funding)) {
            conflicts.reject(orderId,"ISSUANCE",job.id(),"ISSUANCE_PAYMENT_MISMATCH","RECONCILIATION",job.status(),result.status(),mapper.writeValueAsString(funding));
            return "RESULT_CONFLICT";
        }
        if (funding.cancelledTotal()>0) {
            String problem=payment(item,orderId,funding);
            if (problem!=null) return problem;
        }
        if ("ACCEPTED".equals(result.status())) return "PROVIDER_PENDING";
        if ("ISSUED".equals(job.status()) && jobs.profile(orderId).isEmpty()) {
            conflicts.reject(orderId,"ISSUANCE",job.id(),"MISSING_PROFILE_LINK","RECONCILIATION",job.status(),result.status(),mapper.writeValueAsString(result));
            return "MISSING_PROFILE_LINK";
        }
        if (!List.of("ISSUED","FAILED").contains(job.status())
                && (!"PAID".equals(orders.lock(orderId).status()) || jobs.find(orderId).filter(j->j.id().equals(job.id())).isEmpty()))
            return "INTERNAL_STATE_INCONSISTENT";
        issuanceResults.result(result,null,"LOOKUP");
        return consistent(orderId)?null:"INTERNAL_STATE_INCONSISTENT";
    }
    private boolean consistent(UUID orderId) {
        if (conflicts.blocked(orderId)) return false;
        var order=orders.lock(orderId); var job=jobs.find(orderId); var profile=jobs.profile(orderId);
        if (!refunds.list(orderId).isEmpty()) {
            var totals=balance.summary(orderId);
            String expected=totals.reserved()>0?"REFUND_PROCESSING":totals.confirmed()==totals.approved()?"REFUNDED":totals.confirmed()>0?"PARTIALLY_REFUNDED":"PAID";
            return !totals.overReserved() && expected.equals(order.status()) && job.isPresent()
                && (profile.isPresent()?"ISSUED".equals(job.get().status()):"FAILED".equals(job.get().status()));
        }
        if (!"PAID".equals(order.status()) || job.isEmpty()) return false;
        return profile.isPresent()=="ISSUED".equals(job.get().status());
    }
    private boolean recordCancellations(ExternalLedger.PaymentSnapshot snapshot) {
        boolean unchanged=true;
        for (var cancellation:snapshot.cancellations()) {
            var occurred=snapshot.cancellationTimes().get(cancellation.id());
            String evidence=RecoveryTargets.hash(mapper.writeValueAsString(new Object[]{cancellation,occurred}));
            jdbc.update("""
                INSERT INTO external_cancellations(id,payment_id,request_id,amount,cancelled_total,evidence_hash,external_occurred_at) VALUES(?,?,?,?,?,?,?)
                ON CONFLICT(id) DO NOTHING
                """,cancellation.id(),cancellation.paymentId(),cancellation.idempotencyKey(),cancellation.amount(),cancellation.cancelledTotal(),evidence,ReconciliationRepository.ts(occurred));
            unchanged&=evidence.equals(jdbc.queryForObject("SELECT evidence_hash FROM external_cancellations WHERE id=?",String.class,cancellation.id()));
        }
        return unchanged;
    }
    private boolean declinedConsistent(UUID orderId) {
        var order=orders.lock(orderId);
        var active=payments.list(orderId).stream().filter(p->!"DECLINED".equals(p.status())).findFirst();
        if (active.isPresent() && "APPROVED".equals(active.get().status())) return consistent(orderId);
        boolean noProvision=jobs.find(orderId).isEmpty() && jobs.profile(orderId).isEmpty() && refunds.find(orderId).isEmpty();
        return noProvision && (active.isPresent()?"PAYMENT_PROCESSING".equals(order.status()):List.of("PENDING_PAYMENT","EXPIRED").contains(order.status()));
    }
    record Observation(UUID order,String version,Object payload,boolean externalFulfillment,ExternalLedger.PaymentSnapshot funding,MockPgService.Cancellation cancellation) {}
}
