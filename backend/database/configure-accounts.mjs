import { pbkdf2Sync, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const local = resolve(root, ".local");
const secretsPath = resolve(local, "fixed-accounts.json");
const envPath = resolve(root, "backend/service/.env");
mkdirSync(local, { recursive: true });
if (!existsSync(envPath)) copyFileSync(resolve(root, "backend/service/.env.example"), envPath);
let env = readFileSync(envPath, "utf8");
if (!existsSync(secretsPath) && /^(CUSTOMER[12]|ADMIN)_PASSWORD_HASH=\{pbkdf2-/m.test(env)) {
  throw new Error("기존 계정 해시가 있습니다. 원문 비밀번호 파일 없이 계정을 자동 재설정하지 않습니다.");
}
const accounts = existsSync(secretsPath) ? JSON.parse(readFileSync(secretsPath, "utf8")) :
  Object.fromEntries(["customer1", "customer2", "admin"].map(username => {
    const password = randomBytes(12).toString("base64url") + "!A1";
    const salt = randomBytes(16);
    const hash = "{pbkdf2-sha256-600k}" + Buffer.concat([salt,
      pbkdf2Sync(password, salt, 600000, 32, "sha256")]).toString("hex");
    return [username, { password, hash }];
  }));
writeFileSync(secretsPath, JSON.stringify(accounts, null, 2) + "\n", { mode: 0o600 });
for (const [username, account] of Object.entries(accounts)) {
  const key = username.toUpperCase() + "_PASSWORD_HASH";
  const line = `${key}=${account.hash}`;
  env = new RegExp(`^${key}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${key}=.*$`, "m"), line) : env.trimEnd() + "\n" + line + "\n";
}
writeFileSync(envPath, env, { mode: 0o600 });
writeFileSync(resolve(local, "fixed-accounts.txt"), "고정 로그인 계정. 비밀번호는 Git에 올리지 않습니다.\n\n" +
  Object.entries(accounts).map(([username, account]) => `${username === "admin" ? "운영자" : "고객"}: ${username}\n비밀번호: ${account.password}\n`).join("\n"), { mode: 0o600 });
console.log("고정 계정 해시 구성 완료. 로그인 정보: .local/fixed-accounts.txt (비밀번호 출력 없음)");
