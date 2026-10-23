import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, pbkdf2Sync, randomBytes, randomInt, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const secret = randomBytes(32).toString("hex");
const children = [];
const reservedPorts = new Set();
let directory, dbPort, servicePort, gatewayPort, serviceProcess, base, alice, bob, admin, first, firstKey;
const future = "2099-01-01";
const password = "LocalOrderTest!2026Aa";
const accountHashes = Object.fromEntries(["CUSTOMER1", "CUSTOMER2", "ADMIN", "ADMIN2"].map(name => {
  const salt = randomBytes(16);
  return [`${name}_PASSWORD_HASH`, "{pbkdf2-sha256-600k}" + Buffer.concat([
    salt, pbkdf2Sync(password, salt, 600000, 32, "sha256")]).toString("hex")];
}));

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
  // Windows clients use the dynamic range from 49152; server restarts must not race those sockets.
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = randomInt(20000, 30000);
    if (reservedPorts.has(value)) continue;
    reservedPorts.add(value);
    const server = createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(value, "127.0.0.1", resolve);
      });
      await new Promise(resolve => server.close(resolve));
      return value;
    } catch { reservedPorts.delete(value); }
  }
  throw new Error("No available isolated test server port in 20000–29999");
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
  const jar = join(directory, `${name}.jar`);
  const logPath = join(directory, `${name}.log`);
  const log = createWriteStream(logPath, { flags: "a" });
  const processChild = spawn("java", ["-jar", jar], {
    cwd: join(root, "backend", name), windowsHide: true,
    env: { ...process.env, SPRING_PROFILES_ACTIVE: "render", INTERNAL_GATEWAY_TOKEN: secret, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let startupOutput = "", startupError;
  processChild.stdout.on("data", chunk => { startupOutput = (startupOutput + chunk.toString()).slice(-8192); });
  processChild.once("error", error => { startupError = error; });
  processChild.stdout.pipe(log); processChild.stderr.pipe(log);
  children.push(processChild);
  const url = `http://127.0.0.1:${env.PORT}/health`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (startupError || processChild.exitCode !== null || processChild.signalCode !== null) {
      throw new Error(`${name} exited before startup (exit=${processChild.exitCode}, signal=${processChild.signalCode}); see ${logPath}`);
    }
    // A stale process on the same port must not satisfy the new process's health check.
    if (/Started (?:Service|Gateway)Application in /.test(startupOutput)) {
      try {
        if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return processChild;
      } catch { /* Wait for this application's HTTP listener. */ }
    }
    await delay(250);
  }
  throw new Error(`${name} did not become healthy; see ${logPath}`);
}

function startService(extra = {}) {
  const url = `jdbc:postgresql://127.0.0.1:${dbPort}/orders_test`;
  return startJava("service", { PORT: String(servicePort), DB_URL: url, DB_USERNAME: "alpha_media_app",
    DB_PASSWORD: secret, DB_MIGRATION_URL: url, DB_MIGRATION_USERNAME: "test_owner",
    DB_MIGRATION_PASSWORD: secret, DB_CONNECTION_TIMEOUT: "10000", SESSION_COOKIE_SECURE: "false",
    MOCK_PG_ENABLED: "true", MOCK_PG_API_KEY: secret, PG_WEBHOOK_SECRET: secret,
    MOCK_PG_BASE_URL: `http://127.0.0.1:${servicePort}/internal/mock-pg`,
    PG_WEBHOOK_URL: `http://127.0.0.1:${gatewayPort}/webhooks/pg`,
    PG_HTTP_TIMEOUT_MS: "500", PAYMENT_LEASE_MS: "3000", PAYMENT_RETRY_BASE_MS: "500",
    MOCK_SUPPLIER_ENABLED: "true", SUPPLIER_API_KEY: secret, SUPPLIER_WEBHOOK_SECRET: secret,
    SUPPLIER_BASE_URL: `http://127.0.0.1:${servicePort}/internal/mock-supplier`,
    SUPPLIER_WEBHOOK_URL: `http://127.0.0.1:${gatewayPort}/webhooks/supplier`,
    SUPPLIER_HTTP_TIMEOUT_MS: "500", ISSUANCE_LEASE_MS: "3000", ISSUANCE_POLL_MS: "1000",
    ISSUANCE_WORKER_DELAY_MS: "100", SUPPLIER_COMPLETION_DELAY_MS: "200",
    PAYMENT_WORKER_DELAY_MS: "100", WEBHOOK_WORKER_DELAY_MS: "50", WEBHOOK_LEASE_MS: "3000",
    WEBHOOK_RETRY_BASE_MS: "100", WEBHOOK_INBOX_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    RECOVERY_WORKER_DELAY_MS: "100", RECOVERY_LEASE_MS: "1200", RECOVERY_RETRY_BASE_MS: "100",
    MONITORING_ENABLED: "false", MONITORING_INTERVAL_MS: "500", REQUEST_RATE_LIMIT_ENABLED: "false",
    RECONCILIATION_SCHEDULE_ENABLED: "false", RECONCILIATION_WORKER_DELAY_MS: "100",
    RECONCILIATION_LEASE_MS: "3000", RECONCILIATION_RETRY_BASE_MS: "100",
    ...accountHashes, ...extra });
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
  async pay(orderId, key = randomUUID(), scenario = "APPROVE", overrides = {}) {
    return this.request(`/api/orders/${orderId}/payment-attempts`, { method: "POST",
      headers: { ...await this.csrf(), "Idempotency-Key": key },
      body: { scenario, webhookCopies: 0, webhookDelayMs: 0, ...overrides } });
  }
}

async function member(name) {
  const client = new Client();
  const username = { alice: "customer1", bob: "customer2", admin: "admin", admin2: "admin2" }[name];
  const r = await client.request("/api/auth/login", { method: "POST",
    headers: { ...await client.csrf(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }).toString() });
  assert.equal(r.status, 200); client.memberId = (await r.json()).id; return client;
}

before(async () => {
  await mkdir(join(root, ".local"), { recursive: true });
  directory = await mkdtemp(join(root, ".local", "order-tests-"));
  // Keep restarts on the same build if an editor or another task rebuilds target/.
  for (const name of ["service", "gateway"]) {
    const jar = join(root, "backend", name, "target", `${name}-0.0.1-SNAPSHOT.jar`);
    assert.ok(await stat(jar).catch(() => null), `Build backend/${name} with Maven package first`);
    await copyFile(jar, join(directory, `${name}.jar`));
  }
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
  alice = await member("alice"); bob = await member("bob"); admin = await member("admin");
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

test("fixed customer accounts and admin authenticate without signup; DB starts with no orders", async () => {
  assert.equal(sql("SELECT string_agg(username,',' ORDER BY username) FROM members"), "admin,admin2,customer1,customer2");
  assert.equal(sql("SELECT count(*) FROM members WHERE role='ADMIN'"), "2");
  assert.equal(sql("SELECT count(*) FROM orders"), "0");
  assert.equal(sql("SELECT count(*) FROM payment_attempts"), "0");
  assert.equal(sql("SELECT count(*) FROM plans"), "3");
  const me = await (await alice.request("/api/me")).json();
  assert.equal(me.username, "customer1"); assert.equal(me.role, "USER");
  assert.equal(me.passwordHash, undefined); assert.equal(me.password, undefined);
  assert.equal((await (await admin.request("/api/me")).json()).role, "ADMIN");
  assert.equal((await alice.request("/api/auth/signup", { method: "POST", headers: await alice.csrf(),
    body: { username: "extra", password } })).status, 403);
  const bad = new Client();
  assert.equal((await bad.request("/api/auth/login", { method: "POST",
    headers: { ...await bad.csrf(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "customer1", password: "incorrect" }).toString() })).status, 401);
  sql("INSERT INTO members(id,username,display_name,password_hash) VALUES(gen_random_uuid(),'extra','추가고객','fake')", true, true);
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

test("admin reads real orders for both customers while customers cannot access admin APIs", async () => {
  assert.equal((await alice.request("/api/admin/orders")).status, 403);
  assert.equal((await new Client().request("/api/admin/orders")).status, 401);
  const response = await admin.request("/api/admin/orders?size=100"); assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.items.some(item => item.customerUsername === "customer1" && item.order.id === first.id));
  assert.ok(result.items.some(item => item.customerUsername === "customer2"));
  assert.equal(result.items.length, Number(sql("SELECT count(*) FROM orders")));
  const detail = await admin.request(`/api/admin/orders/${first.id}`); assert.equal(detail.status, 200);
  assert.equal((await detail.json()).order.order.id, first.id);
  assert.equal((await admin.create()).status, 403);
  assert.equal((await admin.pay(first.id)).status, 403);
  for (const query of ["status=invalid", "size=101", "page=-1", "from=2099-02-02&to=2000-01-01"]) {
    assert.equal((await admin.request(`/api/admin/orders?${query}`)).status, 400);
  }
  const filtered = await (await admin.request("/api/admin/orders?status=PENDING_PAYMENT&simType=ESIM&from=2000-01-01&to=2099-12-31&size=100")).json();
  assert.equal(filtered.items.length, result.items.length);
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
  const restorePlan = sql(`SELECT format('UPDATE plans SET price=%L, name=%L WHERE id=%L', price, name, id)
    FROM plans WHERE id='jp-esim-7d'`);
  try {
    sql("UPDATE plans SET price=79999, name='Changed plan' WHERE id='jp-esim-7d'");
    const original = await (await alice.request(`/api/orders/${first.id}`)).json();
    assert.equal(original.amount, 15900); assert.equal(original.planName, first.planName);
    assert.equal((await (await alice.create(firstKey)).json()).amount, 15900);
    const current = await (await alice.create()).json(); assert.equal(current.amount, 79999);
    sql(`UPDATE orders SET amount=1 WHERE id='${first.id}'`, true, true);
    sql(`UPDATE orders SET member_id='${bob.memberId}' WHERE id='${first.id}'`, true, true);
  } finally {
    // Later refund tests must see the original catalog even if an assertion fails.
    sql(restorePlan);
  }
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

async function newOrder() {
  const response = await alice.create(); assert.equal(response.status, 201); return response.json();
}

async function payment(orderId, paymentId) {
  const response = await alice.request(`/api/orders/${orderId}/payment-attempts/${paymentId}`);
  assert.equal(response.status, 200); return response.json();
}

async function settled(order, attempt, status = "APPROVED") {
  await until(async () => (await payment(order.id, attempt.id)).status === status);
  return payment(order.id, attempt.id);
}

function orderState(id) { return sql(`SELECT status FROM orders WHERE id='${id}'`); }
function expire(id) {
  sql(`WITH t AS (SELECT clock_timestamp() AS at) UPDATE orders SET created_at=t.at-INTERVAL '11 minutes',
    expires_at=t.at-INTERVAL '1 minute' FROM t WHERE id='${id}'`);
}

async function pg(path, body, key = randomUUID()) {
  return fetch(`http://127.0.0.1:${servicePort}/internal/mock-pg${path}`, {
    method: body ? "POST" : "GET",
    headers: { "X-Gateway-Token": secret, Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json", "Idempotency-Key": key },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000),
  });
}

function signedHeaders(body, source = "PG", valid = true, overrides = {}) {
  const keyId = overrides.keyId || source.toLowerCase() + "-v1";
  const timestamp = String(overrides.timestamp ?? Math.floor(Date.now() / 1000));
  return { "Content-Type": "application/json", "X-Key-Id": keyId, "X-Signature-Timestamp": timestamp,
    "X-Signature": valid ? createHmac("sha256", overrides.secret || secret)
      .update(`v1\n${source}\n${keyId}\n${timestamp}\n`).update(body).digest("hex") : "0".repeat(64) };
}
async function notify(result, signature = true) {
  const body = JSON.stringify(result);
  return fetch(base + "/webhooks/pg", { method: "POST", body,
    headers: signedHeaders(body,"PG",signature) });
}

function inboundRow(id) {
  const value = sql(`SELECT row_to_json(e) FROM inbound_events e WHERE id='${id}'`);
  return value ? JSON.parse(value) : null;
}

async function webhookOutcome(pendingResponse, errorStatus = null) {
  const response = await pendingResponse;
  if (response.status === 409) {
    assert.equal(errorStatus, 409);
    assert.equal((await response.json()).code, "INBOUND_EVENT_CONFLICT");
    return;
  }
  assert.ok([200, 202].includes(response.status), `unexpected webhook HTTP ${response.status}`);
  const receipt = await response.json();
  assert.ok(receipt.id); assert.ok(receipt.eventId);
  await until(() => inboundRow(receipt.id)?.status === (errorStatus ? "REVIEW_REQUIRED" : "PROCESSED"));
  const row = inboundRow(receipt.id);
  if (errorStatus) assert.equal(row.error_status, errorStatus);
  else assert.ok(row.processed_at);
  return { receipt, row };
}

async function webhookCopies(responses, errorStatus = null) {
  assert.ok(responses.every(response => [200, 202].includes(response.status)));
  const completed = await Promise.all(responses.map(response => webhookOutcome(response, errorStatus)));
  assert.equal(new Set(completed.map(result => result.receipt.id)).size, 1);
  return completed[0];
}

async function restart(extra = {}) {
  if (serviceProcess && serviceProcess.exitCode === null && serviceProcess.signalCode === null) {
    const stopped = once(serviceProcess, "exit"); serviceProcess.kill(); await stopped;
  }
  serviceProcess = await startService(extra);
}

async function providerProxy(name) {
  const proxy = { calls: [], intercept: null };
  const server = createHttpServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const call = { method: request.method, path: request.url, body: body ? JSON.parse(body) : null };
      proxy.calls.push(call);
      const intercepted = await proxy.intercept?.(call);
      if (intercepted) {
        response.writeHead(intercepted.status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(intercepted.body ?? {})); return;
      }
      const upstream = await fetch(`http://127.0.0.1:${servicePort}${request.url}`, {
        method: request.method, headers: { "X-Gateway-Token": secret, Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json", ...(request.headers["idempotency-key"]
            ? { "Idempotency-Key": request.headers["idempotency-key"] } : {}) },
        body: body || undefined, signal: AbortSignal.timeout(5000),
      });
      response.writeHead(upstream.status, { "Content-Type": "application/json" });
      response.end(await upstream.text());
    } catch { response.writeHead(503); response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  proxy.url = `http://127.0.0.1:${server.address().port}/internal/${name}`;
  proxy.forId = id => proxy.calls.filter(c => c.path.includes(id) || c.body?.paymentId === id || c.body?.requestId === id);
  proxy.close = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  return proxy;
}

function rejectTransitions(table, orderId, statuses) {
  // Per-order real database failures exercise transaction rollback without breaking unrelated workers.
  sql(`CREATE FUNCTION reject_transition_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.order_id='${orderId}' AND NEW.status IN (${statuses.map(s => `'${s}'`).join(",")})
      THEN RAISE EXCEPTION 'simulated database write failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_transition_for_test BEFORE UPDATE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION reject_transition_for_test();`);
  return () => sql(`DROP TRIGGER reject_transition_for_test ON ${table}; DROP FUNCTION reject_transition_for_test();`);
}

const inboxOnly = { PAYMENT_WORKER_DELAY_MS: "60000", ISSUANCE_WORKER_DELAY_MS: "60000" };

async function pendingWebhookPayment() {
  const order = await newOrder(), attempt = await (await alice.pay(order.id)).json();
  assert.equal(attempt.status, "QUEUED");
  const approved = await pg("/payments/approve", { paymentId: attempt.id, orderId: order.id,
    amount: order.amount, currency: "KRW", scenario: "APPROVE", webhookCopies: 0, webhookDelayMs: 0 });
  assert.equal(approved.status, 200);
  return { order, attempt, result: await approved.json() };
}

function rejectInbox(eventId, operation, statuses = []) {
  const condition = statuses.length ? `AND NEW.status IN (${statuses.map(value => `'${value}'`).join(",")})` : "";
  sql(`CREATE FUNCTION reject_inbox_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.event_id='${eventId}' ${condition} THEN RAISE EXCEPTION 'simulated inbox database failure'; END IF;
    RETURN NEW; END $$; CREATE TRIGGER reject_inbox_for_test BEFORE ${operation} ON inbound_events
      FOR EACH ROW EXECUTE FUNCTION reject_inbox_for_test();`);
  return () => sql("DROP TRIGGER reject_inbox_for_test ON inbound_events; DROP FUNCTION reject_inbox_for_test();");
}

async function holdOrder(orderId) {
  const processChild = spawn("psql", ["-X", "-At", "-v", "ON_ERROR_STOP=1"], { windowsHide: true,
    env: { ...process.env, PGHOST: "127.0.0.1", PGPORT: String(dbPort), PGDATABASE: "orders_test",
      PGUSER: "postgres", PGPASSWORD: secret, PGSSLMODE: "disable" } });
  let output = "";
  processChild.stdout.on("data", chunk => { output += chunk.toString(); });
  processChild.stdin.write(`BEGIN; SELECT id FROM orders WHERE id='${orderId}' FOR NO KEY UPDATE;\n\\echo lock-ready\n`);
  await until(() => output.includes("lock-ready"));
  return async () => {
    const exited = once(processChild, "exit");
    processChild.stdin.end("ROLLBACK;\n\\q\n");
    await exited;
  };
}

test("webhook inbox persists one encrypted receipt for twenty concurrent deliveries before processing after restart", { timeout: 45000 }, async () => {
  await restart({ ...inboxOnly, WEBHOOK_WORKER_DELAY_MS: "60000" });
  try {
    const { order, attempt, result } = await pendingWebhookPayment();
    const responses = await Promise.all(Array.from({ length: 20 }, () => notify(result)));
    assert.equal(responses.filter(response => response.status === 202).length, 1);
    assert.equal(responses.filter(response => response.status === 200).length, 19);
    const receipts = await Promise.all(responses.map(response => response.json()));
    assert.equal(new Set(receipts.map(receipt => receipt.id)).size, 1);
    const receipt = receipts[0], before = inboundRow(receipt.id);
    assert.equal(before.status, "PENDING"); assert.equal(before.receive_count, 20); assert.equal(before.attempt_count, 0);
    assert.equal(before.order_id, order.id); assert.equal(before.target_id, attempt.id);
    assert.ok(!Buffer.from(before.body.slice(2), "hex").includes(Buffer.from(JSON.stringify(result))));
    assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "0");
    const body = JSON.stringify(Object.fromEntries(Object.entries(result).reverse()), null, 2);
    const formatted = await fetch(base + "/webhooks/pg", { method: "POST", body,
      headers: signedHeaders(body) });
    assert.equal(formatted.status, 200); assert.equal((await formatted.json()).id, receipt.id);
    assert.equal(inboundRow(receipt.id).body, before.body); assert.equal(inboundRow(receipt.id).receive_count, 21);
    sql(`UPDATE inbound_events SET body='tampered'::bytea WHERE id='${receipt.id}'`, true, true);
    sql(`DELETE FROM inbound_events WHERE id='${receipt.id}'`, true, true);
    await restart(inboxOnly);
    await until(() => inboundRow(receipt.id).status === "PROCESSED");
    assert.equal(inboundRow(receipt.id).attempt_count, 1);
    assert.equal(orderState(order.id), "PAID");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "1");
    assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "1");
    assert.equal((await (await pg(`/payments/${attempt.id}/stats`)).json()).approvalExecutions, 1);
    const detail = await (await admin.request(`/api/admin/orders/${order.id}`)).json();
    const visible = detail.inboundEvents.find(event => event.id === receipt.id);
    assert.equal(visible.status, "PROCESSED"); assert.equal(visible.receiveCount, 21);
    for (const privateField of ["body", "payloadHash", "signature", "leaseToken"]) assert.equal(visible[privateField], undefined);
  } finally { await restart(); }
});

test("webhook inbox rejects invalid signatures and returns non-success when its durable insert fails", { timeout: 45000 }, async () => {
  await restart(inboxOnly);
  let restore;
  try {
    const { order, result } = await pendingWebhookPayment();
    assert.equal((await notify(result, false)).status, 401);
    assert.equal((await notify({ ...result, amount: "15900" })).status, 400);
    assert.equal(sql(`SELECT count(*) FROM inbound_events WHERE event_id='${result.eventId}'`), "0");
    restore = rejectInbox(result.eventId, "INSERT");
    const rejected = await notify(result);
    assert.ok(rejected.status >= 500 && rejected.status <= 599);
    assert.equal(sql(`SELECT count(*) FROM inbound_events WHERE event_id='${result.eventId}'`), "0");
    assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
    restore(); restore = null;
    const accepted = await notify(result); assert.equal(accepted.status, 202);
    await webhookOutcome(accepted); assert.equal(orderState(order.id), "PAID");
  } finally { if (restore) restore(); await restart(); }
});

test("webhook inbox keeps a receipt across business DB rollback and restarts then automatically retries the same event", { timeout: 60000 }, async () => {
  const settings = { ...inboxOnly, WEBHOOK_RETRY_BASE_MS: "1000" };
  await restart(settings);
  let restore;
  try {
    const { order, attempt, result } = await pendingWebhookPayment();
    restore = rejectTransitions("payment_attempts", order.id, ["APPROVED"]);
    const response = await notify(result); assert.equal(response.status, 202);
    const receipt = await response.json();
    await until(() => inboundRow(receipt.id).status === "RETRY");
    const failed = inboundRow(receipt.id);
    assert.equal(failed.last_error, "INBOUND_PROCESSING_FAILED"); assert.equal(failed.error_status, 503);
    assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "0");
    assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "0");
    await restart({ ...settings, WEBHOOK_WORKER_DELAY_MS: "60000" });
    assert.ok(inboundRow(receipt.id).attempt_count >= failed.attempt_count);
    assert.equal(inboundRow(receipt.id).body, failed.body);
    restore(); restore = null;
    await restart(settings);
    await until(() => inboundRow(receipt.id).status === "PROCESSED");
    assert.ok(inboundRow(receipt.id).attempt_count >= 2);
    assert.equal(orderState(order.id), "PAID");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "1");
    assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "1");
    assert.equal((await (await pg(`/payments/${attempt.id}/stats`)).json()).approvalRequests, 1);
  } finally { if (restore) restore(); await restart(); }
});

test("webhook inbox completion failure atomically rolls back payment approval and issuance enqueue", { timeout: 45000 }, async () => {
  await restart({ ...inboxOnly, WEBHOOK_RETRY_BASE_MS: "1000" });
  let restore;
  try {
    const { order, attempt, result } = await pendingWebhookPayment();
    restore = rejectInbox(result.eventId, "UPDATE", ["PROCESSED"]);
    const response = await notify(result); assert.equal(response.status, 202); const receipt = await response.json();
    await until(() => inboundRow(receipt.id).status === "RETRY");
    assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
    assert.equal(sql(`SELECT status FROM payment_attempts WHERE id='${attempt.id}'`), "QUEUED");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "0");
    assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "0");
    restore(); restore = null;
    await until(() => inboundRow(receipt.id).status === "PROCESSED");
    assert.equal(orderState(order.id), "PAID");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "1");
    assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "1");
  } finally { if (restore) restore(); await restart(); }
});

test("webhook inbox reclaims an interrupted processing lease after server restart without a second approval", { timeout: 45000 }, async () => {
  await restart(inboxOnly);
  let release;
  try {
    const { order, attempt, result } = await pendingWebhookPayment();
    release = await holdOrder(order.id);
    const response = await notify(result); assert.equal(response.status, 202); const receipt = await response.json();
    await until(() => inboundRow(receipt.id).status === "PROCESSING");
    const claimed = inboundRow(receipt.id); assert.equal(claimed.attempt_count, 1); assert.ok(claimed.lease_token);
    const stopped = once(serviceProcess, "exit"); serviceProcess.kill(); await stopped;
    await release(); release = null;
    serviceProcess = await startService(inboxOnly);
    await until(() => inboundRow(receipt.id).status === "PROCESSED");
    assert.equal(inboundRow(receipt.id).attempt_count, 2); assert.equal(orderState(order.id), "PAID");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "1");
    assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "1");
    assert.equal((await (await pg(`/payments/${attempt.id}/stats`)).json()).approvalRequests, 1);
  } finally { if (release) await release(); await restart(); }
});

test("webhook inbox preserves the original payload and quarantines concurrent reuse of an event ID with changed content", { timeout: 45000 }, async () => {
  await restart({ ...inboxOnly, WEBHOOK_WORKER_DELAY_MS: "60000" });
  try {
    const { order, attempt, result } = await pendingWebhookPayment();
    const response = await notify(result); assert.equal(response.status, 202); const receipt = await response.json();
    const original = inboundRow(receipt.id);
    const changed = { ...result, amount: result.amount + 1 };
    const collisions = await Promise.all(Array.from({ length: 20 }, () => notify(changed)));
    assert.ok(collisions.every(response => response.status === 409));
    assert.ok((await Promise.all(collisions.map(response => response.json()))).every(body => body.code === "INBOUND_EVENT_CONFLICT"));
    const quarantined = inboundRow(receipt.id);
    assert.equal(quarantined.status, "REVIEW_REQUIRED"); assert.equal(quarantined.body, original.body);
    assert.equal(quarantined.payload_hash, original.payload_hash); assert.ok(quarantined.conflicting_payload_hash);
    assert.equal(sql(`SELECT count(*) FROM inbound_events WHERE source='PG' AND event_id='${result.eventId}'`), "1");
    assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${order.id}'`), "1");
    const same = await notify(result); assert.equal(same.status, 200); assert.equal((await same.json()).id, receipt.id);
    await restart(inboxOnly); await delay(500);
    assert.equal(inboundRow(receipt.id).status, "REVIEW_REQUIRED"); assert.equal(inboundRow(receipt.id).attempt_count, 0);
    assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "0");
    assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "0");
  } finally { await restart(); }
});

test("webhook inbox retains its six-attempt budget when completion and error recording both fail across restart", { timeout: 60000 }, async () => {
  const settings = { ...inboxOnly, WEBHOOK_LEASE_MS: "1000" };
  await restart(settings);
  let restore;
  try {
    const { order, attempt, result } = await pendingWebhookPayment();
    restore = rejectInbox(result.eventId, "UPDATE", ["PROCESSED", "RETRY", "REVIEW_REQUIRED"]);
    const response = await notify(result); assert.equal(response.status, 202); const receipt = await response.json();
    await until(() => inboundRow(receipt.id).attempt_count >= 2);
    await restart(settings);
    await until(() => inboundRow(receipt.id).attempt_count === 6);
    await delay(1500);
    assert.equal(inboundRow(receipt.id).status, "PROCESSING");
    assert.equal(inboundRow(receipt.id).attempt_count, 6);
    assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "0");
    restore(); restore = null;
    await restart(settings);
    await until(() => inboundRow(receipt.id).status === "REVIEW_REQUIRED");
    assert.equal(inboundRow(receipt.id).attempt_count, 6);
    assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "0");
    assert.equal((await (await pg(`/payments/${attempt.id}/stats`)).json()).approvalRequests, 1);
    const duplicate = await notify(result); assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).id, receipt.id);
    await delay(500); assert.equal(inboundRow(receipt.id).attempt_count, 6);
  } finally { if (restore) restore(); await restart(); }
});

test("webhook inbox retains an unknown valid target and stops after six deferred lookups without fabricating an order", { timeout: 30000 }, async () => {
  const result = { eventId: randomUUID(), paymentId: randomUUID(), orderId: randomUUID(), amount: 15900,
    currency: "KRW", status: "APPROVED", transactionId: `unknown_${randomUUID()}`, declineCode: null };
  const response = await notify(result); assert.equal(response.status, 202);
  const { row } = await webhookOutcome(response, 404);
  assert.equal(row.attempt_count, 6); assert.equal(row.order_id, null);
  assert.equal(row.last_error, "PAYMENT_NOT_FOUND");
  assert.equal(sql(`SELECT count(*) FROM orders WHERE id='${result.orderId}'`), "0");
  assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${result.orderId}'`), "0");
});

test("payment intake authenticates owner, enforces CSRF, validates inputs and ignores forged amount", async () => {
  const order = await newOrder(), path = `/api/orders/${order.id}/payment-attempts`;
  assert.equal((await new Client().pay(order.id)).status, 401);
  assert.equal((await bob.pay(order.id)).status, 404);
  assert.equal((await alice.request(path, { method: "POST", body: {} })).status, 403);
  assert.equal((await alice.pay(order.id, randomUUID(), "BAD_SCENARIO")).status, 400);
  assert.equal((await alice.pay(order.id, randomUUID(), "APPROVE", { webhookCopies: 21 })).status, 400);
  assert.equal((await alice.pay(order.id, randomUUID(), "APPROVE", { webhookCopies: -1 })).status, 400);
  assert.equal((await alice.pay(order.id, randomUUID(), "APPROVE", { webhookDelayMs: -1 })).status, 400);
  assert.equal((await alice.pay(order.id, randomUUID(), "APPROVE", { webhookDelayMs: 60001 })).status, 400);
  assert.equal((await fetch(base + "/internal/mock-pg/payments/approve", { method: "POST", body: "{}" })).status, 404);
  const response = await alice.pay(order.id, randomUUID(), "APPROVE", { amount: 1, currency: "USD", memberId: bob.memberId });
  assert.equal(response.status, 202); const attempt = await response.json();
  assert.equal(attempt.amount, order.amount); assert.equal(attempt.currency, "KRW");
  assert.equal(response.headers.get("location"), `${path}/${attempt.id}`);
  assert.equal((await bob.request(`${path}/${attempt.id}`)).status, 404);
  await settled(order, attempt); assert.equal(orderState(order.id), "PAID");
  sql(`UPDATE payment_attempts SET amount=1 WHERE id='${attempt.id}'`, true, true);
  sql(`UPDATE payment_attempts SET order_id='${randomUUID()}' WHERE id='${attempt.id}'`, true, true);
});

test("payment simulation settings survive replay, enforce fixed parameters and drive webhook delivery", async () => {
  for (const config of [
    { scenario: "APPROVE", webhookCopies: 20, webhookDelayMs: 1000 },
    { scenario: "DECLINE", webhookCopies: 1, webhookDelayMs: 0 },
    { scenario: "RESPONSE_LOST", webhookCopies: 0, webhookDelayMs: 60000 },
  ]) {
    const order = await newOrder(), key = randomUUID();
    const response = await alice.pay(order.id, key, config.scenario, config);
    assert.equal(response.status, 202);
    const attempt = await response.json();
    for (const name of ["scenario", "webhookCopies", "webhookDelayMs"]) assert.equal(attempt[name], config[name]);
    const replay = await alice.pay(order.id, key, config.scenario, config);
    assert.equal(replay.status, 200); assert.equal((await replay.json()).id, attempt.id);
    assert.equal((await alice.pay(order.id, key, config.scenario,
      { ...config, webhookCopies: config.webhookCopies === 0 ? 1 : 0 })).status, 409);
    assert.equal((await alice.pay(order.id, key, config.scenario,
      { ...config, webhookDelayMs: config.webhookDelayMs === 0 ? 1000 : 0 })).status, 409);
    const declined = config.scenario === "DECLINE";
    await settled(order, attempt, declined ? "DECLINED" : "APPROVED");
    assert.equal(orderState(order.id), declined ? "PENDING_PAYMENT" : "PAID");
    await until(async () => (await (await pg(`/payments/${attempt.id}/stats`)).json()).webhookSent === config.webhookCopies);
    const stats = await (await pg(`/payments/${attempt.id}/stats`)).json();
    assert.equal(stats.approvalRequests, 1);
    assert.equal(stats.approvalExecutions, declined ? 0 : 1);
    assert.equal(stats.webhookFailures, 0);
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "1");
    assert.equal(sql(`SELECT webhook_delay_ms FROM mock_pg_payments WHERE payment_id='${attempt.id}'`), String(config.webhookDelayMs));
  }
});

test("payment same-key concurrency and replay create exactly one attempt and one PG approval", async () => {
  const order = await newOrder(), key = randomUUID(), headers = { ...await alice.csrf(), "Idempotency-Key": key };
  const responses = await Promise.all(Array.from({ length: 20 }, () => alice.request(
    `/api/orders/${order.id}/payment-attempts`, { method: "POST", headers,
      body: { scenario: "APPROVE", webhookCopies: 0, webhookDelayMs: 0 } })));
  assert.equal(responses.filter(r => r.status === 202).length, 1);
  assert.equal(responses.filter(r => r.status === 200).length, 19);
  const attempts = await Promise.all(responses.map(r => r.json()));
  assert.equal(new Set(attempts.map(p => p.id)).size, 1);
  await settled(order, attempts[0]);
  assert.equal(sql(`SELECT count(*) FROM payment_attempts WHERE order_id='${order.id}'`), "1");
  const stats = await (await pg(`/payments/${attempts[0].id}/stats`)).json();
  assert.equal(stats.approvalExecutions, 1);
  const replay = await alice.pay(order.id, key); assert.equal(replay.status, 200);
  assert.equal((await replay.json()).status, "APPROVED");
  assert.equal((await alice.pay(order.id, key, "DECLINE")).status, 409);
  assert.equal((await alice.pay(order.id)).status, 409);
});

test("payment different-key concurrency allows one active payment, even before approval completes", async () => {
  const order = await newOrder(), headers = await alice.csrf();
  const responses = await Promise.all(Array.from({ length: 20 }, () => alice.request(
    `/api/orders/${order.id}/payment-attempts`, { method: "POST",
      headers: { ...headers, "Idempotency-Key": randomUUID() },
      body: { scenario: "RESPONSE_LOST", webhookCopies: 0, webhookDelayMs: 0 } })));
  assert.equal(responses.filter(r => r.status === 202).length, 1);
  assert.equal(responses.filter(r => r.status === 409).length, 19);
  const attempt = await responses.find(r => r.status === 202).json();
  await settled(order, attempt);
  assert.equal(sql(`SELECT count(*) FROM payment_attempts WHERE order_id='${order.id}'`), "1");
  assert.equal((await (await pg(`/payments/${attempt.id}/stats`)).json()).approvalExecutions, 1);
});

test("payment definitive decline reopens only an unexpired order and permits a new attempt", async () => {
  const order = await newOrder(), key = randomUUID();
  const rejected = await (await alice.pay(order.id, key, "DECLINE")).json();
  await settled(order, rejected, "DECLINED"); assert.equal(orderState(order.id), "PENDING_PAYMENT");
  assert.equal((await (await pg(`/payments/${rejected.id}/stats`)).json()).approvalExecutions, 0);
  assert.equal((await alice.pay(order.id, key, "DECLINE")).status, 200);
  const accepted = await alice.pay(order.id); assert.equal(accepted.status, 202);
  const next = await accepted.json(); assert.notEqual(next.id, rejected.id);
  await settled(order, next); assert.equal(orderState(order.id), "PAID");
});

test("payment response loss preserves processing, blocks re-payment and resolves by lookup after expiry", async () => {
  const order = await newOrder(), key = randomUUID();
  const response = await alice.pay(order.id, key, "RESPONSE_LOST");
  assert.equal(response.status, 202); const attempt = await response.json();
  await until(async () => (await payment(order.id, attempt.id)).status === "UNKNOWN");
  assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
  assert.equal((await alice.pay(order.id)).status, 409);
  expire(order.id);
  assert.equal((await (await alice.request(`/api/orders/${order.id}`)).json()).status, "PAYMENT_PROCESSING");
  const final = await settled(order, attempt); assert.equal(final.attemptCount, 2);
  assert.equal(orderState(order.id), "PAID");
  const stats = await (await pg(`/payments/${attempt.id}/stats`)).json();
  assert.equal(stats.approvalRequests, 1); assert.equal(stats.approvalExecutions, 1);
  assert.equal((await alice.pay(order.id, key, "RESPONSE_LOST")).status, 200);
});

test("payment expired orders reject new intake without calling PG", async () => {
  const order = await newOrder(); expire(order.id);
  assert.equal((await alice.pay(order.id)).status, 409);
  assert.equal(sql(`SELECT count(*) FROM payment_attempts WHERE order_id='${order.id}'`), "0");
  assert.equal(sql(`SELECT count(*) FROM mock_pg_payments WHERE order_id='${order.id}'`), "0");
});

test("payment signed duplicate webhook and response races apply one event and one approval", async () => {
  const order = await newOrder();
  const attempt = await (await alice.pay(order.id, randomUUID(), "RESPONSE_LOST", { webhookCopies: 2 })).json();
  await settled(order, attempt);
  const result = await (await pg(`/payments/${attempt.id}`)).json();
  const responses = await Promise.all(Array.from({ length: 20 }, () => notify(result)));
  await webhookCopies(responses);
  assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "1");
  assert.equal(sql(`SELECT status FROM payment_attempts WHERE id='${attempt.id}'`), "APPROVED");
  assert.equal(orderState(order.id), "PAID");
  await until(async () => (await (await pg(`/payments/${attempt.id}/stats`)).json()).webhookSent === 2);
  assert.equal((await (await pg(`/payments/${attempt.id}/stats`)).json()).approvalExecutions, 1);
  assert.equal((await notify(result, false)).status, 401);
  await webhookOutcome(notify({ ...result, amount: result.amount + 1 }), 409);
  await webhookOutcome(notify({ ...result, currency: "USD" }), 409);
  assert.equal((await notify({ ...result, amount: result.amount + 0.5 })).status, 400);
  assert.equal((await notify({ ...result, amount: String(result.amount) })).status, 400);
  await webhookOutcome(notify({ ...result, transactionId: "changed" }), 409);
  await webhookOutcome(notify({ ...result, orderId: randomUUID() }), 409);
  assert.equal(orderState(order.id), "PAID");
});

test("payment forged amount webhook cannot mark an unresolved order paid", async () => {
  const order = await newOrder();
  const attempt = await (await alice.pay(order.id, randomUUID(), "RESPONSE_LOST")).json();
  await until(() => sql(`SELECT count(*) FROM mock_pg_payments WHERE payment_id='${attempt.id}'`) === "1");
  const result = await (await pg(`/payments/${attempt.id}`)).json();
  await webhookOutcome(notify({ ...result, amount: 1 }), 409);
  assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
  assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "0");
  await webhookOutcome(notify(result), 409);
  await settled(order, attempt, "REVIEW_REQUIRED");
  assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
  assert.equal(sql(`SELECT string_agg(code,',' ORDER BY code) FROM order_conflicts WHERE order_id='${order.id}'`),
    "INBOUND_EVENT_CONFLICT,PG_RESULT_MISMATCH");
  assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "0");
});

test("payment PG idempotency prevents duplicate charges and supports bounded partial/full cancellation", async () => {
  const order = await newOrder(), attempt = await (await alice.pay(order.id)).json();
  await settled(order, attempt);
  const approval = { paymentId: attempt.id, orderId: order.id, amount: order.amount, currency: "KRW",
    scenario: "APPROVE", webhookCopies: 0, webhookDelayMs: 0 };
  const responses = await Promise.all(Array.from({ length: 20 }, () => pg("/payments/approve", approval)));
  assert.ok(responses.every(r => r.status === 200));
  assert.equal((await (await pg(`/payments/${attempt.id}/stats`)).json()).approvalExecutions, 1);
  assert.equal((await pg("/payments/approve", { ...approval, amount: 1 })).status, 409);
  const key = randomUUID(), part = Math.floor(order.amount / 3);
  const cancellations = await Promise.all(Array.from({ length: 20 }, () => pg(`/payments/${attempt.id}/cancel`, { amount: part }, key)));
  assert.ok(cancellations.every(r => r.status === 200));
  assert.equal(new Set(await Promise.all(cancellations.map(async r => (await r.json()).id))).size, 1);
  assert.equal((await pg(`/payments/${attempt.id}/cancel`, { amount: part + 1 }, key)).status, 409);
  const rest = await pg(`/payments/${attempt.id}/cancel`, { amount: order.amount - part });
  assert.equal(rest.status, 200); assert.equal((await rest.json()).cancelledTotal, order.amount);
  assert.equal((await pg(`/payments/${attempt.id}/cancel`, { amount: 1 })).status, 409);
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${attempt.id}'`), "2");
});

test("payment intake response can be discarded and safely replayed with the same key", async () => {
  const order = await newOrder(), key = randomUUID(), response = await alice.pay(order.id, key);
  assert.equal(response.status, 202); await response.body.cancel();
  const replay = await alice.pay(order.id, key); assert.equal(replay.status, 200);
  const attempt = await replay.json(); await settled(order, attempt);
  assert.equal(sql(`SELECT count(*) FROM payment_attempts WHERE order_id='${order.id}'`), "1");
  assert.equal((await (await pg(`/payments/${attempt.id}/stats`)).json()).approvalExecutions, 1);
});

test("payment mismatched PG lookup requires review and cannot mark the order paid", async () => {
  const order = await newOrder(), attempt = await (await alice.pay(order.id, randomUUID(), "RESPONSE_LOST")).json();
  await until(() => sql(`SELECT count(*) FROM mock_pg_payments WHERE payment_id='${attempt.id}'`) === "1");
  sql(`UPDATE mock_pg_payments SET amount=amount+1 WHERE payment_id='${attempt.id}'`);
  const review = await settled(order, attempt, "REVIEW_REQUIRED");
  assert.equal(review.lastError, "PG_RESULT_REQUIRES_REVIEW");
  assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
  assert.equal((await alice.pay(order.id)).status, 409);
  assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "0");
  sql(`UPDATE mock_pg_payments SET amount=amount-1 WHERE payment_id='${attempt.id}'`);
  const corrected = await (await pg(`/payments/${attempt.id}`)).json();
  await webhookOutcome(notify(corrected), 409);
  assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
  assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${order.id}'`), "1");
});

test("payment queued work survives restart and a decline after its deadline expires the order", { timeout: 30000 }, async () => {
  await restart({ PAYMENT_WORKER_DELAY_MS: "60000" });
  const order = await newOrder(), key = randomUUID(), response = await alice.pay(order.id, key, "DECLINE");
  assert.equal(response.status, 202); const attempt = await response.json();
  assert.equal(attempt.status, "QUEUED"); expire(order.id);
  await restart();
  await settled(order, attempt, "DECLINED"); assert.equal(orderState(order.id), "EXPIRED");
  assert.equal((await alice.pay(order.id, key, "DECLINE")).status, 200);
  assert.equal((await alice.pay(order.id)).status, 409);
});

test("payment crashed worker recovers PG-committed approval from its durable lease after restart", async () => {
  const order = await newOrder(), attempt = await (await alice.pay(order.id, randomUUID(), "RESPONSE_LOST")).json();
  await until(() => sql(`SELECT count(*) FROM mock_pg_payments WHERE payment_id='${attempt.id}'`) === "1");
  assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
  await restart();
  await settled(order, attempt); assert.equal(orderState(order.id), "PAID");
  assert.equal((await (await pg(`/payments/${attempt.id}/stats`)).json()).approvalRequests, 1);
  assert.equal((await alice.request("/api/me")).status, 200);
});

test("payment stale worker cannot finalize after its lease token changes", async () => {
  const order = await newOrder(), attempt = await (await alice.pay(order.id, randomUUID(), "RESPONSE_LOST")).json();
  await until(() => sql(`SELECT count(*) FROM mock_pg_payments WHERE payment_id='${attempt.id}'`) === "1");
  sql(`UPDATE payment_attempts SET lease_token='${randomUUID()}', lease_until=clock_timestamp()+INTERVAL '3 seconds' WHERE id='${attempt.id}'`);
  await delay(1000); assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
  assert.equal((await payment(order.id, attempt.id)).status, "PROCESSING");
  sql(`UPDATE payment_attempts SET lease_until=clock_timestamp()-INTERVAL '1 second' WHERE id='${attempt.id}'`);
  await settled(order, attempt);
  assert.equal((await (await pg(`/payments/${attempt.id}/stats`)).json()).approvalExecutions, 1);
});

test("payment retries stop at six unresolved cycles without declaring decline or accepting another charge", { timeout: 60000 }, async () => {
  const unused = await port();
  await restart({ MOCK_PG_BASE_URL: `http://127.0.0.1:${unused}/unavailable` });
  const order = await newOrder(), attempt = await (await alice.pay(order.id)).json();
  const review = await settled(order, attempt, "REVIEW_REQUIRED");
  assert.equal(review.attemptCount, 6); assert.equal(review.lastError, "RETRY_LIMIT_REACHED");
  assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
  assert.equal((await alice.pay(order.id)).status, 409);
  assert.equal(sql(`SELECT count(*) FROM mock_pg_payments WHERE payment_id='${attempt.id}'`), "0");
  await restart();
});

for (const domain of ["payment", "refund"]) {
  for (const failure of ["completion", "error recording"]) {
    test(`retry policy ${domain} persists its budget through DB ${failure} failures and restart`, { timeout: 60000 }, async () => {
      const proxy = await providerProxy("mock-pg"), cap = domain === "payment" ? 6 : 3;
      const table = domain === "payment" ? "payment_attempts" : "refunds";
      const data = domain === "payment" ? { order: await newOrder() } : await failedOrder();
      const { order } = data;
      const settings = { MOCK_PG_BASE_URL: proxy.url, PAYMENT_LEASE_MS: "1200" };
      let restore;
      try {
        await restart(settings);
        restore = rejectTransitions(table, order.id, failure === "completion"
          ? [domain === "payment" ? "APPROVED" : "SUCCEEDED"] : ["UNKNOWN", "REVIEW_REQUIRED"]);
        if (failure === "error recording") proxy.intercept = () => ({ status: 503 });
        const response = domain === "payment" ? await alice.pay(order.id)
          : await adminAction(order.id, "refunds", refundRequest(data.job));
        assert.equal(response.status, 202);
        const paymentId = domain === "payment" ? (await response.json()).id : data.attempt.id;
        const row = () => JSON.parse(sql(`SELECT row_to_json(r) FROM ${table} r WHERE order_id='${order.id}'`));
        await until(() => row().attempt_count >= 2);
        const beforeRestart = row();
        await restart(settings);
        await until(() => row().round_attempt_count === cap);
        if (failure === "completion") await until(() => row().status === "REVIEW_REQUIRED");
        else {
          // Even the error write is failing: reclaiming an expired lease must not call PG again at the cap.
          await delay(1500);
          assert.equal(row().status, "PROCESSING");
        }
        const capped = row(), calls = proxy.forId(paymentId).length;
        // A crash may consume a reserved attempt before its HTTP request leaves the process.
        assert.ok(calls > 0 && calls <= cap + (domain === "refund" && failure === "completion" ? 1 : 0));
        assert.equal(capped.attempt_count, cap); assert.equal(capped.round_attempt_count, cap);
        assert.equal(capped.execution_round, 1); assert.ok(capped.attempt_count >= beforeRestart.attempt_count);
        assert.equal(orderState(order.id), domain === "payment" ? "PAYMENT_PROCESSING" : "REFUND_PROCESSING");
        restore(); restore = null;
        await restart(settings);
        await until(() => row().status === "REVIEW_REQUIRED");
        await delay(1500);
        assert.equal(row().attempt_count, cap); assert.equal(row().round_attempt_count, cap);
        assert.equal(row().execution_round, 1); assert.equal(proxy.forId(paymentId).length, calls);
        assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), domain === "payment" ? "0" : "1");
        if (failure === "completion") {
          if (domain === "payment") {
            assert.equal(sql(`SELECT approval_executions FROM mock_pg_payments WHERE payment_id='${paymentId}'`), "1");
            assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${paymentId}'`), "0");
          } else {
            assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${paymentId}'`), "1");
            assert.equal(sql(`SELECT count(*) FROM admin_action_events e JOIN admin_actions a ON a.id=e.action_id
              WHERE a.order_id='${order.id}' AND e.status='SUCCEEDED'`), "0");
          }
        }
        console.log(`retry proof ${domain}/${failure}: round=1 attempts=${cap} no external calls after restart`);
      } finally {
        if (restore) restore();
        await restart(); await proxy.close();
      }
    });
  }
}

test("payment mock is disabled by default and disabled mode cannot accept new attempts", async () => {
  await restart({ MOCK_PG_ENABLED: "false" });
  const order = await newOrder();
  assert.equal((await alice.pay(order.id)).status, 503);
  assert.equal(orderState(order.id), "PENDING_PAYMENT");
  assert.equal((await pg(`/payments/${randomUUID()}`)).status, 404);
});

async function supplier(path, body) {
  return fetch(`http://127.0.0.1:${servicePort}/internal/mock-supplier${path}`, {
    method: body ? "POST" : "GET", headers: { "X-Gateway-Token": secret, Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
}

async function supplierNotify(result, valid = true) {
  const body = JSON.stringify(result);
  return fetch(base + "/webhooks/supplier", { method: "POST", body,
    headers: signedHeaders(body,"SUPPLIER",valid) });
}

function issuanceRow(orderId) {
  const value = sql(`SELECT row_to_json(j) FROM issuance_jobs j WHERE order_id='${orderId}' AND is_current`);
  return value ? JSON.parse(value) : null;
}

async function issueOrder(simulation = { scenario: "SUCCEED", callbackCopies: 1, callbackDelayMs: 0 }) {
  const order = await newOrder(), key = randomUUID();
  const response = await alice.pay(order.id, key, "APPROVE", { issuance: simulation });
  assert.equal(response.status, 202); const attempt = await response.json();
  await settled(order, attempt);
  assert.equal(orderState(order.id), "PAID");
  const job = issuanceRow(order.id); assert.ok(job, "approval and issuance job must commit together");
  return { order, attempt, job, key, simulation };
}

test("issuance settings validate bounds and freeze with the payment idempotency key", async () => {
  await restart();
  const order = await newOrder(), key = randomUUID();
  for (const simulation of [
    { scenario: "BAD", callbackCopies: 1, callbackDelayMs: 0 },
    { scenario: "SUCCEED", callbackCopies: -1, callbackDelayMs: 0 },
    { scenario: "SUCCEED", callbackCopies: 21, callbackDelayMs: 0 },
    { scenario: "SUCCEED", callbackCopies: 1, callbackDelayMs: -1 },
    { scenario: "SUCCEED", callbackCopies: 1, callbackDelayMs: 60001 },
    { scenario: "SUCCEED", callbackCopies: null, callbackDelayMs: 0 },
  ]) assert.equal((await alice.pay(order.id, randomUUID(), "APPROVE", { issuance: simulation })).status, 400);
  const issuance = { scenario: "SUCCEED", callbackCopies: 0, callbackDelayMs: 60000 };
  const response = await alice.pay(order.id, key, "APPROVE", { issuance });
  assert.equal(response.status, 202); const attempt = await response.json(); assert.deepEqual(attempt.issuance, issuance);
  assert.equal((await alice.pay(order.id, key, "APPROVE", { issuance })).status, 200);
  for (const changed of [{ ...issuance, scenario: "FAIL" }, { ...issuance, callbackCopies: 1 }, { ...issuance, callbackDelayMs: 0 }]) {
    assert.equal((await alice.pay(order.id, key, "APPROVE", { issuance: changed })).status, 409);
  }
  await settled(order, attempt);
  assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "1");
  assert.equal((await new Client().request(`/api/orders/${order.id}/issuance`)).status, 401);
  assert.equal((await bob.request(`/api/orders/${order.id}/issuance`)).status, 404);
  assert.equal((await fetch(base + "/internal/mock-supplier/orders/" + issuanceRow(order.id).id)).status, 404);
  const noAuth = await fetch(`http://127.0.0.1:${servicePort}/internal/mock-supplier/orders/${issuanceRow(order.id).id}`,
    { headers: { "X-Gateway-Token": secret } }); assert.equal(noAuth.status, 401);
});

test("issuance queued at payment approval survives browser closure and Service restart", async () => {
  await restart({ ISSUANCE_WORKER_DELAY_MS: "60000" });
  const { order } = await issueOrder();
  assert.equal(issuanceRow(order.id).status, "QUEUED");
  assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "0");
  await restart();
  // 이 뒤에는 고객 요청 없이 DB에 저장된 작업과 콜백만으로 발급된다.
  await until(() => issuanceRow(order.id).status === "ISSUED");
  assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "1");
  const result = await (await alice.request(`/api/orders/${order.id}/issuance`)).json();
  assert.equal(result.profile.installStatus, "ISSUED"); assert.match(result.profile.iccid, /^[0-9]{19,20}$/);
  assert.match(result.profile.activationCode, /^LPA:1\$/);
  assert.equal((await bob.request(`/api/sims/${result.profile.id}`)).status, 404);
  assert.equal((await alice.request(`/api/sims/${result.profile.id}`)).status, 200);
  const list = await (await alice.request("/api/sims")).json(); assert.ok(list.some(p => p.id === result.profile.id));
});

test("issuance delayed duplicate callbacks issue one profile and late acceptance cannot reverse it", async () => {
  await restart({ ISSUANCE_POLL_MS: "60000" });
  const { order, job } = await issueOrder({ scenario: "SUCCEED", callbackCopies: 20, callbackDelayMs: 2000 });
  await until(async () => (await (await supplier(`/orders/${job.id}`)).json()).status === "ISSUED");
  assert.equal(issuanceRow(order.id).status, "WAITING_CALLBACK");
  assert.equal((await (await supplier(`/orders/${job.id}/stats`)).json()).callbackSent, 0);
  await until(() => issuanceRow(order.id).status === "ISSUED");
  const result = await (await supplier(`/orders/${job.id}`)).json();
  const copies = await Promise.all(Array.from({ length: 20 }, () => supplierNotify(result)));
  await webhookCopies(copies);
  await until(async () => (await (await supplier(`/orders/${job.id}/stats`)).json()).callbackSent === 20);
  assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "1");
  assert.equal(sql(`SELECT count(*) FROM issuance_events WHERE event_id='${result.eventId}'`), "1");
  const stats = await (await supplier(`/orders/${job.id}/stats`)).json();
  assert.equal(stats.issueExecutions, 1); assert.equal(stats.requestCount, 1);
  assert.equal(stats.callbackFailures, 0);
  const stale = { ...result, eventId: randomUUID(), status: "ACCEPTED", revision: 1, iccid: null, activationCode: null };
  await webhookOutcome(supplierNotify(stale)); assert.equal(issuanceRow(order.id).status, "ISSUED");
  assert.equal((await supplierNotify(result, false)).status, 401);
  await webhookOutcome(supplierNotify({ ...result, orderId: randomUUID() }), 409);
  await webhookOutcome(supplierNotify({ ...result, eventId: randomUUID(), requestId: randomUUID() }), 404);
  await webhookOutcome(supplierNotify({ ...result, activationCode: "LPA:1$smdp.example$changed" }), 409);
  assert.equal((await supplierNotify({ ...result, revision: 2.5 })).status, 400);
  await webhookOutcome(supplierNotify({ ...result, eventId: randomUUID(), status: "FAILED", reason: "MOCK_ISSUANCE_FAILED",
    iccid: null, activationCode: null }), 409);
  assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "1");
});

test("issuance callback omission recovers by supplier lookup without a second issuance", async () => {
  await restart();
  const { order, job } = await issueOrder({ scenario: "SUCCEED", callbackCopies: 0, callbackDelayMs: 60000 });
  await until(() => issuanceRow(order.id).status === "ISSUED");
  assert.equal(sql(`SELECT count(*) FROM issuance_events WHERE issuance_id='${job.id}' AND source='LOOKUP' AND status='ISSUED'`), "1");
  const stats = await (await supplier(`/orders/${job.id}/stats`)).json();
  assert.equal(stats.callbackSent, 0); assert.equal(stats.issueExecutions, 1); assert.equal(stats.requestCount, 1);
});

test("issuance final failure without callback stays visible to customer and admin, never fabricates a profile", async () => {
  const { order, job } = await issueOrder({ scenario: "FAIL", callbackCopies: 0, callbackDelayMs: 0 });
  await until(() => issuanceRow(order.id).status === "FAILED");
  assert.equal(orderState(order.id), "PAID");
  assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "0");
  const view = await (await alice.request(`/api/orders/${order.id}/issuance`)).json();
  assert.equal(view.issuance.lastError, "MOCK_ISSUANCE_FAILED"); assert.equal(view.profile, null);
  const issues = await (await admin.request("/api/admin/orders?needsReview=true&size=100")).json();
  const flagged = issues.items.find(item => item.order.id === order.id);
  assert.ok(flagged); assert.equal(flagged.issuanceStatus, "FAILED"); assert.equal(flagged.issuanceError, "MOCK_ISSUANCE_FAILED");
  const detail = await (await admin.request(`/api/admin/orders/${order.id}`)).json();
  assert.equal(detail.issuance.issuance.status, "FAILED");
  const result = await (await supplier(`/orders/${job.id}`)).json();
  const repeats = await Promise.all(Array.from({ length: 20 }, () => supplierNotify(result)));
  await webhookCopies(repeats);
  assert.equal((await (await supplier(`/orders/${job.id}/stats`)).json()).issueExecutions, 0);
});

test("issuance supplier acceptance survives lost local acknowledgement and recovers using the same reference", async () => {
  await restart({ ISSUANCE_WORKER_DELAY_MS: "60000" });
  const { order, job, simulation } = await issueOrder({ scenario: "SUCCEED", callbackCopies: 0, callbackDelayMs: 0 });
  const accepted = await supplier("/orders", { requestId: job.id, orderId: order.id, simulation });
  assert.equal(accepted.status, 202); assert.equal((await accepted.json()).status, "ACCEPTED");
  sql(`UPDATE issuance_jobs SET status='PROCESSING',check_count=1,lease_token='${randomUUID()}',
    lease_until=clock_timestamp()-INTERVAL '1 second' WHERE id='${job.id}'`);
  await restart(); await until(() => issuanceRow(order.id).status === "ISSUED");
  const stats = await (await supplier(`/orders/${job.id}/stats`)).json();
  assert.equal(stats.requestCount, 1); assert.equal(stats.issueExecutions, 1);
  assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "1");
});

test("issuance job insertion failure rolls back paid state and the same PG result safely recovers", async () => {
  const order = await newOrder();
  sql("REVOKE INSERT ON issuance_jobs FROM alpha_media_app");
  let attempt;
  try {
    const response = await alice.pay(order.id); assert.equal(response.status, 202); attempt = await response.json();
    await until(async () => (await pg(`/payments/${attempt.id}`)).status === 200);
    await delay(300);
    assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
    assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "0");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "0");
  } finally { sql("GRANT INSERT ON issuance_jobs TO alpha_media_app"); }
  const result = await (await pg(`/payments/${attempt.id}`)).json();
  await webhookOutcome(notify(result));
  assert.equal(orderState(order.id), "PAID");
  await until(() => issuanceRow(order.id)?.status === "ISSUED");
  assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "1");
  assert.equal((await (await pg(`/payments/${attempt.id}/stats`)).json()).approvalExecutions, 1);
});

test("issuance supplier idempotency rejects changed settings and returns one supplier order", async () => {
  const { order, job, simulation } = await issueOrder({ scenario: "SUCCEED", callbackCopies: 0, callbackDelayMs: 0 });
  await until(() => issuanceRow(order.id).status === "ISSUED");
  const body = { requestId: job.id, orderId: order.id, simulation };
  const copies = await Promise.all(Array.from({ length: 20 }, () => supplier("/orders", body)));
  assert.ok(copies.every(r => r.status === 202));
  assert.equal(new Set((await Promise.all(copies.map(r => r.json()))).map(r => r.supplierOrderNo)).size, 1);
  assert.equal((await supplier("/orders", { ...body, simulation: { ...simulation, callbackCopies: 2 } })).status, 409);
  assert.equal((await (await supplier(`/orders/${job.id}/stats`)).json()).issueExecutions, 1);
});

test("issuance unknown supplier result stops after six checks and is visible for operator review", async () => {
  const unused = await port();
  await restart({ SUPPLIER_BASE_URL: `http://127.0.0.1:${unused}/unavailable`, ISSUANCE_POLL_MS: "200" });
  const { order } = await issueOrder();
  await until(() => issuanceRow(order.id).status === "REVIEW_REQUIRED");
  const job = issuanceRow(order.id);
  assert.equal(job.check_count, 6); assert.equal(job.consecutive_failures, 6);
  assert.equal(job.last_error, "SUPPLIER_RETRY_LIMIT_REACHED");
  assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "0");
  const issues = await (await admin.request("/api/admin/orders?needsReview=true&size=100")).json();
  assert.ok(issues.items.some(item => item.order.id === order.id));
  await restart();
});

test("retry policy issuance ACCEPTED polls do not consume failures and retain the two-minute deadline through restart", { timeout: 45000 }, async () => {
  const proxy = await providerProxy("mock-supplier");
  const settings = { SUPPLIER_BASE_URL: proxy.url, ISSUANCE_POLL_MS: "200", SUPPLIER_COMPLETION_DELAY_MS: "600000" };
  try {
    await restart(settings);
    const { order, job } = await issueOrder({ scenario: "SUCCEED", callbackCopies: 0, callbackDelayMs: 0 });
    let waiting;
    await until(() => {
      waiting = issuanceRow(order.id);
      return waiting.check_count >= 8 && waiting.status === "WAITING_CALLBACK";
    });
    assert.equal(waiting.consecutive_failures, 0); assert.equal(waiting.submission_count, 1);
    assert.ok(waiting.waiting_since); assert.equal(waiting.execution_round, 1);
    proxy.intercept = call => call.path.endsWith(`/orders/${job.id}`) ? { status: 503 } : null;
    await until(() => {
      const failed = issuanceRow(order.id);
      return failed.consecutive_failures >= 2 && failed.status === "WAITING_CALLBACK";
    });
    proxy.intercept = null;
    await until(() => {
      const recovered = issuanceRow(order.id);
      return recovered.status === "WAITING_CALLBACK" && recovered.consecutive_failures === 0;
    });
    await restart(settings);
    await until(() => issuanceRow(order.id).status === "WAITING_CALLBACK");
    assert.equal(issuanceRow(order.id).waiting_since, waiting.waiting_since);
    assert.ok(issuanceRow(order.id).check_count > waiting.check_count);
    // Advance only the persisted deadline; there is no need to sleep for two minutes.
    sql(`UPDATE issuance_jobs SET waiting_since=clock_timestamp()-INTERVAL '121 seconds',
      next_check_at=clock_timestamp() WHERE id='${job.id}'`);
    await until(() => issuanceRow(order.id).status === "REVIEW_REQUIRED");
    assert.equal(issuanceRow(order.id).last_error, "SUPPLIER_PENDING_TOO_LONG");
    assert.equal(issuanceRow(order.id).consecutive_failures, 0);
    assert.equal(issuanceRow(order.id).submission_count, 1);
    const calls = proxy.forId(job.id).length;
    await restart(settings); await delay(1000);
    assert.equal(proxy.forId(job.id).length, calls);
    assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "0");
  } finally { await restart(); await proxy.close(); }
});

test("retry policy issuance submissions stop at six even when ACCEPTED keeps resetting communication failures", { timeout: 45000 }, async () => {
  const proxy = await providerProxy("mock-supplier");
  const settings = { SUPPLIER_BASE_URL: proxy.url, ISSUANCE_POLL_MS: "300", SUPPLIER_COMPLETION_DELAY_MS: "600000" };
  try {
    proxy.intercept = call => call.method === "GET" && /\/orders\/[^/]+$/.test(call.path) ? { status: 404 } : null;
    await restart(settings);
    const { order, job } = await issueOrder({ scenario: "SUCCEED", callbackCopies: 0, callbackDelayMs: 0 });
    await until(() => Number(sql(`SELECT request_count FROM mock_supplier_orders WHERE request_id='${job.id}'`)) >= 3);
    await restart(settings);
    await until(() => issuanceRow(order.id).status === "REVIEW_REQUIRED");
    const reviewed = issuanceRow(order.id);
    assert.equal(reviewed.submission_count, 6); assert.equal(reviewed.execution_round, 1);
    assert.equal(reviewed.last_error, "SUPPLIER_SUBMISSION_LIMIT_REACHED");
    assert.equal(proxy.forId(job.id).filter(c => c.method === "POST").length, 6);
    assert.equal(sql(`SELECT request_count FROM mock_supplier_orders WHERE request_id='${job.id}'`), "6");
    const calls = proxy.forId(job.id).length;
    await restart(settings); await delay(1000);
    assert.equal(proxy.forId(job.id).length, calls);
    assert.equal(issuanceRow(order.id).submission_count, 6);
  } finally { await restart(); await proxy.close(); }
});

test("retry policy issuance DB acknowledgement failures exhaust durable failure reservations without resubmission", { timeout: 45000 }, async () => {
  const proxy = await providerProxy("mock-supplier");
  const settings = { SUPPLIER_BASE_URL: proxy.url, ISSUANCE_LEASE_MS: "1200", SUPPLIER_COMPLETION_DELAY_MS: "600000" };
  let restore;
  try {
    await restart({ ...settings, ISSUANCE_WORKER_DELAY_MS: "60000" });
    const { order, job } = await issueOrder({ scenario: "SUCCEED", callbackCopies: 0, callbackDelayMs: 0 });
    restore = rejectTransitions("issuance_jobs", order.id, ["WAITING_CALLBACK", "ISSUED", "FAILED"]);
    await restart(settings);
    await until(() => issuanceRow(order.id).consecutive_failures >= 2);
    await restart(settings);
    await until(() => issuanceRow(order.id).status === "REVIEW_REQUIRED");
    assert.equal(issuanceRow(order.id).consecutive_failures, 6);
    assert.equal(issuanceRow(order.id).check_count, 6); assert.equal(issuanceRow(order.id).submission_count, 1);
    assert.equal(sql(`SELECT count(*) FROM issuance_events WHERE issuance_id='${job.id}'`), "0");
    const calls = proxy.forId(job.id).length;
    restore(); restore = null;
    await restart(settings); await delay(1000);
    assert.equal(proxy.forId(job.id).length, calls);
    assert.equal(sql(`SELECT request_count FROM mock_supplier_orders WHERE request_id='${job.id}'`), "1");
    assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "0");
  } finally { if (restore) restore(); await restart(); await proxy.close(); }
});

async function failedOrder() {
  const data = await issueOrder({ scenario: "FAIL", callbackCopies: 0, callbackDelayMs: 0 });
  await until(() => issuanceRow(data.order.id).status === "FAILED");
  return data;
}
function refundRow(orderId) {
  const row = sql(`SELECT row_to_json(r) FROM refunds r WHERE order_id='${orderId}'`);
  return row ? JSON.parse(row) : null;
}
async function adminAction(orderId, type, body, key = randomUUID(), client = admin) {
  return client.request(`/api/admin/orders/${orderId}/${type}`, { method: "POST",
    headers: { ...await client.csrf(), "Idempotency-Key": key }, body });
}
function refundRequest(job, scenario = "SUCCESS") { return { issuanceId: job.id, reason: "발급 실패 고객 전액 환불", scenario }; }
function retryRequest(job, scenario = "SUCCEED") {
  return { issuanceId: job.id, reason: "공급사 오류 확인 후 재발급", simulation: { scenario, callbackCopies: 3, callbackDelayMs: 100 } };
}

async function contradictoryIssuedResult(order, job) {
  const actual = await (await supplier(`/orders/${job.id}`)).json();
  const issued = await issueOrder({ scenario: "SUCCEED", callbackCopies: 0, callbackDelayMs: 0 });
  await until(() => issuanceRow(issued.order.id).status === "ISSUED");
  const profile = await (await supplier(`/orders/${issued.job.id}`)).json();
  return { ...actual, eventId: randomUUID(), orderId: order.id, status: "ISSUED", reason: null,
    iccid: profile.iccid, activationCode: profile.activationCode };
}

test("conflict policy terminal supplier contradiction is durable deduplicated and blocks both administrator actions", { timeout: 45000 }, async () => {
  const { order, job } = await failedOrder();
  const contradiction = await contradictoryIssuedResult(order, job);
  assert.equal((await supplierNotify(contradiction, false)).status, 401);
  assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${order.id}'`), "0");
  const responses = await Promise.all(Array.from({ length: 20 }, () => supplierNotify(contradiction)));
  await webhookCopies(responses, 409);
  assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${order.id}'`), "1");
  assert.equal(issuanceRow(order.id).status, "FAILED");
  assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "0");
  for (const client of [admin, await member("admin2")]) {
    assert.equal((await adminAction(order.id, "refunds", refundRequest(job), randomUUID(), client)).status, 409);
    assert.equal((await adminAction(order.id, "issuance-retries", retryRequest(job), randomUUID(), client)).status, 409);
  }
  const detail = await (await admin.request(`/api/admin/orders/${order.id}`)).json();
  assert.equal(detail.conflicts.length, 1);
  assert.equal(detail.conflicts[0].target, "ISSUANCE"); assert.equal(detail.conflicts[0].targetId, job.id);
  assert.equal(detail.conflicts[0].expectedStatus, "FAILED"); assert.equal(detail.conflicts[0].observedStatus, "ISSUED");
  assert.ok(detail.timeline.items.some(e => e.target === "CONFLICT"));
  await restart();
  await webhookOutcome(supplierNotify(contradiction), 409);
  assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${order.id}'`), "1");
  assert.equal((await adminAction(order.id, "refunds", refundRequest(job))).status, 409);
  assert.equal((await adminAction(order.id, "issuance-retries", retryRequest(job))).status, 409);
  assert.equal(sql(`SELECT count(*) FROM admin_actions WHERE order_id='${order.id}'`), "0");
  assert.equal(sql(`SELECT count(*) FROM order_history WHERE order_id='${order.id}' AND target='CONFLICT'`), "1");
  sql(`UPDATE order_conflicts SET code='HIDDEN' WHERE order_id='${order.id}'`, true, true);
  sql(`DELETE FROM order_conflicts WHERE order_id='${order.id}'`, true, true);
});

test("conflict policy signed contradictory payment result blocks new charges after decline and survives restart", async () => {
  const order = await newOrder(), attempt = await (await alice.pay(order.id, randomUUID(), "DECLINE")).json();
  await settled(order, attempt, "DECLINED");
  const result = await (await pg(`/payments/${attempt.id}`)).json();
  const contradiction = { ...result, eventId: randomUUID(), status: "APPROVED", declineCode: null,
    transactionId: `contradictory_${randomUUID()}` };
  assert.equal((await notify(contradiction, false)).status, 401);
  assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${order.id}'`), "0");
  await webhookOutcome(notify(contradiction), 409);
  await webhookOutcome(notify(contradiction), 409);
  assert.equal(orderState(order.id), "PENDING_PAYMENT");
  assert.equal((await alice.pay(order.id)).status, 409);
  await restart();
  assert.equal((await alice.pay(order.id)).status, 409);
  assert.equal(sql(`SELECT count(*) FROM payment_attempts WHERE order_id='${order.id}'`), "1");
  assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${order.id}'`), "1");
  assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "0");
  const issues = await (await admin.request("/api/admin/orders?needsReview=true&size=100")).json();
  assert.ok(issues.items.some(item => item.order.id === order.id));
});

test("conflict policy mismatched callback order ID quarantines the referenced payment or issuance, not an unrelated order", async () => {
  for (const target of ["PAYMENT", "ISSUANCE"]) {
    const { order, job, attempt } = await failedOrder(), unrelated = await newOrder();
    const result = target === "PAYMENT" ? await (await pg(`/payments/${attempt.id}`)).json()
      : await (await supplier(`/orders/${job.id}`)).json();
    const notifyResult = target === "PAYMENT" ? notify : supplierNotify;
    await webhookOutcome(notifyResult({ ...result, orderId: unrelated.id }), 409);
    assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${order.id}' AND target='${target}'`), "1");
    assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${unrelated.id}'`), "0");
    assert.equal((await adminAction(order.id, "refunds", refundRequest(job))).status, 409);
    assert.equal((await adminAction(order.id, "issuance-retries", retryRequest(job))).status, 409);
    const payable = await alice.pay(unrelated.id, randomUUID(), "DECLINE");
    assert.equal(payable.status, 202); await settled(unrelated, await payable.json(), "DECLINED");
  }
});

test("conflict policy reused PG transaction reference quarantines an unresolved payment without issuing another SIM", async () => {
  const original = await newOrder(), paid = await (await alice.pay(original.id)).json();
  await settled(original, paid);
  const approved = await (await pg(`/payments/${paid.id}`)).json();
  await restart({ PAYMENT_WORKER_DELAY_MS: "60000" });
  try {
    const order = await newOrder(), queued = await (await alice.pay(order.id)).json();
    assert.equal(queued.status, "QUEUED");
    const collision = { ...approved, eventId: randomUUID(), orderId: order.id, paymentId: queued.id };
    await webhookOutcome(notify(collision), 409);
    await webhookOutcome(notify(collision), 409);
    assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${order.id}' AND code='PG_TRANSACTION_CONFLICT'`), "1");
    assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${original.id}'`), "0");
    assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${queued.id}'`), "0");
    assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "0");
  } finally { await restart(); }
});

test("conflict policy reused supplier ICCID quarantines a queued issuance without inserting a duplicate profile", async () => {
  const original = await issueOrder({ scenario: "SUCCEED", callbackCopies: 0, callbackDelayMs: 0 });
  await until(() => issuanceRow(original.order.id).status === "ISSUED");
  const issued = await (await supplier(`/orders/${original.job.id}`)).json();
  await restart({ ISSUANCE_WORKER_DELAY_MS: "60000" });
  try {
    const { order, job } = await issueOrder({ scenario: "SUCCEED", callbackCopies: 0, callbackDelayMs: 0 });
    assert.equal(issuanceRow(order.id).status, "QUEUED");
    const collision = { ...issued, eventId: randomUUID(), orderId: order.id, requestId: job.id,
      supplierOrderNo: `supplier_${job.id}` };
    await webhookOutcome(supplierNotify(collision), 409);
    await webhookOutcome(supplierNotify(collision), 409);
    assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${order.id}' AND code='SUPPLIER_REFERENCE_CONFLICT'`), "1");
    assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${original.order.id}'`), "0");
    assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "0");
    assert.equal(sql(`SELECT count(*) FROM issuance_events WHERE issuance_id='${job.id}'`), "0");
    assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE iccid='${issued.iccid}'`), "1");
  } finally { await restart(); }
});

test("conflict policy quarantines a queued refund before the external cancellation can execute", async () => {
  const { order, job, attempt } = await failedOrder();
  const contradiction = await contradictoryIssuedResult(order, job);
  await restart({ PAYMENT_WORKER_DELAY_MS: "60000" });
  try {
    assert.equal((await adminAction(order.id, "refunds", refundRequest(job))).status, 202);
    assert.equal(refundRow(order.id).status, "REQUESTED");
    await webhookOutcome(supplierNotify(contradiction), 409);
    await restart();
    await until(() => refundRow(order.id).status === "REVIEW_REQUIRED");
    assert.equal(orderState(order.id), "REFUND_PROCESSING");
    assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${attempt.id}'`), "0");
    assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "0");
  } finally { await restart(); }
});

for (const domain of ["payment", "refund"]) {
  test(`conflict policy ${domain} rechecks quarantine after a blocked lookup before sending a provider write`, { timeout: 45000 }, async () => {
    const data = domain === "payment" ? { order: await newOrder() } : await failedOrder();
    const { order } = data, proxy = await providerProxy("mock-pg");
    let paymentId = data.attempt?.id, lookupEntered = false, releaseLookup;
    const blockedLookup = new Promise(resolve => { releaseLookup = resolve; });
    proxy.intercept = async call => {
      if (domain === "payment" && call.method === "POST" && call.body?.orderId === order.id) return { status: 503 };
      if (call.method === "GET" && paymentId && call.path.includes(`/payments/${paymentId}`)) {
        lookupEntered = true;
        await blockedLookup;
        return { status: 404 };
      }
      return null;
    };
    try {
      await restart({ MOCK_PG_BASE_URL: proxy.url, PG_HTTP_TIMEOUT_MS: "5000", PAYMENT_LEASE_MS: "12000" });
      const response = domain === "payment" ? await alice.pay(order.id)
        : await adminAction(order.id, "refunds", refundRequest(data.job));
      assert.equal(response.status, 202);
      if (domain === "payment") paymentId = (await response.json()).id;
      await until(() => lookupEntered, 10000);
      const writesBeforeConflict = proxy.forId(paymentId).filter(c => c.method === "POST").length;
      assert.equal(writesBeforeConflict, domain === "payment" ? 1 : 0);
      await webhookOutcome(notify({ eventId: randomUUID(), paymentId, orderId: order.id, amount: 1,
        currency: "KRW", status: "APPROVED", transactionId: `conflicting_${randomUUID()}`, declineCode: null }), 409);
      assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${order.id}'`), "1");
      releaseLookup();
      const row = () => domain === "payment"
        ? JSON.parse(sql(`SELECT row_to_json(p) FROM payment_attempts p WHERE id='${paymentId}'`)) : refundRow(order.id);
      await until(() => row().status === "REVIEW_REQUIRED");
      assert.equal(row().last_error, "ORDER_RESULT_CONFLICT");
      assert.equal(proxy.forId(paymentId).filter(c => c.method === "POST").length, writesBeforeConflict);
      const externalTable = domain === "payment" ? "mock_pg_payments" : "mock_pg_cancellations";
      assert.equal(sql(`SELECT count(*) FROM ${externalTable} WHERE payment_id='${paymentId}'`), "0");
      assert.equal(orderState(order.id), domain === "payment" ? "PAYMENT_PROCESSING" : "REFUND_PROCESSING");
    } finally { releaseLookup(); await restart(); await proxy.close(); }
  });
}

test("refund admin actions require administrator, CSRF, reason and a confirmed current failure", async () => {
  const { order, job } = await failedOrder(), body = refundRequest(job);
  assert.equal((await adminAction(order.id,"refunds",body,randomUUID(),new Client())).status,401);
  assert.equal((await adminAction(order.id,"refunds",body,randomUUID(),alice)).status,403);
  assert.equal((await adminAction(order.id,"issuance-retries",retryRequest(job),randomUUID(),bob)).status,403);
  assert.equal((await admin.request(`/api/admin/orders/${order.id}/refunds`, { method: "POST", body,
    headers: { "Idempotency-Key": randomUUID() } })).status,403);
  for (const invalid of [{ ...body, reason: " " }, { ...body, reason: "x".repeat(301) }, { ...body, scenario: "INVALID" }, { ...body, issuanceId: null }]) {
    assert.equal((await adminAction(order.id,"refunds",invalid)).status,400);
  }
  assert.equal((await adminAction(randomUUID(),"refunds",body)).status,404);
  const issued = await issueOrder(); await until(() => issuanceRow(issued.order.id).status === "ISSUED");
  assert.equal((await adminAction(issued.order.id,"refunds",refundRequest(issued.job))).status,202);
  assert.equal((await adminAction(issued.order.id,"issuance-retries",retryRequest(issued.job))).status,409);
  const pending = await newOrder();
  assert.equal((await adminAction(pending.id,"refunds",body)).status,409);
  sql(`UPDATE issuance_jobs SET status='REVIEW_REQUIRED' WHERE id='${job.id}'`);
  assert.equal((await adminAction(order.id,"refunds",body)).status,409);
  assert.equal((await adminAction(order.id,"issuance-retries",retryRequest(job))).status,409);
});

test("refund twenty simultaneous identical requests cancel once and retain one immutable audit action", async () => {
  const { order, job, attempt } = await failedOrder(), key = randomUUID(), body = { ...refundRequest(job), amount: order.amount, currency: "USD", actor: "customer2" };
  const headers = { ...await admin.csrf(), "Idempotency-Key": key };
  const responses = await Promise.all(Array.from({ length: 20 }, () => admin.request(`/api/admin/orders/${order.id}/refunds`, { method: "POST", headers, body })));
  assert.equal(responses.filter(r => r.status === 202).length,1);
  assert.equal(responses.filter(r => r.status === 200).length,19);
  assert.equal(new Set((await Promise.all(responses.map(r => r.json()))).map(r => r.action.id)).size,1);
  await until(() => refundRow(order.id)?.status === "SUCCEEDED");
  assert.equal(orderState(order.id),"REFUNDED");
  assert.equal((await (await alice.request(`/api/orders/${order.id}`)).json()).status,"REFUNDED");
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${attempt.id}'`),"1");
  assert.equal(sql(`SELECT cancelled_amount FROM mock_pg_payments WHERE payment_id='${attempt.id}'`),String(order.amount));
  const replay = await adminAction(order.id,"refunds",body,key); assert.equal(replay.status,200);
  assert.equal(replay.headers.get("Idempotency-Replayed"),"true");
  for (const changed of [{ ...body, reason: "다른 사유" }, { ...body, scenario: "RESPONSE_LOST" }]) {
    assert.equal((await adminAction(order.id,"refunds",changed,key)).status,409);
  }
  assert.equal((await adminAction(order.id,"issuance-retries",retryRequest(job),key)).status,409);
  const detail = await (await admin.request(`/api/admin/orders/${order.id}`)).json();
  assert.equal(detail.actions.length,1); assert.equal(detail.actions[0].actor,"admin");
  assert.equal(detail.actions[0].payloadHash,undefined); assert.equal(detail.actions[0].reason,body.reason);
  assert.deepEqual(detail.actionEvents.map(e => e.status),["REQUESTED","SUCCEEDED"]);
  const issues = await (await admin.request("/api/admin/orders?needsReview=true&size=100")).json();
  assert.ok(!issues.items.some(i => i.order.id===order.id));
  sql(`UPDATE admin_actions SET reason='tamper' WHERE order_id='${order.id}'`,true,true);
  sql(`DELETE FROM admin_action_events WHERE action_id='${detail.actions[0].id}'`,true,true);
  assert.equal((await alice.pay(order.id)).status,409);
});

test("refund different keys and a simultaneous issuance retry cannot produce two operations", async () => {
  for (const mix of [false,true]) {
    const { order, job } = await failedOrder();
    const results = await Promise.all(Array.from({ length: 12 }, (_,i) => adminAction(order.id,
      mix && i%2 ? "issuance-retries":"refunds",mix && i%2 ? retryRequest(job):refundRequest(job))));
    assert.equal(results.filter(r => r.status===202).length,1);
    assert.equal(results.filter(r => r.status===409).length,11);
    assert.equal(sql(`SELECT count(*) FROM admin_actions WHERE order_id='${order.id}'`),"1");
    await until(() => orderState(order.id)==="REFUNDED" || issuanceRow(order.id).status==="ISSUED");
    assert.ok(!(refundRow(order.id) && sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`)!=="0"));
  }
});

test("refund issuance retry preserves failed attempts and ignores old callbacks without duplicate profiles", async () => {
  const { order, job } = await failedOrder();
  const oldResult = await (await supplier(`/orders/${job.id}`)).json();
  const key=randomUUID(), body=retryRequest(job,"FAIL");
  const headers={ ...await admin.csrf(),"Idempotency-Key":key };
  const responses=await Promise.all(Array.from({ length:20 },()=>admin.request(`/api/admin/orders/${order.id}/issuance-retries`,{ method:"POST",headers,body })));
  assert.equal(responses.filter(r=>r.status===202).length,1); assert.equal(responses.filter(r=>r.status===200).length,19);
  await until(()=>issuanceRow(order.id).id!==job.id && issuanceRow(order.id).status==="FAILED");
  assert.equal((await adminAction(order.id,"issuance-retries",body,key)).status,200);
  assert.equal((await adminAction(order.id,"issuance-retries",body)).status,409);
  await webhookOutcome(supplierNotify(oldResult));
  const second=issuanceRow(order.id), last=await adminAction(order.id,"issuance-retries",retryRequest(second));
  assert.equal(last.status,202);
  await until(()=>issuanceRow(order.id).status==="ISSUED");
  await webhookOutcome(supplierNotify(oldResult));
  assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`),"3");
  assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`),"1");
  assert.equal(sql(`SELECT sum(issue_executions) FROM mock_supplier_orders WHERE order_id='${order.id}'`),"1");
  const detail=await (await admin.request(`/api/admin/orders/${order.id}`)).json();
  assert.equal(detail.actions.length,2);
  assert.equal(detail.actionEvents.filter(e=>e.status==="FAILED").length,1);
  assert.equal(detail.actionEvents.filter(e=>e.status==="ISSUED").length,1);
});

test("refund cancellation response loss reconciles the same refund reference with exactly one PG cancellation", async () => {
  const { order, job, attempt }=await failedOrder();
  const r=await adminAction(order.id,"refunds",refundRequest(job,"RESPONSE_LOST")); assert.equal(r.status,202);
  await until(()=>refundRow(order.id)?.status==="SUCCEEDED");
  const refund=refundRow(order.id); assert.equal(refund.attempt_count,2);
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${attempt.id}' AND idempotency_key='${refund.id}'`),"1");
  assert.equal(orderState(order.id),"REFUNDED");
  const detail=await (await admin.request(`/api/admin/orders/${order.id}`)).json();
  assert.deepEqual(detail.actionEvents.map(e=>e.status),["REQUESTED","UNKNOWN","SUCCEEDED"]);
  const old=await (await supplier(`/orders/${job.id}`)).json();
  await webhookOutcome(supplierNotify(old));
  await webhookOutcome(notify(await (await pg(`/payments/${attempt.id}`)).json()));
  assert.equal(orderState(order.id),"REFUNDED");
});

test("refund queued work survives server restart and discarded intake response", async () => {
  const { order, job, attempt }=await failedOrder();
  await restart({ PAYMENT_WORKER_DELAY_MS:"60000" });
  const key=randomUUID(), body=refundRequest(job), response=await adminAction(order.id,"refunds",body,key);
  assert.equal(response.status,202); await response.body.cancel();
  assert.equal(refundRow(order.id).status,"REQUESTED");
  await restart();
  assert.equal((await adminAction(order.id,"refunds",body,key)).status,200);
  await until(()=>orderState(order.id)==="REFUNDED");
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${attempt.id}'`),"1");
});

test("refund PG outage stops after three attempts, blocks reissue and remains in operator issues", async () => {
  const { order, job, attempt }=await failedOrder(), key=randomUUID(), body=refundRequest(job,"UNAVAILABLE");
  assert.equal((await adminAction(order.id,"refunds",body,key)).status,202);
  await until(()=>refundRow(order.id)?.status==="REVIEW_REQUIRED");
  const refund=refundRow(order.id); assert.equal(refund.attempt_count,3); assert.equal(orderState(order.id),"REFUND_PROCESSING");
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${attempt.id}'`),"0");
  assert.equal((await adminAction(order.id,"refunds",body,key)).status,200);
  assert.equal((await adminAction(order.id,"refunds",body)).status,409);
  assert.equal((await adminAction(order.id,"issuance-retries",retryRequest(job))).status,409);
  const issues=await (await admin.request("/api/admin/orders?needsReview=true&size=100")).json();
  assert.ok(issues.items.some(i=>i.order.id===order.id));
  await delay(1000); assert.equal(refundRow(order.id).attempt_count,3);
});

test("refund DB completion failure recovers PG cancellation after lease expiry without losing audit or double refund", async () => {
  const { order, job, attempt }=await failedOrder();
  sql(`CREATE FUNCTION reject_refund_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.status='SUCCEEDED' THEN RAISE EXCEPTION 'simulated database failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_refund_completion BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION reject_refund_completion();`);
  try {
    assert.equal((await adminAction(order.id,"refunds",refundRequest(job))).status,202);
    await until(()=>sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${attempt.id}'`)==="1");
    assert.equal(orderState(order.id),"REFUND_PROCESSING");
    assert.equal(sql(`SELECT count(*) FROM admin_action_events e JOIN admin_actions a ON a.id=e.action_id WHERE a.order_id='${order.id}' AND e.status='SUCCEEDED'`),"0");
  } finally { sql("DROP TRIGGER reject_refund_completion ON refunds; DROP FUNCTION reject_refund_completion();"); }
  await until(()=>refundRow(order.id).status==="SUCCEEDED");
  assert.equal(orderState(order.id),"REFUNDED");
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${attempt.id}'`),"1");
});

test("refund intake and audit are atomic and preexisting partial cancellation cannot over-refund", async () => {
  const { order, job, attempt }=await failedOrder(), body=refundRequest(job), key=randomUUID();
  sql("REVOKE INSERT ON admin_action_events FROM alpha_media_app");
  try {
    assert.equal((await adminAction(order.id,"issuance-retries",retryRequest(job))).status,500);
    assert.equal(issuanceRow(order.id).id,job.id);
    assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`),"1");
    assert.equal((await adminAction(order.id,"refunds",body,key)).status,500);
  }
  finally { sql("GRANT INSERT ON admin_action_events TO alpha_media_app"); }
  assert.equal(refundRow(order.id),null); assert.equal(orderState(order.id),"PAID");
  assert.equal(sql(`SELECT count(*) FROM admin_actions WHERE order_id='${order.id}'`),"0");
  assert.equal((await pg(`/payments/${attempt.id}/cancel`,{ amount:100 })).status,200);
  assert.equal((await adminAction(order.id,"refunds",body,key)).status,202);
  await until(()=>refundRow(order.id)?.status==="REVIEW_REQUIRED");
  assert.equal(sql(`SELECT cancelled_amount FROM mock_pg_payments WHERE payment_id='${attempt.id}'`),"100");
  assert.equal(orderState(order.id),"REFUND_PROCESSING");
});

test("refund mismatched PG cancellation identifiers or amounts never mark an order refunded", async () => {
  const { order, job, attempt }=await failedOrder();
  const fake=createHttpServer((request,response) => {
    const refund=refundRow(order.id);
    response.writeHead(200,{ "Content-Type":"application/json" });
    response.end(JSON.stringify({ id:randomUUID(),paymentId:randomUUID(),idempotencyKey:refund?.id,
      amount:1,cancelledTotal:1 }));
  });
  fake.listen(0,"127.0.0.1"); await once(fake,"listening");
  try {
    await restart({ MOCK_PG_BASE_URL:`http://127.0.0.1:${fake.address().port}/internal/mock-pg` });
    assert.equal((await adminAction(order.id,"refunds",refundRequest(job))).status,202);
    await until(()=>refundRow(order.id)?.status==="REVIEW_REQUIRED");
    assert.equal(orderState(order.id),"REFUND_PROCESSING");
    assert.equal(refundRow(order.id).pg_cancellation_id,null);
    assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${attempt.id}'`),"0");
  } finally {
    fake.closeAllConnections(); await new Promise(resolve=>fake.close(resolve)); await restart();
  }
});

async function trackingProfile() {
  const data = await issueOrder();
  await until(() => issuanceRow(data.order.id)?.status === "ISSUED");
  const profile = JSON.parse(sql(`SELECT row_to_json(p) FROM sim_profiles p WHERE order_id='${data.order.id}'`));
  return { ...data, profile };
}
async function trackingView(profile, client = alice) {
  const response = await client.request(`/api/sims/${profile.id}/tracking`);
  assert.equal(response.status, 200); return response.json();
}
async function trackingChange(profile, body, key = randomUUID(), client = alice) {
  return client.request(`/api/sims/${profile.id}/simulation`, { method: "POST", body,
    headers: { ...await client.csrf(), "Idempotency-Key": key } });
}
async function profileNotify(signal, valid = true) {
  const body = JSON.stringify(signal);
  return fetch(base + "/webhooks/supplier/profiles", { method: "POST", body,
    headers: signedHeaders(body,"SUPPLIER",valid) });
}
const installedChange = { state: "INSTALLED", activatedAt: null, callbackCopies: 1, callbackDelayMs: 0 };

for (const source of ["SUPPLIER", "PROFILE"]) {
  test(`webhook inbox ${source.toLowerCase()} callback survives queued receipt restart and applies one event`, { timeout: 60000 }, async () => {
    let order, job, profile, result;
    try {
      if (source === "SUPPLIER") {
        await restart({ ISSUANCE_WORKER_DELAY_MS: "60000", WEBHOOK_WORKER_DELAY_MS: "60000" });
        ({ order, job } = await issueOrder({ scenario: "SUCCEED", callbackCopies: 0, callbackDelayMs: 0 }));
        sql(`UPDATE issuance_jobs SET next_check_at=clock_timestamp()+INTERVAL '5 minutes' WHERE id='${job.id}'`);
        await restart({ WEBHOOK_WORKER_DELAY_MS: "60000" });
        assert.equal((await supplier("/orders", { requestId: job.id, orderId: order.id,
          simulation: { scenario: "SUCCEED", callbackCopies: 0, callbackDelayMs: 0 } })).status, 202);
        await until(async () => (await (await supplier(`/orders/${job.id}`)).json()).status === "ISSUED");
        result = await (await supplier(`/orders/${job.id}`)).json();
      } else {
        ({ order, profile } = await trackingProfile());
        sql(`UPDATE sim_profiles SET next_sync_at=clock_timestamp()+INTERVAL '5 minutes' WHERE id='${profile.id}'`);
        await restart({ WEBHOOK_WORKER_DELAY_MS: "60000" });
        const changed = await trackingChange(profile, { ...installedChange, callbackCopies: 0 });
        assert.equal(changed.status, 200); result = await changed.json();
      }
      const receive = source === "SUPPLIER" ? supplierNotify : profileNotify;
      const response = await receive(result); assert.equal(response.status, 202); const receipt = await response.json();
      assert.equal(receipt.source, source); assert.equal(inboundRow(receipt.id).status, "PENDING");
      const duplicate = await receive(result); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).id, receipt.id);
      await restart({ ISSUANCE_WORKER_DELAY_MS: "60000" });
      await until(() => inboundRow(receipt.id).status === "PROCESSED");
      assert.equal(inboundRow(receipt.id).attempt_count, 1);
      if (source === "SUPPLIER") {
        assert.equal(issuanceRow(order.id).status, "ISSUED");
        assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "1");
        assert.equal(sql(`SELECT source FROM issuance_events WHERE event_id='${result.eventId}'`), "CALLBACK");
        assert.equal((await (await supplier(`/orders/${job.id}/stats`)).json()).issueExecutions, 1);
      } else {
        assert.equal((await trackingView(profile)).profile.installStatus, "INSTALLED");
        assert.equal(sql(`SELECT count(*) FROM sim_profile_events WHERE event_id='${result.eventId}' AND source='CALLBACK'`), "1");
      }
    } finally { await restart(); }
  });
}

test("webhook inbox retries a profile callback received before issuance and resolves after the supplier callback creates the SIM", { timeout: 60000 }, async () => {
  await restart({ ISSUANCE_WORKER_DELAY_MS: "60000", WEBHOOK_RETRY_BASE_MS: "1000" });
  try {
    const simulation = { scenario: "SUCCEED", callbackCopies: 0, callbackDelayMs: 0 };
    const { order, job } = await issueOrder(simulation);
    sql(`UPDATE issuance_jobs SET next_check_at=clock_timestamp()+INTERVAL '5 minutes' WHERE id='${job.id}'`);
    await restart({ WEBHOOK_RETRY_BASE_MS: "1000" });
    assert.equal((await supplier("/orders", { requestId: job.id, orderId: order.id, simulation })).status, 202);
    await until(async () => (await (await supplier(`/orders/${job.id}`)).json()).status === "ISSUED");
    const issued = await (await supplier(`/orders/${job.id}`)).json();
    await until(async () => (await supplier(`/profiles/${issued.iccid}`)).status === 200);
    const changed = await fetch(`http://127.0.0.1:${servicePort}/internal/mock-supplier/profiles/${issued.iccid}/simulate`, {
      method: "POST", headers: { "X-Gateway-Token": secret, Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ ...installedChange, callbackCopies: 0 }), signal: AbortSignal.timeout(5000),
    });
    assert.equal(changed.status, 200); const signal = await changed.json();
    await restart({ ISSUANCE_WORKER_DELAY_MS: "60000", WEBHOOK_RETRY_BASE_MS: "1000" });
    const response = await profileNotify(signal); assert.equal(response.status, 202); const receipt = await response.json();
    await until(() => inboundRow(receipt.id).status === "RETRY");
    assert.equal(inboundRow(receipt.id).last_error, "SIM_NOT_FOUND");
    assert.equal(inboundRow(receipt.id).error_status, 404);
    assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "0");
    await webhookOutcome(supplierNotify(issued));
    await until(() => inboundRow(receipt.id).status === "PROCESSED");
    assert.ok(inboundRow(receipt.id).attempt_count >= 2);
    assert.equal(sql(`SELECT install_status FROM sim_profiles WHERE order_id='${order.id}'`), "INSTALLED");
    assert.equal(sql(`SELECT count(*) FROM sim_profile_events WHERE event_id='${signal.eventId}' AND source='CALLBACK'`), "1");
    assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "1");
  } finally { await restart(); }
});

test("tracking owner authorization, CSRF, validation and activation-information viewing are enforced", async () => {
  const { profile } = await trackingProfile();
  assert.equal((await new Client().request(`/api/sims/${profile.id}/tracking`)).status, 401);
  assert.equal((await bob.request(`/api/sims/${profile.id}/tracking`)).status, 404);
  assert.equal((await trackingChange(profile, installedChange, randomUUID(), bob)).status, 404);
  assert.equal((await alice.request(`/api/sims/${profile.id}/simulation`, { method: "POST", body: installedChange,
    headers: { "Idempotency-Key": randomUUID() } })).status, 403);
  for (const body of [{ ...installedChange, callbackCopies: 21 }, { ...installedChange, callbackDelayMs: -1 },
    { ...installedChange, state: "ACTIVE" }, { ...installedChange, state: "ENABLED", activatedAt: "2099-01-01T00:00:00Z" }]) {
    assert.equal((await trackingChange(profile, body)).status, 400);
  }
  const headers = await alice.csrf();
  const viewed = await Promise.all(Array.from({ length: 20 }, () => alice.request(`/api/sims/${profile.id}/activation-view`, { method: "POST", headers })));
  assert.ok(viewed.every(response => response.status === 200));
  const view = await trackingView(profile);
  assert.equal(view.profile.installStatus, "QR_VIEWED"); assert.ok(view.profile.qrViewedAt);
  assert.equal(view.profile.installedAt, null); assert.equal(view.profile.activatedAt, null);
  assert.equal(sql(`SELECT count(*) FROM sim_profile_events WHERE profile_id='${profile.id}' AND source='QR_VIEW'`), "1");
});

test("tracking delayed duplicate callbacks and concurrent replay apply one supplier version", async () => {
  const { profile } = await trackingProfile(), key = randomUUID();
  const body = { ...installedChange, callbackCopies: 3, callbackDelayMs: 1200 };
  sql(`UPDATE sim_profiles SET next_sync_at=clock_timestamp()+INTERVAL '5 minutes' WHERE id='${profile.id}'`);
  const response = await trackingChange(profile, body, key); assert.equal(response.status, 200);
  const signal = await response.json();
  assert.notEqual((await trackingView(profile)).profile.installStatus, "INSTALLED");
  const headers = { ...await alice.csrf(), "Idempotency-Key": key };
  const duplicates = await Promise.all(Array.from({ length: 2 }, () => alice.request(`/api/sims/${profile.id}/simulation`, { method: "POST", headers, body })));
  assert.ok(duplicates.every(response => response.status === 200));
  assert.ok((await Promise.all(duplicates.map(response => response.json()))).every(copy => copy.eventId === signal.eventId));
  await until(async () => (await trackingView(profile)).profile.installStatus === "INSTALLED");
  const callbacks = await Promise.all(Array.from({ length: 20 }, () => profileNotify(signal)));
  await webhookCopies(callbacks);
  await until(() => sql(`SELECT callback_sent FROM mock_profile_notifications WHERE event_id='${signal.eventId}'`) === "3");
  assert.equal(sql(`SELECT count(*) FROM sim_profile_events WHERE event_id='${signal.eventId}'`), "1");
  assert.equal((await trackingChange(profile, { ...body, callbackCopies: 4 }, key)).status, 409);
  assert.equal((await profileNotify(signal, false)).status, 401);
  assert.equal((await profileNotify({ ...signal, revision: 2.5 })).status, 400);
  await webhookOutcome(profileNotify({ ...signal, eventId: randomUUID(), orderId: randomUUID() }), 404);
});

test("tracking callback omission is reconciled by polling and survives Service restart", async () => {
  const { profile } = await trackingProfile();
  const response = await trackingChange(profile, { ...installedChange, callbackCopies: 0 });
  assert.equal(response.status, 200); const signal = await response.json();
  await restart();
  await until(async () => (await trackingView(profile)).profile.installStatus === "INSTALLED");
  assert.equal(sql(`SELECT callback_sent FROM mock_profile_notifications WHERE event_id='${signal.eventId}'`), "0");
  assert.equal(sql(`SELECT source FROM sim_profile_events WHERE event_id='${signal.eventId}'`), "LOOKUP");
  assert.ok((await trackingView(profile)).profile.lastSyncedAt);
});

test("tracking reordered events cannot regress activation or alter an already known timestamp", async () => {
  const { profile, order } = await trackingProfile();
  const oldResponse = await trackingChange(profile, { ...installedChange, callbackCopies: 0 });
  assert.equal(oldResponse.status, 200); const old = await oldResponse.json();
  assert.equal((await trackingChange(profile, { state: "ENABLED", activatedAt: "2020-01-01T00:00:00Z", callbackCopies: 0, callbackDelayMs: 0 })).status, 400);
  const activatedAt = new Date().toISOString();
  const activeResponse = await trackingChange(profile, { state: "ENABLED", activatedAt, callbackCopies: 1, callbackDelayMs: 0 });
  assert.equal(activeResponse.status, 200); const active = await activeResponse.json();
  await until(async () => (await trackingView(profile)).profile.installStatus === "ACTIVE");
  await webhookOutcome(profileNotify(old));
  assert.equal((await trackingView(profile)).profile.installStatus, "ACTIVE");
  await webhookOutcome(profileNotify({ ...active, eventId: randomUUID() }), 409);
  assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${order.id}'`), "0");
  assert.ok((await (await admin.request("/api/admin/orders?needsReview=true&size=100")).json()).items.some(item => item.order.id === order.id));
  await webhookOutcome(profileNotify({ ...old, state: "DELETED" }), 409);
  assert.equal((await trackingChange(profile, installedChange)).status, 409);
  assert.equal((await trackingChange(profile, { state: "ENABLED", activatedAt: "2020-01-01T00:00:00Z", callbackCopies: 0, callbackDelayMs: 0 })).status, 409);
  assert.equal((await alice.request(`/api/sims/${profile.id}/tracking`)).status, 409);
  assert.equal(Date.parse(sql(`SELECT activated_at FROM sim_profiles WHERE id='${profile.id}'`)), Date.parse(activatedAt));
});

test("tracking UTC expiry uses exactly seven 24-hour periods and displays the next KST date", async () => {
  const { profile, order } = await trackingProfile();
  const response = await trackingChange(profile, { state: "ENABLED", activatedAt: "2026-05-01T15:20:00Z", callbackCopies: 1, callbackDelayMs: 0 });
  assert.equal(response.status, 200);
  await until(async () => (await trackingView(profile)).profile.installStatus === "EXPIRED");
  const view = await trackingView(profile);
  assert.equal(new Date(view.profile.expiresAt).toISOString(), "2026-05-08T15:20:00.000Z");
  assert.equal(Date.parse(view.profile.expiresAt) - Date.parse(view.profile.activatedAt), 7 * 24 * 60 * 60 * 1000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(view.profile.expiresAt)).map(part => [part.type, part.value]));
  assert.equal(`${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`, "2026-05-09 00:20");
  assert.equal((await (await alice.request(`/api/orders/${order.id}`)).json()).travelStartDate, future);
});

test("tracking expiry transitions at the boundary and persists an expiration event without a callback", async () => {
  const { profile } = await trackingProfile();
  const activatedAt = new Date(Date.now() - 7 * 86400000 + 7000).toISOString();
  const response = await trackingChange(profile, { state: "ENABLED", activatedAt, callbackCopies: 1, callbackDelayMs: 0 });
  assert.equal(response.status, 200);
  await until(async () => (await trackingView(profile)).profile.installStatus === "ACTIVE");
  await until(() => sql(`SELECT install_status FROM sim_profiles WHERE id='${profile.id}'`) === "EXPIRED", 15000);
  assert.equal((await trackingView(profile)).profile.installStatus, "EXPIRED");
  assert.equal(sql(`SELECT count(*) FROM sim_profile_events WHERE profile_id='${profile.id}' AND source='EXPIRY'`), "1");
});

test("tracking deleted profiles retain installation evidence and do not reopen refunds", async () => {
  const { profile, order, job } = await trackingProfile();
  assert.equal((await trackingChange(profile, installedChange)).status, 200);
  await until(async () => (await trackingView(profile)).profile.installStatus === "INSTALLED");
  const installedAt = (await trackingView(profile)).profile.installedAt;
  assert.equal((await trackingChange(profile, { state: "DELETED", activatedAt: null, callbackCopies: 1, callbackDelayMs: 0 })).status, 200);
  await until(async () => (await trackingView(profile)).profile.installStatus === "DELETED");
  assert.equal((await trackingView(profile)).profile.installedAt, installedAt);
  assert.equal((await trackingChange(profile, { ...installedChange, state: "RELEASED" })).status, 409);
  assert.equal((await adminAction(order.id, "refunds", refundRequest(job))).status, 409);
});

test("admin console second operator can read orders and history, but customers and anonymous callers cannot", async () => {
  const second = await member("admin2"), order = await newOrder();
  assert.equal((await (await second.request("/api/me")).json()).role, "ADMIN");
  for (const path of ["/api/admin/orders", `/api/admin/orders/${order.id}`, `/api/admin/orders/${order.id}/history`]) {
    assert.equal((await second.request(path)).status, 200);
    assert.equal((await alice.request(path)).status, 403);
    assert.equal((await new Client().request(path)).status, 401);
  }
  assert.equal((await second.create()).status, 403);
  const detail = await (await second.request(`/api/admin/orders/${order.id}`)).json();
  assert.ok(Date.parse(detail.checkedAt));
  assert.equal(detail.timeline.items[0].actor, "USER:customer1");
  assert.equal(detail.timeline.items[0].source, "ORDER_REQUEST");
});

test("admin console combines payment issuance installation and KST date filters without duplicate rows", async () => {
  const { order, profile } = await trackingProfile();
  assert.equal((await trackingChange(profile, installedChange)).status, 200);
  await until(async () => (await trackingView(profile)).profile.installStatus === "INSTALLED");
  const query = "/api/admin/orders?paymentStatus=APPROVED&issuanceStatus=ISSUED&installStatus=INSTALLED&simType=ESIM&size=100";
  let result = await (await admin.request(query)).json();
  assert.ok(result.items.some(row => row.order.id === order.id));
  assert.equal(new Set(result.items.map(row => row.order.id)).size, result.items.length);
  assert.ok(result.items.every(row => row.paymentStatus === "APPROVED" && row.issuanceStatus === "ISSUED" && row.installStatus === "INSTALLED"));
  assert.ok(result.items.find(row => row.order.id === order.id).lastSyncedAt);
  for (const filter of ["paymentStatus=INVALID", "issuanceStatus=INVALID", "installStatus=INVALID"]) {
    assert.equal((await admin.request("/api/admin/orders?" + filter)).status, 400);
  }
  sql(`UPDATE orders SET created_at='2026-05-01T15:00:00Z',expires_at='2026-05-01T15:10:00Z' WHERE id='${order.id}'`);
  result = await (await admin.request(query + "&from=2026-05-02&to=2026-05-02")).json();
  assert.ok(result.items.some(row => row.order.id === order.id));
  sql(`UPDATE orders SET created_at='2026-05-01T14:59:59.999999Z',expires_at='2026-05-01T15:09:59.999999Z' WHERE id='${order.id}'`);
  result = await (await admin.request(query + "&from=2026-05-02&to=2026-05-02")).json();
  assert.ok(!result.items.some(row => row.order.id === order.id));
  sql(`UPDATE sim_profiles SET sync_error='SUPPLIER_PROFILE_UNAVAILABLE',next_sync_at=clock_timestamp()+INTERVAL '1 hour' WHERE id='${profile.id}'`);
  assert.ok((await (await admin.request("/api/admin/orders?needsReview=true&size=100")).json()).items.some(row => row.order.id === order.id));
});

test("admin console timeline captures signal sources and does not repeat an unchanged supplier state", async () => {
  const { order, profile } = await trackingProfile();
  assert.equal((await alice.request(`/api/sims/${profile.id}/activation-view`, { method: "POST", headers: await alice.csrf() })).status, 200);
  const response = await trackingChange(profile, { state: "ENABLED", activatedAt: new Date().toISOString(), callbackDelayMs: 0, callbackCopies: 0 });
  const signal = await response.json();
  await until(async () => (await trackingView(profile)).profile.installStatus === "ACTIVE");
  const path = `/api/admin/orders/${order.id}/history?size=100`;
  const events = (await (await admin.request(path)).json()).items;
  assert.ok(events.some(e => e.target === "ORDER" && e.toStatus === "PAID" && e.source.startsWith("PG_")));
  assert.ok(events.some(e => e.target === "PAYMENT" && e.toStatus === "APPROVED"));
  assert.ok(events.some(e => e.target === "ISSUANCE" && e.toStatus === "ISSUED" && e.source.startsWith("SUPPLIER_")));
  assert.ok(events.some(e => e.target === "PROFILE" && e.toStatus === "QR_VIEWED" && e.actor === "USER:customer1"));
  assert.ok(events.some(e => e.target === "PROFILE" && e.toStatus === "ACTIVE" && e.source === "PROFILE_LOOKUP" && e.actor === "SYSTEM"));
  await webhookOutcome(profileNotify(signal));
  await webhookOutcome(profileNotify(signal));
  const replayed = (await (await admin.request(path)).json()).items;
  assert.equal(replayed.filter(e => e.target === "PROFILE" && e.toStatus === "ACTIVE").length, 1);
  assert.equal(replayed.filter(e => e.target === "ORDER" && e.toStatus === "PAID").length, 1);
  const page1 = await (await admin.request(`/api/admin/orders/${order.id}/history?size=2`)).json();
  const page2 = await (await admin.request(`/api/admin/orders/${order.id}/history?size=2&before=${page1.nextBefore}`)).json();
  assert.equal(page1.items.length, 2); assert.equal(page2.items.length, 2);
  assert.equal(new Set([...page1.items, ...page2.items].map(e => e.id)).size, 4);
  for (const query of ["before=0", "size=0", "size=101"]) assert.equal((await admin.request(`/api/admin/orders/${order.id}/history?${query}`)).status, 400);
  await restart();
  assert.deepEqual((await (await admin.request(path)).json()).items, replayed);
});

test("admin console second operator refund retains actor and reason without leaking them to workers or later requests", async () => {
  const second = await member("admin2"), { order, job } = await failedOrder();
  const body = { ...refundRequest(job), reason: "운영자 2가 발급 실패 확인 후 환불" };
  assert.equal((await adminAction(order.id, "refunds", body, randomUUID(), second)).status, 202);
  await until(() => refundRow(order.id)?.status === "SUCCEEDED");
  const detail = await (await second.request(`/api/admin/orders/${order.id}`)).json();
  assert.equal(detail.actions[0].actor, "admin2");
  assert.equal(detail.actions[0].reason, body.reason);
  assert.ok(detail.timeline.items.some(e => e.target === "REFUND" && e.toStatus === "REQUESTED" && e.actor === "ADMIN:admin2" && e.reason === body.reason));
  assert.ok(detail.timeline.items.some(e => e.target === "REFUND" && e.toStatus === "SUCCEEDED" && e.actor === "SYSTEM"));
  const fresh = await newOrder();
  const history = await (await second.request(`/api/admin/orders/${fresh.id}/history`)).json();
  assert.equal(history.items[0].actor, "USER:customer1");
  assert.equal(history.items[0].reason, null);
});

test("admin console history rolls back with state changes and cannot be edited by the application role", async () => {
  const order = await newOrder();
  const count = sql(`SELECT count(*) FROM order_history WHERE order_id='${order.id}'`);
  sql(`BEGIN; UPDATE orders SET status='EXPIRED' WHERE id='${order.id}'; ROLLBACK;`);
  assert.equal(orderState(order.id), "PENDING_PAYMENT");
  assert.equal(sql(`SELECT count(*) FROM order_history WHERE order_id='${order.id}'`), count);
  sql(`UPDATE order_history SET actor='ADMIN:forged' WHERE order_id='${order.id}'`, true, true);
  sql(`DELETE FROM order_history WHERE order_id='${order.id}'`, true, true);
  sql(`INSERT INTO order_history(order_id,target,target_id,to_status,actor,source) VALUES('${order.id}','ORDER','${order.id}','PAID','ADMIN:forged','FORGED')`, true, true);
  sql("CREATE FUNCTION fail_history_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'history unavailable'; END $$; CREATE TRIGGER fail_history_for_test BEFORE INSERT ON order_history FOR EACH ROW EXECUTE FUNCTION fail_history_for_test();");
  try {
    const orders = sql("SELECT count(*) FROM orders");
    assert.equal((await alice.create()).status, 500);
    assert.equal(sql("SELECT count(*) FROM orders"), orders);
  } finally { sql("DROP TRIGGER fail_history_for_test ON order_history; DROP FUNCTION fail_history_for_test();"); }
});

const demoRequest = (job, mode = "REFUND_REFUND", keyMode = "SEPARATE") => ({
  issuanceId: job.id, mode, keyMode, reason: "두 운영자가 실제 세션으로 동시에 조치 시연",
});
const partialDemoRequest = (job, firstAmount, secondAmount, keyMode = "SEPARATE") => ({
  ...demoRequest(job, "PARTIAL_REFUND_REFUND", keyMode), firstAmount, secondAmount,
});

test("partial concurrency demo validates amounts, authorization and immutable preparation", async () => {
  const { order, job } = await failedOrder(), request = partialDemoRequest(job, 7000, 8000), key = randomUUID();
  assert.equal((await adminAction(order.id, "concurrency-demos", request, key, alice)).status, 403);
  assert.equal((await adminAction(order.id, "concurrency-demos", request, key, new Client())).status, 401);
  assert.equal((await admin.request(`/api/admin/orders/${order.id}/concurrency-demos`, {
    method: "POST", body: request, headers: { "Idempotency-Key": key },
  })).status, 403);
  for (const amount of [null, 0, -1, 1.5, order.amount, order.amount + 1, 1e25]) {
    for (const field of ["firstAmount", "secondAmount"]) {
      assert.equal((await adminAction(order.id, "concurrency-demos", { ...request, [field]: amount })).status, 400);
    }
  }
  assert.equal((await adminAction(order.id, "concurrency-demos", { ...request, mode: "REFUND_REFUND" })).status, 400);
  const response = await adminAction(order.id, "concurrency-demos", request, key);
  assert.equal(response.status, 200); const demo = await response.json();
  assert.equal(demo.participants[0].amount, 7000);
  assert.equal((await adminAction(order.id, "concurrency-demos", request, key)).status, 200);
  assert.equal((await adminAction(order.id, "concurrency-demos", { ...request, secondAmount: 8001 }, key)).status, 409);
  assert.equal((await demoCall(order.id, key, "start")).status, 409);
  assert.equal(sql(`SELECT count(*) FROM refunds WHERE order_id='${order.id}'`), "0");
});

for (const [name, firstAmount, secondAmount, keyMode, statuses] of [
  ["within balance", 7000, 8000, "SEPARATE", [202, 202]],
  ["exact balance", 7000, 8900, "SEPARATE", [202, 202]],
  ["over balance", 10000, 11000, "SEPARATE", [202, 409]],
  ["same key and amount", 7000, 7000, "SHARED", [200, 202]],
  ["same key different amount", 7000, 8000, "SHARED", [202, 409]],
]) test(`partial concurrency demo ${name} verifies both receipts and actual PG amounts`, async () => {
  const { order, job, attempt } = await failedOrder(), second = await member("admin2");
  assert.equal(order.amount, 15900);
  const request = partialDemoRequest(job, firstAmount, secondAmount, keyMode), key = randomUUID();
  const response = await adminAction(order.id, "concurrency-demos", request, key);
  assert.equal(response.status, 200); const demo = await response.json();
  assert.equal((await demoCall(order.id, demo.id, "join", second)).status, 200);
  const starts = await Promise.all([demoCall(order.id, demo.id, "start"), demoCall(order.id, demo.id, "start", second)]);
  assert.ok(starts.every(r => r.status === 200));
  let done;
  await until(async () => {
    done = await demoView(order.id, demo.id);
    return ["PASSED", "INVARIANT_FAILED", "REVIEW_REQUIRED", "BLOCKED"].includes(done.phase);
  });
  assert.equal(done.phase, "PASSED", JSON.stringify(done));
  assert.deepEqual(done.participants.map(p => p.result.status).sort(), statuses);
  assert.deepEqual(done.participants.map(p => p.amount), [firstAmount, secondAmount]);
  const accepted = done.participants.filter(p => p.result.status === 202);
  const total = accepted.reduce((sum, p) => sum + p.amount, 0);
  assert.equal(done.stats.actionCount, accepted.length);
  assert.equal(done.stats.refundCount, accepted.length);
  assert.equal(done.stats.pgCancellations, accepted.length);
  assert.equal(done.stats.cancelledAmount, total);
  assert.equal(done.stats.confirmedAmount, total);
  assert.equal(done.stats.reservedAmount, 0);
  assert.equal(orderState(order.id), total === order.amount ? "REFUNDED" : "PARTIALLY_REFUNDED");
  const detail = await recoveryDetail(order.id);
  assert.equal(detail.refundBalance.available, order.amount - total);
  for (const person of accepted) {
    const action = detail.actions.find(a => a.id === person.result.actionId);
    assert.equal(action.actor, person.username); assert.equal(action.reason, request.reason);
    assert.equal(refundById(action.refundId).amount, person.amount);
    assert.ok(detail.timeline.items.some(e => e.actor === `ADMIN:${person.username}` && e.reason === request.reason));
  }
  const rejected = done.participants.find(p => p.result.status === 409);
  if (rejected) assert.equal(rejected.result.code, keyMode === "SHARED" ? "ACTION_KEY_CONFLICT" : "REFUND_BALANCE_EXCEEDED");
  if (statuses.includes(200)) assert.equal(new Set(done.participants.map(p => p.result.actionId)).size, 1);
  assert.equal((await demoCall(order.id, demo.id, "start", second)).status, 200);
  assert.equal((await adminAction(order.id, "concurrency-demos", request, key)).status, 200);
  assert.deepEqual((await demoView(order.id, demo.id)).stats, done.stats);
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${attempt.id}'`), String(accepted.length));
  console.log(`partial concurrency ${name}: HTTP ${statuses.join("/")}, cancellations=${accepted.length}, confirmed=${total}, available=${order.amount-total}`);
});

test("partial concurrency demo keeps both reservations through DB completion failure and restart without duplicate cancellation", { timeout: 90000 }, async () => {
  const { order, job, attempt } = await failedOrder(), second = await member("admin2");
  const request = partialDemoRequest(job, 7000, 8000);
  const demo = await (await adminAction(order.id, "concurrency-demos", request)).json();
  await demoCall(order.id, demo.id, "join", second);
  let pending;
  sql(`CREATE FUNCTION partial_demo_reject_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.order_id='${order.id}'::uuid AND NEW.status='SUCCEEDED' THEN RAISE EXCEPTION 'simulated completion failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER partial_demo_reject_completion BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION partial_demo_reject_completion();`);
  try {
    await demoCall(order.id, demo.id, "start");
    await until(() => sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${attempt.id}'`) === "2");
    pending = await demoView(order.id, demo.id);
    assert.equal(pending.phase, "PROCESSING", JSON.stringify(pending));
    assert.equal(pending.stats.reservedAmount, 15000); assert.equal(pending.stats.confirmedAmount, 0);
    const extra = await adminAction(order.id, "refunds", { ...refundRequest(job), amount: 1000 });
    assert.equal(extra.status, 409); assert.equal((await extra.json()).code, "REFUND_BALANCE_EXCEEDED");
  } finally { sql("DROP TRIGGER partial_demo_reject_completion ON refunds; DROP FUNCTION partial_demo_reject_completion();"); }
  await restart();
  assert.equal((await admin.request(`/api/admin/orders/${order.id}/concurrency-demos/${demo.id}`)).status, 404);
  await until(() => sql(`SELECT count(*) FROM refunds WHERE order_id='${order.id}' AND status='SUCCEEDED'`) === "2");
  for (const person of pending.participants) {
    const response = await adminAction(order.id, "refunds", { ...refundRequest(job), reason: request.reason, amount: person.amount }, person.key);
    assert.equal(response.status, 200); assert.equal((await response.json()).action.id, person.result.actionId);
  }
  const detail = await recoveryDetail(order.id);
  assert.equal(detail.refundBalance.confirmed, 15000); assert.equal(detail.refundBalance.reserved, 0);
  assert.equal(detail.refundBalance.available, 900); assert.equal(detail.actions.length, 2);
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${attempt.id}'`), "2");
  assert.equal(sql(`SELECT sum(amount) FROM refund_ledger WHERE payment_id='${attempt.id}'`), "15000");
});

async function demoCall(orderId, id, action, client = admin) {
  return adminAction(orderId, `concurrency-demos/${id}/${action}`, undefined, randomUUID(), client);
}
async function demoView(orderId, id, client = admin) {
  const response = await client.request(`/api/admin/orders/${orderId}/concurrency-demos/${id}`);
  assert.equal(response.status, 200);
  return response.json();
}

test("admin concurrency requires two distinct authenticated operators, CSRF and a current failed issuance", async () => {
  const { order, job } = await failedOrder(), request = demoRequest(job), key = randomUUID();
  const path = `/api/admin/orders/${order.id}/concurrency-demos`;
  assert.equal((await adminAction(order.id, "concurrency-demos", request, key, new Client())).status, 401);
  assert.equal((await adminAction(order.id, "concurrency-demos", request, key, alice)).status, 403);
  assert.equal((await admin.request(path, { method: "POST", body: request, headers: { "Idempotency-Key": key } })).status, 403);
  for (const invalid of [{ ...request, mode: "FAKE" }, { ...request, reason: " " },
    { ...request, reason: "a".repeat(301) }, { ...request, keyMode: null }, demoRequest(job, "REFUND_RETRY", "SHARED")]) {
    assert.equal((await adminAction(order.id, "concurrency-demos", invalid)).status, 400);
  }
  assert.equal((await adminAction(order.id, "concurrency-demos", { ...request, issuanceId: randomUUID() })).status, 409);
  assert.equal((await adminAction(order.id, "concurrency-demos", request, "invalid-key")).status, 400);
  const response = await adminAction(order.id, "concurrency-demos", { ...request, actor: "admin2" }, key);
  assert.equal(response.status, 200); const demo = await response.json();
  assert.equal(demo.phase, "WAITING"); assert.equal(demo.participants.length, 1);
  assert.equal(demo.participants[0].username, "admin");
  assert.equal((await adminAction(order.id, "concurrency-demos", request, key)).status, 200);
  assert.equal((await adminAction(order.id, "concurrency-demos", { ...request, reason: "변경" }, key)).status, 409);
  const second = await member("admin2");
  assert.equal((await adminAction(order.id, "concurrency-demos", request, key, second)).status, 409);
  assert.equal((await demoCall(order.id, demo.id, "start", second)).status, 403);
  assert.equal((await demoCall(order.id, demo.id, "start")).status, 409);
  assert.equal((await demoCall(order.id, demo.id, "join")).status, 200);
  assert.equal((await demoView(order.id, demo.id)).participants.length, 1);
  assert.equal((await demoCall(order.id, demo.id, "join", bob)).status, 403);
  assert.equal((await alice.request(`${path}/${demo.id}`)).status, 403);
  assert.equal((await admin.request(`${path}/${randomUUID()}`)).status, 404);
  assert.equal((await admin.request(`/api/admin/orders/${randomUUID()}/concurrency-demos/${demo.id}`)).status, 404);
  assert.equal(sql(`SELECT count(*) FROM admin_actions WHERE order_id='${order.id}'`), "0");
  assert.equal(refundRow(order.id), null); assert.equal(issuanceRow(order.id).id, job.id);
});

for (const [mode, keyMode] of [["REFUND_REFUND", "SEPARATE"], ["RETRY_RETRY", "SEPARATE"],
  ["REFUND_RETRY", "SEPARATE"], ["REFUND_REFUND", "SHARED"], ["RETRY_RETRY", "SHARED"]]) {
  test(`admin concurrency ${mode} ${keyMode} runs exactly one real action and external effect`, async () => {
    const second = await member("admin2"), { order, job } = await failedOrder(), key = randomUUID();
    const request = demoRequest(job, mode, keyMode);
    const response = await adminAction(order.id, "concurrency-demos", request, key);
    assert.equal(response.status, 200); const demo = await response.json();
    assert.equal(demo.id, key); assert.equal(demo.stats.actionCount, 0);
    assert.equal((await demoCall(order.id, demo.id, "join", second)).status, 200);
    const ready = await demoView(order.id, demo.id, second);
    assert.equal(ready.phase, "READY"); assert.equal(ready.participating, true);
    assert.deepEqual(ready.participants.map(p => p.username), ["admin", "admin2"]);
    assert.equal(new Set(ready.participants.map(p => p.key)).size, keyMode === "SHARED" ? 1 : 2);
    // Both authenticated operators can press start; this must not dispatch a second batch.
    const starts = await Promise.all([demoCall(order.id, demo.id, "start"), demoCall(order.id, demo.id, "start", second)]);
    assert.ok(starts.every(r => r.status === 200));
    let done;
    await until(async () => {
      done = await demoView(order.id, demo.id);
      return ["PASSED", "INVARIANT_FAILED", "REVIEW_REQUIRED", "BLOCKED"].includes(done.phase);
    });
    assert.equal(done.phase, "PASSED", JSON.stringify(done));
    assert.deepEqual(done.participants.map(p => p.result.status).sort(), keyMode === "SHARED" ? [200, 202] : [202, 409]);
    const winner = done.participants.find(p => p.result.status === 202);
    assert.ok(done.participants.every(p => p.result.startedAt && p.result.finishedAt));
    assert.ok(Math.abs(Date.parse(done.participants[0].result.startedAt) - Date.parse(done.participants[1].result.startedAt)) < 1000);
    assert.equal(done.stats.actionCount, 1);
    assert.equal(done.stats.refundCount + done.stats.retryCount, 1);
    assert.equal(sql(`SELECT count(*) FROM admin_actions WHERE order_id='${order.id}'`), "1");
    const detail = await (await admin.request(`/api/admin/orders/${order.id}`)).json();
    assert.equal(detail.actions[0].actor, winner.username);
    assert.equal(detail.actions[0].reason, request.reason);
    assert.equal(detail.actions[0].id, winner.result.actionId);
    assert.ok(detail.timeline.items.some(e => e.actor === `ADMIN:${winner.username}` && e.reason === request.reason));
    if (keyMode === "SHARED") {
      assert.equal(new Set(done.participants.map(p => p.result.actionId)).size, 1);
      assert.ok(done.participants.every(p => p.result.appliedBy === winner.username));
    }
    if (winner.operation === "REFUND") {
      assert.equal(orderState(order.id), "REFUNDED");
      assert.equal(done.stats.pgCancellations, 1); assert.equal(done.stats.cancelledAmount, order.amount);
      assert.equal(done.stats.profileCount, 0); assert.equal(done.stats.retryCount, 0);
      assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id IN (SELECT id FROM payment_attempts WHERE order_id='${order.id}')`), "1");
    } else {
      assert.equal(done.stats.supplierOrders, 1); assert.equal(done.stats.supplierIssues, 1);
      assert.equal(done.stats.profileCount, 1); assert.equal(done.stats.pgCancellations, 0);
      assert.equal(refundRow(order.id), null);
      assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "2");
      assert.equal(sql(`SELECT sum(issue_executions) FROM mock_supplier_orders WHERE request_id='${issuanceRow(order.id).id}'`), "1");
    }
    assert.equal((await demoCall(order.id, demo.id, "join", second)).status, 200);
    assert.equal((await demoCall(order.id, demo.id, "start")).status, 200);
    assert.equal((await adminAction(order.id, "concurrency-demos", request, key)).status, 200);
    assert.deepEqual((await demoView(order.id, demo.id)).stats, done.stats);
    console.log(`concurrency proof ${mode}/${keyMode}: statuses=${done.participants.map(p => p.result.status).join(",")} action=1 pg=${done.stats.pgCancellations} supplier=${done.stats.supplierIssues} SIM=${done.stats.profileCount}`);
  });
}

test("admin concurrency stale prepared round is blocked after an external operator action", async () => {
  const second = await member("admin2"), { order, job } = await failedOrder();
  const demo = await (await adminAction(order.id, "concurrency-demos", demoRequest(job))).json();
  await demoCall(order.id, demo.id, "join", second);
  assert.equal((await adminAction(order.id, "refunds", refundRequest(job), randomUUID(), second)).status, 202);
  assert.equal((await demoCall(order.id, demo.id, "start")).status, 200);
  let done;
  await until(async () => { done = await demoView(order.id, demo.id); return done.phase === "BLOCKED"; });
  assert.deepEqual(done.participants.map(p => p.result.status), [409, 409]);
  assert.equal(done.stats.actionCount, 0);
  await until(() => refundRow(order.id)?.status === "SUCCEEDED");
  assert.equal(sql(`SELECT count(*) FROM admin_actions WHERE order_id='${order.id}'`), "1");
});

test("admin concurrency ordinary two-session HTTP actions also serialize without the demo coordinator", async () => {
  const second = await member("admin2");
  for (const types of [["refunds", "refunds"], ["issuance-retries", "issuance-retries"], ["refunds", "issuance-retries"]]) {
    const { order, job } = await failedOrder();
    const results = await Promise.all(types.map((type, i) => adminAction(order.id, type,
      type === "refunds" ? refundRequest(job) : retryRequest(job), randomUUID(), i === 0 ? admin : second)));
    assert.deepEqual(results.map(r => r.status).sort(), [202, 409]);
    await until(() => orderState(order.id) === "REFUNDED" || issuanceRow(order.id).status === "ISSUED");
    assert.equal(sql(`SELECT count(*) FROM admin_actions WHERE order_id='${order.id}'`), "1");
    assert.ok(!(refundRow(order.id) && sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`) !== "0"));
  }
});

test("admin concurrency restart loses only coordination metadata; accepted action and idempotency survive", async () => {
  const second = await member("admin2"), { order, job } = await failedOrder();
  const demo = await (await adminAction(order.id, "concurrency-demos", demoRequest(job))).json();
  await demoCall(order.id, demo.id, "join", second);
  await demoCall(order.id, demo.id, "start");
  let done;
  await until(async () => { done = await demoView(order.id, demo.id); return done.phase === "PASSED"; });
  const winner = done.participants.find(p => p.result.status === 202);
  await restart();
  assert.equal((await admin.request(`/api/admin/orders/${order.id}/concurrency-demos/${demo.id}`)).status, 404);
  assert.equal((await adminAction(order.id, "refunds", { ...refundRequest(job), reason: demo.request.reason }, winner.key)).status, 200);
  assert.equal(sql(`SELECT count(*) FROM admin_actions WHERE order_id='${order.id}'`), "1");
  assert.equal(refundRow(order.id).status, "SUCCEEDED");
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE idempotency_key='${refundRow(order.id).id}'`), "1");
});

async function generateScenario(scenario = "ISSUANCE_FAILED", key = randomUUID(),
  overrides = {}, client = admin) {
  return client.request("/api/admin/scenarios", { method: "POST", headers: { ...await client.csrf(), "Idempotency-Key": key },
    body: { scenario, customer: "customer1", planId: "jp-esim-7d", ...overrides } });
}
async function scenarioResult(id, client = admin) {
  const response = await client.request(`/api/admin/scenarios/${id}`);
  assert.equal(response.status, 200); return response.json();
}
async function readyScenario(id) {
  let result;
  await until(async () => { result = await scenarioResult(id); return result.status !== "GENERATING"; }, 45000);
  assert.equal(result.status, "READY", JSON.stringify(result));
  return result;
}

test("scenario generator restricts options, writes and reads to authenticated operators with CSRF", async () => {
  for (const client of [new Client(), alice, bob]) {
    const expected = client === alice || client === bob ? 403 : 401;
    assert.equal((await client.request("/api/admin/scenarios/options")).status, expected);
    assert.equal((await generateScenario("PENDING_PAYMENT", randomUUID(), {}, client)).status, expected);
    assert.equal((await client.request(`/api/admin/scenarios/${randomUUID()}`)).status, expected);
  }
  assert.equal((await admin.request("/api/admin/scenarios", { method: "POST", body: {} })).status, 403);
  const response = await admin.request("/api/admin/scenarios/options");
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const options = await response.json();
  assert.deepEqual(options.customers.map(c => c.username), ["customer1", "customer2"]);
  assert.ok(options.plans.length === 2 && options.plans.every(p => p.simType === "ESIM" && p.price > 0));
  assert.ok(!JSON.stringify(options).includes("password"));
  for (const body of [{ scenario: "FAKE" }, { scenario: null }, { customer: "admin" }, { customer: "admin2" },
    { customer: "missing" }, { customer: "" }, { customer: "x".repeat(33) }, { planId: "jp-usim-7d" }]) {
    assert.equal((await generateScenario("PENDING_PAYMENT", randomUUID(), body)).status, 400);
  }
  assert.equal((await generateScenario("PENDING_PAYMENT", randomUUID(), { planId: "missing" })).status, 404);
  assert.equal((await generateScenario("PENDING_PAYMENT", "bad-key")).status, 400);
  assert.equal((await admin.request("/api/admin/scenarios", { method: "POST", headers: await admin.csrf(),
    body: { scenario: "PENDING_PAYMENT", customer: "customer1", planId: "jp-esim-7d" } })).status, 400);
  assert.equal((await admin.request(`/api/admin/scenarios/${randomUUID()}`)).status, 404);
});

for (const scenario of ["PENDING_PAYMENT", "ISSUANCE_FAILED", "ISSUED", "REFUNDED", "REFUND_REVIEW_REQUIRED"]) {
  test(`scenario generator ${scenario} uses real order payment supplier and refund records`, async () => {
    const second = await member("admin2"), key = randomUUID();
    const response = await generateScenario(scenario, key, { customer: "customer2", planId: "th-esim-5d",
      actor: "admin", memberId: alice.memberId, amount: 1, currency: "USD", status: "REFUNDED" }, second);
    assert.equal(response.status, 201); assert.equal(response.headers.get("location"), `/api/admin/scenarios/${key}`);
    assert.equal(response.headers.get("idempotency-replayed"), "false");
    const initial = await response.json();
    assert.equal(initial.id, key); assert.equal(initial.createdBy, "admin2");
    assert.equal(initial.customer, "customer2"); assert.equal(initial.planId, "th-esim-5d");
    assert.equal(initial.status, scenario === "PENDING_PAYMENT" ? "READY" : "GENERATING");
    const result = await readyScenario(key);
    const detail = await (await second.request(`/api/admin/orders/${result.orderId}`)).json();
    assert.equal(detail.order.order.amount, 9900); assert.equal(detail.order.order.currency, "KRW");
    assert.equal(sql(`SELECT member_id FROM orders WHERE id='${result.orderId}'`), bob.memberId);
    assert.equal((await alice.request(`/api/orders/${result.orderId}`)).status, 404);
    assert.equal((await bob.request(`/api/orders/${result.orderId}`)).status, 200);
    assert.ok(detail.timeline.items.some(e => e.target === "ORDER" && e.toStatus === "PENDING_PAYMENT"
      && e.actor === "ADMIN:admin2" && e.source === "SCENARIO_GENERATOR"));
    assert.equal(sql(`SELECT count(*) FROM scenario_generations WHERE id='${key}'`), "1");
    if (scenario === "PENDING_PAYMENT") {
      assert.equal(result.orderStatus, "PENDING_PAYMENT"); assert.equal(detail.payments.length, 0);
      assert.equal(result.issuanceStatus, null); assert.equal(result.refundStatus, null);
      assert.equal(Date.parse(detail.order.order.expiresAt) - Date.parse(detail.order.order.createdAt), 600000);
    } else {
      assert.equal(detail.payments.length, 1); assert.equal(detail.payments[0].status, "APPROVED");
      assert.equal(sql(`SELECT approval_executions FROM mock_pg_payments WHERE payment_id='${detail.payments[0].id}'`), "1");
      assert.equal(sql(`SELECT count(*) FROM mock_supplier_orders WHERE request_id='${detail.issuance.issuance.id}'`), "1");
      assert.equal(sql(`SELECT issue_executions FROM mock_supplier_orders WHERE request_id='${detail.issuance.issuance.id}'`), scenario === "ISSUED" ? "1" : "0");
      assert.ok(detail.timeline.items.some(e => e.target === "PAYMENT" && e.actor === "ADMIN:admin2" && e.source === "SCENARIO_GENERATOR"));
      if (scenario === "ISSUED") {
        assert.equal(result.orderStatus, "PAID"); assert.equal(result.issuanceStatus, "ISSUED");
        assert.equal(detail.issuance.profile.installStatus, "ISSUED"); assert.ok(result.simId);
        assert.equal(detail.issuance.profile.installedAt, null); assert.equal(detail.refund, null);
      } else {
        assert.equal(result.issuanceStatus, "FAILED"); assert.equal(result.simId, null);
        if (scenario === "ISSUANCE_FAILED") {
          assert.equal(result.orderStatus, "PAID"); assert.equal(detail.refund, null); assert.equal(detail.actions.length, 0);
          assert.equal((await adminAction(result.orderId, "concurrency-demos", demoRequest(issuanceRow(result.orderId)), randomUUID(), second)).status, 200);
        } else {
          assert.equal(detail.actions.length, 1); assert.equal(detail.actions[0].actor, "admin2");
          assert.equal(detail.actions[0].reason, `시나리오 데이터 생성: ${scenario}`);
          if (scenario === "REFUNDED") {
            assert.equal(result.orderStatus, "REFUNDED"); assert.equal(result.refundStatus, "SUCCEEDED");
            assert.equal(sql(`SELECT amount FROM mock_pg_cancellations WHERE idempotency_key='${detail.refund.id}'`), "9900");
          } else {
            assert.equal(result.orderStatus, "REFUND_PROCESSING"); assert.equal(result.refundStatus, "REVIEW_REQUIRED");
            assert.equal(detail.refund.attemptCount, 3);
            assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE idempotency_key='${detail.refund.id}'`), "0");
            assert.equal((await adminAction(result.orderId, "issuance-retries", retryRequest(issuanceRow(result.orderId)))).status, 409);
          }
        }
      }
    }
    console.log(`scenario proof ${scenario}: generation=READY order=${result.orderStatus} issuance=${result.issuanceStatus} refund=${result.refundStatus}`);
  });
}

test("scenario generator twenty concurrent identical requests create one order and one external effect", async () => {
  const key = randomUUID(), headers = { ...await admin.csrf(), "Idempotency-Key": key };
  const requests = await Promise.all(Array.from({ length: 20 }, () => admin.request("/api/admin/scenarios", {
    method: "POST", headers, body: { scenario: "REFUNDED", customer: "customer1", planId: "jp-esim-7d" },
  })));
  assert.equal(requests.filter(r => r.status === 201).length, 1);
  assert.equal(requests.filter(r => r.status === 200).length, 19);
  assert.equal(new Set(await Promise.all(requests.map(async r => (await r.json()).orderId))).size, 1);
  const result = await readyScenario(key);
  assert.equal(sql(`SELECT count(*) FROM orders WHERE idempotency_key='${key}'`), "1");
  assert.equal(sql(`SELECT count(*) FROM payment_attempts WHERE order_id='${result.orderId}'`), "1");
  assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${result.orderId}'`), "1");
  assert.equal(sql(`SELECT count(*) FROM admin_actions WHERE order_id='${result.orderId}'`), "1");
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE idempotency_key='${refundRow(result.orderId).id}'`), "1");
  const replay = await generateScenario("REFUNDED", key);
  assert.equal(replay.status, 200); assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.equal((await replay.json()).orderId, result.orderId);
});

test("scenario generator changed payload or operator conflicts and a discarded response safely replays", async () => {
  const key = randomUUID(), response = await generateScenario("PENDING_PAYMENT", key);
  assert.equal(response.status, 201); await response.body.cancel();
  const replay = await generateScenario("PENDING_PAYMENT", key); assert.equal(replay.status, 200);
  const original = await replay.json();
  for (const changed of [{ scenario: "ISSUED" }, { customer: "customer2" }, { planId: "th-esim-5d" }]) {
    const conflict = await generateScenario("PENDING_PAYMENT", key, changed);
    assert.equal(conflict.status, 409); assert.equal((await conflict.json()).code, "SCENARIO_KEY_CONFLICT");
  }
  assert.equal((await generateScenario("PENDING_PAYMENT", key, {}, await member("admin2"))).status, 409);
  assert.equal(sql(`SELECT count(*) FROM orders WHERE idempotency_key='${key}'`), "1");
  expire(original.orderId);
  const expired = await (await generateScenario("PENDING_PAYMENT", key)).json();
  assert.equal(expired.orderId, original.orderId); assert.equal(expired.orderStatus, "EXPIRED");
});

test("scenario generator durable acceptance survives restart and never reports ready before workers finish", async () => {
  await restart({ PAYMENT_WORKER_DELAY_MS: "60000" });
  const key = randomUUID(), response = await generateScenario("ISSUANCE_FAILED", key);
  assert.equal(response.status, 201); const queued = await response.json();
  assert.equal(queued.status, "GENERATING"); assert.equal(queued.orderStatus, "PAYMENT_PROCESSING");
  await restart();
  const result = await readyScenario(key);
  assert.equal(result.orderId, queued.orderId); assert.equal(result.issuanceStatus, "FAILED");
  assert.equal((await generateScenario("ISSUANCE_FAILED", key)).status, 200);
  assert.equal(sql(`SELECT count(*) FROM orders WHERE idempotency_key='${key}'`), "1");
});

test("scenario generator replay preserves order snapshots when current product price changes", async () => {
  const key = randomUUID(), response = await generateScenario("PENDING_PAYMENT", key);
  assert.equal(response.status, 201); const original = await response.json();
  const price = sql("SELECT price FROM plans WHERE id='jp-esim-7d'");
  sql("UPDATE plans SET price=0 WHERE id='jp-esim-7d'");
  try {
    const replay = await generateScenario("PENDING_PAYMENT", key);
    assert.equal(replay.status, 200); assert.equal((await replay.json()).orderId, original.orderId);
    assert.equal((await generateScenario("PENDING_PAYMENT")).status, 400);
    assert.equal(sql(`SELECT amount FROM orders WHERE id='${original.orderId}'`), price);
  } finally { sql(`UPDATE plans SET price=${price} WHERE id='jp-esim-7d'`); }
});

test("scenario generator intake failures roll back the generation order payment and history together", async () => {
  const key = randomUUID(), count = sql("SELECT count(*) FROM orders");
  sql("CREATE FUNCTION fail_scenario_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'payment insert unavailable'; END $$; CREATE TRIGGER fail_scenario_for_test BEFORE INSERT ON payment_attempts FOR EACH ROW EXECUTE FUNCTION fail_scenario_for_test();");
  try { assert.equal((await generateScenario("ISSUED", key)).status, 500); }
  finally { sql("DROP TRIGGER fail_scenario_for_test ON payment_attempts; DROP FUNCTION fail_scenario_for_test();"); }
  assert.equal(sql("SELECT count(*) FROM orders"), count);
  assert.equal(sql(`SELECT count(*) FROM scenario_generations WHERE id='${key}'`), "0");
  assert.equal(sql(`SELECT count(*) FROM orders WHERE idempotency_key='${key}'`), "0");
  assert.equal((await generateScenario("ISSUED", key)).status, 201);
  assert.equal((await readyScenario(key)).issuanceStatus, "ISSUED");
});

test("scenario generator timeout preserves the actual order without fabricating the target state", async () => {
  await restart({ PAYMENT_WORKER_DELAY_MS: "60000" });
  const response = await generateScenario("ISSUED"); assert.equal(response.status, 201); const queued = await response.json();
  sql(`UPDATE scenario_generations SET created_at=clock_timestamp()-INTERVAL '11 minutes' WHERE id='${queued.id}'`);
  let stopped;
  await until(async () => { stopped = await scenarioResult(queued.id); return stopped.status === "FAILED"; });
  assert.equal(stopped.lastError, "GENERATION_TIMEOUT"); assert.equal(stopped.orderStatus, "PAYMENT_PROCESSING");
  assert.equal(stopped.simId, null);
  assert.equal((await generateScenario("ISSUED", queued.id)).status, 200);
  await restart();
  await until(() => issuanceRow(queued.orderId)?.status === "ISSUED");
  assert.equal((await scenarioResult(queued.id)).status, "FAILED");
});

test("scenario generator cannot create data when either mock provider is disabled", async () => {
  const count = sql("SELECT count(*) FROM orders");
  for (const extra of [{ MOCK_PG_ENABLED: "false" }, { MOCK_SUPPLIER_ENABLED: "false" }]) {
    await restart(extra);
    assert.equal((await generateScenario()).status, 503);
    assert.equal((await admin.request("/api/admin/scenarios/options")).status, 503);
    assert.equal(sql("SELECT count(*) FROM orders"), count);
  }
  await restart();
});

function recoveryRow(id) {
  const value = sql(`SELECT row_to_json(a) FROM recovery_actions a WHERE id='${id}'`);
  return value ? JSON.parse(value) : null;
}

async function recoveryDetail(orderId) {
  const response = await admin.request(`/api/admin/orders/${orderId}`);
  assert.equal(response.status, 200); return response.json();
}

async function recoveryTarget(orderId, kind, id) {
  const detail = await recoveryDetail(orderId);
  const target = detail.recoveryTargets.find(target => target.kind === kind && (!id || target.id === id));
  assert.ok(target, `missing ${kind} recovery target for ${orderId}`); return target;
}

function recoveryRequest(target, overrides = {}) {
  return { target: target.kind, targetId: target.id, expectedVersion: target.version,
    reason: "운영자 확인 후 같은 외부 요청번호로 복구", ...overrides };
}

async function recoveryAction(orderId, path, body, key = randomUUID(), client = admin) {
  return adminAction(orderId, path, body, key, client);
}

async function recoveryPoster(orderId, path, body, client = admin) {
  // Create a session's new CSRF token once before racing the actual operator mutations.
  const csrf = await client.csrf();
  return (key = randomUUID()) => client.request(`/api/admin/orders/${orderId}/${path}`, { method: "POST",
    headers: { ...csrf, "Idempotency-Key": key }, body });
}

async function reconcile(orderId, target, client = admin) {
  const response = await recoveryAction(orderId, "reconciliations", recoveryRequest(target), randomUUID(), client);
  assert.equal(response.status, 202);
  const { action } = await response.json(); assert.ok(action.id);
  await until(() => ["SUCCEEDED", "REVIEW_REQUIRED", "STALE"].includes(recoveryRow(action.id)?.status));
  return recoveryRow(action.id);
}

async function resumeRecovery(orderId, target, evidence, key = randomUUID(), client = admin) {
  return recoveryAction(orderId, "recoveries", recoveryRequest(target, { evidenceId: evidence.id }), key, client);
}

async function reviewPayment(approved = false, extra = {}) {
  await restart({ ...inboxOnly, ...extra });
  const order = await newOrder(), response = await alice.pay(order.id);
  assert.equal(response.status, 202); const attempt = await response.json();
  // Automatic exhaustion is covered above; isolate operator recovery from background claim races.
  sql(`UPDATE payment_attempts SET status='REVIEW_REQUIRED',attempt_count=6,round_attempt_count=6,
    last_error='RETRY_LIMIT_REACHED',lease_token=NULL,lease_until=NULL WHERE id='${attempt.id}'`);
  if (approved) {
    const result = await pg("/payments/approve", { paymentId: attempt.id, orderId: order.id,
      amount: order.amount, currency: "KRW", scenario: "APPROVE", webhookCopies: 0, webhookDelayMs: 0 });
    assert.equal(result.status, 200);
  }
  return { order, attempt, target: await recoveryTarget(order.id, "PAYMENT", attempt.id) };
}

test("operator recovery requires administrator, CSRF, a reason, a current target and explicit evidence", { timeout: 45000 }, async () => {
  const { order, target } = await reviewPayment();
  const body = recoveryRequest(target), path = `/api/admin/orders/${order.id}/reconciliations`;
  assert.equal((await recoveryAction(order.id, "reconciliations", body, randomUUID(), new Client())).status, 401);
  assert.equal((await recoveryAction(order.id, "reconciliations", body, randomUUID(), alice)).status, 403);
  assert.equal((await admin.request(path, { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body })).status, 403);
  assert.equal((await recoveryAction(order.id, "reconciliations", { ...body, reason: " " })).status, 400);
  assert.equal((await recoveryAction(order.id, "reconciliations", { ...body, expectedVersion: "bad" })).status, 400);
  assert.equal((await recoveryAction(order.id, "recoveries", body)).status, 400);
  const other = await newOrder();
  const crossOrder = await recoveryAction(other.id, "reconciliations", body);
  assert.ok([404, 409].includes(crossOrder.status));
  assert.equal(sql(`SELECT count(*) FROM recovery_actions WHERE order_id='${order.id}'`), "0");
  await restart();
});

test("operator recovery twenty identical queries survive restart and apply a PG approval once without reapproving", { timeout: 60000 }, async () => {
  const proxy = await providerProxy("mock-pg");
  try {
    const { order, attempt, target } = await reviewPayment(true, { MOCK_PG_BASE_URL: proxy.url, RECOVERY_WORKER_DELAY_MS: "60000" });
    const key = randomUUID(), body = recoveryRequest(target);
    const post = await recoveryPoster(order.id, "reconciliations", body);
    const responses = await Promise.all(Array.from({ length: 20 }, () => post(key)));
    assert.equal(responses.filter(response => response.status === 202).length, 1);
    assert.equal(responses.filter(response => response.status === 200).length, 19);
    const results = await Promise.all(responses.map(response => response.json()));
    const actionId = results[0].action.id;
    assert.equal(new Set(results.map(result => result.action.id)).size, 1);
    assert.equal(recoveryRow(actionId).status, "QUEUED");
    assert.equal(proxy.forId(attempt.id).length, 0);
    const changed = await recoveryAction(order.id, "reconciliations", { ...body, reason: "다른 조치 사유" }, key);
    assert.equal(changed.status, 409); assert.equal((await changed.json()).code, "RECOVERY_KEY_CONFLICT");
    await restart({ ...inboxOnly, MOCK_PG_BASE_URL: proxy.url });
    await until(() => recoveryRow(actionId).status === "SUCCEEDED");
    const action = recoveryRow(actionId);
    assert.equal(action.outcome, "APPLIED"); assert.equal(action.attempt_count, 1);
    assert.equal(orderState(order.id), "PAID");
    assert.ok(proxy.forId(attempt.id).every(call => call.method === "GET"));
    assert.equal(sql(`SELECT approval_executions FROM mock_pg_payments WHERE payment_id='${attempt.id}'`), "1");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "1");
    assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "1");
    const replay = await recoveryAction(order.id, "reconciliations", body, key);
    assert.equal(replay.status, 200); assert.equal((await replay.json()).action.id, actionId);
    const detail = await recoveryDetail(order.id);
    assert.ok(detail.recoveryActions.some(item => item.id === actionId && item.reason === body.reason));
    assert.ok(sql(`SELECT actor FROM order_history WHERE target_id='${actionId}' LIMIT 1`).includes("admin"));
    sql(`UPDATE recovery_actions SET reason='rewritten' WHERE id='${actionId}'`, true, true);
    sql(`DELETE FROM recovery_actions WHERE id='${actionId}'`, true, true);
    sql(`UPDATE recovery_action_events SET status='STALE' WHERE action_id='${actionId}'`, true, true);
  } finally { await restart(); await proxy.close(); }
});

test("operator recovery different keys from two operators accept only one active query", { timeout: 45000 }, async () => {
  const { order, target } = await reviewPayment(false, { RECOVERY_WORKER_DELAY_MS: "60000" });
  const second = await member("admin2"), body = recoveryRequest(target);
  const posts = await Promise.all([admin, second].map(client => recoveryPoster(order.id, "reconciliations", body, client)));
  const responses = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    posts[index % 2]()));
  assert.equal(responses.filter(response => response.status === 202).length, 1);
  assert.equal(responses.filter(response => response.status === 409).length, 19);
  for (const response of responses.filter(response => response.status === 409)) {
    assert.ok(["RECOVERY_IN_PROGRESS", "STALE_RECOVERY_TARGET"].includes((await response.json()).code));
  }
  assert.equal(sql(`SELECT count(*) FROM recovery_actions WHERE order_id='${order.id}'`), "1");
  const accepted = await responses.find(response => response.status === 202).json();
  await restart(inboxOnly);
  await until(() => recoveryRow(accepted.action.id).status === "SUCCEEDED");
  assert.equal(recoveryRow(accepted.action.id).outcome, "RESUME_ALLOWED");
  assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
  assert.equal(sql(`SELECT count(*) FROM mock_pg_payments WHERE payment_id='${target.id}'`), "0");
  await restart();
});

test("operator recovery query DB failures roll back business writes and preserve a three-attempt budget across restart", { timeout: 60000 }, async () => {
  const proxy = await providerProxy("mock-pg"); let restore;
  try {
    const { order, attempt, target } = await reviewPayment(true, { MOCK_PG_BASE_URL: proxy.url, RECOVERY_RETRY_BASE_MS: "1500" });
    restore = rejectTransitions("payment_attempts", order.id, ["APPROVED"]);
    const response = await recoveryAction(order.id, "reconciliations", recoveryRequest(target));
    assert.equal(response.status, 202); const { action } = await response.json();
    await until(() => recoveryRow(action.id).status === "RETRY");
    assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "0");
    const priorCount = recoveryRow(action.id).attempt_count;
    await restart({ ...inboxOnly, MOCK_PG_BASE_URL: proxy.url, RECOVERY_RETRY_BASE_MS: "100" });
    await until(() => recoveryRow(action.id).status === "REVIEW_REQUIRED");
    assert.equal(recoveryRow(action.id).attempt_count, 3); assert.ok(priorCount >= 1);
    const calls = proxy.forId(attempt.id).length;
    assert.equal(calls, 3); assert.ok(proxy.forId(attempt.id).every(call => call.method === "GET"));
    restore(); restore = null;
    await restart({ ...inboxOnly, MOCK_PG_BASE_URL: proxy.url }); await delay(500);
    assert.equal(recoveryRow(action.id).attempt_count, 3); assert.equal(proxy.forId(attempt.id).length, calls);
    const recovered = await reconcile(order.id, await recoveryTarget(order.id, "PAYMENT"));
    assert.equal(recovered.outcome, "APPLIED"); assert.equal(orderState(order.id), "PAID");
    assert.equal(sql(`SELECT approval_executions FROM mock_pg_payments WHERE payment_id='${attempt.id}'`), "1");
  } finally { if (restore) restore(); await restart(); await proxy.close(); }
});

test("operator recovery provider outages exhaust queries without resuming or resetting the payment budget", { timeout: 45000 }, async () => {
  const proxy = await providerProxy("mock-pg"); proxy.intercept = () => ({ status: 503 });
  try {
    const { order, attempt, target } = await reviewPayment(false, { MOCK_PG_BASE_URL: proxy.url });
    const action = await reconcile(order.id, target);
    assert.equal(action.status, "REVIEW_REQUIRED"); assert.equal(action.attempt_count, 3);
    assert.equal(proxy.forId(attempt.id).length, 3);
    assert.ok(proxy.forId(attempt.id).every(call => call.method === "GET"));
    assert.equal(sql(`SELECT attempt_count||':'||round_attempt_count||':'||execution_round FROM payment_attempts WHERE id='${attempt.id}'`), "6:6:1");
    assert.equal((await resumeRecovery(order.id, await recoveryTarget(order.id, "PAYMENT"), action)).status, 409);
    assert.equal(sql(`SELECT count(*) FROM mock_pg_payments WHERE payment_id='${attempt.id}'`), "0");
  } finally { await restart(); await proxy.close(); }
});

test("operator recovery concurrent resume reuses the payment ID and opens exactly one bounded execution round", { timeout: 60000 }, async () => {
  const { order, attempt, target } = await reviewPayment();
  const evidence = await reconcile(order.id, target);
  assert.equal(evidence.outcome, "RESUME_ALLOWED");
  const current = await recoveryTarget(order.id, "PAYMENT"), key = randomUUID();
  const post = await recoveryPoster(order.id, "recoveries", recoveryRequest(current, { evidenceId: evidence.id }));
  const responses = await Promise.all(Array.from({ length: 20 }, () => post(key)));
  assert.equal(responses.filter(response => response.status === 202).length, 1);
  assert.equal(responses.filter(response => response.status === 200).length, 19);
  const results = await Promise.all(responses.map(response => response.json()));
  assert.equal(new Set(results.map(result => result.action.id)).size, 1);
  const action = recoveryRow(results[0].action.id);
  assert.equal(action.from_round, 1); assert.equal(action.to_round, 2);
  assert.equal(sql(`SELECT attempt_count||':'||round_attempt_count||':'||execution_round FROM payment_attempts WHERE id='${attempt.id}'`), "6:0:2");
  assert.equal(sql(`SELECT count(*) FROM payment_attempts WHERE order_id='${order.id}'`), "1");
  await restart({ ISSUANCE_WORKER_DELAY_MS: "60000" }); await settled(order, attempt);
  assert.equal(sql(`SELECT attempt_count||':'||round_attempt_count||':'||execution_round FROM payment_attempts WHERE id='${attempt.id}'`), "7:1:2");
  assert.equal(sql(`SELECT approval_executions FROM mock_pg_payments WHERE payment_id='${attempt.id}'`), "1");
  await restart();
});

test("operator recovery stale and expired evidence cannot resume a payment and missing evidence cannot create an action", { timeout: 45000 }, async () => {
  const { order, target } = await reviewPayment();
  const evidence = await reconcile(order.id, target);
  sql(`UPDATE payment_attempts SET last_error='NEW_OPERATOR_OBSERVATION' WHERE id='${target.id}'`);
  const stale = await resumeRecovery(order.id, target, evidence);
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, "STALE_RECOVERY_TARGET");
  const current = await recoveryTarget(order.id, "PAYMENT"), fresh = await reconcile(order.id, current);
  sql(`UPDATE recovery_actions SET checked_at=clock_timestamp()-INTERVAL '61 seconds' WHERE id='${fresh.id}'`);
  const expired = await resumeRecovery(order.id, await recoveryTarget(order.id, "PAYMENT"), fresh);
  assert.equal(expired.status, 409); assert.equal((await expired.json()).code, "RECOVERY_EVIDENCE_EXPIRED");
  assert.equal((await recoveryAction(order.id, "recoveries", recoveryRequest(current))).status, 400);
  assert.equal(sql(`SELECT count(*) FROM recovery_actions WHERE order_id='${order.id}' AND kind='RESUME'`), "0");
  assert.equal(sql(`SELECT execution_round FROM payment_attempts WHERE id='${target.id}'`), "1");
  await restart();
});

test("operator recovery cannot start a new PG approval after the order payment deadline", { timeout: 45000 }, async () => {
  const { order, attempt } = await reviewPayment(); expire(order.id);
  const target = await recoveryTarget(order.id, "PAYMENT"), evidence = await reconcile(order.id, target);
  assert.equal(evidence.outcome, "BLOCKED");
  assert.equal((await resumeRecovery(order.id, await recoveryTarget(order.id, "PAYMENT"), evidence)).status, 409);
  assert.equal(sql(`SELECT count(*) FROM mock_pg_payments WHERE payment_id='${attempt.id}'`), "0");
  assert.equal(sql(`SELECT execution_round FROM payment_attempts WHERE id='${attempt.id}'`), "1");
  await restart();
});

test("operator recovery a queued query becomes stale when the target changes before its worker starts", { timeout: 45000 }, async () => {
  const proxy = await providerProxy("mock-pg");
  try {
    const { order, attempt, target } = await reviewPayment(true, { MOCK_PG_BASE_URL: proxy.url, RECOVERY_WORKER_DELAY_MS: "60000" });
    const response = await recoveryAction(order.id, "reconciliations", recoveryRequest(target));
    assert.equal(response.status, 202); const { action } = await response.json();
    sql(`UPDATE payment_attempts SET last_error='NEW_OPERATOR_OBSERVATION' WHERE id='${attempt.id}'`);
    await restart({ ...inboxOnly, MOCK_PG_BASE_URL: proxy.url });
    await until(() => recoveryRow(action.id).status === "STALE");
    assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "0");
    assert.ok(proxy.forId(attempt.id).every(call => call.method === "GET"));
  } finally { await restart(); await proxy.close(); }
});

test("operator recovery refund resumes preserve one refund ID and stop after three rounds of three attempts", { timeout: 60000 }, async () => {
  await restart();
  const { order, attempt, job } = await failedOrder();
  assert.equal((await adminAction(order.id, "refunds", refundRequest(job, "UNAVAILABLE"))).status, 202);
  await until(() => refundRow(order.id)?.status === "REVIEW_REQUIRED");
  const refundId = refundRow(order.id).id;
  for (let round = 1; round <= 3; round++) {
    const row = refundRow(order.id);
    assert.equal(row.id, refundId); assert.equal(row.execution_round, round);
    assert.equal(row.attempt_count, round * 3); assert.equal(row.round_attempt_count, 3);
    const target = await recoveryTarget(order.id, "REFUND", refundId), evidence = await reconcile(order.id, target);
    assert.equal(evidence.outcome, "RESUME_ALLOWED");
    const response = await resumeRecovery(order.id, await recoveryTarget(order.id, "REFUND", refundId), evidence);
    if (round === 3) {
      assert.equal(response.status, 409); assert.equal((await response.json()).code, "RECOVERY_ROUND_LIMIT");
    } else {
      assert.equal(response.status, 202);
      await until(() => refundRow(order.id)?.status === "REVIEW_REQUIRED");
    }
  }
  await restart(); assert.equal(refundRow(order.id).attempt_count, 9);
  assert.equal(sql(`SELECT count(*) FROM refunds WHERE order_id='${order.id}'`), "1");
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${attempt.id}'`), "0");
  assert.equal(sql(`SELECT count(*) FROM recovery_actions WHERE order_id='${order.id}' AND kind='RESUME'`), "2");
});

test("operator recovery supplier lookup and resume keep the same issuance request and lifetime submission count", { timeout: 60000 }, async () => {
  await restart({ ISSUANCE_WORKER_DELAY_MS: "60000" });
  const { order, job } = await issueOrder({ scenario: "SUCCEED", callbackCopies: 0, callbackDelayMs: 0 });
  sql(`UPDATE issuance_jobs SET status='REVIEW_REQUIRED',check_count=6,consecutive_failures=6,submission_count=6,
    round_submission_count=6,last_error='SUPPLIER_RETRY_LIMIT_REACHED',
    lease_token=NULL,lease_until=NULL WHERE id='${job.id}'`);
  const target = await recoveryTarget(order.id, "ISSUANCE", job.id), evidence = await reconcile(order.id, target);
  assert.equal(evidence.outcome, "RESUME_ALLOWED");
  assert.equal((await resumeRecovery(order.id, await recoveryTarget(order.id, "ISSUANCE", job.id), evidence)).status, 202);
  let resumed = issuanceRow(order.id);
  assert.equal(resumed.id, job.id); assert.equal(resumed.execution_round, 2);
  assert.equal(resumed.submission_count, 6); assert.equal(resumed.round_submission_count, 0);
  await restart(); await until(() => issuanceRow(order.id).status === "ISSUED");
  resumed = issuanceRow(order.id);
  assert.equal(resumed.id, job.id); assert.equal(resumed.submission_count, 7);
  assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "1");
  assert.equal(sql(`SELECT count(*) FROM mock_supplier_orders WHERE request_id='${job.id}'`), "1");
});

test("operator recovery inbox replay retains encrypted evidence and stops at six attempts in each of three rounds", { timeout: 60000 }, async () => {
  await restart(inboxOnly); const { order, attempt, result } = await pendingWebhookPayment(); let restore;
  try {
    restore = rejectTransitions("payment_attempts", order.id, ["APPROVED"]);
    const response = await notify(result); assert.equal(response.status, 202);
    const receipt = await response.json();
    await until(() => inboundRow(receipt.id).status === "REVIEW_REQUIRED");
    const original = inboundRow(receipt.id);
    for (let round = 1; round <= 3; round++) {
      const row = inboundRow(receipt.id);
      assert.equal(row.attempt_count, round * 6); assert.equal(row.round_attempt_count, 6);
      assert.equal(row.execution_round, round); assert.equal(row.body, original.body);
      assert.equal(row.payload_hash, original.payload_hash);
      const target = await recoveryTarget(order.id, "INBOUND", receipt.id), evidence = await reconcile(order.id, target);
      assert.equal(evidence.outcome, "REPLAY_ALLOWED");
      const response = await resumeRecovery(order.id, await recoveryTarget(order.id, "INBOUND", receipt.id), evidence);
      if (round === 3) {
        assert.equal(response.status, 409); assert.equal((await response.json()).code, "RECOVERY_ROUND_LIMIT");
      } else {
        assert.equal(response.status, 202);
        await until(() => inboundRow(receipt.id).status === "REVIEW_REQUIRED");
      }
    }
    restore(); restore = null;
    await restart(inboxOnly); await delay(500);
    assert.equal(inboundRow(receipt.id).attempt_count, 18);
    assert.equal(inboundRow(receipt.id).status, "REVIEW_REQUIRED");
    assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "0");
    assert.equal(sql(`SELECT approval_executions FROM mock_pg_payments WHERE payment_id='${attempt.id}'`), "1");
  } finally { if (restore) restore(); await restart(); }
});

test("operator recovery never clears conflicting evidence or applies a contradictory approval", { timeout: 45000 }, async () => {
  const { order, attempt } = await reviewPayment(true);
  const result = await (await pg(`/payments/${attempt.id}`)).json();
  await webhookOutcome(notify({ ...result, eventId: randomUUID(), amount: result.amount + 1 }), 409);
  const conflictCount = sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${order.id}'`);
  assert.equal(conflictCount, "1");
  const target = await recoveryTarget(order.id, "PAYMENT"), action = await reconcile(order.id, target);
  assert.equal(action.outcome, "BLOCKED");
  assert.equal((await resumeRecovery(order.id, await recoveryTarget(order.id, "PAYMENT"), action)).status, 409);
  assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${order.id}'`), conflictCount);
  assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
  assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "0");
  assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "0");
  await restart();
});

test("operator recovery two operators with different keys cannot both reopen the same execution round", { timeout: 45000 }, async () => {
  const { order, attempt, target } = await reviewPayment();
  const evidence = await reconcile(order.id, target), current = await recoveryTarget(order.id, "PAYMENT");
  const second = await member("admin2");
  const body = recoveryRequest(current, { evidenceId: evidence.id });
  const posts = await Promise.all([admin, second].map(client => recoveryPoster(order.id, "recoveries", body, client)));
  const responses = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    posts[index % 2]()));
  assert.equal(responses.filter(response => response.status === 202).length, 1);
  assert.equal(responses.filter(response => response.status === 409).length, 19);
  assert.equal(sql(`SELECT count(*) FROM recovery_actions WHERE order_id='${order.id}' AND kind='RESUME'`), "1");
  assert.equal(sql(`SELECT attempt_count||':'||round_attempt_count||':'||execution_round FROM payment_attempts WHERE id='${attempt.id}'`), "6:0:2");
  await restart(); await settled(order, attempt);
  assert.equal(sql(`SELECT approval_executions FROM mock_pg_payments WHERE payment_id='${attempt.id}'`), "1");
});

test("operator recovery resolves an already cancelled refund by lookup without a second cancellation", { timeout: 60000 }, async () => {
  await restart();
  const { order, attempt, job } = await failedOrder();
  await restart(inboxOnly);
  assert.equal((await adminAction(order.id, "refunds", refundRequest(job))).status, 202);
  const refund = refundRow(order.id);
  sql(`UPDATE refunds SET status='REVIEW_REQUIRED',attempt_count=3,round_attempt_count=3,
    last_error='REFUND_RETRY_LIMIT_REACHED',lease_token=NULL,lease_until=NULL WHERE id='${refund.id}'`);
  const cancellation = await pg(`/payments/${attempt.id}/cancel`, { amount: order.amount, scenario: "SUCCESS" }, refund.id);
  assert.equal(cancellation.status, 200);
  const target = await recoveryTarget(order.id, "REFUND", refund.id), evidence = await reconcile(order.id, target);
  assert.equal(evidence.outcome, "APPLIED");
  assert.equal(refundRow(order.id).status, "SUCCEEDED"); assert.equal(orderState(order.id), "REFUNDED");
  assert.equal(refundRow(order.id).attempt_count, 3); assert.equal(refundRow(order.id).execution_round, 1);
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${attempt.id}'`), "1");
  assert.equal(sql(`SELECT count(*) FROM admin_action_events e JOIN admin_actions a ON a.id=e.action_id
    WHERE a.order_id='${order.id}' AND e.status='SUCCEEDED'`), "1");
  await restart();
});

test("operator recovery payment resumed before expiry cannot approve after its queued work crosses the deadline", { timeout: 45000 }, async () => {
  const { order, attempt, target } = await reviewPayment();
  const evidence = await reconcile(order.id, target);
  assert.equal((await resumeRecovery(order.id, await recoveryTarget(order.id, "PAYMENT"), evidence)).status, 202);
  expire(order.id);
  await restart(); await settled(order, attempt, "REVIEW_REQUIRED");
  assert.equal((await payment(order.id, attempt.id)).lastError, "ORDER_PAYMENT_DEADLINE_PASSED");
  assert.equal(sql(`SELECT count(*) FROM mock_pg_payments WHERE payment_id='${attempt.id}'`), "0");
  assert.equal(sql(`SELECT execution_round FROM payment_attempts WHERE id='${attempt.id}'`), "2");
  assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
});

test("operator recovery a webhook can complete while provider lookup is in flight and makes the old query stale", { timeout: 45000 }, async () => {
  const proxy = await providerProxy("mock-pg"); let release;
  try {
    const { order, attempt, target } = await reviewPayment(true, { MOCK_PG_BASE_URL: proxy.url,
      PG_HTTP_TIMEOUT_MS: "5000", PAYMENT_LEASE_MS: "12000", RECOVERY_LEASE_MS: "12000" });
    let entered = false;
    const barrier = new Promise(resolve => { release = resolve; });
    proxy.intercept = async call => {
      if (call.method === "GET" && call.path.endsWith(`/payments/${attempt.id}`)) {
        entered = true; await barrier;
      }
      return null;
    };
    const response = await recoveryAction(order.id, "reconciliations", recoveryRequest(target));
    assert.equal(response.status, 202); const { action } = await response.json();
    await until(() => entered);
    const result = await (await pg(`/payments/${attempt.id}`)).json();
    await webhookOutcome(notify(result));
    assert.equal(orderState(order.id), "PAID");
    release();
    await until(() => recoveryRow(action.id).status === "STALE");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "1");
    assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "1");
    assert.equal(sql(`SELECT approval_executions FROM mock_pg_payments WHERE payment_id='${attempt.id}'`), "1");
  } finally { release?.(); await restart(); await proxy.close(); }
});

test("operator recovery completion and error-recording DB failures cannot reset the lookup budget after restart", { timeout: 60000 }, async () => {
  const proxy = await providerProxy("mock-pg"); let restore;
  try {
    const { order, attempt, target } = await reviewPayment(true, { MOCK_PG_BASE_URL: proxy.url });
    sql(`CREATE FUNCTION reject_recovery_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.order_id='${order.id}' AND NEW.status IN ('SUCCEEDED','RETRY','REVIEW_REQUIRED','STALE')
        THEN RAISE EXCEPTION 'simulated recovery recording failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_recovery_for_test BEFORE UPDATE ON recovery_actions
        FOR EACH ROW EXECUTE FUNCTION reject_recovery_for_test();`);
    restore = () => sql("DROP TRIGGER reject_recovery_for_test ON recovery_actions; DROP FUNCTION reject_recovery_for_test();");
    const response = await recoveryAction(order.id, "reconciliations", recoveryRequest(target));
    assert.equal(response.status, 202); const { action } = await response.json();
    await until(() => proxy.forId(attempt.id).length === 1); await delay(250);
    assert.equal(recoveryRow(action.id).status, "PROCESSING");
    await restart({ ...inboxOnly, MOCK_PG_BASE_URL: proxy.url });
    await until(() => recoveryRow(action.id).attempt_count === 3);
    await delay(1500);
    const calls = proxy.forId(attempt.id).length;
    assert.ok(calls > 0 && calls <= 3);
    assert.equal(recoveryRow(action.id).status, "PROCESSING");
    assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "0");
    assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "0");
    restore(); restore = null;
    await until(() => recoveryRow(action.id).status === "REVIEW_REQUIRED");
    assert.equal(recoveryRow(action.id).attempt_count, 3);
    await delay(1500); assert.equal(proxy.forId(attempt.id).length, calls);
    assert.equal(sql(`SELECT approval_executions FROM mock_pg_payments WHERE payment_id='${attempt.id}'`), "1");
  } finally { if (restore) restore(); await restart(); await proxy.close(); }
});

async function externalPayment(amount = 15900) {
  const paymentId = randomUUID(), orderId = randomUUID();
  const response = await pg("/payments/approve", { paymentId, orderId, amount, currency: "KRW",
    scenario: "APPROVE", webhookCopies: 0, webhookDelayMs: 0 });
  assert.equal(response.status, 200);
  return { paymentId, orderId, amount, result: await response.json() };
}

function ledgerQuery(from, to, overrides = {}) {
  return new URLSearchParams({ from, to, ...overrides }).toString();
}

test("reconciliation ledger payment pages honor KST day boundaries and a stable timestamp plus UUID cursor", async () => {
  const from = "2001-02-01T15:00:00Z", to = "2001-02-02T15:00:00Z";
  const times = ["2001-02-01T14:59:59.999999Z", from, "2001-02-01T16:00:00Z",
    "2001-02-01T16:00:00Z", "2001-02-01T16:00:00Z", "2001-02-02T14:59:59.999999Z", to];
  const created = [];
  for (const time of times) {
    const value = await externalPayment(); created.push({ ...value, time });
    sql(`UPDATE mock_pg_payments SET created_at='${time}' WHERE payment_id='${value.paymentId}'`);
  }
  const expected = created.slice(1, -1).sort((a, b) => Date.parse(a.time) - Date.parse(b.time)
    || a.paymentId.localeCompare(b.paymentId)).map(value => value.paymentId);
  const received = []; let cursor = {}, pages = 0;
  do {
    const response = await pg(`/ledger/payments?${ledgerQuery(from, to, { limit: 2, ...cursor })}`);
    assert.equal(response.status, 200); const page = await response.json(); pages++;
    assert.ok(page.items.length <= 2); received.push(...page.items.map(item => item.id));
    assert.ok(page.items.every(item => item.paymentId === item.id && item.orderId && item.occurredAt));
    assert.ok(!JSON.stringify(page).includes("transactionId"));
    if (!page.nextTime) { assert.equal(page.nextId, null); break; }
    assert.ok(page.nextId); cursor = { afterTime: page.nextTime, afterId: page.nextId };
    assert.ok(pages < 5, "ledger cursor must advance");
  } while (true);
  assert.deepEqual(received, expected); assert.equal(pages, 3);
  assert.equal(new Set(received).size, 5);
});

test("reconciliation ledger endpoints require provider credentials and validate range cursor and page bounds", async () => {
  const from = "2001-02-01T15:00:00Z", to = "2001-02-02T15:00:00Z", query = ledgerQuery(from, to);
  for (const endpoint of ["/ledger/payments", "/ledger/cancellations"]) {
    const response = await fetch(`http://127.0.0.1:${servicePort}/internal/mock-pg${endpoint}?${query}`,
      { headers: { "X-Gateway-Token": secret } });
    assert.equal(response.status, 401);
    assert.equal((await admin.request(`/internal/mock-pg${endpoint}?${query}`)).status, 404);
    for (const overrides of [{ limit: 0 }, { limit: 101 }, { afterTime: from }, { afterId: randomUUID() }, { from: to }, { from: "not-a-date" }]) {
      assert.equal((await pg(`${endpoint}?${ledgerQuery(from, to, overrides)}`)).status, 400);
    }
  }
  const supplierPath = `/ledger/orders?${query}`;
  const unauthenticated = await fetch(`http://127.0.0.1:${servicePort}/internal/mock-supplier${supplierPath}`,
    { headers: { "X-Gateway-Token": secret } });
  assert.equal(unauthenticated.status, 401);
  for (const overrides of [{ limit: 0 }, { limit: 101 }, { afterTime: from }, { afterId: randomUUID() }, { from: to }]) {
    assert.equal((await supplier(`/ledger/orders?${ledgerQuery(from, to, overrides)}`)).status, 400);
  }
});

test("reconciliation PG financial snapshot includes manual cancellation evidence without another provider write", async () => {
  const value = await externalPayment(20000);
  const first = await pg(`/payments/${value.paymentId}/cancel`, { amount: 3000, scenario: "SUCCESS" });
  const second = await pg(`/payments/${value.paymentId}/cancel`, { amount: 4000, scenario: "SUCCESS" });
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  const cancellations = [await first.json(), await second.json()];
  const before = await (await pg(`/payments/${value.paymentId}/stats`)).json();
  const response = await pg(`/ledger/payments/${value.paymentId}`);
  assert.equal(response.status, 200); const snapshot = await response.json();
  assert.equal(snapshot.payment.paymentId, value.paymentId); assert.equal(snapshot.payment.status, "APPROVED");
  assert.equal(snapshot.cancelledTotal, 7000);
  assert.deepEqual(snapshot.cancellations.map(item => item.id).sort(), cancellations.map(item => item.id).sort());
  assert.deepEqual(Object.keys(snapshot.cancellationTimes).sort(), cancellations.map(item => item.id).sort());
  assert.ok(Object.values(snapshot.cancellationTimes).every(value => Number.isFinite(Date.parse(value))));
  const after = await (await pg(`/payments/${value.paymentId}/stats`)).json();
  assert.deepEqual(after, before);
  const from = "2002-03-01T15:00:00Z", to = "2002-03-02T15:00:00Z";
  sql(`UPDATE mock_pg_cancellations SET created_at='${from}' WHERE payment_id='${value.paymentId}'`);
  const page = await (await pg(`/ledger/cancellations?${ledgerQuery(from, to, { limit: 100 })}`)).json();
  assert.deepEqual(page.items.map(item => item.id).sort(), cancellations.map(item => item.id).sort());
  assert.ok(page.items.every(item => item.paymentId === value.paymentId && item.orderId === value.orderId));
});

test("reconciliation supplier ledger follows business status changes rather than delivery counters", { timeout: 45000 }, async () => {
  await restart({ ISSUANCE_WORKER_DELAY_MS: "60000" });
  try {
    const requestId = randomUUID(), orderId = randomUUID();
    const response = await supplier("/orders", { requestId, orderId,
      simulation: { scenario: "FAIL", callbackCopies: 0, callbackDelayMs: 0 } });
    assert.equal(response.status, 202);
    sql(`UPDATE mock_supplier_orders SET created_at='2003-04-01T15:00:00Z',ledger_updated_at='2003-04-01T15:00:00Z' WHERE request_id='${requestId}'`);
    const before = sql(`SELECT ledger_updated_at FROM mock_supplier_orders WHERE request_id='${requestId}'`);
    sql(`UPDATE mock_supplier_orders SET callback_failures=callback_failures+1,request_count=request_count+1 WHERE request_id='${requestId}'`);
    assert.equal(sql(`SELECT ledger_updated_at FROM mock_supplier_orders WHERE request_id='${requestId}'`), before);
    sql(`UPDATE mock_supplier_orders SET status='FAILED' WHERE request_id='${requestId}'`);
    const changed = sql(`SELECT ledger_updated_at FROM mock_supplier_orders WHERE request_id='${requestId}'`);
    assert.notEqual(changed, before);
    const from = new Date(Date.now() - 60000).toISOString(), to = new Date(Date.now() + 60000).toISOString();
    const page = await (await supplier(`/ledger/orders?${ledgerQuery(from, to)}`)).json();
    const found = page.items.find(item => item.id === requestId);
    assert.ok(found); assert.equal(found.orderId, orderId); assert.equal(found.paymentId, null);
    assert.ok(!JSON.stringify(page).includes("activationCode"));
  } finally { await restart(); }
});

function reconciliationRow(id) {
  const value = sql(`SELECT row_to_json(r) FROM reconciliation_runs r WHERE id='${id}'`);
  return value ? JSON.parse(value) : null;
}

function reconciliationItem(runId, targetId) {
  const value = sql(`SELECT row_to_json(i) FROM reconciliation_items i WHERE run_id='${runId}' AND target_id='${targetId}'`);
  return value ? JSON.parse(value) : null;
}

async function requestReconciliation(body, key = randomUUID(), client = admin) {
  return client.request("/api/admin/reconciliation-runs", { method: "POST",
    headers: { ...await client.csrf(), "Idempotency-Key": key }, body });
}

async function completedReconciliation(id) {
  await until(() => ["SUCCEEDED", "REVIEW_REQUIRED"].includes(reconciliationRow(id)?.status), 60000);
  return reconciliationRow(id);
}

async function runReconciliation(body) {
  const response = await requestReconciliation({ reason: "외부 원장과 업무 기록 정합성 확인", ...body });
  assert.equal(response.status, 202); const { run } = await response.json();
  assert.ok(run.id); return completedReconciliation(run.id);
}

function incidentFor(kind, targetId, code) {
  const value = sql(`SELECT row_to_json(i) FROM incidents i WHERE kind='${kind}' AND target_id='${targetId}'${code ? ` AND code='${code}'` : ""} ORDER BY first_seen_at LIMIT 1`);
  return value ? JSON.parse(value) : null;
}

function ledgerDay(date) {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  return { mode: "LEDGER", from: date, to: next };
}

function stampPayment(paymentId, date) {
  sql(`UPDATE mock_pg_payments SET created_at='${date}T00:00:00+09:00' WHERE payment_id='${paymentId}'`);
}

function stampSupplier(requestId, date) {
  // Only this isolated fixture rewinds provider history; the production trigger forbids that update.
  sql(`BEGIN; ALTER TABLE mock_supplier_orders DISABLE TRIGGER mock_supplier_ledger_update;
    UPDATE mock_supplier_orders SET ledger_updated_at='${date}T00:00:00+09:00' WHERE request_id='${requestId}';
    ALTER TABLE mock_supplier_orders ENABLE TRIGGER mock_supplier_ledger_update; COMMIT;`);
}

test("reconciliation runs require admin CSRF and bounded KST dates and expose only audit metadata", { timeout: 60000 }, async () => {
  const path = "/api/admin/reconciliation-runs", body = { ...ledgerDay("2004-01-02"), reason: "입력 검증" };
  assert.equal((await requestReconciliation(body, randomUUID(), new Client())).status, 401);
  assert.equal((await requestReconciliation(body, randomUUID(), alice)).status, 403);
  assert.equal((await admin.request(path, { method: "POST", body, headers: { "Idempotency-Key": randomUUID() } })).status, 403);
  for (const invalid of [{ ...body, mode: "FAKE" }, { ...body, reason: " " }, { ...body, reason: "x".repeat(301) },
    { ...body, from: body.to }, { ...body, from: "2004-01-01", to: "2004-02-02" },
    { ...body, from: "2004-13-01" }, { ...body, to: null }]) {
    assert.equal((await requestReconciliation(invalid)).status, 400);
  }
  assert.equal((await alice.request(path)).status, 403);
  assert.equal((await new Client().request("/api/admin/incidents")).status, 401);
  assert.equal((await alice.request("/api/admin/incidents")).status, 403);
  const result = await runReconciliation(body);
  assert.equal(new Date(result.from_at).toISOString(), "2004-01-01T15:00:00.000Z");
  assert.equal(new Date(result.to_at).toISOString(), "2004-01-02T15:00:00.000Z");
  const response = await admin.request(`${path}/${result.id}?page=0&size=2`);
  assert.equal(response.status, 200); const detail = await response.json();
  assert.equal(detail.page, 0); assert.equal(detail.size, 2); assert.ok(Array.isArray(detail.items));
  const serialized = JSON.stringify(detail);
  for (const privateField of ["leaseToken", "payloadHash", "activationCode", "password", "LPA:"]) assert.ok(!serialized.includes(privateField));
  const list = await (await admin.request(path)).json();
  assert.ok(list.items.some(item => item.id === result.id)); assert.ok(list.lastSuccessfulAt); assert.ok(list.checkedAt);
});

test("reconciliation twenty identical run requests create one durable run and changed parameters conflict", { timeout: 60000 }, async () => {
  await restart({ RECONCILIATION_WORKER_DELAY_MS: "60000" });
  const body = { ...ledgerDay("2004-02-02"), reason: "중복 대사 요청" }, key = randomUUID();
  const headers = { ...await admin.csrf(), "Idempotency-Key": key };
  const responses = await Promise.all(Array.from({ length: 20 }, () => admin.request("/api/admin/reconciliation-runs",
    { method: "POST", headers, body })));
  assert.equal(responses.filter(response => response.status === 202).length, 1);
  assert.equal(responses.filter(response => response.status === 200).length, 19);
  const receipts = await Promise.all(responses.map(response => response.json()));
  assert.equal(new Set(receipts.map(receipt => receipt.run.id)).size, 1);
  const runId = receipts[0].run.id;
  assert.equal(reconciliationRow(runId).status, "QUEUED");
  assert.equal(sql(`SELECT count(*) FROM reconciliation_runs WHERE idempotency_key='${key}'`), "1");
  assert.equal((await requestReconciliation({ ...body, reason: "다른 내용" }, key)).status, 409);
  await restart(); assert.equal((await completedReconciliation(runId)).status, "SUCCEEDED");
  const replay = await requestReconciliation(body, key); assert.equal(replay.status, 200);
  assert.equal((await replay.json()).run.id, runId);
});

test("reconciliation pending scan includes arbitrarily old unresolved payments and recovers approval by read only lookup", { timeout: 75000 }, async () => {
  const proxy = await providerProxy("mock-pg");
  try {
    const { order, attempt } = await reviewPayment(true, { MOCK_PG_BASE_URL: proxy.url });
    sql(`UPDATE orders SET created_at='1999-01-01T00:00:00Z',expires_at='1999-01-01T00:10:00Z' WHERE id='${order.id}';
      UPDATE payment_attempts SET created_at='1999-01-01T00:00:00Z',updated_at='1999-01-01T00:00:00Z' WHERE id='${attempt.id}'`);
    const run = await runReconciliation({ mode: "PENDING" });
    const item = reconciliationItem(run.id, attempt.id); assert.ok(item);
    assert.equal(item.status, "SUCCEEDED"); assert.equal(orderState(order.id), "PAID");
    assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "1");
    assert.ok(proxy.forId(attempt.id).length > 0);
    assert.ok(proxy.forId(attempt.id).every(call => call.method === "GET"));
    assert.equal(sql(`SELECT approval_executions FROM mock_pg_payments WHERE payment_id='${attempt.id}'`), "1");
    assert.equal(sql(`SELECT execution_round||':'||attempt_count FROM payment_attempts WHERE id='${attempt.id}'`), "1:6");
  } finally { await restart(); await proxy.close(); }
});

test("reconciliation discovers a manually cancelled approval without marking it paid or starting issuance", { timeout: 60000 }, async () => {
  const { order, attempt } = await reviewPayment(true);
  const cancellation = await pg(`/payments/${attempt.id}/cancel`, { amount: order.amount, scenario: "SUCCESS" });
  assert.equal(cancellation.status, 200); const cancelled = await cancellation.json();
  stampPayment(attempt.id, "2005-01-02");
  sql(`UPDATE mock_pg_cancellations SET created_at='2005-01-02T00:00:00+09:00' WHERE id='${cancelled.id}'`);
  const run = await runReconciliation(ledgerDay("2005-01-02"));
  assert.ok(reconciliationItem(run.id, attempt.id));
  assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
  assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "0");
  assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "0");
  assert.ok(incidentFor("PAYMENT", attempt.id, "EXTERNAL_CANCELLATION_UNMATCHED"));
  assert.equal(sql(`SELECT count(*) FROM external_cancellations WHERE id='${cancelled.id}'`), "1");
  assert.equal(new Date(sql(`SELECT external_occurred_at FROM external_cancellations WHERE id='${cancelled.id}'`)).toISOString(), "2005-01-01T15:00:00.000Z");
  sql(`UPDATE external_cancellations SET amount=1 WHERE id='${cancelled.id}'`, true, true);
  assert.equal(sql(`SELECT count(*) FROM refunds WHERE order_id='${order.id}'`), "0");
  await restart();
});

test("reconciliation external orphan payments and supplier orders create incidents without inventing business records", { timeout: 60000 }, async () => {
  const paymentValue = await externalPayment(), requestId = randomUUID(), supplierOrderId = randomUUID();
  stampPayment(paymentValue.paymentId, "2005-02-02");
  const supplierResponse = await supplier("/orders", { requestId, orderId: supplierOrderId,
    simulation: { scenario: "FAIL", callbackCopies: 0, callbackDelayMs: 0 } });
  assert.equal(supplierResponse.status, 202);
  await until(() => sql(`SELECT status FROM mock_supplier_orders WHERE request_id='${requestId}'`) === "FAILED");
  stampSupplier(requestId, "2005-02-02");
  const beforeOrders = sql("SELECT count(*) FROM orders"), beforePayments = sql("SELECT count(*) FROM payment_attempts");
  const beforeJobs = sql("SELECT count(*) FROM issuance_jobs");
  await runReconciliation(ledgerDay("2005-02-02"));
  const paymentIncident = incidentFor("PAYMENT", paymentValue.paymentId, "ORPHAN_PAYMENT");
  const supplierIncident = incidentFor("ISSUANCE", requestId, "ORPHAN_ISSUANCE");
  assert.ok(paymentIncident, "external payment incident is required");
  assert.ok(supplierIncident, "external supplier incident is required");
  assert.equal(paymentIncident.order_id, null); assert.equal(supplierIncident.order_id, null);
  assert.equal(sql("SELECT count(*) FROM orders"), beforeOrders);
  assert.equal(sql("SELECT count(*) FROM payment_attempts"), beforePayments);
  assert.equal(sql("SELECT count(*) FROM issuance_jobs"), beforeJobs);
  assert.equal(sql(`SELECT count(*) FROM orders WHERE id IN ('${paymentValue.orderId}','${supplierOrderId}')`), "0");
});

test("reconciliation repeated discrepancies deduplicate incidents and only verified repair automatically resolves them", { timeout: 75000 }, async () => {
  const { order, attempt } = await failedOrder(), proxy = await providerProxy("mock-pg");
  try {
    stampPayment(attempt.id, "2006-01-02");
    proxy.intercept = call => call.path === `/internal/mock-pg/ledger/payments/${attempt.id}` ? { status: 404 } : null;
    await restart({ MOCK_PG_BASE_URL: proxy.url });
    await runReconciliation(ledgerDay("2006-01-02"));
    const original = incidentFor("PAYMENT", attempt.id, "PROVIDER_RECORD_MISSING"); assert.ok(original);
    await runReconciliation(ledgerDay("2006-01-02"));
    const repeated = incidentFor("PAYMENT", attempt.id, "PROVIDER_RECORD_MISSING");
    assert.equal(repeated.id, original.id); assert.equal(repeated.version, original.version);
    assert.equal(sql(`SELECT count(*) FROM incidents WHERE kind='PAYMENT' AND target_id='${attempt.id}' AND code='PROVIDER_RECORD_MISSING'`), "1");
    assert.equal(sql(`SELECT count(*) FROM incident_events WHERE incident_id='${original.id}'`), "1");
    const path = `/api/admin/incidents/${original.id}/investigations`, key = randomUUID();
    const body = { expectedVersion: repeated.version, reason: "PG 운영 기록 확인 중" };
    assert.equal((await alice.request(path, { method: "POST", headers: { ...await alice.csrf(), "Idempotency-Key": key }, body })).status, 403);
    assert.equal((await admin.request(path, { method: "POST", headers: { "Idempotency-Key": key }, body })).status, 403);
    const headers = { ...await admin.csrf(), "Idempotency-Key": key };
    const responses = await Promise.all(Array.from({ length: 20 }, () => admin.request(path, { method: "POST", headers, body })));
    assert.ok(responses.every(response => [200, 202].includes(response.status)));
    const receipts = await Promise.all(responses.map(response => response.json()));
    assert.equal(receipts.filter(receipt => !receipt.replayed).length, 1);
    assert.equal(sql(`SELECT count(*) FROM incident_actions WHERE incident_id='${original.id}'`), "1");
    const investigating = incidentFor("PAYMENT", attempt.id, "PROVIDER_RECORD_MISSING");
    assert.equal(investigating.status, "INVESTIGATING"); assert.equal(investigating.version, original.version + 1);
    assert.equal((await admin.request(path, { method: "POST", headers, body: { ...body, reason: "다른 이유" } })).status, 409);
    assert.equal((await admin.request(path, { method: "POST", headers: { ...headers, "Idempotency-Key": randomUUID() }, body })).status, 409);
    assert.equal((await admin.request(`/api/admin/incidents/${original.id}/resolve`, { method: "POST", headers, body })).status, 404);
    proxy.intercept = null;
    await runReconciliation(ledgerDay("2006-01-02"));
    const resolved = incidentFor("PAYMENT", attempt.id, "PROVIDER_RECORD_MISSING");
    assert.equal(resolved.status, "RESOLVED"); assert.ok(resolved.resolved_at);
    assert.equal(orderState(order.id), "PAID");
    const detail = await (await admin.request(`/api/admin/incidents/${original.id}`)).json();
    assert.equal(detail.incident.status, "RESOLVED"); assert.ok(detail.events.some(event => event.status === "INVESTIGATING"));
    const publicJson = JSON.stringify(detail);
    for (const value of ["activationCode", "leaseToken", "payloadHash", "LPA:"]) assert.ok(!publicJson.includes(value));
    sql(`UPDATE incident_events SET reason='rewrite' WHERE incident_id='${original.id}'`, true, true);
    sql(`DELETE FROM incidents WHERE id='${original.id}'`, true, true);
  } finally { await restart(); await proxy.close(); }
});

test("reconciliation matches an existing refund to the provider cancellation without cancelling twice", { timeout: 60000 }, async () => {
  await restart(); const { order, attempt, job } = await failedOrder();
  await restart(inboxOnly);
  assert.equal((await adminAction(order.id, "refunds", refundRequest(job))).status, 202);
  const refund = refundRow(order.id);
  sql(`UPDATE refunds SET status='REVIEW_REQUIRED',attempt_count=3,round_attempt_count=3,last_error='REFUND_RETRY_LIMIT_REACHED' WHERE id='${refund.id}'`);
  const response = await pg(`/payments/${attempt.id}/cancel`, { amount: order.amount, scenario: "SUCCESS" }, refund.id);
  assert.equal(response.status, 200); const cancellation = await response.json();
  sql(`UPDATE mock_pg_cancellations SET created_at='2007-01-02T00:00:00+09:00' WHERE id='${cancellation.id}'`);
  await runReconciliation(ledgerDay("2007-01-02"));
  assert.equal(refundRow(order.id).status, "SUCCEEDED"); assert.equal(orderState(order.id), "REFUNDED");
  assert.equal(refundRow(order.id).attempt_count, 3); assert.equal(refundRow(order.id).execution_round, 1);
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${attempt.id}'`), "1");
  assert.equal(sql(`SELECT count(*) FROM external_cancellations WHERE id='${cancellation.id}'`), "1");
  assert.equal(new Date(sql(`SELECT external_occurred_at FROM external_cancellations WHERE id='${cancellation.id}'`)).toISOString(), "2007-01-01T15:00:00.000Z");
  assert.equal(sql(`SELECT count(*) FROM incidents WHERE order_id='${order.id}' AND status<>'RESOLVED'`), "0");
  await restart();
});

test("reconciliation page checkpoint and discovered items commit atomically and resume from the same cursor after restart", { timeout: 75000 }, async () => {
  const targets = [];
  for (let index = 0; index < 3; index++) {
    const value = await externalPayment(); targets.push(value.paymentId); stampPayment(value.paymentId, "2008-01-02");
  }
  const ids = targets.map(id => `'${id}'`).join(","); let restore;
  try {
    await restart({ ...inboxOnly, RECONCILIATION_WORKER_DELAY_MS: "60000", RECONCILIATION_PAGE_SIZE: "2" });
    const response = await requestReconciliation({ ...ledgerDay("2008-01-02"), reason: "페이지 체크포인트 장애 검증" });
    assert.equal(response.status, 202); const { run } = await response.json();
    sql(`CREATE FUNCTION reject_reconciliation_page() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id='${run.id}' AND NEW.phase='PG_PAYMENTS' AND NEW.cursor_id IS NOT NULL
        THEN RAISE EXCEPTION 'simulated page checkpoint failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_reconciliation_page BEFORE UPDATE ON reconciliation_runs
        FOR EACH ROW EXECUTE FUNCTION reject_reconciliation_page();`);
    restore = () => sql("DROP TRIGGER reject_reconciliation_page ON reconciliation_runs; DROP FUNCTION reject_reconciliation_page();");
    await restart({ ...inboxOnly, RECONCILIATION_PAGE_SIZE: "2", RECONCILIATION_RETRY_BASE_MS: "10000" });
    await until(() => reconciliationRow(run.id).last_error === "RECONCILIATION_STORAGE_UNKNOWN", 60000);
    const failed = reconciliationRow(run.id);
    assert.equal(failed.phase, "PG_PAYMENTS"); assert.equal(failed.cursor_id, null);
    assert.equal(failed.page_attempt_count, 1);
    assert.equal(sql(`SELECT count(*) FROM reconciliation_items WHERE run_id='${run.id}' AND target_id IN (${ids})`), "0");
    restore(); restore = null;
    await restart({ ...inboxOnly, RECONCILIATION_PAGE_SIZE: "2" });
    const completed = await completedReconciliation(run.id);
    assert.equal(completed.status, "SUCCEEDED");
    assert.ok(completed.page_count > failed.page_count);
    assert.equal(sql(`SELECT count(*) FROM reconciliation_items WHERE run_id='${run.id}' AND target_id IN (${ids})`), "3");
    assert.equal(sql(`SELECT count(DISTINCT target_id) FROM reconciliation_items WHERE run_id='${run.id}' AND target_id IN (${ids})`), "3");
    for (const id of targets) assert.ok(incidentFor("PAYMENT", id, "ORPHAN_PAYMENT"));
  } finally { if (restore) restore(); await restart(); }
});

test("reconciliation item business DB failure rolls back approval and preserves a three-lookup budget across restart", { timeout: 90000 }, async () => {
  const proxy = await providerProxy("mock-pg"); let restore;
  try {
    const { order, attempt } = await reviewPayment(true, { MOCK_PG_BASE_URL: proxy.url, RECONCILIATION_RETRY_BASE_MS: "2000" });
    stampPayment(attempt.id, "2009-01-02");
    restore = rejectTransitions("payment_attempts", order.id, ["APPROVED"]);
    const response = await requestReconciliation({ ...ledgerDay("2009-01-02"), reason: "대사 결과 DB 롤백 검증" });
    assert.equal(response.status, 202); const { run } = await response.json();
    await until(() => reconciliationItem(run.id, attempt.id)?.status === "RETRY", 60000);
    assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "0");
    assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "0");
    const before = reconciliationItem(run.id, attempt.id).attempt_count;
    await restart({ ...inboxOnly, MOCK_PG_BASE_URL: proxy.url });
    await completedReconciliation(run.id);
    const failed = reconciliationItem(run.id, attempt.id);
    assert.equal(failed.status, "REVIEW_REQUIRED"); assert.equal(failed.attempt_count, 3); assert.ok(before >= 1);
    const calls = proxy.forId(attempt.id).length;
    assert.equal(calls, 3); assert.ok(proxy.forId(attempt.id).every(call => call.method === "GET"));
    restore(); restore = null;
    await restart({ ...inboxOnly, MOCK_PG_BASE_URL: proxy.url }); await delay(500);
    assert.equal(reconciliationItem(run.id, attempt.id).attempt_count, 3); assert.equal(proxy.forId(attempt.id).length, calls);
    await runReconciliation(ledgerDay("2009-01-02"));
    assert.equal(orderState(order.id), "PAID");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "1");
    assert.equal(sql(`SELECT approval_executions FROM mock_pg_payments WHERE payment_id='${attempt.id}'`), "1");
    assert.equal(incidentFor("PAYMENT", attempt.id, "RECONCILIATION_QUERY_FAILED").status, "RESOLVED");
  } finally { if (restore) restore(); await restart(); await proxy.close(); }
});

test("reconciliation item completion and error recording failures cannot exceed three durable claims after restart", { timeout: 90000 }, async () => {
  const proxy = await providerProxy("mock-pg"), value = await externalPayment(); let restore;
  stampPayment(value.paymentId, "2010-01-02");
  try {
    await restart({ ...inboxOnly, MOCK_PG_BASE_URL: proxy.url, RECONCILIATION_LEASE_MS: "1200" });
    sql(`CREATE FUNCTION reject_reconciliation_item() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.target_id='${value.paymentId}' AND NEW.status IN ('SUCCEEDED','RETRY','REVIEW_REQUIRED','STALE')
        THEN RAISE EXCEPTION 'simulated item recording failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_reconciliation_item BEFORE UPDATE ON reconciliation_items
        FOR EACH ROW EXECUTE FUNCTION reject_reconciliation_item();`);
    restore = () => sql("DROP TRIGGER reject_reconciliation_item ON reconciliation_items; DROP FUNCTION reject_reconciliation_item();");
    const response = await requestReconciliation({ ...ledgerDay("2010-01-02"), reason: "아이템 상태 기록 장애 검증" });
    assert.equal(response.status, 202); const { run } = await response.json();
    await until(() => proxy.forId(value.paymentId).length > 0, 60000); await delay(200);
    assert.equal(reconciliationItem(run.id, value.paymentId).status, "PROCESSING");
    await restart({ ...inboxOnly, MOCK_PG_BASE_URL: proxy.url, RECONCILIATION_LEASE_MS: "1200" });
    await until(() => reconciliationItem(run.id, value.paymentId).attempt_count === 3, 60000); await delay(1500);
    const calls = proxy.forId(value.paymentId).length;
    assert.ok(calls > 0 && calls <= 3);
    assert.equal(reconciliationItem(run.id, value.paymentId).status, "PROCESSING");
    assert.equal(incidentFor("PAYMENT", value.paymentId, "ORPHAN_PAYMENT"), null);
    restore(); restore = null;
    await completedReconciliation(run.id);
    assert.equal(reconciliationItem(run.id, value.paymentId).attempt_count, 3);
    assert.equal(reconciliationItem(run.id, value.paymentId).status, "REVIEW_REQUIRED");
    assert.equal(proxy.forId(value.paymentId).length, calls);
    assert.ok(incidentFor("PAYMENT", value.paymentId, "RECONCILIATION_QUERY_FAILED"));
    assert.equal(sql(`SELECT count(*) FROM orders WHERE id='${value.orderId}'`), "0");
  } finally { if (restore) restore(); await restart(); await proxy.close(); }
});

test("reconciliation expired page lease cannot publish an old cursor or exceed three failed provider reads", { timeout: 90000 }, async () => {
  const proxy = await providerProxy("mock-pg"); let release;
  try {
    let entered = false;
    const barrier = new Promise(resolve => { release = resolve; });
    proxy.intercept = async call => {
      if (call.path.startsWith("/internal/mock-pg/ledger/payments?") && call.path.includes("2011-01-01")) {
        entered = true; await barrier; return { status: 503 };
      }
      return null;
    };
    await restart({ ...inboxOnly, MOCK_PG_BASE_URL: proxy.url, PG_HTTP_TIMEOUT_MS: "5000", PAYMENT_LEASE_MS: "12000", RECONCILIATION_LEASE_MS: "12000" });
    const response = await requestReconciliation({ ...ledgerDay("2011-01-02"), reason: "페이지 lease와 재시도 상한 검증" });
    assert.equal(response.status, 202); const { run } = await response.json();
    await until(() => entered, 60000);
    const newerToken = randomUUID();
    sql(`UPDATE reconciliation_runs SET lease_token='${newerToken}',lease_until=clock_timestamp()+INTERVAL '1 hour' WHERE id='${run.id}'`);
    release(); await delay(500);
    assert.equal(reconciliationRow(run.id).lease_token, newerToken);
    assert.equal(reconciliationRow(run.id).last_error, null);
    assert.equal(reconciliationRow(run.id).cursor_id, null);
    sql(`UPDATE reconciliation_runs SET lease_until=clock_timestamp()-INTERVAL '1 second' WHERE id='${run.id}'`);
    await restart({ ...inboxOnly, MOCK_PG_BASE_URL: proxy.url, RECONCILIATION_LEASE_MS: "1200" });
    const done = await completedReconciliation(run.id);
    assert.equal(done.status, "REVIEW_REQUIRED"); assert.equal(done.page_attempt_count, 3);
    const count = proxy.calls.filter(call => call.path.startsWith("/internal/mock-pg/ledger/payments?") && call.path.includes("2011-01-01")).length;
    assert.ok(count > 0 && count <= 3);
    await restart({ ...inboxOnly, MOCK_PG_BASE_URL: proxy.url }); await delay(500);
    assert.equal(reconciliationRow(run.id).page_attempt_count, 3);
    assert.equal(proxy.calls.filter(call => call.path.startsWith("/internal/mock-pg/ledger/payments?") && call.path.includes("2011-01-01")).length, count);
  } finally { release?.(); await restart(); await proxy.close(); }
});

test("reconciliation scheduler persists fifteen-minute pending and daily seven-completed-KST-day runs across restart", { timeout: 90000 }, async () => {
  const existing = sql("SELECT count(*) FROM reconciliation_runs WHERE actor_id IS NULL");
  sql("UPDATE reconciliation_schedule SET next_at=clock_timestamp()-INTERVAL '1 second'");
  await restart({ ...inboxOnly, RECONCILIATION_SCHEDULE_ENABLED: "true" });
  await until(() => Number(sql("SELECT count(*) FROM reconciliation_runs WHERE actor_id IS NULL")) === Number(existing) + 2, 60000);
  const rows = JSON.parse(sql("SELECT json_agg(r) FROM (SELECT * FROM reconciliation_runs WHERE actor_id IS NULL ORDER BY created_at DESC LIMIT 2) r"));
  assert.deepEqual(rows.map(row => row.mode).sort(), ["LEDGER", "PENDING"]);
  const ledger = rows.find(row => row.mode === "LEDGER"), pending = rows.find(row => row.mode === "PENDING");
  const kstToday = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  assert.equal(new Date(ledger.to_at).toISOString(), new Date(`${kstToday}T00:00:00+09:00`).toISOString());
  assert.equal(Date.parse(ledger.to_at) - Date.parse(ledger.from_at), 7 * 24 * 60 * 60 * 1000);
  assert.equal(new Date(pending.from_at).toISOString(), "1970-01-01T00:00:00.000Z");
  const pendingDelay = Number(sql("SELECT EXTRACT(EPOCH FROM next_at-clock_timestamp()) FROM reconciliation_schedule WHERE mode='PENDING'"));
  assert.ok(pendingDelay > 850 && pendingDelay <= 900);
  const tomorrow = new Date(`${kstToday}T00:00:00+09:00`).getTime() + 24 * 60 * 60 * 1000;
  assert.equal(new Date(sql("SELECT next_at FROM reconciliation_schedule WHERE mode='LEDGER'")).getTime(), tomorrow);
  await restart({ ...inboxOnly, RECONCILIATION_SCHEDULE_ENABLED: "true" });
  await delay(500);
  assert.equal(Number(sql("SELECT count(*) FROM reconciliation_runs WHERE actor_id IS NULL")), Number(existing) + 2);
  await completedReconciliation(pending.id); await completedReconciliation(ledger.id);
  await restart();
});

test("reconciliation missing local issuance links on an approved order are quarantined without issuing a new request ID", { timeout: 75000 }, async () => {
  await restart(); const { order, attempt, job } = await failedOrder();
  await restart(inboxOnly);
  // Simulate missing restored business rows while retaining the independent provider ledger.
  sql(`DELETE FROM issuance_events WHERE issuance_id='${job.id}'; DELETE FROM issuance_jobs WHERE id='${job.id}'`);
  const providerBefore = await (await supplier(`/orders/${job.id}/stats`)).json();
  stampPayment(attempt.id, "2012-01-02");
  await runReconciliation(ledgerDay("2012-01-02"));
  assert.ok(incidentFor("PAYMENT", attempt.id, "MISSING_FULFILLMENT_LINK"));
  assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "0");
  assert.equal(sql(`SELECT count(*) FROM mock_supplier_orders WHERE order_id='${order.id}'`), "1");
  assert.deepEqual(await (await supplier(`/orders/${job.id}/stats`)).json(), providerBefore);
  assert.equal(orderState(order.id), "PAID");
  await restart(); await delay(300);
  assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "0");
});

test("reconciliation unknown local payment with an already issued provider order cannot create another issuance", { timeout: 75000 }, async () => {
  const { order, attempt } = await reviewPayment(true);
  const requestId = randomUUID();
  await restart({ PAYMENT_WORKER_DELAY_MS: "60000" });
  const response = await supplier("/orders", { requestId, orderId: order.id,
    simulation: { scenario: "SUCCEED", callbackCopies: 0, callbackDelayMs: 0 } });
  assert.equal(response.status, 202);
  await until(() => sql(`SELECT status FROM mock_supplier_orders WHERE request_id='${requestId}'`) === "ISSUED");
  stampPayment(attempt.id, "2013-01-02");
  await runReconciliation(ledgerDay("2013-01-02"));
  assert.ok(incidentFor("PAYMENT", attempt.id, "MISSING_FULFILLMENT_LINK"));
  assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
  assert.equal(sql(`SELECT status FROM payment_attempts WHERE id='${attempt.id}'`), "REVIEW_REQUIRED");
  assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "0");
  assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "0");
  assert.equal(sql(`SELECT count(*) FROM mock_supplier_orders WHERE order_id='${order.id}'`), "1");
  const stats = await (await supplier(`/orders/${requestId}/stats`)).json();
  assert.equal(stats.issueExecutions, 1); assert.equal(stats.requestCount, 1);
  await restart();
});

test("reconciliation finds an issued local job with its profile missing and preserves provider evidence", { timeout: 75000 }, async () => {
  await restart(); const { order, job } = await trackingProfile();
  await restart(inboxOnly);
  const profileId = sql(`SELECT id FROM sim_profiles WHERE order_id='${order.id}'`);
  const providerBefore = await (await supplier(`/orders/${job.id}/stats`)).json();
  sql(`DELETE FROM sim_profile_events WHERE profile_id='${profileId}'; DELETE FROM sim_profiles WHERE id='${profileId}'`);
  await runReconciliation({ mode: "PENDING" });
  assert.ok(incidentFor("ISSUANCE", job.id, "MISSING_PROFILE_LINK"));
  assert.equal(issuanceRow(order.id).id, job.id); assert.equal(issuanceRow(order.id).status, "ISSUED");
  assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "0");
  assert.equal(sql(`SELECT count(*) FROM mock_supplier_profiles WHERE request_id='${job.id}'`), "1");
  assert.deepEqual(await (await supplier(`/orders/${job.id}/stats`)).json(), providerBefore);
  assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${order.id}'`), "1");
  await restart();
});

test("reconciliation financial lookup racing duplicate PG webhooks discards its stale result without approving twice", { timeout: 75000 }, async () => {
  const proxy = await providerProxy("mock-pg"); let release;
  try {
    const { order, attempt } = await reviewPayment(true, { MOCK_PG_BASE_URL: proxy.url,
      PG_HTTP_TIMEOUT_MS: "20000", PAYMENT_LEASE_MS: "45000", RECONCILIATION_LEASE_MS: "60000" });
    const before = sql("SELECT max(last_successful_at) FROM reconciliation_schedule");
    const result = await (await pg(`/payments/${attempt.id}`)).json();
    let entered = false;
    const barrier = new Promise(resolve => { release = resolve; });
    proxy.intercept = async call => {
      if (call.path === `/internal/mock-pg/ledger/payments/${attempt.id}`) { entered = true; await barrier; }
      return null;
    };
    const response = await requestReconciliation({ mode: "PENDING", reason: "대사 조회 중 중복 승인 웹훅" });
    assert.equal(response.status, 202); const { run } = await response.json();
    await until(() => entered, 60000);
    const responses = await Promise.all(Array.from({ length: 20 }, () => notify(result)));
    assert.ok(responses.every(response => [200, 202].includes(response.status)));
    const receipts = await Promise.all(responses.map(response => response.json()));
    assert.equal(new Set(receipts.map(receipt => receipt.id)).size, 1);
    await until(() => inboundRow(receipts[0].id)?.status === "PROCESSED");
    assert.equal(orderState(order.id), "PAID");
    release();
    const done = await completedReconciliation(run.id);
    assert.equal(done.status, "REVIEW_REQUIRED");
    assert.equal(reconciliationItem(run.id, attempt.id).status, "STALE");
    assert.equal(reconciliationItem(run.id, attempt.id).attempt_count, 1);
    assert.equal(sql("SELECT max(last_successful_at) FROM reconciliation_schedule"), before);
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "1");
    assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "1");
    assert.equal(sql(`SELECT approval_executions FROM mock_pg_payments WHERE payment_id='${attempt.id}'`), "1");
    assert.ok(proxy.forId(attempt.id).every(call => call.method === "GET"));
  } finally { release?.(); await restart(); await proxy.close(); }
});

test("reconciliation issuance-only pending lookup checks cancelled funding before creating a SIM profile", { timeout: 75000 }, async () => {
  try {
    await restart({ ISSUANCE_WORKER_DELAY_MS: "60000" });
    const { order, attempt, job, simulation } = await issueOrder({ scenario: "SUCCEED", callbackCopies: 0, callbackDelayMs: 0 });
    // Keep the normal issuance worker away while the independent supplier finishes the request.
    sql(`UPDATE issuance_jobs SET next_check_at=clock_timestamp()+INTERVAL '1 day',
      created_at=clock_timestamp()-INTERVAL '3 minutes' WHERE id='${job.id}'`);
    await restart({ PAYMENT_WORKER_DELAY_MS: "60000" });
    const response = await supplier("/orders", { requestId: job.id, orderId: order.id, simulation });
    assert.equal(response.status, 202);
    await until(() => sql(`SELECT status FROM mock_supplier_orders WHERE request_id='${job.id}'`) === "ISSUED");
    const cancellationResponse = await pg(`/payments/${attempt.id}/cancel`, { amount: order.amount, scenario: "SUCCESS" });
    assert.equal(cancellationResponse.status, 200); const cancellation = await cancellationResponse.json();
    await restart(inboxOnly);
    assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "0");
    const run = await runReconciliation({ mode: "PENDING" });
    assert.equal(reconciliationItem(run.id, job.id).kind, "ISSUANCE");
    assert.equal(reconciliationItem(run.id, attempt.id), null);
    assert.ok(incidentFor("ISSUANCE", job.id, "EXTERNAL_CANCELLATION_UNMATCHED"));
    assert.equal(issuanceRow(order.id).status, "QUEUED"); assert.equal(orderState(order.id), "REFUNDED");
    assert.equal(sql(`SELECT sum(amount) FROM refund_ledger WHERE payment_id='${attempt.id}'`),String(order.amount));
    assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "0");
    assert.equal(sql(`SELECT count(*) FROM refunds WHERE order_id='${order.id}'`), "0");
    assert.equal(sql(`SELECT count(*) FROM external_cancellations WHERE id='${cancellation.id}'`), "1");
    const stats = await (await supplier(`/orders/${job.id}/stats`)).json();
    assert.equal(stats.issueExecutions, 1); assert.equal(stats.requestCount, 1);
  } finally { await restart(); }
});

test("reconciliation rejects a provider ledger cursor moving backwards without checkpointing or retrying forever", { timeout: 75000 }, async () => {
  const proxy = await providerProxy("mock-pg"), paymentId = randomUUID(), orderId = randomUUID();
  const matches = call => call.path.startsWith("/internal/mock-pg/ledger/payments?") && call.path.includes("2014-01-01");
  try {
    proxy.intercept = call => matches(call) ? { status: 200, body: {
      items: [{ id: paymentId, orderId, paymentId, occurredAt: "2014-01-01T15:00:00Z" }],
      nextTime: "2014-01-01T14:59:59Z", nextId: paymentId,
    } } : null;
    await restart({ ...inboxOnly, MOCK_PG_BASE_URL: proxy.url, RECONCILIATION_PAGE_SIZE: "1" });
    const before = sql("SELECT max(last_successful_at) FROM reconciliation_schedule");
    const run = await runReconciliation(ledgerDay("2014-01-02"));
    assert.equal(run.status, "REVIEW_REQUIRED"); assert.equal(run.last_error, "RECONCILIATION_INVALID_PROVIDER_RESULT");
    assert.equal(run.page_attempt_count, 1); assert.equal(run.cursor_id, null); assert.equal(run.cursor_time, null);
    assert.equal(proxy.calls.filter(matches).length, 1);
    assert.equal(reconciliationItem(run.id, paymentId), null);
    assert.equal(sql(`SELECT count(*) FROM orders WHERE id='${orderId}'`), "0");
    assert.equal(sql("SELECT max(last_successful_at) FROM reconciliation_schedule"), before);
    await restart({ ...inboxOnly, MOCK_PG_BASE_URL: proxy.url }); await delay(500);
    assert.equal(proxy.calls.filter(matches).length, 1);
    assert.equal(reconciliationRow(run.id).page_attempt_count, 1);
  } finally { await restart(); await proxy.close(); }
});

const monitoringPaused = { MONITORING_ENABLED: "true", PAYMENT_WORKER_DELAY_MS: "3600000",
  ISSUANCE_WORKER_DELAY_MS: "3600000", WEBHOOK_WORKER_DELAY_MS: "3600000",
  RECOVERY_WORKER_DELAY_MS: "3600000", RECONCILIATION_WORKER_DELAY_MS: "3600000" };
async function monitoringView(client = admin) {
  const response = await client.request("/api/admin/monitoring");
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}
async function monitorScan() {
  const before = sql("SELECT last_checked_at FROM monitoring_status");
  await until(() => sql("SELECT last_checked_at FROM monitoring_status") !== before);
}
async function pausedMonitor(extra = {}) {
  await restart({ ...monitoringPaused, ...extra });
  await until(() => sql("SELECT count(*) FROM worker_heartbeats") === "8");
  sql("UPDATE worker_heartbeats SET initialized_at=clock_timestamp(),last_seen_at=clock_timestamp()");
  await monitorScan();
}
function monitorIncident(kind, reference, code) {
  const value = sql(`SELECT row_to_json(i) FROM incidents i WHERE kind='${kind}' AND external_reference='${reference}' AND code='${code}'`);
  return value ? JSON.parse(value) : null;
}
function incidentEvents(id) { return Number(sql(`SELECT count(*) FROM incident_events WHERE incident_id='${id}'`)); }

test("monitoring admin-only snapshots expose thresholds and worker signals without changing normal payment issuance or refund", { timeout: 90000 }, async () => {
  await restart({ MONITORING_ENABLED: "true" });
  try {
    assert.equal((await new Client().request("/api/admin/monitoring")).status, 401);
    assert.equal((await alice.request("/api/admin/monitoring")).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${servicePort}/api/admin/monitoring`)).status, 403);
    await until(async () => (await monitoringView()).workers.every(worker => !worker.enabled || worker.lastSeenAt));
    const data = await monitoringView();
    assert.equal(data.heartbeatThresholdSeconds, 60); assert.equal(data.backlogThresholdSeconds, 120);
    assert.equal(data.supplierThresholdSeconds, 300); assert.equal(data.workers.length, 8);
    assert.ok(!/activationCode|password|apiKey|leaseToken/.test(JSON.stringify(data)));
    const issued = await trackingProfile(); assert.equal(issuanceRow(issued.order.id).status, "ISSUED");
    const failed = await failedOrder();
    assert.equal((await adminAction(failed.order.id, "refunds", refundRequest(failed.job))).status, 202);
    await until(() => refundRow(failed.order.id)?.status === "SUCCEEDED");
    assert.equal(orderState(failed.order.id), "REFUNDED");
    assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${failed.attempt.id}'`), "1");
  } finally { await restart(); }
});

test("monitoring missed heartbeat deduplicates preserves investigation across restart and reopens after recovery", { timeout: 90000 }, async () => {
  await pausedMonitor();
  try {
    sql("UPDATE worker_heartbeats SET last_seen_at=clock_timestamp()-INTERVAL '50 seconds' WHERE name='PAYMENT'");
    await monitorScan();
    assert.notEqual(monitorIncident("WORKER", "PAYMENT", "WORKER_HEARTBEAT_MISSING")?.status, "OPEN");
    sql("UPDATE worker_heartbeats SET last_seen_at=clock_timestamp()-INTERVAL '61 seconds' WHERE name='PAYMENT'");
    await until(() => monitorIncident("WORKER", "PAYMENT", "WORKER_HEARTBEAT_MISSING")?.status === "OPEN");
    const incident = monitorIncident("WORKER", "PAYMENT", "WORKER_HEARTBEAT_MISSING");
    const body = { expectedVersion: incident.version, reason: "워커 신호 누락 확인 중" }, key = randomUUID();
    const investigate = () => admin.request(`/api/admin/incidents/${incident.id}/investigations`, { method: "POST",
      headers: { "Idempotency-Key": key, ...investigationCsrf }, body });
    const investigationCsrf = await admin.csrf();
    const responses = await Promise.all(Array.from({ length: 20 }, investigate));
    assert.equal(responses.filter(r => r.status === 202).length, 1);
    assert.ok(responses.every(r => [200, 202].includes(r.status)));
    const count = incidentEvents(incident.id);
    await monitorScan(); await monitorScan(); assert.equal(incidentEvents(incident.id), count);
    await restart(monitoringPaused); await monitorScan();
    const retained = monitorIncident("WORKER", "PAYMENT", "WORKER_HEARTBEAT_MISSING");
    assert.equal(retained.id, incident.id); assert.equal(retained.status, "INVESTIGATING");
    assert.equal(retained.actor_id, admin.memberId); assert.equal(incidentEvents(incident.id), count);
    await restart({ MONITORING_ENABLED: "true" });
    await until(() => monitorIncident("WORKER", "PAYMENT", "WORKER_HEARTBEAT_MISSING")?.status === "RESOLVED");
    assert.equal(incidentEvents(incident.id), count + 1);
    await pausedMonitor();
    sql("UPDATE worker_heartbeats SET last_seen_at=clock_timestamp()-INTERVAL '61 seconds' WHERE name='PAYMENT'");
    await until(() => monitorIncident("WORKER", "PAYMENT", "WORKER_HEARTBEAT_MISSING")?.status === "OPEN");
    assert.equal(monitorIncident("WORKER", "PAYMENT", "WORKER_HEARTBEAT_MISSING").id, incident.id);
    assert.equal(incidentEvents(incident.id), count + 2);
    sql(`UPDATE incident_events SET reason='tamper' WHERE incident_id='${incident.id}'`, true, true);
    sql(`DELETE FROM incident_actions WHERE incident_id='${incident.id}'`, true, true);
  } finally { await restart(); }
});

test("monitoring records a persisted signal gap even when the service restarts before its next scan", { timeout: 60000 }, async () => {
  await pausedMonitor();
  try {
    const before = Number(sql("SELECT count(*) FROM incident_events e JOIN incidents i ON i.id=e.incident_id WHERE i.kind='WORKER' AND i.external_reference='REFUND'"));
    await restart();
    sql("UPDATE worker_heartbeats SET last_seen_at=clock_timestamp()-INTERVAL '70 seconds' WHERE name='REFUND'");
    await restart({ MONITORING_ENABLED: "true" });
    await until(() => monitorIncident("WORKER", "REFUND", "WORKER_HEARTBEAT_MISSING")?.status === "RESOLVED");
    const incident = monitorIncident("WORKER", "REFUND", "WORKER_HEARTBEAT_MISSING");
    assert.equal(incidentEvents(incident.id), before + 2);
    assert.ok(sql(`SELECT string_agg(status,',' ORDER BY id) FROM incident_events WHERE incident_id='${incident.id}'`).endsWith("OPEN,RESOLVED"));
  } finally { await restart(); }
});

test("monitoring executable backlog ignores future retries and active leases and clears only the queue incident", { timeout: 60000 }, async () => {
  await pausedMonitor();
  try {
    const a = await newOrder(), b = await newOrder(), c = await newOrder();
    const pa = await (await alice.pay(a.id)).json(), pb = await (await alice.pay(b.id)).json(), pc = await (await alice.pay(c.id)).json();
    sql(`UPDATE payment_attempts SET next_attempt_at=clock_timestamp()+INTERVAL '1 hour' WHERE id='${pa.id}';
      UPDATE payment_attempts SET status='PROCESSING',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+INTERVAL '1 hour',
      next_attempt_at=clock_timestamp()-INTERVAL '1 hour' WHERE id='${pb.id}';
      UPDATE payment_attempts SET next_attempt_at=clock_timestamp()-INTERVAL '110 seconds' WHERE id='${pc.id}'`);
    await monitorScan();
    let queue = (await monitoringView()).queues.find(row => row.name === "PAYMENT");
    assert.equal(queue.overdue, false); assert.equal(queue.oldestId, pc.id);
    sql(`UPDATE payment_attempts SET next_attempt_at=clock_timestamp()-INTERVAL '121 seconds' WHERE id='${pc.id}'`);
    await until(() => monitorIncident("QUEUE", "PAYMENT", "EXECUTABLE_BACKLOG")?.status === "OPEN");
    const incident = monitorIncident("QUEUE", "PAYMENT", "EXECUTABLE_BACKLOG"), count = incidentEvents(incident.id);
    await monitorScan(); assert.equal(incidentEvents(incident.id), count);
    queue = (await monitoringView()).queues.find(row => row.name === "PAYMENT");
    assert.equal(queue.oldestId, pc.id); assert.equal(queue.orderId, c.id);
    assert.equal(sql(`SELECT count(*) FROM mock_pg_payments WHERE payment_id IN ('${pa.id}','${pb.id}','${pc.id}')`), "0");
    sql(`UPDATE payment_attempts SET next_attempt_at=clock_timestamp()+INTERVAL '1 hour' WHERE id='${pc.id}'`);
    await until(() => monitorIncident("QUEUE", "PAYMENT", "EXECUTABLE_BACKLOG")?.status === "RESOLVED");
    assert.equal(sql(`SELECT attempt_count FROM payment_attempts WHERE id='${pc.id}'`), "0");
    assert.equal(sql(`SELECT status FROM payment_attempts WHERE id='${pb.id}'`), "PROCESSING");
  } finally { await restart(); }
});

test("monitoring supplier failures retain their first failure time and resolve after a real supplier refresh", { timeout: 90000 }, async () => {
  const { profile } = await trackingProfile();
  await pausedMonitor();
  try {
    sql(`UPDATE sim_profiles SET sync_error='SUPPLIER_PROFILE_UNAVAILABLE' WHERE id='${profile.id}'`);
    assert.ok(sql(`SELECT sync_failure_since FROM sim_profiles WHERE id='${profile.id}'`));
    sql(`UPDATE sim_profiles SET sync_failure_since=clock_timestamp()-INTERVAL '290 seconds' WHERE id='${profile.id}'`);
    await monitorScan(); assert.equal(incidentFor("PROFILE", profile.id, "SUPPLIER_CONFIRMATION_DELAYED"), null);
    sql(`UPDATE sim_profiles SET sync_failure_since=clock_timestamp()-INTERVAL '301 seconds' WHERE id='${profile.id}'`);
    const since = sql(`SELECT sync_failure_since FROM sim_profiles WHERE id='${profile.id}'`);
    sql(`UPDATE sim_profiles SET sync_error='SUPPLIER_PROFILE_UNAVAILABLE' WHERE id='${profile.id}'`);
    assert.equal(sql(`SELECT sync_failure_since FROM sim_profiles WHERE id='${profile.id}'`), since);
    await until(() => incidentFor("PROFILE", profile.id, "SUPPLIER_CONFIRMATION_DELAYED")?.status === "OPEN");
    const incident = incidentFor("PROFILE", profile.id, "SUPPLIER_CONFIRMATION_DELAYED"), count = incidentEvents(incident.id);
    sql(`INSERT INTO incidents(id,kind,target_id,code,reason) VALUES(gen_random_uuid(),'PROFILE','${profile.id}','MANUAL_REVIEW','별도 조사')`);
    await restart(monitoringPaused); await monitorScan();
    assert.equal(incidentFor("PROFILE", profile.id, "SUPPLIER_CONFIRMATION_DELAYED").id, incident.id);
    assert.equal(incidentEvents(incident.id), count);
    sql(`UPDATE sim_profiles SET next_sync_at=clock_timestamp(),sync_lease_token=NULL,sync_lease_until=NULL WHERE id='${profile.id}'`);
    await restart({ MONITORING_ENABLED: "true" });
    await until(() => incidentFor("PROFILE", profile.id, "SUPPLIER_CONFIRMATION_DELAYED")?.status === "RESOLVED");
    assert.equal(sql(`SELECT sync_failure_since FROM sim_profiles WHERE id='${profile.id}'`), "");
    assert.equal(incidentFor("PROFILE", profile.id, "MANUAL_REVIEW").status, "OPEN");
  } finally { await restart(); }
});

test("monitoring tracks issuance confirmation failure duration without resetting business retry budgets", { timeout: 60000 }, async () => {
  const { order, job } = await failedOrder();
  await pausedMonitor();
  try {
    sql(`UPDATE issuance_jobs SET status='REVIEW_REQUIRED',last_error='SUPPLIER_RETRY_LIMIT_REACHED' WHERE id='${job.id}';
      UPDATE issuance_jobs SET supplier_failure_since=clock_timestamp()-INTERVAL '301 seconds' WHERE id='${job.id}'`);
    const counts = sql(`SELECT check_count||':'||submission_count||':'||execution_round FROM issuance_jobs WHERE id='${job.id}'`);
    await until(() => incidentFor("ISSUANCE", job.id, "SUPPLIER_CONFIRMATION_DELAYED")?.status === "OPEN");
    assert.equal(sql(`SELECT check_count||':'||submission_count||':'||execution_round FROM issuance_jobs WHERE id='${job.id}'`), counts);
    assert.equal(orderState(order.id), "PAID");
    sql(`UPDATE issuance_jobs SET status='FAILED',last_error=NULL WHERE id='${job.id}'`);
    await until(() => incidentFor("ISSUANCE", job.id, "SUPPLIER_CONFIRMATION_DELAYED")?.status === "RESOLVED");
  } finally { await restart(); }
});

test("monitoring conflict alerts are immediate transactional and do not wait for scheduled reconciliation", { timeout: 75000 }, async () => {
  const { order, attempt } = await reviewPayment(true);
  const approved = await (await pg(`/payments/${attempt.id}`)).json();
  const mismatch = { ...approved, amount: order.amount + 1 };
  await webhookCopies(await Promise.all(Array.from({ length: 20 }, () => notify(mismatch))), 409);
  const incident = incidentFor("PAYMENT", attempt.id, "ORDER_RESULT_CONFLICT");
  assert.ok(incident); assert.equal(incident.status, "OPEN"); assert.equal(incidentEvents(incident.id), 1);
  const snapshot = await monitoringView();
  assert.ok(snapshot.alerts.some(alert => alert.incidentId === incident.id));
  assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
  const other = await newOrder(), target = randomUUID(), before = sql("SELECT count(*) FROM incidents");
  sql(`BEGIN; INSERT INTO order_conflicts(id,order_id,target,target_id,code,source,payload_hash)
    VALUES(gen_random_uuid(),'${other.id}','PAYMENT','${target}','TEST_ROLLBACK','TEST','${"b".repeat(64)}'); ROLLBACK;`);
  assert.equal(sql("SELECT count(*) FROM incidents"), before);
  await restart();
});

test("monitoring scan DB failure rolls back incidents and alerts and stale snapshots cannot claim health", { timeout: 90000 }, async () => {
  await pausedMonitor();
  try {
    const old = monitorIncident("WORKER", "RECOVERY", "WORKER_HEARTBEAT_MISSING");
    const oldEvents = old ? incidentEvents(old.id) : 0;
    sql("CREATE FUNCTION fail_monitor_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'monitor storage failure'; END $$; CREATE TRIGGER fail_monitor_commit BEFORE UPDATE ON monitoring_status FOR EACH ROW EXECUTE FUNCTION fail_monitor_commit();");
    sql("ALTER TABLE monitoring_status DISABLE TRIGGER fail_monitor_commit; UPDATE monitoring_status SET last_checked_at=clock_timestamp()-INTERVAL '31 seconds'; ALTER TABLE monitoring_status ENABLE TRIGGER fail_monitor_commit;");
    sql("UPDATE worker_heartbeats SET last_seen_at=clock_timestamp()-INTERVAL '61 seconds' WHERE name='RECOVERY'");
    const before = sql("SELECT last_checked_at FROM monitoring_status");
    await delay(1400);
    assert.equal(sql("SELECT last_checked_at FROM monitoring_status"), before);
    assert.equal(monitorIncident("WORKER", "RECOVERY", "WORKER_HEARTBEAT_MISSING")?.status, old?.status);
    assert.equal((await monitoringView()).status, "STALE");
    await restart(monitoringPaused); await delay(1000);
    assert.equal(monitorIncident("WORKER", "RECOVERY", "WORKER_HEARTBEAT_MISSING")?.status, old?.status);
    sql("DROP TRIGGER fail_monitor_commit ON monitoring_status; DROP FUNCTION fail_monitor_commit();");
    await until(() => monitorIncident("WORKER", "RECOVERY", "WORKER_HEARTBEAT_MISSING")?.status === "OPEN");
    const incident = monitorIncident("WORKER", "RECOVERY", "WORKER_HEARTBEAT_MISSING");
    assert.equal(incidentEvents(incident.id), oldEvents + 1);
    sql("REVOKE SELECT ON monitoring_status FROM alpha_media_app");
    const unavailable = await admin.request("/api/admin/monitoring");
    assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).code, "MONITORING_UNAVAILABLE");
  } finally {
    sql("DROP TRIGGER IF EXISTS fail_monitor_commit ON monitoring_status; DROP FUNCTION IF EXISTS fail_monitor_commit(); GRANT SELECT ON monitoring_status TO alpha_media_app;");
    await restart();
  }
});

test("monitoring disabled providers do not raise heartbeat incidents and operational incidents never become payment reconciliation items", { timeout: 60000 }, async () => {
  await pausedMonitor({ MOCK_PG_ENABLED: "false", MOCK_SUPPLIER_ENABLED: "false" });
  try {
    sql("UPDATE worker_heartbeats SET last_seen_at=clock_timestamp()-INTERVAL '1 hour' WHERE name IN ('PAYMENT','REFUND','ISSUANCE','PROFILE','RECONCILIATION')");
    await monitorScan();
    const data = await monitoringView();
    assert.ok(data.workers.filter(w => ['PAYMENT','REFUND','ISSUANCE','PROFILE','RECONCILIATION'].includes(w.name)).every(w => !w.enabled));
    assert.equal(sql("SELECT count(*) FROM incidents WHERE kind='WORKER' AND external_reference IN ('PAYMENT','REFUND','ISSUANCE','PROFILE','RECONCILIATION') AND status<>'RESOLVED'"), "0");
    await restart({ ...monitoringPaused, RECONCILIATION_WORKER_DELAY_MS: "100" });
    await monitorScan();
    assert.equal(sql("SELECT count(*) FROM incidents WHERE kind='WORKER' AND external_reference IN ('PAYMENT','REFUND','ISSUANCE','PROFILE','RECONCILIATION') AND status<>'RESOLVED'"), "0");
    const enabledPayment = (await monitoringView()).workers.find(worker => worker.name === "PAYMENT");
    assert.equal(enabledPayment.lastSeenAt, null); assert.ok(enabledPayment.silentSeconds < 60);
    sql("UPDATE worker_heartbeats SET last_seen_at=clock_timestamp()-INTERVAL '61 seconds' WHERE name='PAYMENT'");
    await until(() => monitorIncident("WORKER", "PAYMENT", "WORKER_HEARTBEAT_MISSING")?.status === "OPEN");
    const run = await runReconciliation({ mode: "PENDING" });
    assert.equal(sql(`SELECT count(*) FROM reconciliation_items WHERE run_id='${run.id}' AND kind NOT IN ('PAYMENT','ISSUANCE','REFUND')`), "0");
    assert.equal(monitorIncident("WORKER", "PAYMENT", "WORKER_HEARTBEAT_MISSING").status, "OPEN");
  } finally { await restart(); }
});

test("monitoring heartbeat storage failure cannot prevent business processing or create duplicate approvals", { timeout: 60000 }, async () => {
  await restart({ MONITORING_ENABLED: "true" });
  try {
    sql("REVOKE UPDATE(last_seen_at) ON worker_heartbeats FROM alpha_media_app");
    await restart({ MONITORING_ENABLED: "true" });
    const { order, attempt } = await trackingProfile();
    assert.equal(orderState(order.id), "PAID");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "1");
    assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "1");
    assert.equal(sql(`SELECT approval_executions FROM mock_pg_payments WHERE payment_id='${attempt.id}'`), "1");
  } finally { sql("GRANT UPDATE(last_seen_at) ON worker_heartbeats TO alpha_media_app"); await restart(); }
});

function securityPayload(source="PG") {
  const shared={eventId:randomUUID(),orderId:randomUUID()};
  if (source==="PG") return {...shared,paymentId:randomUUID(),amount:15900,currency:"KRW",status:"APPROVED",transactionId:"test-"+randomUUID(),declineCode:null};
  if (source==="SUPPLIER") return {...shared,requestId:randomUUID(),supplierOrderNo:"test-"+randomUUID(),status:"FAILED",revision:2,iccid:null,activationCode:null,reason:"MOCK_ISSUANCE_FAILED"};
  return {...shared,requestId:randomUUID(),iccid:"0".repeat(19),state:"RELEASED",revision:1,observedAt:"2020-01-01T00:00:00Z",installedAt:null,activatedAt:null};
}
const securityPath=source=>source==="PG"?"/webhooks/pg":source==="SUPPLIER"?"/webhooks/supplier":"/webhooks/supplier/profiles";
async function securityPost(source,payload,overrides={},headers={}) {
  const body=typeof payload==="string"?payload:JSON.stringify(payload);
  return fetch(base+securityPath(source),{method:"POST",body,headers:{...signedHeaders(body,source==="PG"?"PG":"SUPPLIER",true,overrides),...headers}});
}
async function freshRateWindow() {
  const seconds=Number(sql("SELECT EXTRACT(SECOND FROM clock_timestamp())::int"));
  if (seconds>45) await delay((61-seconds)*1000);
  sql("TRUNCATE request_rate_buckets");
}
async function stopChild(child) {
  if (child && child.exitCode===null && child.signalCode===null) { const exited=once(child,"exit"); child.kill(); await exited; }
}
function rawChunked(url,body,headers={}) {
  return new Promise((resolve,reject)=>{
    const request=httpRequest(url,{method:"POST",headers:{"Content-Type":"application/json",...headers}},response=>{
      let data=""; response.on("data",part=>data+=part); response.on("end",()=>resolve({status:response.statusCode,body:data}));
    });
    request.on("error",reject); request.write(body.slice(0,8000)); request.end(body.slice(8000));
  });
}
test("request security bounds declared and chunked bodies before Gateway and Service parsing while form login survives",{timeout:60000},async()=>{
  const large=" ".repeat(16385),exact=" ".repeat(16384);
  for (const origin of [base,"http://127.0.0.1:"+servicePort]) {
    for (const path of ["/api/auth/login","/api/orders","/webhooks/pg","/webhooks/supplier/profiles"]) {
      const response=await fetch(origin+path,{method:"POST",body:large,headers:{"Content-Type":"application/json"}});
      assert.equal(response.status,413); assert.equal((await response.json()).code,"BODY_TOO_LARGE");
      assert.equal((await rawChunked(origin+path,large)).status,413);
    }
    const bounded=await fetch(origin+"/webhooks/pg",{method:"POST",body:exact,headers:{"X-Gateway-Token":secret,...signedHeaders(exact)}});
    assert.equal(bounded.status,400);
    assert.equal((await fetch(origin+"/webhooks/pg",{method:"POST",body:"{}",headers:{"Content-Encoding":"gzip"}})).status,415);
  }
  const c=new Client(),form=new URLSearchParams({username:"customer1",password}).toString();
  const response=await c.request("/api/auth/login",{method:"POST",headers:{...await c.csrf(),"Content-Type":"application/x-www-form-urlencoded"},
    body:form+"&pad="+"x".repeat(16384-form.length-5)});
  assert.equal(response.status,200);
});
test("request security shares thirty member writes across two instances and retains the budget after restart",{timeout:120000},async()=>{
  const config={REQUEST_RATE_LIMIT_ENABLED:"true"};
  await restart(config); let second;
  try {
    const otherPort=await port();
    second=await startService({...config,PORT:String(otherPort),MOCK_PG_ENABLED:"false",MOCK_SUPPLIER_ENABLED:"false"});
    const key=randomUUID(),headers={...await alice.csrf(),"Idempotency-Key":key,"Content-Type":"application/json"};
    const cookie=[...alice.cookies].map(([k,v])=>k+"="+v).join("; ");
    const body=JSON.stringify({planId:"jp-esim-7d",travelStartDate:future});
    await freshRateWindow();
    const replies=await Promise.all(Array.from({length:40},(_,index)=>fetch(
      index%2?base+"/api/orders":"http://127.0.0.1:"+otherPort+"/api/orders",{
        method:"POST",body,headers:{...headers,Cookie:cookie,"X-Gateway-Token":secret,"X-Gateway-Client-IP":"127.0.0.1"}
      })));
    assert.equal(replies.filter(r=>r.status===201).length,1);
    assert.equal(replies.filter(r=>r.status===200).length,29);
    assert.equal(replies.filter(r=>r.status===429).length,10);
    for (const r of replies.filter(r=>r.status===429)) assert.ok(Number(r.headers.get("Retry-After"))>=1 && Number(r.headers.get("Retry-After"))<=60);
    const window=sql("SELECT max(window_start) FROM request_rate_buckets WHERE scope='WRITE_MEMBER'");
    await stopChild(second); await restart(config);
    assert.equal(sql("SELECT max(window_start) FROM request_rate_buckets WHERE scope='WRITE_MEMBER'"),window);
    assert.equal((await alice.request("/api/orders",{method:"POST",headers:{...await alice.csrf(),"Idempotency-Key":key},body:JSON.parse(body)})).status,429);
    assert.equal((await bob.create()).status,201);
    assert.equal(sql("SELECT max(hits) FROM request_rate_buckets WHERE scope='WRITE_MEMBER'"),"31");
    sql("UPDATE request_rate_buckets SET window_start=window_start-INTERVAL '1 minute'");
    assert.equal((await alice.request("/api/orders",{method:"POST",headers:{...await alice.csrf(),"Idempotency-Key":key},body:JSON.parse(body)})).status,200);
  } finally { await stopChild(second); await restart(); }
});
test("request security login enforces five attempts per account and thirty per IP despite spoofed forwarding headers",{timeout:120000},async()=>{
  await restart({REQUEST_RATE_LIMIT_ENABLED:"true"});
  try {
    const c=new Client(),csrf=await c.csrf();
    const login=(username,index=0)=>c.request("/api/auth/login",{method:"POST",
      headers:{...csrf,"Content-Type":"application/x-www-form-urlencoded","X-Forwarded-For":"198.51.100."+index,"Forwarded":"for=198.51.100."+index,
        "X-Gateway-Client-IP":"198.51.100."+index},
      body:new URLSearchParams({username,password:"incorrect"}).toString()});
    await freshRateWindow();
    for(let i=0;i<5;i++) assert.equal((await login("customer1",i)).status,401);
    assert.equal((await login("customer1",6)).status,429);
    assert.equal((await login("customer2",7)).status,401);
    assert.equal(sql("SELECT count(*) FROM request_rate_buckets WHERE scope='LOGIN_IP'"),"1");
    sql("TRUNCATE request_rate_buckets");
    for(let i=0;i<30;i++) assert.equal((await login("unknown-"+i,i)).status,401);
    assert.equal((await login("fresh-account",31)).status,429);
    assert.equal(sql("SELECT count(*) FROM request_rate_buckets WHERE scope='LOGIN_ACCOUNT'"),"30");
    assert.equal(sql("SELECT count(*) FROM request_rate_buckets WHERE subject_hash LIKE '%customer%'"),"0");
  } finally { await restart(); }
});
test("request security read webhook and write budgets are separate and IP limits cover shared accounts",{timeout:90000},async()=>{
  await restart({REQUEST_RATE_LIMIT_ENABLED:"true",REQUEST_READ_IP_LIMIT:"3",REQUEST_WEBHOOK_IP_LIMIT:"2",REQUEST_WRITE_IP_LIMIT:"2"});
  try {
    const a=await alice.csrf(),b=await bob.csrf(); await freshRateWindow();
    for(let i=0;i<3;i++) assert.equal((await fetch(base+"/api/plans")).status,200);
    const read=await fetch(base+"/api/plans",{headers:{"X-Gateway-Client-IP":"10.0.0.1"}});
    assert.equal(read.status,429); assert.ok(read.headers.get("Retry-After"));
    assert.equal((await fetch("http://127.0.0.1:"+servicePort+"/health")).status,200);
    for (const [client,csrf] of [[alice,a],[bob,b]]) assert.equal((await client.request("/api/orders",{method:"POST",
      headers:{...csrf,"Idempotency-Key":randomUUID()},body:{planId:"jp-esim-7d",travelStartDate:future}})).status,201);
    assert.equal((await alice.request("/api/orders",{method:"POST",headers:{...a,"Idempotency-Key":randomUUID()},body:{}})).status,429);
    for(let i=0;i<2;i++) assert.equal((await securityPost("PG",securityPayload())).status,202);
    assert.equal((await securityPost("PG",securityPayload())).status,429);
  } finally { await restart(); }
});
test("request security limiter DB failure refuses business execution and the same request key succeeds after repair",{timeout:60000},async()=>{
  await restart({REQUEST_RATE_LIMIT_ENABLED:"true"});
  const key=randomUUID(),headers={...await alice.csrf(),"Idempotency-Key":key};
  const body={planId:"jp-esim-7d",travelStartDate:future},before=sql("SELECT count(*) FROM orders");
  try {
    sql("REVOKE INSERT ON request_rate_buckets FROM alpha_media_app");
    const response=await alice.request("/api/orders",{method:"POST",headers,body});
    assert.equal(response.status,503); assert.equal((await response.json()).code,"REQUEST_GUARD_UNAVAILABLE");
    assert.equal(sql("SELECT count(*) FROM orders"),before);
    sql("GRANT INSERT ON request_rate_buckets TO alpha_media_app");
    assert.equal((await alice.request("/api/orders",{method:"POST",headers,body})).status,201);
    assert.equal((await alice.request("/api/orders",{method:"POST",headers,body})).status,200);
  } finally { sql("GRANT INSERT ON request_rate_buckets TO alpha_media_app"); await restart(); }
});
test("request security webhook signature binds bytes key ID provider and timestamp without creating inbox or business evidence",async()=>{
  const payload=securityPayload(),body=JSON.stringify(payload),valid=signedHeaders(body),before=sql("SELECT count(*) FROM inbound_events");
  for(const headers of [
    {...valid,"X-Signature":"0".repeat(64)},{...valid,"X-Key-Id":"unknown"},{...valid,"X-Signature-Timestamp":"bad"},
    signedHeaders(body,"PG",true,{timestamp:Math.floor(Date.now()/1000)-301}),
    signedHeaders(body,"PG",true,{timestamp:Math.floor(Date.now()/1000)+7}),
    signedHeaders(body,"SUPPLIER"),{...valid,"X-Key-Id":valid["X-Key-Id"]+", "+valid["X-Key-Id"]},
    {"Content-Type":"application/json","X-Signature":createHmac("sha256",secret).update(body).digest("hex")}
  ]) assert.equal((await fetch(base+"/webhooks/pg",{method:"POST",body,headers})).status,401);
  assert.equal((await fetch(base+"/webhooks/pg",{method:"POST",body:body+" ",headers:valid})).status,401);
  assert.equal(sql("SELECT count(*) FROM inbound_events"),before);
  assert.ok(Number(sql("SELECT sum(hits) FROM request_security_counts WHERE source='PG'"))>=9);
  const accepted=await securityPost("PG",payload); assert.equal(accepted.status,202);
  const receipt=await accepted.json();
  const replay=await securityPost("PG",JSON.stringify(Object.fromEntries(Object.entries(payload).reverse()),null,2));
  assert.equal(replay.status,200); assert.equal((await replay.json()).id,receipt.id);
});
test("request security rotates PG and supplier keys with overlap expiry and deduplicated signed receipts across restart",{timeout:90000},async()=>{
  const rotated=randomBytes(32).toString("hex"),futureUntil=new Date(Date.now()+3600000).toISOString();
  const config={PG_WEBHOOK_SECRET:rotated,PG_WEBHOOK_KEY_ID:"pg-v2",PG_WEBHOOK_PREVIOUS_KEY_ID:"pg-v1",
    PG_WEBHOOK_PREVIOUS_SECRET:secret,PG_WEBHOOK_PREVIOUS_VALID_UNTIL:futureUntil,
    SUPPLIER_WEBHOOK_SECRET:rotated,SUPPLIER_WEBHOOK_KEY_ID:"supplier-v2",SUPPLIER_WEBHOOK_PREVIOUS_KEY_ID:"supplier-v1",
    SUPPLIER_WEBHOOK_PREVIOUS_SECRET:secret,SUPPLIER_WEBHOOK_PREVIOUS_VALID_UNTIL:futureUntil,WEBHOOK_WORKER_DELAY_MS:"60000"};
  await restart(config);
  try {
    for(const source of ["PG","SUPPLIER","PROFILE"]) {
      const payload=securityPayload(source),old=await securityPost(source,payload);
      assert.equal(old.status,202); const receipt=await old.json();
      const current=await securityPost(source,payload,{keyId:source==="PG"?"pg-v2":"supplier-v2",secret:rotated});
      assert.equal(current.status,200); assert.equal((await current.json()).id,receipt.id);
      assert.equal(sql("SELECT count(*) FROM inbound_verifications WHERE inbound_id='"+receipt.id+"'"),"2");
      sql("UPDATE inbound_verifications SET signed_at=clock_timestamp() WHERE inbound_id='"+receipt.id+"'",true,true);
    }
    await restart({...config,PG_WEBHOOK_PREVIOUS_VALID_UNTIL:"2020-01-01T00:00:00Z",SUPPLIER_WEBHOOK_PREVIOUS_VALID_UNTIL:"2020-01-01T00:00:00Z"});
    for(const source of ["PG","SUPPLIER","PROFILE"]) {
      const payload=securityPayload(source);
      assert.equal((await securityPost(source,payload)).status,401);
      assert.equal((await securityPost(source,payload,{keyId:source==="PG"?"pg-v2":"supplier-v2",secret:rotated})).status,202);
    }
    const settings=await admin.request("/api/admin/request-security"); assert.equal(settings.status,200);
    const text=await settings.text(); assert.ok(!text.includes(rotated) && !text.includes(secret) && !text.includes("fingerprint"));
    const contract=JSON.parse(text);
    assert.deepEqual(contract.requests.limits,{LOGIN_IP:30,LOGIN_ACCOUNT:5,WRITE_IP:300,WRITE_MEMBER:30,READ_IP:600,READ_MEMBER:300,WEBHOOK_IP:600,WEBHOOK_SOURCE:3000});
    assert.ok(contract.requests.history.length>0);
    sql("UPDATE request_guard_history SET enabled=false",true,true);
    assert.equal((await alice.request("/api/admin/request-security")).status,403);
    assert.equal((await new Client().request("/api/admin/request-security")).status,401);
    assert.ok(Number(sql("SELECT count(*) FROM webhook_key_history WHERE valid_until='2020-01-01T00:00:00Z'"))>=2);
  } finally { await restart(); }
});
test("request security signature evidence and inbox roll back together after DB error and survive restart",{timeout:60000},async()=>{
  const payload=securityPayload();
  try {
    sql("REVOKE INSERT ON inbound_verifications FROM alpha_media_app");
    assert.ok((await securityPost("PG",payload)).status>=500);
    assert.equal(sql("SELECT count(*) FROM inbound_events WHERE event_id='"+payload.eventId+"'"),"0");
    await restart();
    assert.ok((await securityPost("PG",payload)).status>=500);
    sql("GRANT INSERT ON inbound_verifications TO alpha_media_app");
    const response=await securityPost("PG",payload); assert.equal(response.status,202); const receipt=await response.json();
    await restart();
    assert.equal((await securityPost("PG",payload)).status,200);
    assert.equal(sql("SELECT count(*) FROM inbound_verifications WHERE inbound_id='"+receipt.id+"'"),"1");
    sql("DELETE FROM inbound_verifications WHERE inbound_id='"+receipt.id+"'",true,true);
  } finally { sql("GRANT INSERT ON inbound_verifications TO alpha_media_app"); await restart(); }
});
test("request security mock PG delivery honors Retry-After and retries with fresh signed headers",{timeout:60000},async()=>{
  const calls=[];
  const server=createHttpServer((request,response)=>{
    let body=""; request.on("data",chunk=>body+=chunk); request.on("end",()=>{
      calls.push({at:Date.now(),headers:request.headers,body});
      response.writeHead(calls.length===1?429:200,{"Retry-After":"2"}); response.end("{}");
    });
  });
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  try {
    await restart({PG_WEBHOOK_URL:"http://127.0.0.1:"+server.address().port+"/webhooks/pg"});
    const order=await newOrder(),attempt=await(await alice.pay(order.id,randomUUID(),"APPROVE",{webhookCopies:1})).json();
    await until(()=>calls.length>=2);
    assert.ok(calls[1].at-calls[0].at>=1900);
    assert.equal(calls[0].body,calls[1].body);
    assert.notEqual(calls[0].headers["x-signature-timestamp"],calls[1].headers["x-signature-timestamp"]);
    await until(()=>sql("SELECT webhook_sent FROM mock_pg_payments WHERE payment_id='"+attempt.id+"'")==="1");
    assert.equal(sql("SELECT approval_executions FROM mock_pg_payments WHERE payment_id='"+attempt.id+"'"),"1");
  } finally { await restart(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});

test("request security trusts only configured proxy hops and ignores a forged leftmost client IP",{timeout:60000},async()=>{
  await restart({REQUEST_RATE_LIMIT_ENABLED:"true",REQUEST_READ_IP_LIMIT:"2"});
  let gateway;
  try {
    const p=await port();
    gateway=await startJava("gateway",{PORT:String(p),SERVICE_BASE_URL:"http://127.0.0.1:"+servicePort,GATEWAY_TRUSTED_PROXY_CIDRS:"127.0.0.1/32"});
    await freshRateWindow();
    const request=(chain)=>fetch("http://127.0.0.1:"+p+"/api/plans",{headers:{"X-Forwarded-For":chain,"X-Gateway-Client-IP":randomUUID()}});
    assert.equal((await request("198.51.100.1, 203.0.113.9")).status,200);
    assert.equal((await request("198.51.100.2, 203.0.113.9")).status,200);
    assert.equal((await request("198.51.100.3, 203.0.113.9")).status,429);
    assert.equal((await request("198.51.100.3, 203.0.113.10")).status,200);
    assert.equal(sql("SELECT count(*) FROM request_rate_buckets WHERE scope='READ_IP'"),"2");
  } finally { await stopChild(gateway); await restart(); }
});
test("request security provider webhook budget spans client IPs and preserves twenty normal duplicate deliveries",{timeout:60000},async()=>{
  await restart({REQUEST_RATE_LIMIT_ENABLED:"true",REQUEST_WEBHOOK_SOURCE_LIMIT:"20"});
  try {
    await freshRateWindow();
    const payload=securityPayload(),body=JSON.stringify(payload);
    const replies=await Promise.all(Array.from({length:20},(_,i)=>fetch("http://127.0.0.1:"+servicePort+"/webhooks/pg",{
      method:"POST",body,headers:{...signedHeaders(body),"X-Gateway-Token":secret,"X-Gateway-Client-IP":"198.51.100."+i}
    })));
    assert.equal(replies.filter(r=>r.status===202).length,1); assert.equal(replies.filter(r=>r.status===200).length,19);
    assert.equal((await securityPost("PG",payload)).status,429);
    assert.equal((await securityPost("SUPPLIER",securityPayload("SUPPLIER"))).status,202);
    assert.equal(sql("SELECT receive_count FROM inbound_events WHERE event_id='"+payload.eventId+"'"),"20");
    assert.equal(sql("SELECT count(*) FROM inbound_verifications v JOIN inbound_events e ON e.id=v.inbound_id WHERE e.event_id='"+payload.eventId+"'"),"1");
  } finally { await restart(); }
});
test("request security supplier and profile callback deliveries honor Retry-After without duplicate provisioning",{timeout:60000},async()=>{
  const calls=new Map();
  const server=createHttpServer((request,response)=>{
    let body=""; request.on("data",chunk=>body+=chunk); request.on("end",()=>{
      const parsed=JSON.parse(body),key=request.url+":"+parsed.eventId;
      const rows=calls.get(key)||[]; rows.push({at:Date.now(),headers:request.headers,body}); calls.set(key,rows);
      response.writeHead(rows.length===1?503:200,{"Retry-After":"2"}); response.end("{}");
    });
  });
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  try {
    await restart({SUPPLIER_WEBHOOK_URL:"http://127.0.0.1:"+server.address().port+"/webhooks/supplier"});
    const {order,job,profile}=await trackingProfile();
    const change=await trackingChange(profile,installedChange); assert.equal(change.status,200); const signal=await change.json();
    await until(()=>Array.from(calls.values()).filter(rows=>rows.length>=2).length>=2);
    for(const rows of calls.values()) {
      assert.ok(rows[1].at-rows[0].at>=1900);
      assert.equal(rows[0].body,rows[1].body);
      assert.notEqual(rows[0].headers["x-signature-timestamp"],rows[1].headers["x-signature-timestamp"]);
    }
    await until(()=>sql("SELECT callback_sent FROM mock_profile_notifications WHERE event_id='"+signal.eventId+"'")==="1");
    assert.equal(sql("SELECT issue_executions FROM mock_supplier_orders WHERE request_id='"+job.id+"'"),"1");
    assert.equal(sql("SELECT count(*) FROM sim_profiles WHERE order_id='"+order.id+"'"),"1");
  } finally { await restart(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});


function refundById(id) { return JSON.parse(sql(`SELECT row_to_json(r) FROM refunds r WHERE id='${id}'`)); }
function protectionRows(order) { return JSON.parse(sql(`SELECT COALESCE(json_agg(j ORDER BY created_at,id),'[]') FROM refund_protection_jobs j WHERE order_id='${order}'`)); }
async function requestPartial(data, overrides = {}, key = randomUUID(), client = admin) {
  const response = await adminAction(data.order.id, "refunds", { ...refundRequest(data.job), ...overrides }, key, client);
  assert.equal(response.status, 202, await response.clone().text());
  return (await response.json()).action.refundId;
}
async function protectedDone(data, phase = "TERMINATE") {
  await until(() => protectionRows(data.order.id).some(j => j.phase === phase && j.status === "SUCCEEDED"));
}

test("partial refund validates integer amount and serializes different administrators without overspending", {timeout:60000}, async()=>{
  await restart();
  const data=await failedOrder(), other=await member("admin2");
  for (const amount of [0,-1,0.5,1.5,1e25]) assert.equal((await adminAction(data.order.id,"refunds",{...refundRequest(data.job),amount})).status,400);
  const key=randomUUID(), body={...refundRequest(data.job),amount:10000};
  const send1=await recoveryPoster(data.order.id,"refunds",body),send2=await recoveryPoster(data.order.id,"refunds",body,other);
  const replies=await Promise.all([send1(key),send2()]);
  assert.deepEqual(replies.map(r=>r.status).sort(),[202,409]);
  const accepted=await replies.find(r=>r.status===202).json();
  await until(()=>refundById(accepted.action.refundId).status==="SUCCEEDED");
  assert.equal(orderState(data.order.id),"PARTIALLY_REFUNDED");
  // The losing administrator may have won; replay the persisted request key.
  const savedKey=sql(`SELECT idempotency_key FROM admin_actions WHERE refund_id='${accepted.action.refundId}'`);
  assert.equal((await adminAction(data.order.id,"refunds",body,savedKey)).status,200);
  assert.equal((await adminAction(data.order.id,"refunds",{...body,amount:9999},savedKey)).status,409);
  assert.equal((await adminAction(data.order.id,"issuance-retries",retryRequest(data.job))).status,409);
  let view=await recoveryDetail(data.order.id);
  assert.equal(view.refundBalance.confirmed,10000); assert.equal(view.refundBalance.available,data.order.amount-10000);
  const second=await requestPartial(data,{amount:data.order.amount-10000,scenario:"RESPONSE_LOST"});
  await until(()=>refundById(second).status==="SUCCEEDED");
  assert.equal(orderState(data.order.id),"REFUNDED");
  view=await recoveryDetail(data.order.id); assert.equal(view.refunds.length,2); assert.equal(view.refundBalance.available,0);
  assert.equal(sql(`SELECT sum(amount) FROM refund_ledger WHERE payment_id='${data.attempt.id}'`),String(data.order.amount));
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${data.attempt.id}'`),"2");
  await runReconciliation({mode:"LEDGER"});
  assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${data.order.id}'`),"0");
});

test("partial refund reserves every unknown amount and excludes it from a second cancellation", {timeout:45000},async()=>{
  await restart(); const data=await failedOrder();
  const first=await requestPartial(data,{amount:10000,scenario:"UNAVAILABLE"});
  await until(()=>refundById(first).status==="REVIEW_REQUIRED");
  assert.equal((await adminAction(data.order.id,"refunds",{...refundRequest(data.job),amount:6000})).status,409);
  const second=await requestPartial(data,{amount:data.order.amount-10000});
  await until(()=>refundById(second).status==="SUCCEEDED");
  const view=await recoveryDetail(data.order.id);
  assert.equal(view.refundBalance.reserved,10000); assert.equal(view.refundBalance.available,0);
  assert.equal(orderState(data.order.id),"REFUND_PROCESSING");
  await restart(); assert.equal(refundById(first).round_attempt_count,3);
  assert.equal(sql(`SELECT cancelled_amount FROM mock_pg_payments WHERE payment_id='${data.attempt.id}'`),String(data.order.amount-10000));
});

test("partial refund blocks an unused SIM before PG cancellation and permanently terminates it even for a partial amount", {timeout:60000},async()=>{
  await restart(); const data=await trackingProfile();
  const id=await requestPartial(data,{amount:1000,holdScenario:"RESPONSE_LOST",cleanupScenario:"RESPONSE_LOST",scenario:"RESPONSE_LOST"});
  await protectedDone(data);
  assert.equal(refundById(id).status,"SUCCEEDED"); assert.equal(orderState(data.order.id),"PARTIALLY_REFUNDED");
  assert.equal((await trackingChange(data.profile,installedChange)).status,409);
  assert.equal((await trackingView(data.profile)).profile.installStatus,"DELETED");
  const jobs=protectionRows(data.order.id);
  assert.equal(jobs.length,2); assert.ok(jobs.every(j=>j.attempt_count===2));
  assert.equal(sql(`SELECT count(*) FROM mock_supplier_hold_operations WHERE refund_id='${id}'`),"2");
  const rest=await requestPartial(data,{amount:data.order.amount-1000});
  await until(()=>refundById(rest).status==="SUCCEEDED");
  await until(()=>protectionRows(data.order.id).filter(j=>j.phase==="TERMINATE"&&j.status==="SUCCEEDED").length===2);
  assert.equal(orderState(data.order.id),"REFUNDED");
  await runReconciliation({mode:"LEDGER"});
  assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${data.order.id}'`),"0");
});

test("partial refund definitive PG rejection releases both reservation and supplier hold without cancelling money", {timeout:60000},async()=>{
  await restart(); const data=await trackingProfile();
  const id=await requestPartial(data,{scenario:"DECLINED",cleanupScenario:"RESPONSE_LOST"});
  await protectedDone(data,"RELEASE");
  assert.equal(refundById(id).status,"FAILED"); assert.equal(orderState(data.order.id),"PAID");
  const view=await recoveryDetail(data.order.id); assert.equal(view.refundBalance.available,data.order.amount);
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${data.attempt.id}'`),"0");
  assert.equal((await pg(`/payments/${data.attempt.id}/cancel`,{amount:data.order.amount,scenario:"SUCCESS"},id)).status,409);
  assert.equal((await trackingChange(data.profile,installedChange)).status,200);
  await until(async()=>(await trackingView(data.profile)).profile.installStatus==="INSTALLED");
  assert.equal((await adminAction(data.order.id,"refunds",refundRequest(data.job))).status,409);
});

test("partial refund supplier installation wins before hold despite a stale unused local snapshot", {timeout:45000},async()=>{
  await restart(); const data=await trackingProfile();
  await restart({PAYMENT_WORKER_DELAY_MS:"60000"});
  const id=await requestPartial(data);
  const direct=await fetch(`http://127.0.0.1:${servicePort}/internal/mock-supplier/profiles/${data.profile.iccid}/simulate`,{
    method:"POST",headers:{"X-Gateway-Token":secret,Authorization:`Bearer ${secret}`,"Content-Type":"application/json","Idempotency-Key":randomUUID()},
    body:JSON.stringify({...installedChange,callbackCopies:0})});
  assert.equal(direct.status,200);
  await restart();
  await until(()=>refundById(id).status==="FAILED");
  assert.equal(protectionRows(data.order.id)[0].status,"REJECTED");
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${data.attempt.id}'`),"0");
  assert.equal((await recoveryDetail(data.order.id)).refundBalance.reserved,0);
});

test("partial refund hold storage and error-recording failures retain the reservation and six-attempt budget across restart", {timeout:90000},async()=>{
  await restart(); const data=await trackingProfile(); let restore;
  try {
    restore=rejectTransitions("refund_protection_jobs",data.order.id,["SUCCEEDED","UNKNOWN","REVIEW_REQUIRED"]);
    const id=await requestPartial(data);
    await until(()=>protectionRows(data.order.id)[0]?.attempt_count>=2);
    await restart();
    await until(()=>protectionRows(data.order.id)[0]?.attempt_count===6,35000);
    await restart(); await delay(1000);
    assert.equal(protectionRows(data.order.id)[0].attempt_count,6);
    assert.equal(refundById(id).status,"WAITING_GUARD");
    assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${data.attempt.id}'`),"0");
    assert.equal((await trackingChange(data.profile,installedChange)).status,409);
    restore(); restore=null;
    await until(()=>protectionRows(data.order.id)[0].status==="REVIEW_REQUIRED");
    const job=protectionRows(data.order.id)[0];
    assert.ok(incidentFor("PROTECTION",job.id));
    const run=await runReconciliation({mode:"PENDING"});
    assert.equal(reconciliationItem(run.id,job.id).external_status,"BLOCKED");
    await protectedDone(data);
    assert.equal(incidentFor("PROTECTION",job.id).status,"RESOLVED");
    assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${data.attempt.id}'`),"1");
    assert.equal(sql(`SELECT count(*) FROM mock_supplier_hold_operations WHERE refund_id='${id}' AND phase='HOLD'`),"1");
  } finally { if(restore)restore(); await restart(); }
});

for (const phase of ["HOLD","TERMINATE","RELEASE"]) test(`partial refund ${phase} outage has bounded durable recovery and separate financial state`,{timeout:120000},async()=>{
  const proxy=await providerProxy("mock-supplier"); let down=true;
  proxy.intercept=call=>down && call.method==="POST" && call.body?.phase===phase?{status:503}:null;
  try {
    await restart({SUPPLIER_BASE_URL:proxy.url,PAYMENT_RETRY_BASE_MS:"100"});
    const data=await trackingProfile();
    const id=await requestPartial(data,{scenario:phase==="RELEASE"?"DECLINED":"SUCCESS"});
    await until(()=>protectionRows(data.order.id).some(j=>j.phase===phase && j.status==="REVIEW_REQUIRED"));
    let job=protectionRows(data.order.id).find(j=>j.phase===phase);
    assert.equal(job.attempt_count,6); assert.ok(incidentFor("PROTECTION",job.id));
    assert.equal(refundById(id).status,phase==="HOLD"?"WAITING_GUARD":phase==="RELEASE"?"FAILED":"SUCCEEDED");
    if(phase!=="HOLD") assert.equal((await trackingChange(data.profile,installedChange)).status,409);
    await restart({SUPPLIER_BASE_URL:proxy.url,PAYMENT_RETRY_BASE_MS:"100"}); await delay(300);
    assert.equal(protectionRows(data.order.id).find(j=>j.id===job.id).attempt_count,6);
    const target=await recoveryTarget(data.order.id,"PROTECTION",job.id), evidence=await reconcile(data.order.id,target);
    assert.equal(evidence.outcome,"RESUME_ALLOWED");
    const fresh=await recoveryTarget(data.order.id,"PROTECTION",job.id), second=await member("admin2");
    const body=recoveryRequest(fresh,{evidenceId:evidence.id});
    const firstPost=await recoveryPoster(data.order.id,"recoveries",body), secondPost=await recoveryPoster(data.order.id,"recoveries",body,second);
    down=false;
    const replies=await Promise.all([firstPost(),secondPost()]); assert.deepEqual(replies.map(r=>r.status).sort(),[202,409]);
    await until(()=>protectionRows(data.order.id).find(j=>j.id===job.id).status==="SUCCEEDED");
    job=protectionRows(data.order.id).find(j=>j.id===job.id);
    assert.equal(job.execution_round,2); assert.equal(job.attempt_count,7);
    await protectedDone(data,phase==="RELEASE"?"RELEASE":"TERMINATE");
    assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${data.attempt.id}'`),phase==="RELEASE"?"0":"1");
    assert.equal(sql(`SELECT count(*) FROM mock_supplier_hold_operations WHERE refund_id='${id}' AND phase='${phase}'`),"1");
  } finally { await restart(); await proxy.close(); }
});

test("partial refund external manual cancellation is counted once and quarantines over-reserved pending refunds",{timeout:60000},async()=>{
  await restart(); const data=await failedOrder();
  const id=await requestPartial(data,{scenario:"UNAVAILABLE"});
  await until(()=>refundById(id).status==="REVIEW_REQUIRED");
  assert.equal((await pg(`/payments/${data.attempt.id}/cancel`,{amount:1000})).status,200);
  await runReconciliation({mode:"PENDING"});
  let view=await recoveryDetail(data.order.id);
  assert.equal(view.refundBalance.confirmed,1000); assert.equal(view.refundBalance.reserved,data.order.amount);
  assert.equal(view.refundBalance.overReserved,true); assert.ok(view.conflicts.length);
  await runReconciliation({mode:"PENDING"});
  assert.equal(sql(`SELECT count(*) FROM refund_ledger WHERE payment_id='${data.attempt.id}'`),"1");
  assert.equal(sql(`SELECT cancelled_amount FROM mock_pg_payments WHERE payment_id='${data.attempt.id}'`),"1000");
  assert.equal((await adminAction(data.order.id,"refunds",{...refundRequest(data.job),amount:1})).status,409);
});


test("partial refund unknown holds never expire and stop after three rounds of six attempts",{timeout:90000},async()=>{
  await restart({PAYMENT_RETRY_BASE_MS:"100"}); const data=await trackingProfile();
  const id=await requestPartial(data,{holdScenario:"UNAVAILABLE"});
  for(let round=1;round<=3;round++) {
    await until(()=>protectionRows(data.order.id)[0]?.status==="REVIEW_REQUIRED");
    const job=protectionRows(data.order.id)[0]; assert.equal(job.attempt_count,round*6); assert.equal(job.execution_round,round);
    const target=await recoveryTarget(data.order.id,"PROTECTION",job.id),evidence=await reconcile(data.order.id,target);
    assert.equal(evidence.outcome,"RESUME_ALLOWED");
    const response=await resumeRecovery(data.order.id,await recoveryTarget(data.order.id,"PROTECTION",job.id),evidence);
    assert.equal(response.status,round<3?202:409);
  }
  await restart(); await delay(500);
  assert.equal(protectionRows(data.order.id)[0].attempt_count,18);
  assert.equal(refundById(id).status,"WAITING_GUARD");
  assert.equal((await recoveryDetail(data.order.id)).refundBalance.reserved,data.order.amount);
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${data.attempt.id}'`),"0");
});

test("partial refund simultaneous install and hold never both permit installation and cancellation",{timeout:60000},async()=>{
  await restart();
  for(let i=0;i<3;i++) {
    const data=await trackingProfile();
    const [intake,installed]=await Promise.all([
      adminAction(data.order.id,"refunds",refundRequest(data.job)),trackingChange(data.profile,installedChange)]);
    assert.ok([202,409].includes(intake.status)); assert.ok([200,409].includes(installed.status));
    if(intake.status===202) {
      const id=(await intake.json()).action.refundId;
      await until(()=>["FAILED","SUCCEEDED"].includes(refundById(id).status));
      if(installed.status===200) {
        assert.equal(refundById(id).status,"FAILED");
        assert.equal(sql(`SELECT cancelled_amount FROM mock_pg_payments WHERE payment_id='${data.attempt.id}'`),"0");
      } else { assert.equal(refundById(id).status,"SUCCEEDED"); await protectedDone(data); }
    } else assert.equal(installed.status,200);
  }
});

test("partial refund unknown PG result keeps a confirmed hold and mismatched protection results never reach PG",{timeout:60000},async()=>{
  await restart(); const data=await trackingProfile();
  const id=await requestPartial(data,{scenario:"UNAVAILABLE"});
  await until(()=>refundById(id).status==="REVIEW_REQUIRED");
  assert.equal(protectionRows(data.order.id).length,1);
  assert.equal(sql(`SELECT state FROM mock_supplier_holds WHERE refund_id='${id}'`),"BLOCKED");
  await restart(); assert.equal((await trackingChange(data.profile,installedChange)).status,409);
  assert.equal((await recoveryDetail(data.order.id)).refundBalance.reserved,data.order.amount);
  const proxy=await providerProxy("mock-supplier");
  try {
    const bad=await trackingProfile();
    proxy.intercept=call=>call.method==="POST" && call.body?.phase==="HOLD"?{status:200,body:{
      operationId:call.path.split("/").at(-1),refundId:call.body.refundId,orderId:randomUUID(),iccid:bad.profile.iccid,phase:"HOLD",state:"BLOCKED",profile:null}}:null;
    await restart({SUPPLIER_BASE_URL:proxy.url});
    await requestPartial(bad);
    await until(()=>protectionRows(bad.order.id)[0]?.status==="REVIEW_REQUIRED");
    assert.equal(protectionRows(bad.order.id)[0].attempt_count,1);
    assert.equal(sql(`SELECT cancelled_amount FROM mock_pg_payments WHERE payment_id='${bad.attempt.id}'`),"0");
  } finally { await restart(); await proxy.close(); }
});


test("partial refund reconciliation recovers a definitive PG rejection after DB failure without a new cancellation",{timeout:60000},async()=>{
  await restart(); const data=await failedOrder(); let restore;
  try {
    restore=rejectTransitions("refunds",data.order.id,["FAILED"]);
    const id=await requestPartial(data,{scenario:"DECLINED"});
    await until(()=>refundById(id).status==="REVIEW_REQUIRED");
    restore(); restore=null; await restart();
    await runReconciliation({mode:"PENDING"});
    assert.equal(refundById(id).status,"FAILED"); assert.equal(orderState(data.order.id),"PAID");
    assert.equal((await recoveryDetail(data.order.id)).refundBalance.available,data.order.amount);
    assert.equal(sql(`SELECT count(*) FROM mock_pg_cancel_rejections WHERE payment_id='${data.attempt.id}'`),"1");
    assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${data.attempt.id}'`),"0");
  } finally {if(restore)restore(); await restart();}
});

test("partial refund termination completion DB failure leaves money confirmed and recovers cleanup read only after restart",{timeout:90000},async()=>{
  await restart({PAYMENT_RETRY_BASE_MS:"100"}); const data=await trackingProfile();
  sql(`CREATE FUNCTION reject_cleanup_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.order_id='${data.order.id}' AND NEW.phase='TERMINATE' AND NEW.status='SUCCEEDED' THEN RAISE EXCEPTION 'cleanup commit failed'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_cleanup_completion BEFORE UPDATE ON refund_protection_jobs FOR EACH ROW EXECUTE FUNCTION reject_cleanup_completion();`);
  let removed=false;
  try {
    const id=await requestPartial(data);
    await until(()=>protectionRows(data.order.id).some(j=>j.phase==="TERMINATE" && j.status==="REVIEW_REQUIRED"));
    assert.equal(refundById(id).status,"SUCCEEDED"); assert.equal(orderState(data.order.id),"REFUNDED");
    assert.equal(sql(`SELECT state FROM mock_supplier_holds WHERE refund_id='${id}'`),"TERMINATED");
    sql("DROP TRIGGER reject_cleanup_completion ON refund_protection_jobs; DROP FUNCTION reject_cleanup_completion();");removed=true;
    await restart(); await runReconciliation({mode:"PENDING"});
    await protectedDone(data);
    assert.equal(sql(`SELECT count(*) FROM mock_supplier_hold_operations WHERE refund_id='${id}' AND phase='TERMINATE'`),"1");
    assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${data.attempt.id}'`),"1");
    assert.equal((await trackingView(data.profile)).profile.installStatus,"DELETED");
  } finally {
    if(!removed)sql("DROP TRIGGER reject_cleanup_completion ON refund_protection_jobs; DROP FUNCTION reject_cleanup_completion();");
    await restart();
  }
});


test("partial refund preserves the legacy full-refund request fingerprint for retries after upgrade",{timeout:45000},async()=>{
  await restart(); const data=await failedOrder(),key=randomUUID(),body=refundRequest(data.job);
  const response=await adminAction(data.order.id,"refunds",body,key); assert.equal(response.status,202);
  const action=(await response.json()).action;
  const legacyHash=createHash("sha256").update(JSON.stringify(["REFUND",body])).digest("hex");
  assert.equal(sql(`SELECT payload_hash FROM admin_actions WHERE id='${action.id}'`),legacyHash);
  await until(()=>refundById(action.refundId).status==="SUCCEEDED");
  await restart();
  assert.equal((await adminAction(data.order.id,"refunds",body,key)).status,200);
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${data.attempt.id}'`),"1");
});

const reconciliationDemoPath = "reconciliation-demo";
const reconciliationDemoBody = (kind = "CONFLICTING_DECLINE", overrides = {}) => ({ kind,
  reason: "상충 결과와 외부 원장 불일치 대응 시연", copies: kind === "CONFLICTING_DECLINE" ? 3 : 1, delayMs: 0, ...overrides });
function reconciliationDemoRow(id) {
  const value = sql(`SELECT row_to_json(d) FROM mock_reconciliation_demos d WHERE id='${id}'`);
  return value ? JSON.parse(value) : null;
}
async function createReconciliationDemo(orderId, body = reconciliationDemoBody(), key = randomUUID()) {
  const response = await adminAction(orderId, reconciliationDemoPath, body, key);
  assert.equal(response.status, 201); return (await response.json()).demo;
}
function currentLedgerDay() { return ledgerDay(new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" })); }

test("reconciliation demo requires admin CSRF valid options enabled mock and an unrefunded failed issuance", { timeout: 60000 }, async () => {
  await restart(); const data = await failedOrder(), path = `/api/admin/orders/${data.order.id}/${reconciliationDemoPath}`, body = reconciliationDemoBody();
  assert.equal((await new Client().request(path)).status, 401);
  assert.equal((await alice.request(path)).status, 403);
  assert.equal((await adminAction(data.order.id, reconciliationDemoPath, body, randomUUID(), new Client())).status, 401);
  assert.equal((await adminAction(data.order.id, reconciliationDemoPath, body, randomUUID(), alice)).status, 403);
  assert.equal((await admin.request(path, { method: "POST", body, headers: { "Idempotency-Key": randomUUID() } })).status, 403);
  for (const invalid of [{ ...body, reason: " " }, { ...body, reason: "x".repeat(301) }, { ...body, kind: "FAKE" },
    { ...body, copies: 0 }, { ...body, copies: 21 }, { ...body, copies: 1.5 }, { ...body, delayMs: -1 }, { ...body, delayMs: 60001 },
    reconciliationDemoBody("EXTERNAL_CANCELLATION", { copies: 2 })])
    assert.equal((await adminAction(data.order.id, reconciliationDemoPath, invalid)).status, 400);
  assert.equal((await adminAction(randomUUID(), reconciliationDemoPath, body)).status, 404);
  const pending = await newOrder();
  assert.equal((await adminAction(pending.id, reconciliationDemoPath, body)).status, 409);
  const issued = await issueOrder({ scenario: "SUCCEED", callbackCopies: 0, callbackDelayMs: 0 });
  await until(() => issuanceRow(issued.order.id).status === "ISSUED");
  assert.equal((await adminAction(issued.order.id, reconciliationDemoPath, body)).status, 409);
  try {
    await restart({ MOCK_PG_ENABLED: "false" });
    assert.equal((await adminAction(data.order.id, reconciliationDemoPath, body)).status, 503);
    assert.equal((await admin.request(path)).status, 200);
  } finally { await restart(); }
  const refundId = await requestPartial(data, { scenario: "UNAVAILABLE" });
  await until(() => refundById(refundId).status === "REVIEW_REQUIRED");
  assert.equal((await adminAction(data.order.id, reconciliationDemoPath, body)).status, 409);
  assert.equal(sql(`SELECT count(*) FROM mock_reconciliation_demos WHERE order_id='${data.order.id}'`), "0");
});

test("reconciliation demo conflicting signed notifications survive restart deduplicate and keep the approval quarantined", { timeout: 90000 }, async () => {
  await restart(); const data = await failedOrder(), key = randomUUID(), body = reconciliationDemoBody(undefined, { delayMs: 2000 });
  await restart({ PAYMENT_WORKER_DELAY_MS: "60000" });
  const send1 = await recoveryPoster(data.order.id, reconciliationDemoPath, body);
  const send2 = await recoveryPoster(data.order.id, reconciliationDemoPath, body, await member("admin2"));
  const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? send2 : send1)(key)));
  assert.equal(responses.filter(r => r.status === 201).length, 1); assert.equal(responses.filter(r => r.status === 200).length, 19);
  const receipts = await Promise.all(responses.map(r => r.json())), demo = receipts[0].demo;
  assert.equal(new Set(receipts.map(r => r.demo.id)).size, 1);
  assert.equal(reconciliationDemoRow(demo.id).attempt_count, 0);
  assert.equal(sql(`SELECT count(*) FROM inbound_events WHERE event_id='${demo.eventId}'`), "0");
  assert.equal((await adminAction(data.order.id, reconciliationDemoPath, { ...body, copies: 4 }, key)).status, 409);
  assert.equal((await adminAction(data.order.id, reconciliationDemoPath, body)).status, 200);
  assert.equal((await adminAction(data.order.id, reconciliationDemoPath, reconciliationDemoBody("EXTERNAL_CANCELLATION"))).status, 409);
  await restart();
  await until(() => reconciliationDemoRow(demo.id).status === "DELIVERED");
  const inboundId = sql(`SELECT id FROM inbound_events WHERE event_id='${demo.eventId}'`);
  await until(() => inboundRow(inboundId).status === "REVIEW_REQUIRED");
  assert.equal(inboundRow(inboundId).receive_count, 3);
  assert.equal(inboundRow(inboundId).last_error, "PG_RESULT_CONFLICT");
  assert.equal(sql(`SELECT count(*) FROM inbound_verifications WHERE inbound_id='${inboundId}'`), "1");
  assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${data.order.id}'`), "1");
  assert.equal(sql(`SELECT status FROM payment_attempts WHERE id='${data.attempt.id}'`), "APPROVED");
  assert.equal(sql(`SELECT status FROM mock_pg_payments WHERE payment_id='${data.attempt.id}'`), "APPROVED");
  assert.equal(orderState(data.order.id), "PAID");
  assert.equal((await adminAction(data.order.id, "refunds", refundRequest(data.job))).status, 409);
  assert.equal((await adminAction(data.order.id, "issuance-retries", retryRequest(data.job))).status, 409);
  const incident = incidentFor("PAYMENT", data.attempt.id, "ORDER_RESULT_CONFLICT"); assert.ok(incident);
  await runReconciliation({ mode: "PENDING" }); await runReconciliation({ mode: "PENDING" });
  assert.equal(incidentFor("PAYMENT", data.attempt.id, "ORDER_RESULT_CONFLICT").id, incident.id);
  assert.notEqual(incidentFor("PAYMENT", data.attempt.id, "ORDER_RESULT_CONFLICT").status, "RESOLVED");
  const view = await (await admin.request(`/api/admin/orders/${data.order.id}/${reconciliationDemoPath}`)).json();
  assert.ok(view.incidents.some(i => i.id === incident.id)); assert.equal(view.demos[0].sentCount, 3);
  assert.equal(sql(`SELECT count(*) FROM order_history WHERE order_id='${data.order.id}' AND source='MOCK_RECONCILIATION_DEMO'`), "1");
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${data.attempt.id}'`), "0");
  assert.equal((await adminAction(data.order.id, reconciliationDemoPath, body, key)).status, 200);
});

test("reconciliation demo external cancellation is discovered once by read only ledger scans without inventing a refund", { timeout: 90000 }, async () => {
  await restart(); const data = await failedOrder(), other = await failedOrder(), proxy = await providerProxy("mock-pg");
  try {
    await restart({ MOCK_PG_BASE_URL: proxy.url });
    const body = reconciliationDemoBody("EXTERNAL_CANCELLATION"), key = randomUUID();
    const send1 = await recoveryPoster(data.order.id, reconciliationDemoPath, body);
    const send2 = await recoveryPoster(data.order.id, reconciliationDemoPath, body, await member("admin2"));
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? send2 : send1)(key)));
    assert.equal(responses.filter(r => r.status === 201).length, 1); assert.equal(responses.filter(r => r.status === 200).length, 19);
    const demo = (await responses[0].json()).demo;
    assert.equal(demo.status, "DELIVERED"); assert.ok(demo.cancellationId);
    assert.equal(sql(`SELECT cancelled_amount FROM mock_pg_payments WHERE payment_id='${data.attempt.id}'`), String(data.order.amount));
    assert.equal(orderState(data.order.id), "PAID"); assert.equal(refundRow(data.order.id), null);
    assert.equal((await recoveryDetail(data.order.id)).refundBalance.confirmed, 0);
    await runReconciliation(currentLedgerDay());
    assert.equal(orderState(data.order.id), "REFUNDED");
    assert.equal((await recoveryDetail(data.order.id)).refundBalance.confirmed, data.order.amount);
    const incident = incidentFor("PAYMENT", data.attempt.id, "EXTERNAL_CANCELLATION_UNMATCHED"); assert.ok(incident);
    assert.notEqual(incident.status, "RESOLVED");
    assert.equal(sql(`SELECT count(*) FROM external_cancellations WHERE id='${demo.cancellationId}'`), "1");
    assert.equal(sql(`SELECT count(*) FROM refund_ledger WHERE payment_id='${data.attempt.id}'`), "1");
    assert.equal(sql(`SELECT count(*) FROM refunds WHERE order_id='${data.order.id}'`), "0");
    assert.equal((await adminAction(data.order.id, "refunds", refundRequest(data.job))).status, 409);
    await runReconciliation(currentLedgerDay());
    assert.equal(incidentFor("PAYMENT", data.attempt.id, "EXTERNAL_CANCELLATION_UNMATCHED").id, incident.id);
    assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${data.attempt.id}'`), "1");
    assert.equal(sql(`SELECT count(*) FROM refund_ledger WHERE payment_id='${data.attempt.id}'`), "1");
    assert.ok(proxy.forId(data.attempt.id).length > 0); assert.ok(proxy.forId(data.attempt.id).every(c => c.method === "GET"));
    assert.equal(orderState(other.order.id), "PAID");
    assert.equal(sql(`SELECT cancelled_amount FROM mock_pg_payments WHERE payment_id='${other.attempt.id}'`), "0");
    await restart();
    assert.equal((await adminAction(data.order.id, reconciliationDemoPath, body, key)).status, 200);
  } finally { await restart(); await proxy.close(); }
});

test("reconciliation demo audit failure rolls back the mock cancellation and immutable request before safe retry", { timeout: 60000 }, async () => {
  await restart(); const data = await failedOrder(), key = randomUUID(), body = reconciliationDemoBody("EXTERNAL_CANCELLATION");
  sql(`CREATE FUNCTION reject_demo_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.order_id='${data.order.id}' AND NEW.source='MOCK_RECONCILIATION_DEMO' THEN RAISE EXCEPTION 'audit failure'; END IF;
    RETURN NEW; END $$; CREATE TRIGGER reject_demo_audit BEFORE INSERT ON order_history FOR EACH ROW EXECUTE FUNCTION reject_demo_audit();`);
  try {
    assert.equal((await adminAction(data.order.id, reconciliationDemoPath, body, key)).status, 500);
    assert.equal(sql(`SELECT count(*) FROM mock_reconciliation_demos WHERE order_id='${data.order.id}'`), "0");
    assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${data.attempt.id}'`), "0");
    assert.equal(sql(`SELECT cancelled_amount FROM mock_pg_payments WHERE payment_id='${data.attempt.id}'`), "0");
  } finally { sql("DROP TRIGGER reject_demo_audit ON order_history; DROP FUNCTION reject_demo_audit();"); }
  const demo = await createReconciliationDemo(data.order.id, body, key);
  sql(`UPDATE mock_reconciliation_demos SET reason='changed' WHERE id='${demo.id}'`, true, true);
  sql(`DELETE FROM mock_reconciliation_demos WHERE id='${demo.id}'`, true, true);
  await restart();
  assert.equal((await adminAction(data.order.id, reconciliationDemoPath, body, key)).status, 200);
  assert.equal(sql(`SELECT count(*) FROM order_history WHERE order_id='${data.order.id}' AND source='MOCK_RECONCILIATION_DEMO'`), "1");
});

test("reconciliation demo delivery DB failure and restart preserve the six-claim budget and one conflict", { timeout: 90000 }, async () => {
  await restart(); const data = await failedOrder();
  const settings = { PAYMENT_LEASE_MS: "1200", PAYMENT_RETRY_BASE_MS: "100" };
  await restart({ ...settings, PAYMENT_WORKER_DELAY_MS: "60000" });
  const demo = await createReconciliationDemo(data.order.id, reconciliationDemoBody(undefined, { copies: 1 }));
  sql(`CREATE FUNCTION reject_demo_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id='${demo.id}' AND NEW.status<>'SENDING' THEN RAISE EXCEPTION 'completion write failed'; END IF;
    RETURN NEW; END $$; CREATE TRIGGER reject_demo_completion BEFORE UPDATE ON mock_reconciliation_demos
    FOR EACH ROW EXECUTE FUNCTION reject_demo_completion();`);
  let restored = false;
  const restore = () => { sql("DROP TRIGGER reject_demo_completion ON mock_reconciliation_demos; DROP FUNCTION reject_demo_completion();"); restored = true; };
  try {
    await restart(settings);
    await until(() => reconciliationDemoRow(demo.id).attempt_count >= 2);
    await until(() => Number(sql(`SELECT receive_count FROM inbound_events WHERE event_id='${demo.eventId}'`)) >= 2);
    await restart(settings);
    await until(() => reconciliationDemoRow(demo.id).attempt_count === 6);
    await delay(1800);
    assert.equal(reconciliationDemoRow(demo.id).attempt_count, 6);
    const inboundId = sql(`SELECT id FROM inbound_events WHERE event_id='${demo.eventId}'`);
    const received = inboundRow(inboundId).receive_count;
    // A process may stop after reserving a claim but before sending HTTP; that still consumes budget.
    assert.ok(received >= 2 && received <= 6);
    assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${data.order.id}'`), "1");
    restore();
    await until(() => reconciliationDemoRow(demo.id).status === "REVIEW_REQUIRED");
    await restart(settings); await delay(500);
    assert.equal(reconciliationDemoRow(demo.id).attempt_count, 6); assert.equal(inboundRow(inboundId).receive_count, received);
    assert.equal(orderState(data.order.id), "PAID");
  } finally { if (!restored) restore(); await restart(); }
});

test("reconciliation demo retries unavailable webhook delivery within its durable budget", { timeout: 60000 }, async () => {
  await restart(); const data = await failedOrder(), proxy = await providerProxy("mock-pg");
  proxy.intercept = () => ({ status: 503 });
  try {
    await restart({ PG_WEBHOOK_URL: proxy.url, PAYMENT_RETRY_BASE_MS: "1000" });
    const demo = await createReconciliationDemo(data.order.id, reconciliationDemoBody(undefined, { copies: 1 }));
    await until(() => reconciliationDemoRow(demo.id).attempt_count >= 2);
    const before = reconciliationDemoRow(demo.id).attempt_count;
    await restart();
    await until(() => reconciliationDemoRow(demo.id).status === "DELIVERED");
    assert.ok(reconciliationDemoRow(demo.id).attempt_count > before);
    assert.ok(reconciliationDemoRow(demo.id).attempt_count <= 6);
    const inboundId = sql(`SELECT id FROM inbound_events WHERE event_id='${demo.eventId}'`);
    await until(() => inboundRow(inboundId).status === "REVIEW_REQUIRED");
    assert.equal(sql(`SELECT count(*) FROM order_conflicts WHERE order_id='${data.order.id}'`), "1");
  } finally { await restart(); await proxy.close(); }
});

const outagePath = refundId => `refunds/${refundId}/mock-pg-outage-release`;
const storagePath = "mock-payment-storage";
const storageRequest = action => ({ action, reason: "주문별 승인 DB 반영 실패와 원문 재처리 시연" });
async function storageFaultOrder() {
  const order = await newOrder();
  assert.equal((await adminAction(order.id, storagePath, storageRequest("ARM"))).status, 201);
  return order;
}
async function storageWebhook(order) {
  const attempt = await (await alice.pay(order.id)).json();
  const approved = await pg("/payments/approve", { paymentId: attempt.id, orderId: order.id,
    amount: order.amount, currency: "KRW", scenario: "APPROVE", webhookCopies: 0, webhookDelayMs: 0 });
  assert.equal(approved.status, 200);
  const result = await approved.json(), response = await notify(result);
  assert.equal(response.status, 202);
  return { attempt, result, receipt: await response.json() };
}

test("payment storage demo restricts arming to admins and unattempted valid mock orders", { timeout: 60000 }, async () => {
  await restart(); const order = await newOrder(), body = storageRequest("ARM");
  assert.equal((await adminAction(order.id, storagePath, body, randomUUID(), new Client())).status, 401);
  assert.equal((await adminAction(order.id, storagePath, body, randomUUID(), alice)).status, 403);
  assert.equal((await admin.request(`/api/admin/orders/${order.id}/${storagePath}`, {
    method: "POST", headers: { "Idempotency-Key": randomUUID() }, body })).status, 403);
  for (const invalid of [{ ...body, reason: "" }, { ...body, reason: " " }, { ...body, reason: "x".repeat(301) },
    { ...body, action: "UNKNOWN" }, { reason: body.reason }])
    assert.equal((await adminAction(order.id, storagePath, invalid)).status, 400);
  assert.equal((await adminAction(randomUUID(), storagePath, body)).status, 404);
  assert.equal((await adminAction(order.id, storagePath, storageRequest("RELEASE"))).status, 409);
  const expired = await newOrder();
  sql(`UPDATE orders SET created_at=CURRENT_TIMESTAMP-interval '11 minutes',expires_at=CURRENT_TIMESTAMP-interval '1 minute' WHERE id='${expired.id}'`);
  assert.equal((await adminAction(expired.id, storagePath, body)).status, 409);
  await alice.pay(order.id); await until(() => orderState(order.id) === "PAID");
  assert.equal((await adminAction(order.id, storagePath, body)).status, 409);
  const declined = await newOrder(); await alice.pay(declined.id, randomUUID(), "DECLINE");
  await until(() => sql(`SELECT status FROM payment_attempts WHERE order_id='${declined.id}'`) === "DECLINED");
  assert.equal(orderState(declined.id), "PENDING_PAYMENT");
  assert.equal((await adminAction(declined.id, storagePath, body)).status, 409);
  const fresh = await newOrder();
  try {
    await restart({ MOCK_PG_ENABLED: "false" });
    assert.equal((await adminAction(fresh.id, storagePath, body)).status, 503);
  } finally { await restart(); }
  assert.equal(sql(`SELECT count(*) FROM mock_payment_storage_actions WHERE order_id='${fresh.id}'`), "0");
});

test("payment storage demo deduplicates two operators and rolls back actions with audit failures", { timeout: 60000 }, async () => {
  await restart(); const order = await newOrder(), admin2 = await member("admin2"), key = randomUUID();
  const send1 = await recoveryPoster(order.id, storagePath, storageRequest("ARM"));
  const send2 = await recoveryPoster(order.id, storagePath, storageRequest("ARM"), admin2);
  const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? send2 : send1)(key)));
  assert.equal(responses.filter(r => r.status === 201).length, 1);
  assert.equal(responses.filter(r => r.status === 200).length, 19);
  const receipts = await Promise.all(responses.map(r => r.json()));
  assert.equal(new Set(receipts.map(r => r.action.id)).size, 1);
  assert.equal((await adminAction(order.id, storagePath, { ...storageRequest("ARM"), reason: "changed" }, key)).status, 409);
  assert.equal((await adminAction(order.id, storagePath, storageRequest("RELEASE"), key)).status, 409);
  assert.equal((await adminAction(order.id, storagePath, storageRequest("ARM"))).status, 200);
  const releaseKey = randomUUID();
  sql(`CREATE FUNCTION reject_storage_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.order_id='${order.id}' AND NEW.source='MOCK_PAYMENT_STORAGE_RELEASE' THEN RAISE EXCEPTION 'audit failure'; END IF;
    RETURN NEW; END $$; CREATE TRIGGER reject_storage_audit BEFORE INSERT ON order_history
    FOR EACH ROW EXECUTE FUNCTION reject_storage_audit();`);
  try {
    assert.equal((await adminAction(order.id, storagePath, storageRequest("RELEASE"), releaseKey)).status, 500);
    assert.equal((await recoveryDetail(order.id)).mockPaymentStorageActions.length, 1);
  } finally { sql("DROP TRIGGER reject_storage_audit ON order_history; DROP FUNCTION reject_storage_audit();"); }
  try {
    await restart({ MOCK_PG_ENABLED: "false" });
    const release1 = await recoveryPoster(order.id, storagePath, storageRequest("RELEASE"));
    const release2 = await recoveryPoster(order.id, storagePath, storageRequest("RELEASE"), admin2);
    assert.deepEqual((await Promise.all([release1(releaseKey), release2()])).map(r => r.status).sort(), [200,201]);
    const detail = await recoveryDetail(order.id), actions = detail.mockPaymentStorageActions;
    assert.equal(actions.length, 2); assert.equal(orderState(order.id), "PENDING_PAYMENT");
    for (const action of actions) {
      const rows = detail.timeline.items.filter(e => e.source === `MOCK_PAYMENT_STORAGE_${action.action}`);
      assert.equal(rows.length, 1); assert.equal(rows[0].actor, `ADMIN:${action.actor}`); assert.equal(rows[0].reason, action.reason);
    }
    sql(`UPDATE mock_payment_storage_actions SET reason='changed' WHERE order_id='${order.id}'`, true, true);
    sql(`DELETE FROM mock_payment_storage_actions WHERE order_id='${order.id}'`, true, true);
  } finally { await restart(); }
  assert.equal((await adminAction(order.id, storagePath, storageRequest("ARM"))).status, 200);
  assert.equal((await recoveryDetail(order.id)).mockPaymentStorageActions.length, 2);
});

test("payment storage demo preserves PG approval and inbox through real rollback and restart then automatically recovers", { timeout: 75000 }, async () => {
  await restart({ WEBHOOK_RETRY_BASE_MS: "1000" }); const order = await storageFaultOrder();
  try {
    const response = await alice.pay(order.id, randomUUID(), "APPROVE", { webhookCopies: 3 });
    assert.equal(response.status, 202); const attempt = await response.json();
    await until(() => sql(`SELECT count(*) FROM inbound_events WHERE order_id='${order.id}' AND status='RETRY'`) === "1");
    const id = sql(`SELECT id FROM inbound_events WHERE order_id='${order.id}'`), original = inboundRow(id);
    await until(() => inboundRow(id).receive_count === 3);
    assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "0");
    assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "0");
    assert.equal(sql(`SELECT status FROM mock_pg_payments WHERE payment_id='${attempt.id}'`), "APPROVED");
    const detail = await recoveryDetail(order.id);
    assert.deepEqual(detail.mockPaymentStoragePayments, [{ paymentId: attempt.id, status: "APPROVED", approvalExecutions: 1 }]);
    await until(() => Number(sql(`SELECT attempt_count FROM payment_attempts WHERE id='${attempt.id}'`)) >= 2);
    assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
    assert.equal((await alice.pay(order.id)).status, 409);
    const other = await newOrder(); await alice.pay(other.id);
    await until(() => orderState(other.id) === "PAID");
    assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
    await restart({ ...inboxOnly, WEBHOOK_WORKER_DELAY_MS: "60000" });
    const before = inboundRow(id); assert.ok(before.attempt_count >= original.attempt_count);
    assert.equal(before.body, original.body); assert.equal(before.payload_hash, original.payload_hash);
    assert.equal((await recoveryDetail(order.id)).mockPaymentStorageActions.length, 1);
    assert.equal((await adminAction(order.id, storagePath, storageRequest("RELEASE"))).status, 201);
    assert.deepEqual(inboundRow(id), before);
    await restart(inboxOnly);
    await until(() => inboundRow(id).status === "PROCESSED");
    assert.equal(orderState(order.id), "PAID");
    assert.equal(inboundRow(id).body, original.body);
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "1");
    assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "1");
    const stats = await (await pg(`/payments/${attempt.id}/stats`)).json();
    assert.equal(stats.approvalExecutions, 1); assert.equal(stats.approvalRequests, 1);
  } finally { await adminAction(order.id, storagePath, storageRequest("RELEASE")); await restart(); }
});

test("payment storage demo replays the same stored event after six failures with evidence and concurrent operators", { timeout: 75000 }, async () => {
  await restart(inboxOnly); const order = await storageFaultOrder();
  try {
    const { attempt, result, receipt } = await storageWebhook(order);
    await until(() => inboundRow(receipt.id).status === "REVIEW_REQUIRED");
    const before = inboundRow(receipt.id); assert.equal(before.attempt_count, 6);
    const duplicates = await Promise.all(Array.from({ length: 20 }, () => notify(result)));
    assert.ok(duplicates.every(r => r.status === 200));
    assert.equal(inboundRow(receipt.id).attempt_count, 6); assert.equal(inboundRow(receipt.id).receive_count, 21);
    await restart(inboxOnly);
    assert.equal((await adminAction(order.id, storagePath, storageRequest("RELEASE"))).status, 201);
    await delay(300); assert.equal(inboundRow(receipt.id).status, "REVIEW_REQUIRED");
    assert.equal(inboundRow(receipt.id).attempt_count, 6);
    const noEvidence = await resumeRecovery(order.id, await recoveryTarget(order.id, "INBOUND", receipt.id), { id: randomUUID() });
    assert.equal(noEvidence.status, 409); assert.equal((await noEvidence.json()).code, "RECOVERY_EVIDENCE_REQUIRED");
    const evidence = await reconcile(order.id, await recoveryTarget(order.id, "INBOUND", receipt.id));
    assert.equal(evidence.outcome, "REPLAY_ALLOWED");
    const body = recoveryRequest(await recoveryTarget(order.id, "INBOUND", receipt.id), { evidenceId: evidence.id });
    const send1 = await recoveryPoster(order.id, "recoveries", body);
    const send2 = await recoveryPoster(order.id, "recoveries", body, await member("admin2"));
    assert.deepEqual((await Promise.all([send1(),send2()])).map(r => r.status).sort(), [202,409]);
    await until(() => inboundRow(receipt.id).status === "PROCESSED");
    const after = inboundRow(receipt.id);
    assert.equal(after.attempt_count, 7); assert.equal(after.execution_round, 2); assert.equal(after.round_attempt_count, 1);
    assert.equal(after.body, before.body); assert.equal(after.payload_hash, before.payload_hash); assert.equal(after.event_id, before.event_id);
    assert.equal(orderState(order.id), "PAID");
    assert.equal(sql(`SELECT count(*) FROM issuance_jobs WHERE order_id='${order.id}'`), "1");
    assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "1");
    assert.equal(sql(`SELECT approval_executions FROM mock_pg_payments WHERE payment_id='${attempt.id}'`), "1");
    assert.equal((await notify(result)).status, 200);
    assert.equal(inboundRow(receipt.id).attempt_count, 7);
  } finally { await adminAction(order.id, storagePath, storageRequest("RELEASE")); await restart(); }
});

test("payment storage demo release never resets the three-round replay limit", { timeout: 75000 }, async () => {
  await restart(inboxOnly); const order = await storageFaultOrder();
  try {
    const { receipt } = await storageWebhook(order);
    for (let round = 1; round <= 3; round++) {
      await until(() => inboundRow(receipt.id).status === "REVIEW_REQUIRED");
      assert.equal(inboundRow(receipt.id).attempt_count, round * 6);
      if (round < 3) {
        const evidence = await reconcile(order.id, await recoveryTarget(order.id, "INBOUND", receipt.id));
        assert.equal((await resumeRecovery(order.id, await recoveryTarget(order.id, "INBOUND", receipt.id), evidence)).status, 202);
      }
    }
    const before = inboundRow(receipt.id);
    assert.equal((await adminAction(order.id, storagePath, storageRequest("RELEASE"))).status, 201);
    assert.deepEqual(inboundRow(receipt.id), before);
    const evidence = await reconcile(order.id, await recoveryTarget(order.id, "INBOUND", receipt.id));
    const response = await resumeRecovery(order.id, await recoveryTarget(order.id, "INBOUND", receipt.id), evidence);
    assert.equal(response.status, 409); assert.equal((await response.json()).code, "RECOVERY_ROUND_LIMIT");
    assert.equal(inboundRow(receipt.id).attempt_count, 18);
  } finally { await adminAction(order.id, storagePath, storageRequest("RELEASE")); await restart(); }
});

test("payment storage demo release cannot clear a conflicting webhook or authorize its replay", { timeout: 60000 }, async () => {
  await restart(inboxOnly); const order = await storageFaultOrder();
  try {
    const { result, receipt } = await storageWebhook(order);
    await until(() => inboundRow(receipt.id).status === "RETRY");
    assert.equal((await notify({ ...result, amount: result.amount + 1 })).status, 409);
    assert.equal((await adminAction(order.id, storagePath, storageRequest("RELEASE"))).status, 201);
    const evidence = await reconcile(order.id, await recoveryTarget(order.id, "INBOUND", receipt.id));
    assert.equal(evidence.outcome, "BLOCKED");
    assert.equal((await resumeRecovery(order.id, await recoveryTarget(order.id, "INBOUND", receipt.id), evidence)).status, 409);
    assert.equal(inboundRow(receipt.id).last_error, "INBOUND_EVENT_CONFLICT");
    assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
  } finally { await adminAction(order.id, storagePath, storageRequest("RELEASE")); await restart(); }
});

const outageReason = { reason: "모의 PG 장애 해제 후 같은 환불번호로 복구 시연" };
async function outageRefund() {
  const data = await failedOrder();
  const refundId = await requestPartial(data, { scenario: "UNAVAILABLE" });
  await until(() => refundById(refundId).status === "REVIEW_REQUIRED");
  return { ...data, refundId };
}

test("mock PG outage release requires admin CSRF reason matching order and an enabled mock provider", { timeout: 60000 }, async () => {
  await restart();
  const data = await outageRefund(), path = outagePath(data.refundId), other = await newOrder();
  assert.equal((await adminAction(data.order.id, path, outageReason, randomUUID(), new Client())).status, 401);
  assert.equal((await adminAction(data.order.id, path, outageReason, randomUUID(), alice)).status, 403);
  assert.equal((await admin.request(`/api/admin/orders/${data.order.id}/${path}`, {
    method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: outageReason })).status, 403);
  for (const reason of ["", "   ", "x".repeat(301)])
    assert.equal((await adminAction(data.order.id, path, { reason })).status, 400);
  assert.equal((await adminAction(other.id, path, outageReason)).status, 404);
  assert.equal((await adminAction(randomUUID(), path, outageReason)).status, 404);
  assert.equal((await adminAction(data.order.id, outagePath(randomUUID()), outageReason)).status, 404);
  try {
    await restart({ MOCK_PG_ENABLED: "false" });
    assert.equal((await adminAction(data.order.id, path, outageReason)).status, 503);
    assert.equal((await recoveryDetail(data.order.id)).mockPgEnabled, false);
  } finally { await restart(); }
  assert.equal(sql(`SELECT count(*) FROM mock_pg_outage_releases WHERE refund_id='${data.refundId}'`), "0");
  const normal = await failedOrder(), success = await requestPartial(normal);
  await until(() => refundById(success).status === "SUCCEEDED");
  assert.equal((await adminAction(normal.order.id, outagePath(success), outageReason)).status, 409);
});

test("mock PG outage release deduplicates two operators and resumes the unchanged refund after restart exactly once", { timeout: 60000 }, async () => {
  await restart();
  const data = await outageRefund(), before = refundById(data.refundId), path = outagePath(data.refundId);
  const originalAction = sql(`SELECT row_to_json(a) FROM admin_actions a WHERE refund_id='${data.refundId}'`);
  const admin2 = await member("admin2"), key = randomUUID();
  const send1 = await recoveryPoster(data.order.id, path, outageReason), send2 = await recoveryPoster(data.order.id, path, outageReason, admin2);
  const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? send2 : send1)(key)));
  assert.equal(responses.filter(r => r.status === 201).length, 1);
  assert.equal(responses.filter(r => r.status === 200).length, 19);
  const receipts = await Promise.all(responses.map(r => r.json()));
  assert.equal(new Set(receipts.map(r => r.release.id)).size, 1);
  const release = receipts[0].release;
  assert.ok(["admin", "admin2"].includes(release.actor));
  assert.deepEqual(refundById(data.refundId), before);
  assert.equal((await adminAction(data.order.id, path, { reason: "다른 사유" }, key)).status, 409);
  assert.equal((await adminAction(data.order.id, path, outageReason)).status, 200);
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${data.attempt.id}'`), "0");
  await restart();
  let detail = await recoveryDetail(data.order.id);
  assert.deepEqual(detail.mockPgOutageReleases, [release]);
  assert.equal(detail.refundBalance.reserved, data.order.amount);
  const evidence = await reconcile(data.order.id, await recoveryTarget(data.order.id, "REFUND", data.refundId));
  assert.equal(evidence.outcome, "RESUME_ALLOWED");
  const body = recoveryRequest(await recoveryTarget(data.order.id, "REFUND", data.refundId), { evidenceId: evidence.id });
  const resume1 = await recoveryPoster(data.order.id, "recoveries", body), resume2 = await recoveryPoster(data.order.id, "recoveries", body, admin2);
  assert.deepEqual((await Promise.all([resume1(), resume2()])).map(r => r.status).sort(), [202,409]);
  await until(() => refundById(data.refundId).status === "SUCCEEDED");
  const after = refundById(data.refundId);
  assert.equal(after.id, before.id); assert.equal(after.scenario, "UNAVAILABLE"); assert.equal(after.amount, before.amount);
  assert.equal(after.attempt_count, 4); assert.equal(after.execution_round, 2);
  assert.equal(sql(`SELECT row_to_json(a) FROM admin_actions a WHERE refund_id='${data.refundId}'`), originalAction);
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${data.attempt.id}'`), "1");
  assert.equal(sql(`SELECT scenario FROM mock_pg_cancellations WHERE idempotency_key='${data.refundId}'`), "UNAVAILABLE");
  assert.equal((await pg(`/payments/${data.attempt.id}/cancel`, { amount: before.amount, scenario: "UNAVAILABLE" }, data.refundId)).status, 200);
  assert.equal((await pg(`/payments/${data.attempt.id}/cancel`, { amount: before.amount, scenario: "SUCCESS" }, data.refundId)).status, 409);
  assert.equal((await adminAction(data.order.id, path, outageReason, key)).status, 200);
  detail = await recoveryDetail(data.order.id);
  const history = detail.timeline.items.filter(e => e.source === "MOCK_PG_OUTAGE_RELEASE");
  assert.equal(history.length, 1); assert.equal(history[0].actor, `ADMIN:${release.actor}`);
  assert.equal(history[0].reason, outageReason.reason); assert.equal(history[0].targetId, data.refundId);
});

test("mock PG outage release is scoped to one refund even when another refund shares the payment", { timeout: 60000 }, async () => {
  await restart(); const data = await failedOrder();
  const first = await requestPartial(data, { amount: 6000, scenario: "UNAVAILABLE" });
  const second = await requestPartial(data, { amount: 6000, scenario: "UNAVAILABLE" });
  await until(() => [first,second].every(id => refundById(id).status === "REVIEW_REQUIRED"));
  const send1 = await recoveryPoster(data.order.id, outagePath(first), outageReason);
  const send2 = await recoveryPoster(data.order.id, outagePath(first), outageReason, await member("admin2"));
  assert.deepEqual((await Promise.all([send1(),send2()])).map(r => r.status).sort(), [200,201]);
  const storedKey = sql(`SELECT idempotency_key FROM mock_pg_outage_releases WHERE refund_id='${first}'`);
  assert.equal((await adminAction(data.order.id, outagePath(second), outageReason, storedKey)).status, 409);
  const evidence = await reconcile(data.order.id, await recoveryTarget(data.order.id, "REFUND", first));
  assert.equal((await resumeRecovery(data.order.id, await recoveryTarget(data.order.id, "REFUND", first), evidence)).status, 202);
  await until(() => refundById(first).status === "SUCCEEDED");
  assert.equal((await pg(`/payments/${data.attempt.id}/cancel`, { amount: 6000, scenario: "UNAVAILABLE" }, second)).status, 503);
  assert.equal(refundById(second).status, "REVIEW_REQUIRED"); assert.equal(refundById(second).attempt_count, 3);
  const detail = await recoveryDetail(data.order.id);
  assert.equal(detail.refundBalance.confirmed, 6000); assert.equal(detail.refundBalance.reserved, 6000);
  assert.equal(detail.mockPgOutageReleases.length, 1);
});

test("mock PG outage release rolls back with audit failure and preserves the successful record across restart", { timeout: 60000 }, async () => {
  await restart(); const data = await outageRefund(), before = refundById(data.refundId), key = randomUUID();
  sql(`CREATE FUNCTION reject_outage_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.source='MOCK_PG_OUTAGE_RELEASE' THEN RAISE EXCEPTION 'simulated audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_outage_audit BEFORE INSERT ON order_history FOR EACH ROW EXECUTE FUNCTION reject_outage_audit();`);
  try {
    assert.equal((await adminAction(data.order.id, outagePath(data.refundId), outageReason, key)).status, 500);
    assert.equal(sql(`SELECT count(*) FROM mock_pg_outage_releases WHERE refund_id='${data.refundId}'`), "0");
    assert.deepEqual(refundById(data.refundId), before);
    assert.equal((await pg(`/payments/${data.attempt.id}/cancel`, { amount: before.amount, scenario: "UNAVAILABLE" }, data.refundId)).status, 503);
  } finally { sql("DROP TRIGGER reject_outage_audit ON order_history; DROP FUNCTION reject_outage_audit();"); }
  const accepted = await adminAction(data.order.id, outagePath(data.refundId), outageReason, key);
  assert.equal(accepted.status, 201); const receipt = await accepted.json();
  await restart();
  const replay = await adminAction(data.order.id, outagePath(data.refundId), outageReason, key);
  assert.equal(replay.status, 200); assert.deepEqual((await replay.json()).release, receipt.release);
  sql(`UPDATE mock_pg_outage_releases SET reason='changed' WHERE refund_id='${data.refundId}'`, true, true);
  sql(`DELETE FROM mock_pg_outage_releases WHERE refund_id='${data.refundId}'`, true, true);
  assert.equal(sql(`SELECT count(*) FROM order_history WHERE target_id='${data.refundId}' AND source='MOCK_PG_OUTAGE_RELEASE'`), "1");
});

test("mock PG outage release cannot reset exhausted recovery rounds or authorize resume without evidence", { timeout: 75000 }, async () => {
  await restart(); const data = await outageRefund();
  for (let round = 1; round < 3; round++) {
    const evidence = await reconcile(data.order.id, await recoveryTarget(data.order.id, "REFUND", data.refundId));
    assert.equal((await resumeRecovery(data.order.id, await recoveryTarget(data.order.id, "REFUND", data.refundId), evidence)).status, 202);
    await until(() => refundById(data.refundId).status === "REVIEW_REQUIRED");
  }
  const before = refundById(data.refundId); assert.equal(before.attempt_count, 9);
  assert.equal((await adminAction(data.order.id, outagePath(data.refundId), outageReason)).status, 201);
  assert.deepEqual(refundById(data.refundId), before);
  const evidence = await reconcile(data.order.id, await recoveryTarget(data.order.id, "REFUND", data.refundId));
  const resume = await resumeRecovery(data.order.id, await recoveryTarget(data.order.id, "REFUND", data.refundId), evidence);
  assert.equal(resume.status, 409); assert.equal((await resume.json()).code, "RECOVERY_ROUND_LIMIT");
  assert.equal(sql(`SELECT count(*) FROM mock_pg_cancellations WHERE payment_id='${data.attempt.id}'`), "0");
  const fresh = await outageRefund();
  assert.equal((await adminAction(fresh.order.id, outagePath(fresh.refundId), outageReason)).status, 201);
  const target = await recoveryTarget(fresh.order.id, "REFUND", fresh.refundId);
  const noEvidence = await resumeRecovery(fresh.order.id, target, { id: randomUUID() });
  assert.equal(noEvidence.status, 409); assert.equal((await noEvidence.json()).code, "RECOVERY_EVIDENCE_REQUIRED");
});
