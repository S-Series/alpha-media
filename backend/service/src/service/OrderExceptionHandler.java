package service;

import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

import service.OrderService.OrderException;

@RestControllerAdvice(assignableTypes = OrderController.class)
public class OrderExceptionHandler {

    @ExceptionHandler(OrderException.class)
    ResponseEntity<ApiError> business(OrderException exception) {
        return ResponseEntity.status(exception.status).body(new ApiError(exception.code, exception.getMessage()));
    }

    @ExceptionHandler({MethodArgumentNotValidException.class, HttpMessageNotReadableException.class,
            MissingRequestHeaderException.class, MethodArgumentTypeMismatchException.class})
    ResponseEntity<ApiError> invalid() {
        return ResponseEntity.badRequest().body(new ApiError("INVALID_REQUEST",
                "상품·여행 시작일·UUID 형식의 요청 키를 확인해 주세요."));
    }
}
