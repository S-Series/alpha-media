package service;

import java.io.IOException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.Assert;
import tools.jackson.databind.ObjectMapper;

@Service
public class ReconciliationService {
    static final ZoneId KST=ZoneId.of("Asia/Seoul");
    private final ReconciliationRepository runs;
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final ObjectProvider<PgClient> pg;
    private final ObjectProvider<SupplierClient> supplier;
    private final boolean enabled;
    private final int pageSize;
    public ReconciliationService(ReconciliationRepository runs,JdbcTemplate jdbc,ObjectMapper mapper,ObjectProvider<PgClient> pg,
            ObjectProvider<SupplierClient> supplier,@Value("${reconciliation.enabled:true}") boolean enabled,
            @Value("${reconciliation.page-size:50}") int pageSize) {
        Assert.isTrue(pageSize>=1 && pageSize<=100,"Invalid reconciliation page size");
        this.runs=runs; this.jdbc=jdbc; this.mapper=mapper; this.pg=pg; this.supplier=supplier; this.enabled=enabled; this.pageSize=pageSize;
    }
    boolean available() { return enabled && pg.getIfAvailable()!=null && supplier.getIfAvailable()!=null; }
    @Transactional
    public Receipt create(UUID actor,UUID key,ReconciliationController.Request request) {
        if (!available()) throw new OrderService.OrderException(503,"RECONCILIATION_DISABLED","외부 원장 조회가 활성화되지 않았습니다.");
        String mode=request.mode();
        if (!List.of("PENDING","LEDGER").contains(mode)) throw invalid();
        String hash=RecoveryTargets.hash(mapper.writeValueAsString(request));
        runs.lockKey(key);
        runs.lockMode(mode);
        var old=runs.byKey(key);
        if (old.isPresent()) {
            if (!old.get().payloadHash().equals(hash)) throw new OrderService.OrderException(409,"RECONCILIATION_KEY_CONFLICT","같은 요청 키의 대사 조건이 다릅니다.");
            return new Receipt(old.get(),true);
        }
        Instant from,to;
        if ("PENDING".equals(mode)) {
            if (request.from()!=null || request.to()!=null) throw invalid();
            from=Instant.EPOCH; to=Instant.now();
        } else {
            LocalDate end=request.to()==null?LocalDate.now(KST):request.to();
            LocalDate start=request.from()==null?end.minusDays(7):request.from();
            long days=ChronoUnit.DAYS.between(start,end);
            if (days<1 || days>31 || end.isAfter(LocalDate.now(KST).plusDays(1))) throw invalid();
            from=start.atStartOfDay(KST).toInstant(); to=end.atStartOfDay(KST).toInstant();
            if (to.isAfter(Instant.now())) to=Instant.now();
        }
        if (runs.active(mode)) throw new OrderService.OrderException(409,"RECONCILIATION_IN_PROGRESS","같은 종류의 대사가 진행 중입니다. 기존 작업을 확인해 주세요.");
        return new Receipt(runs.insert(key,hash,mode,actor,request.reason().trim(),from,to),false);
    }
    @Transactional
    public void schedule() {
        if (!available()) return;
        var modes=jdbc.queryForList("SELECT mode FROM reconciliation_schedule WHERE next_at<=clock_timestamp() ORDER BY mode FOR UPDATE SKIP LOCKED",String.class);
        for (String mode:modes) {
            runs.lockMode(mode);
            if (runs.active(mode)) continue;
            Instant now=Instant.now(); LocalDate today=LocalDate.now(KST);
            Instant from="LEDGER".equals(mode)?today.minusDays(7).atStartOfDay(KST).toInstant():Instant.EPOCH;
            Instant to="LEDGER".equals(mode)?today.atStartOfDay(KST).toInstant():now;
            UUID key=UUID.randomUUID();
            runs.insert(key,RecoveryTargets.hash(key.toString()),mode,null,"SCHEDULED_"+mode,from,to);
            Instant next="LEDGER".equals(mode)?today.plusDays(1).atStartOfDay(KST).toInstant():now.plusSeconds(900);
            jdbc.update("UPDATE reconciliation_schedule SET next_at=? WHERE mode=?",ReconciliationRepository.ts(next),mode);
        }
    }
    Scan fetchPage(ReconciliationRepository.Run run) throws IOException,InterruptedException {
        if ("INTERNAL".equals(run.phase())) {
            var rows=jdbc.query("""
                WITH candidates AS (
                    SELECT 'PAYMENT' kind,p.id target_id,p.order_id FROM payment_attempts p JOIN orders o ON o.id=p.order_id
                    WHERE p.created_at<=? AND (p.status IN ('UNKNOWN','REVIEW_REQUIRED')
                        OR (p.status IN ('QUEUED','PROCESSING') AND p.created_at<clock_timestamp()-INTERVAL '2 minutes')
                        OR (p.status='APPROVED' AND o.status='PAID' AND NOT EXISTS(SELECT 1 FROM issuance_jobs j WHERE j.order_id=p.order_id)))
                    UNION SELECT 'ISSUANCE',j.id,j.order_id FROM issuance_jobs j WHERE is_current AND created_at<=?
                        AND (status='REVIEW_REQUIRED' OR (status IN ('QUEUED','PROCESSING','WAITING_CALLBACK') AND created_at<clock_timestamp()-INTERVAL '2 minutes')
                            OR (status='ISSUED' AND NOT EXISTS(SELECT 1 FROM sim_profiles p WHERE p.order_id=j.order_id)))
                    UNION SELECT 'REFUND',id,order_id FROM refunds WHERE created_at<=? AND (status IN ('UNKNOWN','REVIEW_REQUIRED')
                        OR (status IN ('REQUESTED','PROCESSING') AND created_at<clock_timestamp()-INTERVAL '2 minutes'))
                    UNION SELECT 'PROTECTION',id,order_id FROM refund_protection_jobs WHERE created_at<=? AND status='REVIEW_REQUIRED'
                    UNION SELECT kind,target_id,order_id FROM incidents WHERE status<>'RESOLVED' AND first_seen_at<=?
                        AND kind IN ('PAYMENT','ISSUANCE','REFUND','PROTECTION')
                        AND code NOT IN ('WORKER_HEARTBEAT_MISSING','EXECUTABLE_BACKLOG','SUPPLIER_CONFIRMATION_DELAYED')
                    UNION SELECT target,target_id,order_id FROM order_conflicts WHERE target IN ('PAYMENT','ISSUANCE','REFUND') AND recorded_at<=?
                ) SELECT *,kind||':'||target_id::text AS cursor_key FROM candidates
                WHERE (?::varchar IS NULL OR kind||':'||target_id::text>?) ORDER BY kind||':'||target_id::text LIMIT ?
                """,(r,n)->new Candidate(r.getString("kind"),r.getObject("target_id",UUID.class),r.getObject("order_id",UUID.class),r.getString("cursor_key")),
                ReconciliationRepository.ts(run.createdAt()),ReconciliationRepository.ts(run.createdAt()),ReconciliationRepository.ts(run.createdAt()),
                ReconciliationRepository.ts(run.createdAt()),ReconciliationRepository.ts(run.createdAt()),ReconciliationRepository.ts(run.createdAt()),run.cursorKey(),run.cursorKey(),pageSize+1);
            var page=rows.stream().limit(pageSize).toList();
            return new Scan(page,null,rows.size()>pageSize?page.getLast().key():null);
        }
        ExternalLedger.Page page=switch(run.phase()) {
            case "PG_PAYMENTS" -> pg.getObject().paymentLedger(run.fromAt(),run.toAt(),run.cursorTime(),run.cursorId(),pageSize);
            case "PG_CANCELLATIONS" -> pg.getObject().cancellationLedger(run.fromAt(),run.toAt(),run.cursorTime(),run.cursorId(),pageSize);
            case "SUPPLIER" -> supplier.getObject().orderLedger(run.fromAt(),run.toAt(),run.cursorTime(),run.cursorId(),pageSize);
            default -> throw new IllegalStateException("Unknown reconciliation phase");
        };
        return new Scan(null,page,null);
    }
    @Transactional
    public void savePage(ReconciliationRepository.Run claim,Scan page) {
        var current=runs.lock(claim.id()); if (!runs.owns(current,claim)) return;
        if (page.internal()!=null) {
            for (var item:page.internal()) runs.add(claim.id(),item.kind(),item.id(),item.order());
            String phase=page.nextKey()!=null?"INTERNAL":("LEDGER".equals(claim.mode())?"PG_PAYMENTS":"DONE");
            runs.advance(claim,phase,page.nextKey(),null,null);
        } else {
            String kind="SUPPLIER".equals(claim.phase())?"ISSUANCE":"PAYMENT";
            for (var entry:page.external().items()) {
                UUID target="PG_CANCELLATIONS".equals(claim.phase())?entry.paymentId():entry.id();
                // Provider order IDs are evidence, not permission to attach an orphan transaction to a customer.
                var order=jdbc.queryForList("SELECT order_id FROM "+("ISSUANCE".equals(kind)?"issuance_jobs":"payment_attempts")+" WHERE id=?",UUID.class,target);
                runs.add(claim.id(),kind,target,order.isEmpty()?null:order.getFirst());
            }
            String phase=page.external().nextId()!=null?claim.phase():switch(claim.phase()) {
                case "PG_PAYMENTS" -> "PG_CANCELLATIONS"; case "PG_CANCELLATIONS" -> "SUPPLIER"; default -> "DONE"; };
            runs.advance(claim,phase,null,page.external().nextTime(),page.external().nextId());
        }
    }
    private static OrderService.OrderException invalid() { return new OrderService.OrderException(400,"INVALID_RECONCILIATION_RANGE","대사 종류와 KST 조회 구간(시작 포함·종료 제외, 최대 31일)을 확인해 주세요."); }
    record Candidate(String kind,UUID id,UUID order,String key) {}
    record Scan(List<Candidate> internal,ExternalLedger.Page external,String nextKey) {}
    public record Receipt(ReconciliationRepository.Run run,boolean replayed) {}
}
