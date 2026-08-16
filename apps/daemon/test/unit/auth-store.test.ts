import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPaths } from "../../src/infrastructure/paths";
import {
  AUTH_FILE_MODE,
  AuthStore,
  maskKey,
  type ApiKeyCredential,
  type Credential,
  type OAuthCredential,
} from "../../src/infrastructure/auth-store";
import type {
  ApiKeyCredential as PiApiKeyCredential,
  Credential as PiCredential,
  OAuthCredential as PiOAuthCredential,
} from "@earendil-works/pi-ai";

/**
 * AD-2 auth.json 端口（契约 C §3 / T2.3 brief TDD 组1）：
 * - 路径经 paths.ts 单点派生（TR-AD-6：<home>/auth.json，不复制旁路先例）；
 * - Credential 联合格式 = pi 生态 schema（auth/types.d.ts）——类型级等价断言；
 * - 0600 权限位 + 文件锁（跨进程 pid 锁 + 陈锁接管）+ 原子写（tmp+rename）；
 * - daemon 单写点：modify 串行（并发读改写无丢失更新）；
 * - 脱敏（尾 4 位）与 key 读取面（engine getApiKey 数据源 / 子进程 env 快照）。
 */

// ── 类型级等价断言：helix Credential ≡ pi 生态 Credential（互可赋值） ──
type AssertAssignable<TExpected, TActual> = TExpected extends TActual ? (TActual extends TExpected ? true : false) : false;
const _piToHelix: AssertAssignable<Credential, PiCredential> = true;
const _helixToPi: AssertAssignable<PiCredential, Credential> = true;
const _apiKeyEq: AssertAssignable<ApiKeyCredential, PiApiKeyCredential> = true;
const _oauthEq: AssertAssignable<OAuthCredential, PiOAuthCredential> = true;
void _piToHelix;
void _helixToPi;
void _apiKeyEq;
void _oauthEq;

const tmpRoots: string[] = [];

function tmpHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-auth-store-"));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("auth.json 端口（AD-2，契约 C §3）", () => {
  test("路径经 paths.ts 派生：<home>/auth.json（TR-AD-6 单点）", async () => {
    const home = tmpHome();
    const paths = createPaths(home);
    expect(paths.authPath()).toBe(path.join(home, "auth.json"));
    const store = new AuthStore(paths.authPath());
    await store.setKey("anthropic", "sk-ant-1234");
    expect(existsSync(path.join(home, "auth.json"))).toBe(true);
  });

  test("写入面：0600 权限位 + Credential 联合格式 + 原子写（无 tmp 残留）", async () => {
    const home = tmpHome();
    const store = new AuthStore(createPaths(home).authPath());
    await store.setKey("anthropic", "sk-ant-abcd7f3a");
    const file = path.join(home, "auth.json");
    expect(statSync(file).mode & 0o777).toBe(AUTH_FILE_MODE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, Credential>;
    expect(parsed.anthropic).toEqual({ type: "api_key", key: "sk-ant-abcd7f3a" } satisfies ApiKeyCredential);
    // 原子写：tmp 文件不残留
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  test("覆盖宽权限旧文件时同样收严到 0600；OAuth 形状透传保留", async () => {
    const home = tmpHome();
    const file = path.join(home, "auth.json");
    writeFileSync(
      file,
      JSON.stringify({ google: { type: "oauth", refresh: "r1", access: "a1", expires: 123 } }),
      { mode: 0o644 },
    );
    const store = new AuthStore(file);
    await store.setKey("anthropic", "sk-new");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, Credential>;
    // 既有 OAuth 条目保留（只动目标 provider 位）
    expect(parsed.google?.type).toBe("oauth");
    expect(parsed.anthropic).toEqual({ type: "api_key", key: "sk-new" });
  });

  test("文件缺失 → 空表；损坏 JSON → 抛中文错误（fail-fast 不吞）", async () => {
    const home = tmpHome();
    const store = new AuthStore(createPaths(home).authPath());
    expect(await store.readAll()).toEqual({});
    writeFileSync(path.join(home, "auth.json"), "{not-json", "utf8");
    await expect(store.setKey("x", "k")).rejects.toThrow(/auth\.json/);
  });

  test("daemon 单写点：并发 setKey 串行化，无丢失更新", async () => {
    const home = tmpHome();
    const store = new AuthStore(createPaths(home).authPath());
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.setKey(`p-${i}`, `key-${i}`)),
    );
    const all = await store.readAll();
    expect(Object.keys(all).length).toBe(20);
    expect(all["p-19"]).toEqual({ type: "api_key", key: "key-19" });
  });

  test("文件锁语义：锁文件在写操作期间持有、操作后释放；陈锁（死 pid）接管", async () => {
    const home = tmpHome();
    const paths = createPaths(home);
    const store = new AuthStore(paths.authPath());
    let lockSeenDuringOp = false;
    // modify 内观测锁存在（modify 串行读改写期间锁在位）
    await store.modify("anthropic", async () => {
      lockSeenDuringOp = existsSync(`${paths.authPath()}.lock`);
      return { type: "api_key", key: "during" } satisfies ApiKeyCredential;
    });
    expect(lockSeenDuringOp).toBe(true);
    expect(existsSync(`${paths.authPath()}.lock`)).toBe(false); // 操作后释放

    // 陈锁接管：写一个死 pid 的锁文件（999999 无此进程），下次写盘照常成功
    writeFileSync(`${paths.authPath()}.lock`, JSON.stringify({ pid: 999999 }), "utf8");
    await store.setKey("openai", "sk-ok");
    expect((await store.readAll()).openai).toEqual({ type: "api_key", key: "sk-ok" });
  });

  test("文件锁语义：外部进程持锁时阻塞等待后完成（跨进程互斥）", async () => {
    const home = tmpHome();
    const paths = createPaths(home);
    const lockPath = `${paths.authPath()}.lock`;
    // 子进程持锁 ~400ms 后退出释放
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        [
          `const fs = require("node:fs");`,
          `fs.writeFileSync(${JSON.stringify(lockPath)}, JSON.stringify({ pid: process.pid }));`,
          `setTimeout(() => fs.rmSync(${JSON.stringify(lockPath)}), 400);`,
        ].join(""),
      ],
      stdout: "ignore",
      stderr: "ignore",
    });
    // 等子进程把锁写出来
    await new Promise((resolve) => {
      const t0 = Date.now();
      const poll = () => (existsSync(lockPath) ? resolve(undefined) : Date.now() - t0 > 2000 ? resolve(undefined) : setTimeout(poll, 10));
      poll();
    });
    const store = new AuthStore(paths.authPath());
    const t0 = Date.now();
    await store.setKey("anthropic", "sk-after-lock");
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(150); // 确曾等待持锁者释放
    expect((await store.readAll()).anthropic).toEqual({ type: "api_key", key: "sk-after-lock" });
    await child.exited;
  });

  test("读取面：apiKeyOf / apiKeysSnapshot / deleteKey", async () => {
    const home = tmpHome();
    const store = new AuthStore(createPaths(home).authPath());
    await store.setKey("anthropic", "sk-a");
    await store.setKey("openai", "sk-o");
    await store.setKey("google", "g-no-key"); // key 字段存在但值会照存
    expect(store.apiKeyOf("anthropic")).toBe("sk-a");
    expect(store.apiKeyOf("unknown")).toBeUndefined();
    expect(store.apiKeysSnapshot()).toEqual({ anthropic: "sk-a", openai: "sk-o", google: "g-no-key" });
    await store.deleteKey("openai");
    expect(store.apiKeyOf("openai")).toBeUndefined();
    // OAuth 条目 apiKeyOf 不视作 key（不泄漏 access token）
    await store.modify("oauth-prov", async () => ({ type: "oauth", refresh: "r", access: "a", expires: 1 }));
    expect(store.apiKeyOf("oauth-prov")).toBeUndefined();
  });

  test("脱敏：maskKey 尾 4 位（`····7f3a` 形态）+ 短 key 全遮", () => {
    expect(maskKey("sk-ant-abcd7f3a")).toBe("····7f3a");
    expect(maskKey("abcd")).toBe("····");
    expect(maskKey("ab")).toBe("····");
  });

  test("setKey 空 key = 拒写（协议层 error 的 daemon 侧防线）", async () => {
    const home = tmpHome();
    const store = new AuthStore(createPaths(home).authPath());
    await expect(store.setKey("anthropic", "")).rejects.toThrow(/apiKey/);
    await expect(store.setKey("anthropic", "   ")).rejects.toThrow(/apiKey/);
  });
});
