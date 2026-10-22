package service;

import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name="issuance.mock-enabled",havingValue="true")
public class ProfileTrackingWorker {
    private final JdbcTemplate jdbc;
    private final ProfileTrackingService tracking;
    private final SupplierClient supplier;
    private final IssuanceSettings settings;
    public ProfileTrackingWorker(JdbcTemplate jdbc,ProfileTrackingService tracking,SupplierClient supplier,IssuanceSettings settings) {
        this.jdbc=jdbc; this.tracking=tracking; this.supplier=supplier; this.settings=settings;
    }
    @Scheduled(fixedDelayString="${issuance.worker-delay-ms}",initialDelayString="${issuance.worker-delay-ms}")
    public void tick() {
        tracking.expire();
        UUID token=UUID.randomUUID();
        var due=jdbc.query("""
            WITH due AS (SELECT id FROM sim_profiles WHERE install_status<>'DELETED'
                AND next_sync_at<=clock_timestamp() AND (sync_lease_until IS NULL OR sync_lease_until<=clock_timestamp())
                ORDER BY next_sync_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
            UPDATE sim_profiles SET sync_lease_token=?,sync_lease_until=clock_timestamp()+(? * INTERVAL '1 millisecond')
            WHERE id IN (SELECT id FROM due) RETURNING *
            """,IssuanceRepository.PROFILE,token,settings.leaseMs());
        if (due.isEmpty()) return;
        var profile=due.getFirst();
        try { tracking.apply(supplier.profile(profile.iccid()),"LOOKUP",token); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); defer(profile.id(),token); }
        catch (Exception e) { defer(profile.id(),token); }
    }
    private void defer(UUID id,UUID token) {
        jdbc.update("""
            UPDATE sim_profiles SET sync_error='SUPPLIER_PROFILE_UNAVAILABLE',sync_lease_token=NULL,sync_lease_until=NULL,
                next_sync_at=clock_timestamp()+INTERVAL '30 seconds' WHERE id=? AND sync_lease_token=?
            """,id,token);
    }
}
