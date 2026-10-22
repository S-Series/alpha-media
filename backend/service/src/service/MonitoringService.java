package service;

import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class MonitoringService {
    private static final Logger LOG=LoggerFactory.getLogger(MonitoringService.class);
    static final String HEARTBEAT="WORKER_HEARTBEAT_MISSING", BACKLOG="EXECUTABLE_BACKLOG", SUPPLIER="SUPPLIER_CONFIRMATION_DELAYED";
    private final JdbcTemplate jdbc;
    private final IncidentRepository incidents;
    private final TransactionTemplate transaction;
    private final Map<String,Boolean> workers=new LinkedHashMap<>();
    private final Map<String,Long> lastPulse=new ConcurrentHashMap<>();
    private final boolean enabled;

    public MonitoringService(JdbcTemplate jdbc,IncidentRepository incidents,PlatformTransactionManager manager,Environment env) {
        this.jdbc=jdbc; this.incidents=incidents; this.transaction=new TransactionTemplate(manager);
        enabled=env.getProperty("monitoring.enabled",Boolean.class,true);
        boolean pg=env.getProperty("payment.mock-enabled",Boolean.class,false);
        boolean supplier=env.getProperty("issuance.mock-enabled",Boolean.class,false);
        workers.put("PAYMENT",pg); workers.put("REFUND",pg); workers.put("ISSUANCE",supplier); workers.put("PROFILE",supplier);
        workers.put("PROTECTION",supplier); workers.put("INBOUND",true); workers.put("RECOVERY",true);
        workers.put("RECONCILIATION",pg && supplier && env.getProperty("reconciliation.enabled",Boolean.class,true));
    }
    boolean enabled() { return enabled; }
    private static UUID target(String category,String name) { return UUID.nameUUIDFromBytes((category+":"+name).getBytes(StandardCharsets.UTF_8)); }
    private static Instant instant(Timestamp value) { return value==null?null:value.toInstant(); }
    private static long age(Instant now,Instant time) { return time==null?0:Math.max(0,java.time.Duration.between(time,now).getSeconds()); }
    private Instant now() { return jdbc.queryForObject("SELECT clock_timestamp()",Timestamp.class).toInstant(); }
    private void register(String name) {
        jdbc.update("""
            INSERT INTO worker_heartbeats(name,enabled) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET
                enabled=EXCLUDED.enabled,
                initialized_at=CASE WHEN NOT worker_heartbeats.enabled AND EXCLUDED.enabled THEN clock_timestamp() ELSE worker_heartbeats.initialized_at END,
                last_seen_at=CASE WHEN NOT worker_heartbeats.enabled AND EXCLUDED.enabled THEN NULL ELSE worker_heartbeats.last_seen_at END
            WHERE worker_heartbeats.enabled IS DISTINCT FROM EXCLUDED.enabled
            """,name,Boolean.TRUE.equals(workers.get(name)));
    }

    // A heartbeat is a worker-loop signal, not proof that a payment or provider call succeeded.
    void pulse(String name) {
        if (!enabled || !Boolean.TRUE.equals(workers.get(name))) return;
        long tick=System.nanoTime(), previous=lastPulse.getOrDefault(name,0L);
        if (previous!=0 && tick-previous<10_000_000_000L) return;
        lastPulse.put(name,tick);
        try {
            transaction.executeWithoutResult(tx->{
                register(name);
                var row=jdbc.queryForMap("SELECT COALESCE(last_seen_at,initialized_at) AS seen FROM worker_heartbeats WHERE name=? FOR UPDATE",name);
                var seen=((Timestamp)row.get("seen")).toInstant();
                if (now().isAfter(seen.plusSeconds(60)))
                    incidents.open(null,"WORKER",target("WORKER",name),HEARTBEAT,name,RecoveryTargets.hash(name+":"+seen));
                jdbc.update("UPDATE worker_heartbeats SET last_seen_at=clock_timestamp() WHERE name=?",name);
            });
        } catch (RuntimeException error) {
            // Monitoring must not turn a database outage into a new business retry or block normal processing.
            LOG.warn("Worker heartbeat was not persisted ({})",error.getClass().getSimpleName());
        }
    }

    public void scan() {
        if (!enabled) return;
        transaction.executeWithoutResult(tx->{
            // Multiple monitor instances must not publish competing recovery or duplicate alert events.
            if (!Boolean.TRUE.equals(jdbc.queryForObject("SELECT pg_try_advisory_xact_lock(512840051)",Boolean.class))) return;
            for (String worker:workers.keySet()) register(worker);
            var now=now();
            for (var worker:workerStates(now)) {
                var id=target("WORKER",worker.name());
                if (worker.enabled() && worker.overdue()) incidents.open(null,"WORKER",id,HEARTBEAT,worker.name(),RecoveryTargets.hash(worker.name()+":"+worker.lastSignalAt()));
                else incidents.resolveCode("WORKER",id,HEARTBEAT,worker.enabled()?"WORKER_SIGNAL_RESTORED":"WORKER_DISABLED");
            }
            for (var queue:queues(now)) {
                var id=target("QUEUE",queue.name());
                if (queue.overdue()) incidents.open(null,"QUEUE",id,BACKLOG,queue.name(),RecoveryTargets.hash(queue.name()+":"+queue.oldestId()));
                else incidents.resolveCode("QUEUE",id,BACKLOG,"EXECUTABLE_BACKLOG_CLEARED");
            }
            var failures=failures(now);
            for (var failure:failures) if (failure.overdue())
                incidents.open(failure.orderId(),failure.kind(),failure.id(),SUPPLIER,null,RecoveryTargets.hash(failure.kind()+":"+failure.id()+":"+failure.since()));
            // Only monitoring-owned conditions can be closed here; financial discrepancies remain quarantined.
            var open=jdbc.queryForList("SELECT kind,target_id FROM incidents WHERE code=? AND status<>'RESOLVED'",SUPPLIER);
            for (var row:open) if (failures.stream().noneMatch(f->f.overdue() && f.kind().equals(row.get("kind")) && f.id().equals(row.get("target_id"))))
                incidents.resolveCode((String)row.get("kind"),(UUID)row.get("target_id"),SUPPLIER,"SUPPLIER_FAILURE_CLEARED");
            jdbc.update("UPDATE monitoring_status SET last_checked_at=clock_timestamp() WHERE id=TRUE");
        });
    }

    private List<Worker> workerStates(Instant now) {
        var rows=jdbc.query("SELECT name,COALESCE(last_seen_at,initialized_at) AS seen,last_seen_at FROM worker_heartbeats ORDER BY name",
            (r,n)->new Worker(r.getString("name"),Boolean.TRUE.equals(workers.get(r.getString("name"))),r.getTimestamp("seen").toInstant(),
                instant(r.getTimestamp("last_seen_at")),age(now,r.getTimestamp("seen").toInstant()),now.isAfter(r.getTimestamp("seen").toInstant().plusSeconds(60))));
        var result=new ArrayList<Worker>(rows);
        for (var entry:workers.entrySet()) if (rows.stream().noneMatch(w->w.name().equals(entry.getKey())))
            result.add(new Worker(entry.getKey(),entry.getValue(),null,null,0,false));
        return result;
    }
    private List<Queue> queues(Instant now) {
        var result=new ArrayList<Queue>();
        for (String name:List.of("PROTECTION","PAYMENT","REFUND","ISSUANCE","PROFILE","INBOUND","RECOVERY","RECONCILIATION_PAGE","RECONCILIATION_ITEM")) {
            var rows=jdbc.query("""
                SELECT id,order_id,due_at,count(*) OVER() AS total FROM monitoring_queue_items
                WHERE queue=? AND due_at<=? ORDER BY due_at,id LIMIT 1
                """,(r,n)->new Queue(name,r.getLong("total"),r.getObject("id",UUID.class),r.getObject("order_id",UUID.class),
                    r.getTimestamp("due_at").toInstant(),age(now,r.getTimestamp("due_at").toInstant()),now.isAfter(r.getTimestamp("due_at").toInstant().plusSeconds(120))),name,Timestamp.from(now));
            result.add(rows.isEmpty()?new Queue(name,0,null,null,null,0,false):rows.getFirst());
        }
        return result;
    }
    private List<Failure> failures(Instant now) {
        return jdbc.query("SELECT * FROM monitoring_supplier_failures ORDER BY since,id",(r,n)->new Failure(r.getString("kind"),r.getObject("id",UUID.class),
            r.getObject("order_id",UUID.class),r.getTimestamp("since").toInstant(),r.getString("error"),
            age(now,r.getTimestamp("since").toInstant()),now.isAfter(r.getTimestamp("since").toInstant().plusSeconds(300))));
    }
    public Snapshot snapshot() {
        return transaction.execute(tx->{
            Instant now=now(), checked=instant(jdbc.queryForObject("SELECT last_checked_at FROM monitoring_status WHERE id=TRUE",Timestamp.class));
            var workerRows=workerStates(now); var queueRows=queues(now); var supplierRows=failures(now);
            long unresolved=jdbc.queryForObject("SELECT count(*) FROM incidents WHERE status<>'RESOLVED'",Long.class);
            String status=!enabled?"DISABLED":checked==null?"STARTING":now.isAfter(checked.plusSeconds(30))?"STALE"
                :unresolved>0 || workerRows.stream().anyMatch(w->w.enabled() && w.overdue()) || queueRows.stream().anyMatch(Queue::overdue)
                    || supplierRows.stream().anyMatch(Failure::overdue)?"DEGRADED":"HEALTHY";
            var alerts=jdbc.query("""
                SELECT e.id,e.incident_id,e.status,e.actor,e.reason,e.recorded_at,i.kind,i.code,i.order_id
                FROM incident_events e JOIN incidents i ON i.id=e.incident_id ORDER BY e.id DESC LIMIT 50
                """,(r,n)->new Alert(r.getString("id"),r.getObject("incident_id",UUID.class),r.getString("status"),r.getString("actor"),r.getString("reason"),
                    r.getTimestamp("recorded_at").toInstant(),r.getString("kind"),r.getString("code"),r.getObject("order_id",UUID.class)));
            return new Snapshot(status,checked,now,60,120,300,unresolved,workerRows,queueRows,supplierRows,alerts);
        });
    }
    public record Worker(String name,boolean enabled,Instant lastSignalAt,Instant lastSeenAt,long silentSeconds,boolean overdue) {}
    public record Queue(String name,long count,UUID oldestId,UUID orderId,Instant oldestDueAt,long waitingSeconds,boolean overdue) {}
    public record Failure(String kind,UUID id,UUID orderId,Instant since,String error,long failureSeconds,boolean overdue) {}
    public record Alert(String id,UUID incidentId,String status,String actor,String reason,Instant recordedAt,String kind,String code,UUID orderId) {}
    public record Snapshot(String status,Instant lastCheckedAt,Instant checkedAt,int heartbeatThresholdSeconds,int backlogThresholdSeconds,
        int supplierThresholdSeconds,long unresolvedIncidents,List<Worker> workers,List<Queue> queues,List<Failure> supplierFailures,List<Alert> alerts) {}
}
