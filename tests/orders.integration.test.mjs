import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const secret = randomBytes(32).toString("hex");
const children = [];
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
    PAYMENT_WORKER_DELAY_MS: "100", ...accountHashes, ...extra });
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

async function notify(result, signature = true) {
  const body = JSON.stringify(result);
  return fetch(base + "/webhooks/pg", { method: "POST", body,
    headers: { "Content-Type": "application/json", "X-Signature": signature
      ? createHmac("sha256", secret).update(body).digest("hex") : "0".repeat(64) } });
}

async function restart(extra = {}) {
  const stopped = once(serviceProcess, "exit"); serviceProcess.kill(); await stopped;
  serviceProcess = await startService(extra);
}

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
  assert.ok(responses.every(r => r.status === 200));
  assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "1");
  assert.equal(sql(`SELECT status FROM payment_attempts WHERE id='${attempt.id}'`), "APPROVED");
  assert.equal(orderState(order.id), "PAID");
  await until(async () => (await (await pg(`/payments/${attempt.id}/stats`)).json()).webhookSent === 2);
  assert.equal((await (await pg(`/payments/${attempt.id}/stats`)).json()).approvalExecutions, 1);
  assert.equal((await notify(result, false)).status, 401);
  assert.equal((await notify({ ...result, amount: result.amount + 1 })).status, 409);
  assert.equal((await notify({ ...result, currency: "USD" })).status, 409);
  assert.equal((await notify({ ...result, amount: result.amount + 0.5 })).status, 400);
  assert.equal((await notify({ ...result, amount: String(result.amount) })).status, 400);
  assert.equal((await notify({ ...result, transactionId: "changed" })).status, 409);
  assert.equal((await notify({ ...result, orderId: randomUUID() })).status, 404);
  assert.equal(orderState(order.id), "PAID");
});

test("payment forged amount webhook cannot mark an unresolved order paid", async () => {
  const order = await newOrder();
  const attempt = await (await alice.pay(order.id, randomUUID(), "RESPONSE_LOST")).json();
  await until(() => sql(`SELECT count(*) FROM mock_pg_payments WHERE payment_id='${attempt.id}'`) === "1");
  const result = await (await pg(`/payments/${attempt.id}`)).json();
  assert.equal((await notify({ ...result, amount: 1 })).status, 409);
  assert.equal(orderState(order.id), "PAYMENT_PROCESSING");
  assert.equal(sql(`SELECT count(*) FROM payment_events WHERE payment_id='${attempt.id}'`), "0");
  await settled(order, attempt);
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
  assert.equal((await notify(corrected)).status, 200);
  assert.equal(orderState(order.id), "PAID");
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
    headers: { "Content-Type": "application/json", "X-Signature": valid
      ? createHmac("sha256", secret).update(body).digest("hex") : "0".repeat(64) } });
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
  assert.ok(copies.every(r => r.status === 200));
  await until(async () => (await (await supplier(`/orders/${job.id}/stats`)).json()).callbackSent === 20);
  assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "1");
  assert.equal(sql(`SELECT count(*) FROM issuance_events WHERE event_id='${result.eventId}'`), "1");
  const stats = await (await supplier(`/orders/${job.id}/stats`)).json();
  assert.equal(stats.issueExecutions, 1); assert.equal(stats.requestCount, 1);
  assert.equal(stats.callbackFailures, 0);
  const stale = { ...result, eventId: randomUUID(), status: "ACCEPTED", revision: 1, iccid: null, activationCode: null };
  assert.equal((await supplierNotify(stale)).status, 200); assert.equal(issuanceRow(order.id).status, "ISSUED");
  assert.equal((await supplierNotify(result, false)).status, 401);
  assert.equal((await supplierNotify({ ...result, orderId: randomUUID() })).status, 404);
  assert.equal((await supplierNotify({ ...result, requestId: randomUUID() })).status, 404);
  assert.equal((await supplierNotify({ ...result, activationCode: "LPA:1$smdp.example$changed" })).status, 409);
  assert.equal((await supplierNotify({ ...result, revision: 2.5 })).status, 400);
  assert.equal((await supplierNotify({ ...result, eventId: randomUUID(), status: "FAILED", reason: "MOCK_ISSUANCE_FAILED",
    iccid: null, activationCode: null })).status, 409);
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
  assert.ok(repeats.every(r => r.status === 200));
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
  assert.equal((await notify(result)).status, 200);
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
  assert.equal(job.check_count, 6); assert.equal(job.last_error, "SUPPLIER_RETRY_LIMIT_REACHED");
  assert.equal(sql(`SELECT count(*) FROM sim_profiles WHERE order_id='${order.id}'`), "0");
  const issues = await (await admin.request("/api/admin/orders?needsReview=true&size=100")).json();
  assert.ok(issues.items.some(item => item.order.id === order.id));
  await restart();
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
  assert.equal((await adminAction(issued.order.id,"refunds",refundRequest(issued.job))).status,409);
  assert.equal((await adminAction(issued.order.id,"issuance-retries",retryRequest(issued.job))).status,409);
  const pending = await newOrder();
  assert.equal((await adminAction(pending.id,"refunds",body)).status,409);
  sql(`UPDATE issuance_jobs SET status='REVIEW_REQUIRED' WHERE id='${job.id}'`);
  assert.equal((await adminAction(order.id,"refunds",body)).status,409);
  assert.equal((await adminAction(order.id,"issuance-retries",retryRequest(job))).status,409);
});

test("refund twenty simultaneous identical requests cancel once and retain one immutable audit action", async () => {
  const { order, job, attempt } = await failedOrder(), key = randomUUID(), body = { ...refundRequest(job), amount: 1, currency: "USD", actor: "customer2" };
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
  assert.equal((await supplierNotify(oldResult)).status,200);
  const second=issuanceRow(order.id), last=await adminAction(order.id,"issuance-retries",retryRequest(second));
  assert.equal(last.status,202);
  await until(()=>issuanceRow(order.id).status==="ISSUED");
  assert.equal((await supplierNotify(oldResult)).status,200);
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
  assert.equal((await supplierNotify(old)).status,200);
  assert.equal((await notify(await (await pg(`/payments/${attempt.id}`)).json())).status,200);
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
    headers: { "Content-Type": "application/json", "X-Signature": valid ? createHmac("sha256", secret).update(body).digest("hex") : "0".repeat(64) } });
}
const installedChange = { state: "INSTALLED", activatedAt: null, callbackCopies: 1, callbackDelayMs: 0 };

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
  assert.ok(callbacks.every(response => response.status === 200));
  await until(() => sql(`SELECT callback_sent FROM mock_profile_notifications WHERE event_id='${signal.eventId}'`) === "3");
  assert.equal(sql(`SELECT count(*) FROM sim_profile_events WHERE event_id='${signal.eventId}'`), "1");
  assert.equal((await trackingChange(profile, { ...body, callbackCopies: 4 }, key)).status, 409);
  assert.equal((await profileNotify(signal, false)).status, 401);
  assert.equal((await profileNotify({ ...signal, revision: 2.5 })).status, 400);
  assert.equal((await profileNotify({ ...signal, orderId: randomUUID() })).status, 404);
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
  const { profile } = await trackingProfile();
  const oldResponse = await trackingChange(profile, { ...installedChange, callbackCopies: 0 });
  assert.equal(oldResponse.status, 200); const old = await oldResponse.json();
  assert.equal((await trackingChange(profile, { state: "ENABLED", activatedAt: "2020-01-01T00:00:00Z", callbackCopies: 0, callbackDelayMs: 0 })).status, 400);
  const activatedAt = new Date().toISOString();
  const activeResponse = await trackingChange(profile, { state: "ENABLED", activatedAt, callbackCopies: 1, callbackDelayMs: 0 });
  assert.equal(activeResponse.status, 200); const active = await activeResponse.json();
  await until(async () => (await trackingView(profile)).profile.installStatus === "ACTIVE");
  assert.equal((await profileNotify(old)).status, 200);
  assert.equal((await trackingView(profile)).profile.installStatus, "ACTIVE");
  assert.equal((await profileNotify({ ...old, state: "DELETED" })).status, 409);
  assert.equal((await profileNotify({ ...active, eventId: randomUUID() })).status, 409);
  assert.equal((await trackingChange(profile, installedChange)).status, 409);
  assert.equal((await trackingChange(profile, { state: "ENABLED", activatedAt: "2020-01-01T00:00:00Z", callbackCopies: 0, callbackDelayMs: 0 })).status, 409);
  assert.equal((await trackingView(profile)).profile.activatedAt, activatedAt);
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
  assert.equal((await profileNotify(signal)).status, 200);
  assert.equal((await profileNotify(signal)).status, 200);
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
