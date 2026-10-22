import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const secret = randomBytes(32).toString("hex");
const children = [];
let directory, dbPort, servicePort, gatewayPort, serviceProcess, base, alice, bob, first, firstKey;
const future = "2099-01-01";

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw new Error(`${executable} failed; check PostgreSQL/Java installation`);
  return (result.stdout || "").trim();
}

function sql(statement, app = false, expectFailure = false) {
  const result = spawnSync("psql", ["-X", "-At", "-v", "ON_ERROR_STOP=1"], {
    input: statement, encoding: "utf8", windowsHide: true,
    env: { ...process.env, PGHOST: "127.0.0.1", PGPORT: String(dbPort), PGDATABASE: "orders_test",
      PGUSER: app ? "alpha_media_app" : "postgres", PGPASSWORD: secret, PGSSLMODE: "disable" },
  });
  if (expectFailure) { assert.notEqual(result.status, 0); return; }
  assert.equal(result.status, 0, "SQL failed in isolated test database");
  return result.stdout.trim();
}

async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}

async function until(check, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await check()) return; } catch { /* 서버 시작·작업 완료를 기다린다. */ }
    await delay(250);
  }
  throw new Error("Timed out waiting for isolated test server or expiry worker");
}

async function startJava(name, env) {
  const jar = join(root, "backend", name, "target", `${name}-0.0.1-SNAPSHOT.jar`);
  const built = await stat(jar).catch(() => null);
  assert.ok(built, `Build backend/${name} with Maven package first`);
  const log = createWriteStream(join(directory, `${name}.log`), { flags: "a" });
  const processChild = spawn("java", ["-jar", jar], {
    cwd: join(root, "backend", name), windowsHide: true,
    env: { ...process.env, SPRING_PROFILES_ACTIVE: "render", INTERNAL_GATEWAY_TOKEN: secret, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  processChild.stdout.pipe(log); processChild.stderr.pipe(log);
  children.push(processChild);
  const url = `http://127.0.0.1:${env.PORT}/health`;
  await until(async () => (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok);
  return processChild;
}

function startService() {
  const url = `jdbc:postgresql://127.0.0.1:${dbPort}/orders_test`;
  return startJava("service", { PORT: String(servicePort), DB_URL: url, DB_USERNAME: "alpha_media_app",
    DB_PASSWORD: secret, DB_MIGRATION_URL: url, DB_MIGRATION_USERNAME: "test_owner",
    DB_MIGRATION_PASSWORD: secret, DB_CONNECTION_TIMEOUT: "10000", SESSION_COOKIE_SECURE: "false" });
}

class Client {
  cookies = new Map();
  async request(path, options = {}) {
    const { body, headers, ...rest } = options;
    const response = await fetch(base + path, {
      ...rest, headers: { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body && typeof body !== "string" ? JSON.stringify(body) : body,
      signal: AbortSignal.timeout(20000),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0]; const index = pair.indexOf("=");
      this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  }
  async csrf() {
    const response = await this.request("/api/auth/csrf");
    assert.equal(response.status, 200); const token = await response.json();
    return { [token.headerName]: token.token };
  }
  async create(key = randomUUID(), body = { planId: "jp-esim-7d", travelStartDate: future }) {
    return this.request("/api/orders", { method: "POST", headers: { ...await this.csrf(), "Idempotency-Key": key }, body });
  }
}

async function member(name) {
  const client = new Client();
  const email = `${name}@orders.example.test`, password = "LocalOrderTest!2026Aa";
  let r = await client.request("/api/auth/signup", { method: "POST", headers: await client.csrf(),
    body: { email, displayName: name, password } });
  assert.equal(r.status, 201); client.memberId = (await r.json()).id;
  r = await client.request("/api/auth/login", { method: "POST",
    headers: { ...await client.csrf(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password }).toString() });
  assert.equal(r.status, 200); return client;
}

before(async () => {
  await mkdir(join(root, ".local"), { recursive: true });
  directory = await mkdtemp(join(root, ".local", "order-tests-"));
  [dbPort, servicePort, gatewayPort] = await Promise.all([port(), port(), port()]);
  const passwordFile = join(directory, "password");
  await writeFile(passwordFile, secret, { mode: 0o600 });
  command("initdb", ["-D", join(directory, "postgres"), "-U", "postgres", "--encoding=UTF8", "--locale=C",
    "--auth=scram-sha-256", `--pwfile=${passwordFile}`]);
  command("pg_ctl", ["start", "-w", "-D", join(directory, "postgres"), "-l", join(directory, "postgres.log"),
    "-o", `-h 127.0.0.1 -p ${dbPort}`], { stdio: "ignore" });
  command("psql", ["-X", "-v", "ON_ERROR_STOP=1"], {
    env: { ...process.env, PGHOST: "127.0.0.1", PGPORT: String(dbPort), PGDATABASE: "postgres", PGUSER: "postgres", PGPASSWORD: secret },
    input: `CREATE ROLE test_owner LOGIN PASSWORD '${secret}'; CREATE ROLE alpha_media_app LOGIN PASSWORD '${secret}'; CREATE DATABASE orders_test OWNER test_owner;`,
  });
  await startService().then(value => { serviceProcess = value; });
  await startJava("gateway", { PORT: String(gatewayPort), SERVICE_BASE_URL: `http://127.0.0.1:${servicePort}` });
  base = `http://127.0.0.1:${gatewayPort}`;
  alice = await member("alice"); bob = await member("bob");
}, { timeout: 60000 });

after(async () => {
  for (const child of children.reverse()) {
    // 재시작 때 이미 시그널로 종료한 자식은 exitCode가 null일 수 있다.
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
  if (directory) {
    spawnSync("pg_ctl", ["stop", "-w", "-m", "fast", "-D", join(directory, "postgres")], { windowsHide: true });
    // 임시로 생성한 작업 폴더인지 확인한 뒤에만 테스트 클러스터를 삭제한다.
    const actual = await realpath(directory), parent = await realpath(join(root, ".local"));
    assert.ok(actual.startsWith(parent + sep) && actual.slice(parent.length + 1).startsWith("order-tests-"));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("unauthenticated orders and Service bypass are blocked", async () => {
  const anonymous = new Client();
  assert.equal((await anonymous.request("/api/orders")).status, 401);
  assert.equal((await anonymous.create()).status, 401);
  assert.equal((await alice.request("/api/orders", { method: "POST", body: {} })).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${servicePort}/api/orders`)).status, 403);
});

test("create uses authenticated owner, DB price, KRW and an exact ten-minute lifetime", async () => {
  firstKey = randomUUID();
  const r = await alice.create(firstKey, { planId: "jp-esim-7d", travelStartDate: future,
    amount: 1, currency: "USD", memberId: bob.memberId, status: "PAID" });
  assert.equal(r.status, 201); first = await r.json();
  assert.equal(first.amount, 15900); assert.equal(first.currency, "KRW"); assert.equal(first.status, "PENDING_PAYMENT");
  assert.equal(Date.parse(first.expiresAt) - Date.parse(first.createdAt), 600000);
  assert.equal(sql(`SELECT member_id FROM orders WHERE id='${first.id}'`), alice.memberId);
  assert.equal(r.headers.get("location"), `/api/orders/${first.id}`);
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("same request replays, changed payload conflicts without another row", async () => {
  let r = await alice.create(firstKey); assert.equal(r.status, 200);
  assert.equal(r.headers.get("Idempotency-Replayed"), "true"); assert.deepEqual(await r.json(), first);
  r = await alice.create(firstKey, { planId: "th-esim-5d", travelStartDate: future });
  assert.equal(r.status, 409); assert.equal((await r.json()).code, "IDEMPOTENCY_CONFLICT");
  r = await alice.create(firstKey, { planId: "jp-esim-7d", travelStartDate: "2099-01-02" });
  assert.equal(r.status, 409);
  assert.equal(sql(`SELECT count(*) FROM orders WHERE member_id='${alice.memberId}' AND idempotency_key='${firstKey}'`), "1");
});

test("twenty simultaneous requests create one order", async () => {
  const key = randomUUID(), headers = { ...await alice.csrf(), "Idempotency-Key": key };
  const responses = await Promise.all(Array.from({ length: 20 }, () => alice.request("/api/orders", {
    method: "POST", headers, body: { planId: "jp-esim-7d", travelStartDate: future },
  })));
  assert.equal(responses.filter(r => r.status === 201).length, 1);
  assert.equal(responses.filter(r => r.status === 200).length, 19);
  assert.equal(new Set(await Promise.all(responses.map(async r => (await r.json()).id))).size, 1);
  assert.equal(sql(`SELECT count(*) FROM orders WHERE idempotency_key='${key}'`), "1");
});

test("discarded response can be retried with the same key", async () => {
  const key = randomUUID(), response = await alice.create(key);
  assert.equal(response.status, 201); await response.body.cancel();
  const replay = await alice.create(key); assert.equal(replay.status, 200);
  assert.equal(sql(`SELECT count(*) FROM orders WHERE idempotency_key='${key}'`), "1");
});

test("another member cannot read the order or override ownership with headers", async () => {
  assert.equal((await bob.request(`/api/orders/${first.id}`, { headers: { "X-User-Id": alice.memberId } })).status, 404);
  assert.deepEqual((await (await bob.request("/api/orders")).json()).items, []);
  const r = await bob.create(firstKey); assert.equal(r.status, 201);
  assert.notEqual((await r.json()).id, first.id);
});

test("invalid dates, missing products, USIM and malformed keys are rejected", async () => {
  for (const [body, status] of [
    [{ planId: "jp-esim-7d", travelStartDate: "2000-01-01" }, 400],
    [{ planId: "jp-esim-7d", travelStartDate: "2099-02-30" }, 400],
    [{ planId: "jp-esim-7d" }, 400], [{ planId: "unknown", travelStartDate: future }, 404],
    [{ planId: "jp-usim-7d", travelStartDate: future }, 400],
  ]) assert.equal((await alice.create(randomUUID(), body)).status, status);
  for (const key of [null, "not-a-uuid"]) {
    const headers = await alice.csrf(); if (key) headers["Idempotency-Key"] = key;
    assert.equal((await alice.request("/api/orders", { method: "POST", headers,
      body: { planId: "jp-esim-7d", travelStartDate: future } })).status, 400);
  }
});

test("price changes cannot alter saved snapshots or replay amounts", async () => {
  sql("UPDATE plans SET price=79999, name='Changed plan' WHERE id='jp-esim-7d'");
  const original = await (await alice.request(`/api/orders/${first.id}`)).json();
  assert.equal(original.amount, 15900); assert.equal(original.planName, first.planName);
  assert.equal((await (await alice.create(firstKey)).json()).amount, 15900);
  const current = await (await alice.create()).json(); assert.equal(current.amount, 79999);
  sql(`UPDATE orders SET amount=1 WHERE id='${first.id}'`, true, true);
  sql(`UPDATE orders SET member_id='${bob.memberId}' WHERE id='${first.id}'`, true, true);
});

test("pagination is bounded and does not repeat rows", async () => {
  const p0 = await (await alice.request("/api/orders?page=0&size=1")).json();
  const p1 = await (await alice.request("/api/orders?page=1&size=1")).json();
  assert.equal(p0.items.length, 1); assert.equal(p0.hasNext, true);
  assert.notEqual(p0.items[0].id, p1.items[0].id);
  for (const query of ["page=-1", "size=101", "size=0", "page=bad"]) {
    assert.equal((await alice.request(`/api/orders?${query}`)).status, 400);
  }
});

test("member session and order survive a Service restart", async () => {
  serviceProcess.kill(); await once(serviceProcess, "exit");
  serviceProcess = await startService();
  const r = await alice.request(`/api/orders/${first.id}`); assert.equal(r.status, 200);
  assert.equal((await r.json()).id, first.id); assert.equal((await alice.create(firstKey)).status, 200);
});

test("expiry is immediate in reads, never extends on retry, and worker persists it", { timeout: 75000 }, async () => {
  sql(`UPDATE orders SET created_at=CURRENT_TIMESTAMP-INTERVAL '11 minutes',
    expires_at=CURRENT_TIMESTAMP-INTERVAL '1 minute' WHERE id='${first.id}'`);
  assert.equal(sql(`SELECT status FROM orders WHERE id='${first.id}'`), "PENDING_PAYMENT");
  const expired = await (await alice.request(`/api/orders/${first.id}`)).json();
  assert.equal(expired.status, "EXPIRED");
  const replay = await (await alice.create(firstKey)).json();
  assert.equal(replay.id, first.id); assert.equal(replay.status, "EXPIRED"); assert.equal(replay.expiresAt, expired.expiresAt);
  await until(() => sql(`SELECT status FROM orders WHERE id='${first.id}'`) === "EXPIRED", 70000);
  assert.equal((await (await alice.create(firstKey)).json()).status, "EXPIRED");
});
