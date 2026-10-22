package service;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class OrderService {

    private final OrderRepository orders;
    private final PlanRepository plans;

    public OrderService(OrderRepository orders, PlanRepository plans) {
        this.orders = orders;
        this.plans = plans;
    }

    @Transactional
    public Creation create(UUID memberId, UUID key, String planId, LocalDate travelStartDate) {
        var existing = orders.findByKey(memberId, key);
        if (existing.isPresent()) return replay(existing.get(), planId, travelStartDate);
        if (orders.isPast(travelStartDate)) {
            throw new OrderException(400, "INVALID_TRAVEL_DATE", "여행 시작일은 한국 날짜 기준 오늘 이후여야 합니다.");
        }
        var created = orders.insert(memberId, key, planId, travelStartDate);
        if (created.isPresent()) return new Creation(created.get(), false);
        // 같은 키로 동시에 들어온 요청이 UNIQUE 제약에서 기다린 뒤 이 경로로 온다.
        existing = orders.findByKey(memberId, key);
        if (existing.isPresent()) return replay(existing.get(), planId, travelStartDate);
        if (plans.findById(planId).isEmpty()) {
            throw new OrderException(404, "PLAN_NOT_FOUND", "상품을 찾을 수 없습니다.");
        }
        throw new OrderException(400, "UNSUPPORTED_SIM_TYPE", "현재는 eSIM 주문만 지원합니다.");
    }

    private Creation replay(Order order, String planId, LocalDate travelStartDate) {
        if (!order.planId().equals(planId) || !order.travelStartDate().equals(travelStartDate)) {
            throw new OrderException(409, "IDEMPOTENCY_CONFLICT", "같은 요청 키에 다른 주문 조건을 사용할 수 없습니다.");
        }
        // 만료된 주문도 새 주문으로 바꾸지 않고 기존 ID와 EXPIRED 상태를 돌려준다.
        return new Creation(order, true);
    }

    public Order detail(UUID memberId, UUID orderId) {
        return orders.findById(memberId, orderId).orElseThrow(
                () -> new OrderException(404, "ORDER_NOT_FOUND", "주문을 찾을 수 없습니다."));
    }

    public Page list(UUID memberId, int page, int size) {
        var rows = orders.findAll(memberId, page, size);
        return new Page(rows.stream().limit(size).toList(), page, size, rows.size() > size);
    }

    public record Creation(Order order, boolean replayed) {}
    public record Page(List<Order> items, int page, int size, boolean hasNext) {}

    public static class OrderException extends RuntimeException {
        final int status;
        final String code;

        OrderException(int status, String code, String message) {
            super(message);
            this.status = status;
            this.code = code;
        }
    }
}
