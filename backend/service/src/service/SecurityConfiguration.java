package service;

import java.util.Map;

import jakarta.servlet.DispatcherType;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.security.crypto.password.DelegatingPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.crypto.password.Pbkdf2PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.SecurityContextHolderFilter;
import org.springframework.util.Assert;
import tools.jackson.databind.ObjectMapper;

@Configuration(proxyBeanMethods = false)
public class SecurityConfiguration {

    @Bean
    PasswordEncoder passwordEncoder() {
        // 알고리즘 식별자와 무작위 salt를 해시와 함께 저장해 향후 교체할 수 있게 한다.
        var encoder = new Pbkdf2PasswordEncoder("", 16, 600000,
                Pbkdf2PasswordEncoder.SecretKeyFactoryAlgorithm.PBKDF2WithHmacSHA256);
        return new DelegatingPasswordEncoder("pbkdf2-sha256-600k", Map.of("pbkdf2-sha256-600k", encoder));
    }

    @Bean
    UserDetailsService userDetailsService(MemberRepository members) {
        return username -> {
            var member = members.findByUsername(username)
                    .orElseThrow(() -> new UsernameNotFoundException("Invalid credentials"));
            return User.withUsername(member.username()).password(member.passwordHash()).roles(member.role()).build();
        };
    }

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http, MemberRepository members,
            ObjectMapper mapper, @Value("${INTERNAL_GATEWAY_TOKEN:}") String internalToken,
            Environment environment, RequestRateLimits rates) throws Exception {
        if (environment.matchesProfiles("render") || !internalToken.isEmpty()) {
            Assert.isTrue(internalToken.length() >= 32, "INTERNAL_GATEWAY_TOKEN must contain at least 32 characters");
            http.addFilterBefore(new GatewayAccessFilter(internalToken, mapper), SecurityContextHolderFilter.class);
        }
        http.addFilterBefore(new RequestRateLimitFilter(rates,mapper,!internalToken.isEmpty()),org.springframework.security.web.authentication.logout.LogoutFilter.class);
        http
                .httpBasic(basic -> basic.disable())
                .requestCache(cache -> cache.disable())
                // 외부 통지는 세션 대신 본문 HMAC, 내부 모의 PG는 별도 API 키로 인증한다.
                .csrf(csrf -> csrf.ignoringRequestMatchers("/webhooks/pg", "/webhooks/supplier", "/webhooks/supplier/profiles", "/internal/mock-pg/**", "/internal/mock-supplier/**"))
                .authorizeHttpRequests(auth -> auth
                        .dispatcherTypeMatchers(DispatcherType.ERROR).permitAll()
                        .requestMatchers(HttpMethod.GET, "/health").permitAll()
                        .requestMatchers(HttpMethod.GET, "/api/plans", "/api/plans/**", "/api/auth/csrf").permitAll()
                        .requestMatchers(HttpMethod.POST, "/api/auth/login").permitAll()
                        .requestMatchers(HttpMethod.POST, "/webhooks/pg").permitAll()
                        .requestMatchers(HttpMethod.POST, "/webhooks/supplier").permitAll()
                        .requestMatchers(HttpMethod.POST, "/webhooks/supplier/profiles").permitAll()
                        .requestMatchers("/internal/mock-pg/**").permitAll()
                        .requestMatchers("/internal/mock-supplier/**").permitAll()
                        .requestMatchers("/api/admin/**").hasRole("ADMIN")
                        .requestMatchers(HttpMethod.POST, "/api/orders", "/api/orders/*/payment-attempts").hasRole("USER")
                        .requestMatchers("/api/me", "/api/auth/logout", "/api/orders/**", "/api/sims", "/api/sims/**").authenticated()
                        .anyRequest().denyAll())
                .exceptionHandling(errors -> errors
                        .authenticationEntryPoint((request, response, exception) -> ApiError.write(
                                response, mapper, 401, "UNAUTHENTICATED", "로그인이 필요합니다."))
                        .accessDeniedHandler((request, response, exception) -> ApiError.write(
                                response, mapper, 403, "FORBIDDEN", "권한 또는 CSRF 토큰을 확인해 주세요.")))
                // 기본 CSRF 검사를 유지한다. 표준 로그인 필터가 세션 ID와 CSRF 토큰 교체를 처리한다.
                .formLogin(form -> form
                        .loginPage("/login")
                        .loginProcessingUrl("/api/auth/login")
                        .usernameParameter("username")
                        .successHandler((request, response, authentication) -> {
                            response.setContentType("application/json");
                            response.setCharacterEncoding("UTF-8");
                            var member = members.findByUsername(authentication.getName()).orElseThrow();
                            mapper.writeValue(response.getOutputStream(), member.view());
                        })
                        .failureHandler((request, response, exception) -> ApiError.write(response, mapper,
                                401, "INVALID_CREDENTIALS", "아이디 또는 비밀번호가 올바르지 않습니다.")))
                .logout(logout -> logout
                        .logoutUrl("/api/auth/logout")
                        .deleteCookies("ALPHA_SESSION")
                        .logoutSuccessHandler((request, response, authentication) -> response.setStatus(204)));
        return http.build();
    }
}
