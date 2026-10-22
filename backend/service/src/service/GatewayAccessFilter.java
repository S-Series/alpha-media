package service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.ObjectMapper;

// Render 무료 Service도 공개 주소를 받으므로 Gateway가 넣은 공유 키를 별도로 검사한다.
final class GatewayAccessFilter extends OncePerRequestFilter {

    private final byte[] expectedToken;
    private final ObjectMapper mapper;

    GatewayAccessFilter(String token, ObjectMapper mapper) {
        this.expectedToken = token.getBytes(StandardCharsets.UTF_8);
        this.mapper = mapper;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return request.getMethod().equals("GET") && request.getRequestURI().equals("/health");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String supplied = request.getHeader("X-Gateway-Token");
        if (supplied == null || !MessageDigest.isEqual(expectedToken, supplied.getBytes(StandardCharsets.UTF_8))) {
            ApiError.write(response, mapper, 403, "GATEWAY_REQUIRED", "Gateway를 통해 요청해 주세요.");
            return;
        }
        chain.doFilter(request, response);
    }
}
