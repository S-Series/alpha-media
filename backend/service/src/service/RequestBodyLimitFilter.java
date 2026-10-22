package service;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.net.URLDecoder;
import java.util.*;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

// Bound memory before form parsing, JSON conversion, signatures, or proxy forwarding.
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 20)
public class RequestBodyLimitFilter extends OncePerRequestFilter {
    private static final int LIMIT=16*1024;
    @Override protected boolean shouldNotFilter(HttpServletRequest request) {
        String path=request.getRequestURI();
        return !(path.startsWith("/api/") || path.startsWith("/webhooks/") || path.startsWith("/internal/"));
    }
    @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain)
            throws IOException,ServletException {
        if (request.getContentLengthLong()>LIMIT) { reject(response,413,"BODY_TOO_LARGE"); return; }
        String encoding=request.getHeader("Content-Encoding");
        if (encoding!=null && !encoding.equalsIgnoreCase("identity")) { reject(response,415,"UNSUPPORTED_CONTENT_ENCODING"); return; }
        byte[] body=request.getInputStream().readNBytes(LIMIT+1);
        if (body.length>LIMIT) { reject(response,413,"BODY_TOO_LARGE"); return; }
        CachedRequest cached;
        try { cached=new CachedRequest(request,body); }
        catch (IllegalArgumentException malformed) { reject(response,400,"INVALID_FORM_ENCODING"); return; }
        chain.doFilter(cached,response);
    }
    private void reject(HttpServletResponse response,int status,String code) throws IOException {
        response.setStatus(status); response.setContentType("application/json"); response.setHeader("Cache-Control","no-store");
        response.getWriter().write("{\"code\":\""+code+"\",\"message\":\"Request body rejected\"}");
    }
    private static final class CachedRequest extends HttpServletRequestWrapper {
        private final byte[] body;
        private final Map<String,String[]> parameters=new LinkedHashMap<>();
        CachedRequest(HttpServletRequest request,byte[] body) {
            super(request); this.body=body;
            parse(request.getQueryString());
            if (request.getContentType()!=null && request.getContentType().toLowerCase(Locale.ROOT).startsWith("application/x-www-form-urlencoded"))
                parse(new String(body,StandardCharsets.UTF_8));
        }
        private void parse(String text) {
            if (text==null || text.isEmpty()) return;
            for (String pair:text.split("&")) {
                String[] parts=pair.split("=",2);
                String key=URLDecoder.decode(parts[0],StandardCharsets.UTF_8);
                String value=URLDecoder.decode(parts.length==2?parts[1]:"",StandardCharsets.UTF_8);
                String[] old=parameters.getOrDefault(key,new String[0]), next=Arrays.copyOf(old,old.length+1);
                next[old.length]=value; parameters.put(key,next);
            }
        }
        @Override public String getParameter(String name) { var values=parameters.get(name); return values==null?null:values[0]; }
        @Override public Map<String,String[]> getParameterMap() { return Collections.unmodifiableMap(parameters); }
        @Override public Enumeration<String> getParameterNames() { return Collections.enumeration(parameters.keySet()); }
        @Override public String[] getParameterValues(String name) { return parameters.get(name); }
        @Override public int getContentLength() { return body.length; }
        @Override public long getContentLengthLong() { return body.length; }
        @Override public BufferedReader getReader() { return new BufferedReader(new InputStreamReader(getInputStream(),StandardCharsets.UTF_8)); }
        @Override public ServletInputStream getInputStream() {
            var input=new ByteArrayInputStream(body);
            return new ServletInputStream() {
                @Override public int read() { return input.read(); }
                @Override public int read(byte[] b,int off,int len) { return input.read(b,off,len); }
                @Override public boolean isFinished() { return input.available()==0; }
                @Override public boolean isReady() { return true; }
                @Override public void setReadListener(ReadListener listener) { throw new UnsupportedOperationException("Synchronous request only"); }
            };
        }
    }
}
