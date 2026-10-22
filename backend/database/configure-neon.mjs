import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
process.loadEnvFile(resolve(root, existsSync(resolve(root, ".env")) ? ".env" : ".env.local"));
const pooled = new URL(process.env.DATABASE_URL);
const direct = new URL(process.env.DATABASE_URL_UNPOOLED);
if (pooled.protocol !== "postgresql:" || direct.protocol !== "postgresql:"
    || pooled.hostname.replace("-pooler.", ".") !== direct.hostname || pooled.pathname !== direct.pathname
    || !direct.hostname.endsWith(".neon.tech") || direct.hostname.includes("-pooler")) {
  throw new Error("Neon의 pooled DATABASE_URL과 direct DATABASE_URL_UNPOOLED가 필요합니다.");
}

const envPath = resolve(root, "backend/service/.env");
const previous = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const previousValues = Object.fromEntries(previous.split(/\r?\n/).filter((line) => line && !line.startsWith("#"))
  .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
const appPassword = previousValues.DB_URL?.includes(pooled.hostname) && previousValues.DB_PASSWORD
  ? previousValues.DB_PASSWORD : randomBytes(32).toString("hex");

function sql(statement) {
  const result = spawnSync("psql", ["-X", "-At", "-v", "ON_ERROR_STOP=1"], {
    input: statement,
    encoding: "utf8",
    env: { ...process.env, PGHOST: direct.hostname, PGPORT: direct.port || "5432",
      PGDATABASE: decodeURIComponent(direct.pathname.slice(1)), PGUSER: decodeURIComponent(direct.username),
      PGPASSWORD: decodeURIComponent(direct.password), PGSSLMODE: "require", PGCHANNELBINDING: "require" },
  });
  // SQL 오류에 비밀번호가 들어갈 수 있으므로 원문을 출력하지 않는다.
  if (result.error || result.status !== 0) throw new Error("Neon SQL 실행 실패. psql 설치와 DB 소유자 연결을 확인해 주세요.");
  return result.stdout.trim();
}

const exists = sql("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='alpha_media_app');") === "t";
if (exists && !previousValues.DB_URL?.includes(pooled.hostname)) {
  throw new Error("기존 alpha_media_app 계정이 있습니다. 비밀번호를 재설정하지 않았습니다. 기존 접속 정보로 구성해 주세요.");
}

mkdirSync(resolve(root, ".local"), { recursive: true });
const backup = resolve(root, ".local/service-before-neon.env");
if (previous && !previousValues.DB_URL?.includes(pooled.hostname) && !existsSync(backup)) copyFileSync(envPath, backup);
if (!exists) {
  const bootstrap = readFileSync(new URL("./neon-bootstrap.sql", import.meta.url), "utf8");
  sql(`BEGIN;\n${bootstrap}\nALTER ROLE alpha_media_app PASSWORD '${appPassword}';\nCOMMIT;`);
}

function jdbc(url) {
  return `jdbc:postgresql://${url.host}${url.pathname}?sslmode=verify-full&sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory&channelBinding=require&connectTimeout=10`;
}
function property(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r");
}
const values = { ...previousValues, DB_URL: jdbc(pooled), DB_USERNAME: "alpha_media_app", DB_PASSWORD: appPassword,
  DB_MIGRATION_URL: jdbc(direct), DB_MIGRATION_USERNAME: decodeURIComponent(direct.username),
  DB_MIGRATION_PASSWORD: decodeURIComponent(direct.password), DB_CONNECTION_TIMEOUT: "10000",
  SESSION_COOKIE_SECURE: "false", SESSION_CLEANUP_CRON: "0 0 * * * *" };
writeFileSync(envPath, "# neon deploy가 내려받은 연결 정보를 JDBC 설정으로 변환했다.\n"
  + Object.entries(values).map(([key, value]) => `${key}=${property(value)}`).join("\n") + "\n", { mode: 0o600 });
console.log("Neon 연결 설정 완료: backend/service/.env (비밀번호 출력 없음)");
console.log(`실행 계정: alpha_media_app (${exists ? "기존 계정 유지" : "SQL로 제한된 계정 생성"}), Flyway: direct 연결`);
console.log("기존 로컬 설정 백업: .local/service-before-neon.env (있는 경우)");
