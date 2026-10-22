package service;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class OrderExpiryWorker {

    private final OrderRepository orders;

    public OrderExpiryWorker(OrderRepository orders) {
        this.orders = orders;
    }

    @Scheduled(fixedDelay = 60000, initialDelay = 60000)
    public void expire() {
        orders.expireDueOrders();
    }
}
