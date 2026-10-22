package service;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.hibernate.validator.constraints.CodePointLength;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
public class AuthController {

    private final MemberRepository members;
    private final PasswordEncoder passwords;

    public AuthController(MemberRepository members, PasswordEncoder passwords) {
        this.members = members;
        this.passwords = passwords;
    }

    @GetMapping("/api/auth/csrf")
    public CsrfView csrf(CsrfToken token) {
        return new CsrfView(token.getHeaderName(), token.getToken());
    }

    @PostMapping("/api/auth/signup")
    public ResponseEntity<?> signup(@Valid @RequestBody SignupRequest request) {
        try {
            var member = members.create(request.email(), request.displayName(), passwords.encode(request.password()));
            return ResponseEntity.status(HttpStatus.CREATED).body(member.view());
        } catch (DuplicateKeyException exception) {
            // 동시 가입도 DB의 이메일 유니크 제약으로 한 건만 저장한다.
            return ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(new ApiError("EMAIL_ALREADY_EXISTS", "이미 사용 중인 이메일입니다."));
        }
    }

    @GetMapping("/api/me")
    public Member.View me(Authentication authentication) {
        return members.findByEmail(authentication.getName()).orElseThrow(
                () -> new ResponseStatusException(HttpStatus.UNAUTHORIZED)).view();
    }

    // 로그인과 로그아웃 요청은 SecurityConfiguration의 Spring Security 필터가 처리한다.
    public record SignupRequest(
            @NotBlank @Email @Size(max = 254) String email,
            @NotBlank @CodePointLength(min = 2, max = 60) String displayName,
            @NotBlank @Size(min = 12, max = 128) String password) {

        public SignupRequest {
            email = email == null ? null : MemberRepository.normalizeEmail(email);
            displayName = displayName == null ? null : displayName.trim();
        }
    }

    public record CsrfView(String headerName, String token) {
    }
}
