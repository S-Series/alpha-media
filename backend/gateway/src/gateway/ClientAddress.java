package gateway;

import java.net.InetAddress;
import java.util.List;
import java.util.Arrays;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class ClientAddress {
    private final List<Network> trusted;
    public ClientAddress(@Value("${GATEWAY_TRUSTED_PROXY_CIDRS:}") String cidrs) {
        trusted=Arrays.stream(cidrs.split(",")).map(String::trim).filter(s->!s.isEmpty()).map(Network::parse).toList();
    }
    String resolve(HttpServletRequest request) {
        String peer=request.getRemoteAddr(), header=request.getHeader("X-Forwarded-For");
        if (!trusted(peer) || header==null || header.length()>2048) return peer;
        String[] hops=header.split(",",-1);
        if (hops.length>20) return peer;
        // Walk from the socket toward the client, stopping at the first untrusted hop.
        String current=peer;
        for (int i=hops.length-1;i>=0 && trusted(current);i--) {
            String hop=hops[i].trim();
            if (address(hop)==null) return peer;
            current=hop;
        }
        return current;
    }
    private boolean trusted(String ip) { return trusted.stream().anyMatch(network->network.contains(ip)); }
    private static byte[] address(String ip) {
        if (ip==null || !(ip.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}") || (ip.contains(":") && ip.matches("[0-9a-fA-F:.]+")))) return null;
        try { return InetAddress.getByName(ip).getAddress(); } catch (Exception invalid) { return null; }
    }
    private record Network(byte[] network,int bits) {
        static Network parse(String value) {
            String[] parts=value.split("/",-1); byte[] bytes=address(parts[0]);
            if (bytes==null || parts.length>2) throw new IllegalArgumentException("Invalid trusted proxy CIDR");
            int bits=parts.length==2?Integer.parseInt(parts[1]):bytes.length*8;
            if (bits<1 || bits>bytes.length*8) throw new IllegalArgumentException("Trusted proxy CIDR must be explicit");
            return new Network(bytes,bits);
        }
        boolean contains(String ip) {
            byte[] bytes=address(ip); if (bytes==null || bytes.length!=network.length) return false;
            for (int bit=0;bit<bits;bit++) if (((bytes[bit/8]^network[bit/8]) & (1 << (7-bit%8)))!=0) return false;
            return true;
        }
    }
}
