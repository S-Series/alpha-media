"use client";

import { useEffect, useState } from "react";
import { ApiRequestError, getCsrfToken, post } from "@/lib/auth";
import { kst } from "@/lib/format";
import { SimProfile, simStatus } from "@/lib/issuance";

type ProfileEvent = { id: string; source: string; fromStatus: SimProfile["installStatus"]; toStatus: SimProfile["installStatus"];
  occurredAt: string; receivedAt: string };
type View = { profile: SimProfile; events: ProfileEvent[] };
type Change = { state: string; activatedAt: string | null; callbackDelayMs: number; callbackCopies: number };
type Draft = { key: string; body: Change };
type Signal = { state: string; revision: number; eventId: string };

export default function SimTrackingPanel({ initial }: { initial: SimProfile }) {
  const [view, setView] = useState<View>({ profile: initial, events: [] });
  const [state, setState] = useState("INSTALLED");
  const [utc, setUtc] = useState("");
  const [delay, setDelay] = useState(2);
  const [copies, setCopies] = useState(1);
  const [duplicate, setDuplicate] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [opened, setOpened] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);
  const base = `/api/sims/${initial.id}`;
  const storageKey = `sim-simulation:${initial.id}`;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const saved = sessionStorage.getItem(storageKey);
        if (saved) { setDraft(JSON.parse(saved)); setUncertain(true); }
      } catch { sessionStorage.removeItem(storageKey); }
    }
    void read();
    async function poll() {
      try {
        const response = await fetch(`${base}/tracking`, { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error("상태 조회 실패. 마지막 확인 상태를 유지합니다.");
        const result: View = await response.json();
        if (!stopped) { setView(result); setPollError(""); }
      } catch (e) { if (!stopped) setPollError(e instanceof Error ? e.message : "상태를 조회하지 못했습니다."); }
      finally { if (!stopped) timer = setTimeout(poll, 1500); }
    }
    void poll();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { stopped = true; clearTimeout(timer); clearInterval(clock); };
  }, [base, storageKey, refresh]);

  async function send(request: Draft, count: number) {
    setPending(true); setMessage(""); setError("");
    try {
      const csrf = await getCsrfToken();
      const responses = await Promise.all(Array.from({ length: count }, () => post(`${base}/simulation`,
        JSON.stringify(request.body), "application/json", { "Idempotency-Key": request.key }, csrf)));
      const signals: Signal[] = await Promise.all(responses.map(response => response.json()));
      if (new Set(signals.map(signal => signal.eventId)).size !== 1) throw new Error("중복 요청의 결과가 일치하지 않습니다.");
      setMessage(`공급사 상태 ${signals[0].state} · 버전 ${signals[0].revision} · 동일 이벤트 ${count}회 응답. 콜백 또는 서버 조회로 반영됩니다.`);
      setUncertain(false); sessionStorage.removeItem(storageKey);
    } catch (e) {
      const unknown = !(e instanceof ApiRequestError && e.status >= 400 && e.status < 500);
      setUncertain(unknown);
      if (!unknown) { sessionStorage.removeItem(storageKey); setDraft(null); }
      setError(e instanceof Error ? e.message : "접수 결과를 확인하지 못했습니다. 동일 요청으로 재전송해 주세요.");
    }
    finally { setPending(false); }
  }
  async function simulate() {
    const activatedAt = state === "ENABLED" ? view.profile.activatedAt || (utc ? new Date(`${utc}Z`).toISOString() : null) : null;
    const request = { key: crypto.randomUUID(), body: { state, activatedAt, callbackDelayMs: delay * 1000, callbackCopies: copies } };
    setDraft(request); sessionStorage.setItem(storageKey, JSON.stringify(request));
    await send(request, duplicate ? 2 : 1);
  }
  async function open() {
    setPending(true);
    try {
      const response = await post(`${base}/activation-view`);
      setView(await response.json()); setOpened(true);
    } catch (e) { setError(e instanceof Error ? e.message : "열람 기록을 저장하지 못했습니다."); }
    finally { setPending(false); }
  }
  const profile = view.profile;
  const expired = profile.expiresAt && now !== null && now >= Date.parse(profile.expiresAt);
  const displayStatus = profile.installStatus === "ACTIVE" && expired ? "EXPIRED" : profile.installStatus;
  const remaining = profile.expiresAt && now !== null ? Math.max(0, Math.ceil((Date.parse(profile.expiresAt) - now) / 1000)) : null;
  const allowed = (value: string) => !profile.supplierState || profile.supplierState === "RELEASED" || value === profile.supplierState
    || value === "DELETED" || (profile.supplierState === "INSTALLED" && value === "ENABLED");
  return <>
    <section className="home-panel"><h2>설치·사용 상태</h2>
      <p>현재 상태: {simStatus(displayStatus)} ({displayStatus}) · 공급사 버전 {profile.supplierRevision}</p>
      <p>QR·활성화 정보 열람은 사용자 신호이며, 설치·개통은 공급사 콜백 또는 조회로 확인합니다.</p>
      <dl className="detail-list">
        <dt>활성화 정보 열람</dt><dd>{profile.qrViewedAt ? kst(profile.qrViewedAt) : "미열람"}</dd>
        <dt>설치 시각</dt><dd>{profile.installedAt ? kst(profile.installedAt) : "미확인"}</dd>
        <dt>개통 UTC</dt><dd>{profile.activatedAt || "미개통"}</dd>
        <dt>개통 KST</dt><dd>{profile.activatedAt ? kst(profile.activatedAt) : "미개통"}</dd>
        <dt>만료 UTC</dt><dd>{profile.expiresAt || "개통 후 결정"}</dd>
        <dt>만료 KST</dt><dd>{profile.expiresAt ? kst(profile.expiresAt) : "개통 후 결정"}</dd>
        <dt>남은 사용 시간</dt><dd>{remaining === null ? "개통 후 계산" : `${Math.floor(remaining / 86400)}일 ${Math.floor(remaining % 86400 / 3600)}시간 ${Math.floor(remaining % 3600 / 60)}분 ${remaining % 60}초`}</dd>
        <dt>공급사 마지막 확인</dt><dd>{profile.lastSyncedAt ? kst(profile.lastSyncedAt) : "확인 대기"}</dd>
      </dl>
      <p>만료는 개통 시각 + 요금제 일수 × 24시간입니다. 여행 시작일과 독립적으로 계산합니다.</p>
      {profile.syncError && <p role="alert">공급사 확인 지연: {profile.syncError}. 이전 상태를 유지하며 서버가 재조회합니다.</p>}
      {pollError && <p role="alert">{pollError}</p>}
      <button disabled={pending} onClick={open}>활성화 정보 열람</button>
      {opened && <p>활성화 코드: <code>{profile.activationCode}</code></p>}
      <button disabled={pending} onClick={() => setRefresh(value => value + 1)}>상태 다시 확인</button>
    </section>
    <section className="home-panel"><h2>모의 공급사 설치·개통 시연</h2>
      <p>현재 공급사 상태: {profile.supplierState || "조회 대기"}. 설치·개통을 되돌리거나 최초 개통 시각을 변경할 수 없습니다.</p>
      <fieldset disabled={pending || uncertain}>
        <label>공급사 상태 <select value={state} onChange={e => { setState(e.target.value); if (e.target.value === "ENABLED" && !utc) setUtc(new Date().toISOString().slice(0, 19)); }}>
          <option value="RELEASED" disabled={!allowed("RELEASED")}>미설치 (RELEASED)</option>
          <option value="INSTALLED" disabled={!allowed("INSTALLED")}>설치 완료 (INSTALLED)</option>
          <option value="ENABLED" disabled={!allowed("ENABLED")}>개통·사용 (ENABLED)</option>
          <option value="DELETED" disabled={!allowed("DELETED")}>프로필 삭제 (DELETED)</option>
        </select></label>
        {state === "ENABLED" && <label>최초 개통 시각 (UTC) <input type="datetime-local" step="1"
          value={profile.activatedAt?.slice(0, 19) || utc} disabled={Boolean(profile.activatedAt)} onChange={e => setUtc(e.target.value)} /></label>}
        <p>만료 시연은 새 SIM을 바로 ENABLED로 바꾸면서 요금제 일수보다 오래된 UTC 개통 시각을 입력하세요.</p>
        <label>상태 콜백 지연: {delay}초 <input type="range" min="0" max="60" value={delay} onChange={e => setDelay(Number(e.target.value))} /></label>
        <label>상태 콜백 전송 횟수: {copies}회 <input type="range" min="0" max="20" value={copies} onChange={e => setCopies(Number(e.target.value))} /></label>
        <p>0회는 콜백 누락입니다. 시연 변경 후 약 5초 내 조회를 예약합니다. 평상시에는 미설치·설치 5초, 사용 중 60초, 만료 후 1시간 주기로 확인합니다.</p>
        <label><input type="checkbox" checked={duplicate} onChange={e => setDuplicate(e.target.checked)} />같은 상태 변경 요청을 동시에 2회 전송</label>
        <button disabled={!allowed(state) || (state === "ENABLED" && !profile.activatedAt && !utc)} onClick={simulate}>공급사 상태 변경</button>
      </fieldset>
      <button disabled={pending || !draft} onClick={() => draft && void send(draft, 1)}>동일 요청 다시 전송</button>
      {draft && <p>요청 키: {draft.key}</p>}
      {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    </section>
    <section className="home-panel"><h2>설치·개통 상태 이력</h2>
      <p>콜백과 조회가 같은 이벤트를 확인하면 한 번만 기록합니다. 늦은 이전 버전은 상태를 유지한 이력으로 남깁니다.</p>
      {view.events.map(event => <p key={event.id}>{kst(event.occurredAt)} · {event.source} · {event.fromStatus} → {event.toStatus}</p>)}
    </section>
  </>;
}
