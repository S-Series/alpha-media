import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    proxyTimeout: Number(process.env.GATEWAY_REQUEST_TIMEOUT_MS || 30000),
  },
  // 브라우저의 같은 출처 요청을 Gateway로 전달해 세션 쿠키를 함께 사용할 수 있게 한다.
  rewrites() {
    const gateway = (process.env.GATEWAY_BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
    return [{ source: "/api/:path*", destination: `${gateway}/api/:path*` }];
  },
  turbopack: {
    root: __dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
