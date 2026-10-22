package service;

import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
public class AuthController {

    private final MemberRepository members;

    public AuthController(MemberRepository members) {
        this.members = members;
    }

    @GetMapping("/api/auth/csrf")
    public CsrfView csrf(CsrfToken token) {
        return new CsrfView(token.getHeaderName(), token.getToken());
    }

    @GetMapping("/api/me")
    public Member.View me(Authentication authentication) {
        return members.findByUsername(authentication.getName()).orElseThrow(
                () -> new ResponseStatusException(HttpStatus.UNAUTHORIZED)).view();
    }

    // 로그인과 로그아웃 요청은 SecurityConfiguration의 Spring Security 필터가 처리한다.
    public record CsrfView(String headerName, String token) {
    }
}
