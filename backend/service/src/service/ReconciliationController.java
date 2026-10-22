package service;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/admin")
public class ReconciliationController {
    private final ReconciliationService service;
    private final ReconciliationRepository runs;
    private final IncidentRepository incidents;
    private final MemberRepository members;
    public ReconciliationController(ReconciliationService service,ReconciliationRepository runs,IncidentRepository incidents,MemberRepository members) {
        this.service=service; this.runs=runs; this.incidents=incidents; this.members=members;
    }
    @GetMapping("/reconciliation-runs")
    ResponseEntity<Runs> runs() { return read(new Runs(runs.list(),runs.lastSuccessfulAt(),Instant.now())); }
    @PostMapping("/reconciliation-runs")
    ResponseEntity<ReconciliationService.Receipt> create(Authentication auth,@RequestHeader("Idempotency-Key") UUID key,@Valid @RequestBody Request request) {
        var result=service.create(actor(auth),key,request); return accepted(result,result.replayed());
    }
    @GetMapping("/reconciliation-runs/{id}")
    @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    ResponseEntity<Detail> detail(@PathVariable UUID id,@RequestParam(defaultValue="0") int page,@RequestParam(defaultValue="50") int size) {
        validatePage(page,size); var run=runs.get(id); var rows=runs.items(id,page,size);
        return read(new Detail(run,rows.stream().limit(size).toList(),page,size,rows.size()>size));
    }
    @GetMapping("/incidents")
    ResponseEntity<Incidents> incidents(@RequestParam(required=false) String status,@RequestParam(defaultValue="0") int page,@RequestParam(defaultValue="20") int size) {
        validatePage(page,size);
        if (status!=null && !List.of("OPEN","INVESTIGATING","RESOLVED").contains(status)) throw invalid();
        var rows=incidents.list(status,page,size); return read(new Incidents(rows.stream().limit(size).toList(),page,size,rows.size()>size,Instant.now()));
    }
    @GetMapping("/incidents/{id}")
    @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    ResponseEntity<IncidentDetail> incident(@PathVariable UUID id) { return read(new IncidentDetail(incidents.get(id),incidents.events(id))); }
    @PostMapping("/incidents/{id}/investigations")
    ResponseEntity<IncidentRepository.Receipt> investigate(Authentication auth,@PathVariable UUID id,@RequestHeader("Idempotency-Key") UUID key,@Valid @RequestBody Investigation request) {
        var result=incidents.investigate(id,actor(auth),key,request.expectedVersion(),request.reason().trim()); return accepted(result,result.replayed());
    }
    private UUID actor(Authentication auth) { return members.findByUsername(auth.getName()).orElseThrow().id(); }
    private static void validatePage(int page,int size) { if (page<0 || size<1 || size>100) throw invalid(); }
    private static OrderService.OrderException invalid() { return new OrderService.OrderException(400,"INVALID_RECONCILIATION_FILTER","대사·사건 조회 조건을 확인해 주세요."); }
    private static <T> ResponseEntity<T> read(T value) { return ResponseEntity.ok().header("Cache-Control","no-store").body(value); }
    private static <T> ResponseEntity<T> accepted(T value,boolean replayed) { return ResponseEntity.status(replayed?200:202).header("Cache-Control","no-store").header("Idempotency-Replayed",Boolean.toString(replayed)).body(value); }
    public record Request(@NotBlank String mode,@NotBlank @Size(max=300) String reason,LocalDate from,LocalDate to) {}
    public record Investigation(@Min(1) long expectedVersion,@NotBlank @Size(max=300) String reason) {}
    record Runs(List<ReconciliationRepository.Run> items,Instant lastSuccessfulAt,Instant checkedAt) {}
    record Detail(ReconciliationRepository.Run run,List<ReconciliationRepository.Item> items,int page,int size,boolean hasNext) {}
    record Incidents(List<IncidentRepository.Incident> items,int page,int size,boolean hasNext,Instant checkedAt) {}
    record IncidentDetail(IncidentRepository.Incident incident,List<IncidentRepository.Event> events) {}
}
