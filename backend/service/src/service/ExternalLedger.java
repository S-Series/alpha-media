package service;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class ExternalLedger {
    private ExternalLedger() {}
    public record Entry(UUID id,UUID orderId,UUID paymentId,Instant occurredAt) {}
    public record Page(List<Entry> items,Instant nextTime,UUID nextId) {}
    public record PaymentSnapshot(PgResult payment,long cancelledTotal,List<MockPgService.Cancellation> cancellations,
        Map<UUID,Instant> cancellationTimes) {}

    static void range(Instant from,Instant to,Instant afterTime,UUID afterId,int limit) {
        if (from==null || to==null || !from.isBefore(to) || limit<1 || limit>100
                || (afterTime==null)!=(afterId==null)
                || (afterTime!=null && (afterTime.isBefore(from) || !afterTime.isBefore(to))))
            throw new IllegalArgumentException("Invalid ledger range or cursor");
    }
    static String query(Instant from,Instant to,Instant afterTime,UUID afterId,int limit) {
        range(from,to,afterTime,afterId,limit);
        return "?from="+encode(from)+"&to="+encode(to)+"&limit="+limit
            +(afterTime==null?"":"&afterTime="+encode(afterTime)+"&afterId="+afterId);
    }
    private static String encode(Instant value) { return URLEncoder.encode(value.toString(),StandardCharsets.UTF_8); }

    static Page validate(Page page,Instant from,Instant to,Instant afterTime,UUID afterId,int limit,String source) {
        range(from,to,afterTime,afterId,limit);
        if (page==null || page.items()==null || page.items().size()>limit || (page.nextTime()==null)!=(page.nextId()==null))
            throw new IllegalArgumentException("Invalid ledger page");
        var ids=new HashSet<UUID>(); Instant previousTime=afterTime; UUID previousId=afterId;
        for (var item:page.items()) {
            if (item==null || item.id()==null || item.orderId()==null || item.occurredAt()==null
                    || !ids.add(item.id()) || item.occurredAt().isBefore(from) || !item.occurredAt().isBefore(to)
                    || ("SUPPLIER".equals(source)?item.paymentId()!=null:item.paymentId()==null)
                    || ("PAYMENT".equals(source) && !item.id().equals(item.paymentId()))
                    || (previousTime!=null && compare(item.occurredAt(),item.id(),previousTime,previousId)<=0))
                throw new IllegalArgumentException("Invalid ledger entry order or identity");
            previousTime=item.occurredAt(); previousId=item.id();
        }
        if (page.nextTime()!=null && (page.items().size()!=limit || !page.nextTime().equals(previousTime)
                || !page.nextId().equals(previousId))) throw new IllegalArgumentException("Invalid ledger continuation");
        return page;
    }
    private static int compare(Instant leftTime,UUID leftId,Instant rightTime,UUID rightId) {
        int time=leftTime.compareTo(rightTime);
        // PostgreSQL compares UUID bytes unsigned; UUID.compareTo uses signed longs.
        return time!=0?time:leftId.toString().compareTo(rightId.toString());
    }

    static List<Entry> validateOrders(List<Entry> entries,UUID order) {
        if (entries==null || entries.size()>1000) throw new IllegalArgumentException("Invalid supplier order list");
        var ids=new HashSet<UUID>(); Entry previous=null;
        for (var entry:entries) {
            if (entry==null || entry.id()==null || !ids.add(entry.id()) || !order.equals(entry.orderId())
                    || entry.paymentId()!=null || entry.occurredAt()==null
                    || (previous!=null && compare(entry.occurredAt(),entry.id(),previous.occurredAt(),previous.id())<=0))
                throw new IllegalArgumentException("Invalid supplier order identity or sequence");
            previous=entry;
        }
        return List.copyOf(entries);
    }

    static PaymentSnapshot validate(PaymentSnapshot value,UUID expected) {
        if (value==null || value.payment()==null || value.cancellations()==null || value.cancellations().size()>1000
                || value.cancellationTimes()==null || value.cancellationTimes().size()!=value.cancellations().size()
                || value.cancellations().stream().anyMatch(java.util.Objects::isNull))
            throw new IllegalArgumentException("Invalid financial snapshot");
        var payment=value.payment();
        boolean approved="APPROVED".equals(payment.status());
        boolean validStatus=approved
            ? payment.transactionId()!=null && !payment.transactionId().isBlank() && payment.transactionId().length()<=120 && payment.declineCode()==null
            : "DECLINED".equals(payment.status()) && payment.transactionId()==null && "MOCK_CARD_DECLINED".equals(payment.declineCode());
        if (!expected.equals(payment.paymentId()) || payment.eventId()==null || payment.orderId()==null
                || payment.amount()<0 || !"KRW".equals(payment.currency()) || !validStatus || value.cancelledTotal()<0
                || value.cancelledTotal()>payment.amount() || (!approved && value.cancelledTotal()!=0))
            throw new IllegalArgumentException("Invalid financial payment");
        var ids=new HashSet<UUID>(); var keys=new HashSet<UUID>(); long total=0;
        for (var cancellation:value.cancellations().stream()
                .sorted(java.util.Comparator.comparingLong(MockPgService.Cancellation::cancelledTotal)).toList()) {
            if (!"SUCCEEDED".equals(cancellation.status()) || cancellation.id()==null || !ids.add(cancellation.id()) || cancellation.idempotencyKey()==null
                    || !keys.add(cancellation.idempotencyKey()) || !expected.equals(cancellation.paymentId()) || cancellation.amount()<=0
                    || value.cancellationTimes().get(cancellation.id())==null)
                throw new IllegalArgumentException("Invalid financial cancellation");
            total=Math.addExact(total,cancellation.amount());
            if (cancellation.cancelledTotal()!=total) throw new IllegalArgumentException("Inconsistent cancellation total");
        }
        if (total!=value.cancelledTotal()) throw new IllegalArgumentException("Incomplete financial snapshot");
        return value;
    }
}
