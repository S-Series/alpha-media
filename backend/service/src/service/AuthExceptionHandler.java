package service;

import org.springframework.http.HttpStatus;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice(assignableTypes = AuthController.class)
public class AuthExceptionHandler {

    @ExceptionHandler({ MethodArgumentNotValidException.class, HttpMessageNotReadableException.class })
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public ApiError invalidInput() {
        // 검증 오류의 거절된 값에는 비밀번호가 포함될 수 있어 그대로 응답하거나 기록하지 않는다.
        return new ApiError("INVALID_REQUEST", "이메일·이름·비밀번호 입력 조건을 확인해 주세요.");
    }
}
