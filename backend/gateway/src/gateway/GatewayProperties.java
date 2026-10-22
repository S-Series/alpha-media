package gateway;

import java.net.URI;
import java.time.Duration;
import java.util.List;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.util.Assert;

// application.yml의 gateway 아래 값을 읽는다. service-url은 serviceUrl에 자동으로 연결된다.
// 주소는 URI, 2s 같은 시간 값은 Duration, 허용 출처들은 List<String>으로 변환된다.
@ConfigurationProperties("gateway")
// record는 설정값을 보관하는 Java 문법이다. 생성자와 serviceUrl() 같은 조회 메서드를 자동 생성한다.
public record GatewayProperties(URI serviceUrl, List<String> allowedOrigins,
        Duration connectTimeout, Duration readTimeout) {

    public GatewayProperties {
        // record 생성 시 실행된다. 잘못된 설정이면 Assert가 예외를 던져 서버 시작을 중단한다.
        // Service 주소에는 프로토콜·호스트·포트만 허용한다. 요청 경로는 원래 요청에서 가져온다.
        Assert.isTrue(serviceUrl != null && List.of("http", "https").contains(serviceUrl.getScheme())
                && serviceUrl.getHost() != null && serviceUrl.getUserInfo() == null
                && serviceUrl.getQuery() == null && serviceUrl.getFragment() == null
                && (serviceUrl.getPath().isEmpty() || serviceUrl.getPath().equals("/")),
                "gateway.service-url must be an HTTP(S) origin without a path or credentials");
        // 쿠키를 허용하는 CORS 설정이므로 모든 출처(*) 대신 실제 프론트엔드 출처를 지정해야 한다.
        Assert.notEmpty(allowedOrigins, "gateway.allowed-origins must not be empty");
        Assert.isTrue(!allowedOrigins.contains("*"), "Explicit frontend origins are required");
        // 실수로 누락하거나 0 이하로 지정한 시간 제한을 시작 시점에 발견한다.
        Assert.isTrue(connectTimeout != null && connectTimeout.isPositive(),
                "gateway.connect-timeout must be positive");
        Assert.isTrue(readTimeout != null && readTimeout.isPositive(),
                "gateway.read-timeout must be positive");
    }
}
