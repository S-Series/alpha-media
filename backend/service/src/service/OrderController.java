package service;

import java.net.URI;
import java.time.LocalDate;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import service.OrderService.OrderException;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderService orders;
    private final MemberRepository members;

    public OrderController(OrderService orders, MemberRepository members) {
        this.orders = orders;
        this.members = members;
    }

    @PostMapping
    public ResponseEntity<Order> create(Authentication authentication,
            @RequestHeader("Idempotency-Key") UUID key, @Valid @RequestBody CreateOrder request) {
        var result = orders.create(memberId(authentication), key, request.planId(), request.travelStartDate());
        return ResponseEntity.status(result.replayed() ? 200 : 201)
                .location(URI.create("/api/orders/" + result.order().id()))
                .header("Idempotency-Replayed", Boolean.toString(result.replayed()))
                .header("Cache-Control", "no-store").body(result.order());
    }

    @GetMapping
    public ResponseEntity<OrderService.Page> list(Authentication authentication,
            @RequestParam(defaultValue = "0") int page, @RequestParam(defaultValue = "20") int size) {
        if (page < 0 || size < 1 || size > 100) {
            throw new OrderException(400, "INVALID_PAGE", "페이지는 0 이상, 조회 건수는 1~100이어야 합니다.");
        }
        return ResponseEntity.ok().header("Cache-Control", "no-store")
                .body(orders.list(memberId(authentication), page, size));
    }

    @GetMapping("/{orderId}")
    public ResponseEntity<Order> detail(Authentication authentication, @PathVariable UUID orderId) {
        return ResponseEntity.ok().header("Cache-Control", "no-store")
                .body(orders.detail(memberId(authentication), orderId));
    }

    private UUID memberId(Authentication authentication) {
        // 요청 본문이나 X-User-Id가 아닌, 로그인 세션의 회원으로만 주문을 연결한다.
        return members.findByEmail(authentication.getName()).orElseThrow(
                () -> new OrderException(401, "UNAUTHENTICATED", "로그인이 필요합니다.")).id();
    }

    public record CreateOrder(@NotBlank @Size(max = 64) String planId, @NotNull LocalDate travelStartDate) {}
}
