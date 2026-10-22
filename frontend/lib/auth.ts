export type Member = {
  id: string;
  username: string;
  displayName: string;
  role: "USER" | "ADMIN";
  createdAt: string;
};

type CsrfToken = { headerName: string; token: string };

export async function getCsrfToken(): Promise<CsrfToken> {
  // 로그인·로그아웃으로 토큰이 교체될 수 있으므로 변경 요청 전에 새로 조회한다.
  const csrfResponse = await fetch("/api/auth/csrf", { cache: "no-store", credentials: "same-origin" });
  if (!csrfResponse.ok) throw new Error("로그인 서버에 연결하지 못했습니다.");
  return csrfResponse.json();
}

export async function post(path: string, body?: string, contentType?: string,
  extraHeaders: Record<string, string> = {}, token?: CsrfToken) {
  const csrf = token ?? await getCsrfToken();
  const headers: Record<string, string> = { ...extraHeaders, [csrf.headerName]: csrf.token };
  if (contentType) headers["Content-Type"] = contentType;
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers,
    body,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new ApiRequestError(response.status, error?.message || "요청을 처리하지 못했습니다. 다시 시도해 주세요.", error?.code);
  }
  return response;
}

export class ApiRequestError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export async function login(username: string, password: string) {
  // Spring Security의 기본 로그인 필터는 폼 인코딩을 받는다. 비밀번호는 URL에 넣지 않는다.
  const body = new URLSearchParams({ username, password }).toString();
  const response = await post("/api/auth/login", body, "application/x-www-form-urlencoded");
  return (await response.json()) as Member;
}

export async function logout() {
  await post("/api/auth/logout");
}
