"use client";

import { useEffect, useRef, useState } from "react";
import { ApiRequestError, post } from "./auth";

export type ReconciliationRun = { id: string; mode: "PENDING" | "LEDGER";
  status: "QUEUED" | "SCANNING" | "PROCESSING" | "SUCCEEDED" | "REVIEW_REQUIRED";
  actor: string | null; reason: string; fromAt: string | null; toAt: string | null; phase: string;
  pageCount: number; itemCount: number; processedCount: number; issueCount: number; attemptCount: number;
  lastError: string | null; createdAt: string; completedAt: string | null };
export type ReconciliationItem = { id: string; kind: "PAYMENT" | "ISSUANCE" | "REFUND" | "PROTECTION"; targetId: string;
  orderId: string | null; status: string; outcome: string | null; attemptCount: number; lastError: string | null;
  externalStatus: string | null; externalReference: string | null; evidenceHash: string | null; checkedAt: string | null };
export type ReconciliationRuns = { items: ReconciliationRun[]; lastSuccessfulAt: string | null; checkedAt: string };
export type ReconciliationDetail = { run: ReconciliationRun; items: ReconciliationItem[]; page: number; size: number; hasNext: boolean };
export type IncidentStatus = "OPEN" | "INVESTIGATING" | "RESOLVED";
export type Incident = { id: string; orderId: string | null; kind: ReconciliationItem["kind"] | "WORKER" | "QUEUE" | "PROFILE" | "INBOUND"; targetId: string;
  code: string; status: IncidentStatus; version: number; actor: string | null; reason: string | null;
  externalReference: string | null; evidenceHash: string | null; firstSeenAt: string; lastSeenAt: string; resolvedAt: string | null };
export type IncidentPage = { items: Incident[]; page: number; size: number; hasNext: boolean; checkedAt: string };
export type IncidentDetail = { incident: Incident;
  events: { id: string; status: IncidentStatus; actor: string | null; reason: string | null; evidenceHash: string | null; recordedAt: string }[] };
export const reconciliationKinds = { PAYMENT: "결제", ISSUANCE: "발급", REFUND: "환불", PROTECTION: "SIM 차단·정리", WORKER: "워커", QUEUE: "작업 대기열", PROFILE: "SIM 추적", INBOUND: "웹훅" };
export const incidentStatuses: Record<IncidentStatus, string> = { OPEN: "미확인", INVESTIGATING: "조사 중", RESOLVED: "해결 확인" };
export const runStatuses: Record<ReconciliationRun["status"], string> = { QUEUED: "접수·대기", SCANNING: "대상 수집 중",
  PROCESSING: "결과 확인 중", SUCCEEDED: "대사 완료", REVIEW_REQUIRED: "실행 확인 필요" };
export const runModes = { PENDING: "누락·미해결 건 재조회", LEDGER: "기간별 외부 원장 대사" };
export const activeRun = (run: ReconciliationRun) => ["QUEUED", "SCANNING", "PROCESSING"].includes(run.status);

// Keep the last successful response for this URL, never a previous page's rows.
export function useReconciliationRead<T>(path: string | null, refresh: number, interval = 10000) {
  const [result, setResult] = useState<{ path: string; data: T } | null>(null);
  const [failure, setFailure] = useState<{ path: string; message: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(path!, { cache: "no-store", credentials: "same-origin",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        const value = await response.json().catch(() => null);
        if (!response.ok) throw new ApiRequestError(response.status, value?.message || "조회하지 못했습니다. 서버 연결과 권한을 확인해 주세요.");
        if (value === null) throw new Error("조회 응답을 읽지 못했습니다. 다시 확인합니다.");
        if (controller.signal.aborted) return;
        setResult({ path: path!, data: value }); setFailure(null);
        timer = setTimeout(poll, interval);
      } catch (error) {
        if (controller.signal.aborted) return;
        setFailure({ path: path!, message: error instanceof Error ? error.message : "조회하지 못했습니다." });
        if (!(error instanceof ApiRequestError && [401, 403, 404].includes(error.status))) timer = setTimeout(poll, interval);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [path, refresh, interval]);
  return { data: result?.path === path ? result.data : null, error: failure?.path === path ? failure.message : "" };
}

type Draft = { key: string; path: string; body: string; uncertain: boolean };
type Scope = "reconciliation-runs" | "incident-investigation" | `reconciliation-demo:${string}`;
function permittedPath(scope: Scope, path: string) {
  if (scope.startsWith("reconciliation-demo:")) return path === `/api/admin/orders/${scope.slice("reconciliation-demo:".length)}/reconciliation-demo`;
  return scope === "reconciliation-runs" ? path === "/api/admin/reconciliation-runs"
    : /^\/api\/admin\/incidents\/[0-9a-f-]{36}\/investigations$/i.test(path);
}

// A lost response must retain the original key and body, including the expected version.
export function useReconciliationAction<T>(scope: Scope) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const storage = `admin:${scope}`;
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const saved = JSON.parse(sessionStorage.getItem(storage) || "null");
        if (saved && typeof saved.key === "string" && typeof saved.body === "string" && typeof saved.path === "string"
          && permittedPath(scope, saved.path)) setDraft({ ...saved, uncertain: saved.uncertain !== false });
      } catch { /* Keep in-memory replay available if storage is disabled. */ }
      setReady(true);
    }, 0);
    return () => clearTimeout(timer);
  }, [scope, storage]);

  function save(request: Draft) {
    setDraft(request);
    try { sessionStorage.setItem(storage, JSON.stringify(request)); } catch { /* Preserve the in-memory key. */ }
  }

  async function send(request: Draft): Promise<T | null> {
    if (sending.current) return null;
    sending.current = true; setPending(true); setError(""); save({ ...request, uncertain: true });
    try {
      const response = await post(request.path, request.body, "application/json", { "Idempotency-Key": request.key });
      const receipt = await response.json() as T;
      save({ ...request, uncertain: false });
      return receipt;
    } catch (failure) {
      save({ ...request, uncertain: !(failure instanceof ApiRequestError) || failure.status >= 500 });
      setError(failure instanceof Error ? failure.message : "접수 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.");
      return null;
    } finally { sending.current = false; setPending(false); }
  }

  function submit(path: string, body: object) {
    if (!ready || pending || draft?.uncertain || !permittedPath(scope, path)) return Promise.resolve(null);
    return send({ key: crypto.randomUUID(), path, body: JSON.stringify(body), uncertain: true });
  }
  return { draft, pending, error, blocked: !ready || pending || !!draft?.uncertain, submit,
    replay: () => draft ? send(draft) : Promise.resolve(null) };
}
