package service;

import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class RefundProtectionService {
    private final RefundProtection jobs;
    private final RefundRepository refunds;
    private final OrderRepository orders;
    private final RefundBalance balance;
    private final ProfileTrackingService profiles;
    private final IncidentRepository incidents;
    private final PaymentSettings settings;
    private final JdbcTemplate jdbc;
    public RefundProtectionService(RefundProtection jobs,RefundRepository refunds,OrderRepository orders,RefundBalance balance,
            ProfileTrackingService profiles,IncidentRepository incidents,PaymentSettings settings,JdbcTemplate jdbc) {
        this.jobs=jobs; this.refunds=refunds; this.orders=orders; this.balance=balance; this.profiles=profiles;
        this.incidents=incidents; this.settings=settings; this.jdbc=jdbc;
    }
    @Transactional
    public void complete(RefundProtection.Job claim,RefundProtection.Result result) {
        orders.lock(claim.orderId());
        jdbc.queryForList("SELECT id FROM refund_protection_jobs WHERE id=? FOR UPDATE",claim.id());
        if (!jobs.owns(claim)) return;
        apply(jobs.get(claim.id()),result);
    }
    @Transactional
    public void reconcile(RefundProtection.Job job,RefundProtection.Result result) {
        orders.lock(job.orderId());
        jdbc.queryForList("SELECT id FROM refund_protection_jobs WHERE id=? FOR UPDATE",job.id());
        apply(jobs.get(job.id()),result);
    }
    private void apply(RefundProtection.Job job,RefundProtection.Result result) {
        var profile=result==null?null:result.profile();
        boolean identity=result!=null && job.id().equals(result.operationId()) && job.refundId().equals(result.refundId())
            && job.orderId().equals(result.orderId()) && job.iccid().equals(result.iccid()) && job.phase().equals(result.phase())
            && profile!=null && profile.valid() && job.orderId().equals(profile.orderId()) && job.iccid().equals(profile.iccid());
        String expected=switch(job.phase()) { case "HOLD"->"BLOCKED"; case "RELEASE"->"RELEASED"; default->"TERMINATED"; };
        boolean rejected=result!=null && "HOLD".equals(job.phase()) && "REJECTED".equals(result.state());
        if (!identity || !(expected.equals(result.state()) || rejected)
                || (!rejected && (profile.installedAt()!=null || profile.activatedAt()!=null))
                || ("TERMINATE".equals(job.phase()) && !"DELETED".equals(profile.state())))
            throw new SupplierClient.InvalidResult();
        if (List.of("SUCCEEDED","REJECTED").contains(job.status())) {
            if (rejected!="REJECTED".equals(job.status())) throw new SupplierClient.InvalidResult();
            return;
        }
        var refund=refunds.lock(job.refundId());
        if ("HOLD".equals(job.phase())) {
            if (!"WAITING_GUARD".equals(refund.status())) throw new SupplierClient.InvalidResult();
            refunds.save(refund.id(),rejected?"FAILED":"REQUESTED",null,rejected?"SIM_ALREADY_USED":null,0);
            balance.refresh(job.orderId());
        } else {
            if (!("TERMINATE".equals(job.phase())?"SUCCEEDED":"FAILED").equals(refund.status())) throw new SupplierClient.InvalidResult();
            if ("TERMINATE".equals(job.phase())) profiles.apply(profile,"REFUND",null);
        }
        jobs.finish(job,rejected?"REJECTED":"SUCCEEDED",rejected?"SIM_ALREADY_USED":null,0);
        incidents.resolve("PROTECTION",job.id(),null);
    }
    @Transactional
    public void uncertain(RefundProtection.Job claim,boolean force,String error) {
        orders.lock(claim.orderId());
        jdbc.queryForList("SELECT id FROM refund_protection_jobs WHERE id=? FOR UPDATE",claim.id());
        if (!jobs.owns(claim)) return;
        boolean stop=force || claim.roundAttemptCount()>=RefundProtection.LIMIT;
        jobs.finish(claim,stop?"REVIEW_REQUIRED":"UNKNOWN",error,settings.retryDelay(claim.roundAttemptCount()));
        if (stop) incidents.open(claim.orderId(),"PROTECTION",claim.id(),"SUPPLIER_"+claim.phase()+"_UNKNOWN",claim.iccid(),null);
    }
}
