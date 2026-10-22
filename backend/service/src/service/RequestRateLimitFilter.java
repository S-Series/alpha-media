package service;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Locale;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.ObjectMapper;

final class RequestRateLimitFilter extends OncePerRequestFilter {
    private final RequestRateLimits rates;
    private final ObjectMapper mapper;
    private final boolean authenticatedGateway;
    RequestRateLimitFilter(RequestRateLimits rates,ObjectMapper mapper,boolean authenticatedGateway) {
        this.rates=rates; this.mapper=mapper; this.authenticatedGateway=authenticatedGateway;
    }
    @Override protected boolean shouldNotFilter(HttpServletRequest request) {
        String path=request.getRequestURI();
        return !rates.enabled || request.getMethod().equals("OPTIONS") || !(path.startsWith("/api/") || path.startsWith("/webhooks/"));
    }
    @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain) throws IOException,ServletException {
        var subjects=new LinkedHashMap<String,String>();
        String ip=authenticatedGateway?request.getHeader("X-Gateway-Client-IP"):null;
        // GatewayAccessFilter has already authenticated the sender; never trust arbitrary X-Forwarded-For.
        if (ip==null || ip.length()>64) ip=request.getRemoteAddr();
        String path=request.getRequestURI(), method=request.getMethod();
        var auth=SecurityContextHolder.getContext().getAuthentication();
        if (path.startsWith("/webhooks/")) {
            String source=path.equals("/webhooks/pg")?"PG":"SUPPLIER";
            subjects.put("WEBHOOK_IP",ip); subjects.put("WEBHOOK_SOURCE",source);
        } else if (path.equals("/api/auth/login") && method.equals("POST")) {
            subjects.put("LOGIN_IP",ip);
            String account=request.getParameter("username");
            subjects.put("LOGIN_ACCOUNT",account==null?"":account.trim().toLowerCase(Locale.ROOT));
        } else {
            String category=method.equals("GET") || method.equals("HEAD")?"READ":"WRITE";
            subjects.put(category+"_IP",ip);
            if (auth!=null && auth.isAuthenticated()) subjects.put(category+"_MEMBER",auth.getName());
        }
        int retry;
        try { retry=rates.consume(subjects); }
        catch (org.springframework.dao.DataAccessException | org.springframework.transaction.TransactionException unavailable) {
            ApiError.write(response,mapper,503,"REQUEST_GUARD_UNAVAILABLE","요청 제한을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요."); return;
        }
        if (retry>0) {
            response.setHeader("Retry-After",Integer.toString(retry)); response.setHeader("Cache-Control","no-store");
            ApiError.write(response,mapper,429,"RATE_LIMITED","요청이 많습니다. Retry-After 이후 같은 요청 키로 다시 시도해 주세요."); return;
        }
        chain.doFilter(request,response);
    }
}
