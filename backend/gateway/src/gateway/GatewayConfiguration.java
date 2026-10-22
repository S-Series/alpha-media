package gateway;

import java.util.List;

import org.apache.hc.client5.http.config.ConnectionConfig;
import org.apache.hc.client5.http.impl.classic.CloseableHttpClient;
import org.apache.hc.client5.http.impl.classic.HttpClients;
import org.apache.hc.client5.http.impl.io.PoolingHttpClientConnectionManagerBuilder;
import org.apache.hc.core5.util.Timeout;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.util.Assert;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.http.client.HttpComponentsClientHttpRequestFactory;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;
import org.springframework.web.filter.CorsFilter;
import org.springframework.web.servlet.function.RouterFunction;
import org.springframework.web.servlet.function.ServerResponse;

import static org.springframework.cloud.gateway.server.mvc.filter.BeforeFilterFunctions.uri;
import static org.springframework.cloud.gateway.server.mvc.handler.GatewayRouterFunctions.route;
import static org.springframework.cloud.gateway.server.mvc.handler.HandlerFunctions.http;
import static org.springframework.web.servlet.function.RequestPredicates.path;

// Spring이 서버 시작 시 읽는 설정 클래스다. 여기서 중계 경로와 HTTP 연결 도구를 등록한다.
@Configuration(proxyBeanMethods = false)
// application.yml의 gateway 설정을 GatewayProperties 객체로 읽어 Spring에 등록한다.
@EnableConfigurationProperties(GatewayProperties.class)
public class GatewayConfiguration {

    // @Bean: 반환한 객체를 Spring이 관리한다. 메서드의 매개변수도 Spring이 찾아 넣어준다.
    // 이처럼 필요한 객체를 직접 new 하지 않고 전달받는 방식을 의존성 주입이라고 한다.
    @Bean
    RouterFunction<ServerResponse> serviceRoutes(GatewayProperties properties,
            @Value("${INTERNAL_GATEWAY_TOKEN:}") String internalToken, Environment environment) {
        if (environment.matchesProfiles("render") || !internalToken.isEmpty()) {
            Assert.isTrue(internalToken.length() >= 32, "INTERNAL_GATEWAY_TOKEN must contain at least 32 characters");
        }
        return route("service")
                // **는 하위 경로 전체다. 예: /api/orders/123. http()가 실제 HTTP 중계를 맡는다.
                .route(path("/api/**").or(path("/webhooks/**")), http())
                // Service 주소만 지정하며, /api 등의 요청 경로를 지우지 않고 전달한다.
                .before(uri(properties.serviceUrl().toString()))
                // 중계 요청과 응답에 추적 ID를 붙이고, 연결 오류를 처리할 필터다.
                .filter(new ProxyExchangeFilter(internalToken))
                .build();
    }

    // Gateway가 Service에 요청을 보내는 HTTP 클라이언트다. 서버 종료 시 close()로 연결을 정리한다.
    @Bean(destroyMethod = "close")
    CloseableHttpClient serviceHttpClient(GatewayProperties properties) {
        return HttpClients.custom()
                // 연결 풀은 기존 연결을 재사용한다. 요청마다 TCP 연결을 새로 만드는 비용을 줄인다.
                .setConnectionManager(PoolingHttpClientConnectionManagerBuilder.create()
                        .setDefaultConnectionConfig(ConnectionConfig.custom()
                                // Service에 연결할 때와 소켓에서 데이터를 기다릴 때의 제한 시간이다.
                                .setConnectTimeout(Timeout.ofMilliseconds(properties.connectTimeout().toMillis()))
                                .setSocketTimeout(Timeout.ofMilliseconds(properties.readTimeout().toMillis()))
                                .build())
                        .build())
                // 응답만 유실된 결제 요청을 다시 보내지 않는다. 사용자 중복 요청 처리는 Service의 책임이다.
                .disableAutomaticRetries()
                // Service의 리다이렉트를 대신 따라가지 않고 호출자에게 그대로 돌려준다.
                .disableRedirectHandling()
                // 여러 사용자가 같은 HTTP 클라이언트를 쓰므로 Gateway 내부에 쿠키를 저장하지 않는다.
                .disableCookieManagement()
                .build();
    }

    @Bean
    ClientHttpRequestFactory serviceRequestFactory(CloseableHttpClient serviceHttpClient,
            GatewayProperties properties) {
        // Apache HTTP 클라이언트를 Spring의 HTTP 요청 인터페이스에 연결한다.
        // Gateway의 RestClient가 이 Bean을 사용하므로 위의 재시도·연결 설정이 중계에 적용된다.
        var factory = new HttpComponentsClientHttpRequestFactory(serviceHttpClient);
        // 풀에서 사용할 연결이 나올 때까지 기다리는 시간과 Service 응답을 기다리는 시간을 제한한다.
        factory.setConnectionRequestTimeout(properties.connectTimeout());
        factory.setReadTimeout(properties.readTimeout());
        return factory;
    }

    @Bean
    CorsFilter corsFilter(GatewayProperties properties) {
        // CORS는 다른 출처의 프론트엔드가 브라우저에서 이 API를 호출할 수 있는지 정하는 규칙이다.
        // 사용자 인증이나 권한 검사를 대신하지 않으며, 서버 간 호출을 차단하는 장치도 아니다.
        var cors = new CorsConfiguration();
        cors.setAllowedOrigins(properties.allowedOrigins());
        cors.setAllowedMethods(List.of("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        // 브라우저가 요청에 담을 수 있는 헤더와 응답에서 JavaScript로 읽을 수 있는 헤더를 구분한다.
        cors.setAllowedHeaders(List.of("Content-Type", "Authorization", "Idempotency-Key", "X-Request-Id", "X-CSRF-TOKEN"));
        cors.setExposedHeaders(List.of("X-Request-Id"));
        // 명시적으로 허용한 출처에서 쿠키 등 자격 정보를 사용하는 요청을 허용한다.
        cors.setAllowCredentials(true);
        // 브라우저가 사전 확인 요청(OPTIONS)의 허용 결과를 600초 동안 재사용할 수 있다.
        cors.setMaxAge(600L);
        var source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/api/**", cors);
        source.registerCorsConfiguration("/webhooks/**", cors);
        return new CorsFilter(source);
    }
}
