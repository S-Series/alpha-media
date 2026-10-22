package service;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class RequestRateLimits {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final Map<String,Integer> limits=new LinkedHashMap<>();
    final boolean enabled;
    public RequestRateLimits(JdbcTemplate jdbc,PlatformTransactionManager manager,Environment env) {
        this.jdbc=jdbc; transaction=new TransactionTemplate(manager);
        enabled=env.getProperty("REQUEST_RATE_LIMIT_ENABLED",Boolean.class,true);
        configure(env,"LOGIN_IP",30); configure(env,"LOGIN_ACCOUNT",5);
        configure(env,"WRITE_IP",300); configure(env,"WRITE_MEMBER",30);
        configure(env,"READ_IP",600); configure(env,"READ_MEMBER",300);
        configure(env,"WEBHOOK_IP",600); configure(env,"WEBHOOK_SOURCE",3000);
    }
    private void configure(Environment env,String scope,int fallback) {
        int value=env.getProperty("REQUEST_"+scope+"_LIMIT",Integer.class,fallback);
        if (value<1 || value>100000) throw new IllegalArgumentException("Invalid request rate limit: "+scope);
        limits.put(scope,value);
    }
    // Both dimensions commit before business processing, including denied attempts.
    int consume(Map<String,String> subjects) {
        if (!enabled) return 0;
        return transaction.execute(tx->{
            Instant now=jdbc.queryForObject("SELECT clock_timestamp()",Timestamp.class).toInstant();
            Instant start=Instant.ofEpochSecond(Math.floorDiv(now.getEpochSecond(),60)*60);
            for (var subject:subjects.entrySet()) {
                int limit=limits.get(subject.getKey());
                Integer hits=jdbc.queryForObject("""
                    INSERT INTO request_rate_buckets(scope,subject_hash,window_start,hits) VALUES(?,?,?,1)
                    ON CONFLICT(scope,subject_hash,window_start) DO UPDATE
                        SET hits=LEAST(request_rate_buckets.hits+1,?)
                    RETURNING hits
                    """,Integer.class,subject.getKey(),RecoveryTargets.hash(subject.getValue()),Timestamp.from(start),limit+1);
                if (hits>limit) {
                    record(subject.getKey(),"RATE_LIMITED");
                    return (int)Math.max(1,start.plusSeconds(60).getEpochSecond()-now.getEpochSecond());
                }
            }
            return 0;
        });
    }
    void record(String source,String reason) {
        jdbc.update("""
            INSERT INTO request_security_counts(source,reason,window_start)
            VALUES(?,?,date_trunc('minute',clock_timestamp()))
            ON CONFLICT(source,reason,window_start) DO UPDATE SET hits=request_security_counts.hits+1
            """,source,reason);
    }
    public Map<String,Object> snapshot() {
        return Map.of("enabled",enabled,"windowSeconds",60,"limits",limits,"history",jdbc.queryForList(
            "SELECT id,enabled,limits::text AS limits_json,recorded_at FROM request_guard_history ORDER BY recorded_at DESC LIMIT 20"),"counts",jdbc.queryForList("""
            SELECT source,reason,window_start,hits FROM request_security_counts
            WHERE window_start>clock_timestamp()-INTERVAL '24 hours' ORDER BY window_start DESC,source,reason LIMIT 200
            """));
    }
    @org.springframework.context.event.EventListener(org.springframework.boot.context.event.ApplicationReadyEvent.class)
    public void recordConfiguration() {
        String json=limits.entrySet().stream().map(entry->"\""+entry.getKey()+"\":"+entry.getValue())
            .collect(java.util.stream.Collectors.joining(",","{","}"));
        jdbc.update("INSERT INTO request_guard_history(id,enabled,limits) VALUES(?,?,?::jsonb)",java.util.UUID.randomUUID(),enabled,json);
    }
    @Scheduled(fixedDelay=60000,initialDelay=60000)
    public void cleanup() {
        jdbc.update("DELETE FROM request_rate_buckets WHERE window_start<clock_timestamp()-INTERVAL '2 minutes'");
        jdbc.update("DELETE FROM request_security_counts WHERE window_start<clock_timestamp()-INTERVAL '7 days'");
    }
}
