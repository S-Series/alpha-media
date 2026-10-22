package gateway;

import java.net.SocketTimeoutException;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.servlet.function.HandlerFilterFunction;
import org.springframework.web.servlet.function.HandlerFunction;
import org.springframework.web.servlet.function.ServerRequest;
import org.springframework.web.servlet.function.ServerResponse;

// GatewayConfiguration에서 등록한 중계 경로의 요청 전·응답 후 처리를 담당한다.
// HandlerFilterFunction의 두 타입은 다음 처리 단계가 반환할 응답과 이 필터가 반환할 응답이다.
final class ProxyExchangeFilter implements HandlerFilterFunction<ServerResponse, ServerResponse> {

    private static final Logger log = LoggerFactory.getLogger(ProxyExchangeFilter.class);
    private static final String REQUEST_ID = "X-Request-Id";

    @Override
    public ServerResponse filter(ServerRequest request, HandlerFunction<ServerResponse> next) throws Exception {
        // 외부에서 보낸 ID를 그대로 신뢰하지 않고, Gateway 요청마다 새로운 추적 번호를 만든다.
        String requestId = UUID.randomUUID().toString();
        // 원래 요청을 바탕으로 헤더를 수정한 요청을 만든다. headers -> {...}는 람다식(함수 전달)이다.
        var forwarded = ServerRequest.from(request).headers(headers -> {
            headers.set(REQUEST_ID, requestId);
            // 클라이언트가 사용자·관리자 ID를 임의로 보낼 수 있으므로 제거한다. 실제 인증 기능은 아직 없다.
            headers.remove("X-User-Id");
            headers.remove("X-Admin-Id");
        }).build();

        try {
            // next.handle()에서 다음 처리 단계로 넘어가 Service를 호출하고 응답을 받는다.
            var response = next.handle(forwarded);
            // Service에 전달한 ID를 호출자에게도 보내 같은 요청의 오류와 로그를 찾을 수 있게 한다.
            response.headers().set(REQUEST_ID, requestId);
            return response;
        } catch (ResourceAccessException exception) {
            // Service의 정상적인 4xx·5xx 응답은 그대로 전달한다. 이 catch는 연결·읽기 실패를 처리한다.
            boolean timeout = hasTimeoutCause(exception);
            var status = timeout ? HttpStatus.GATEWAY_TIMEOUT : HttpStatus.BAD_GATEWAY;
            String code = timeout ? "SERVICE_TIMEOUT" : "SERVICE_UNAVAILABLE";
            // 요청 본문·인증 토큰을 기록하지 않고 추적 ID와 실패 종류만 남긴다.
            log.warn("Service request failed requestId={} method={} status={} code={}",
                    requestId, request.method(), status.value(), code);
            // 읽기 시간 초과는 504, 그 밖의 연결 실패는 502로 응답한다.
            // 응답을 못 받았어도 결제 처리는 완료됐을 수 있으므로 여기서 재시도하거나 실패로 확정하지 않는다.
            return ServerResponse.status(status)
                    .contentType(MediaType.APPLICATION_JSON)
                    .header(REQUEST_ID, requestId)
                    .body(new GatewayError(code, timeout
                            ? "Service response timed out. The operation may still have completed."
                            : "Service could not be reached. The operation outcome may be unknown.", requestId));
        }
    }

    private boolean hasTimeoutCause(Throwable exception) {
        // Spring 예외 안에 원래 네트워크 예외가 감싸져 있으므로 원인(cause)을 따라가며 확인한다.
        for (Throwable cause = exception; cause != null; cause = cause.getCause()) {
            if (cause instanceof SocketTimeoutException) {
                return true;
            }
        }
        return false;
    }

    // body()에 전달하면 Spring의 JSON 변환기가 세 필드를 JSON 응답 본문으로 변환한다.
    private record GatewayError(String code, String message, String requestId) {
    }
}
