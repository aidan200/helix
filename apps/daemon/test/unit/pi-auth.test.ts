import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { AuthStore } from "../../src/infrastructure/auth-store";
import { createAuthContext, createAuthInjection, createCredentialStore } from "../../src/adapters/driven/llm/pi-auth";

/**
 * pi-auth 契约测试（pi-ai 订阅登录批 M1）：
 * - CredentialStore 适配语义（read/list/modify/delete 直通 auth.json——
 *   TR-175：全参显式书写面经调用不丢参）；
 * - AuthContext 显式-only（env 恒无——AG-08 免疫，即使宿主 env 有 key）；
 * - builtinModels 注入真解析（getAuth 从 auth.json oauth 凭据解析出
 *   access token；凭据缺失时 env key 不得被回落——堵口实证）。
 */

const tmpRoots: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-pi-auth-"));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function authStoreIn(): AuthStore {
  return new AuthStore(path.join(tmpDir(), "auth.json"));
}

describe("① createCredentialStore（AuthStore → pi-ai CredentialStore 直通）", () => {
  test("read/list/modify/delete 与 auth.json 语义一致（含 options 尾参可传不吞）", async () => {
    const store = authStoreIn();
    const cs = createCredentialStore(store);

    // read：缺失 undefined / setKey 后可读
    expect(await cs.read("anthropic")).toBeUndefined();
    await store.setKey("anthropic", "sk-ant-1234");
    expect(await cs.read("anthropic")).toMatchObject({ type: "api_key", key: "sk-ant-1234" });

    // list：providerId + type 清单
    expect(await cs.list()).toEqual([{ providerId: "anthropic", type: "api_key" }]);

    // modify：fn 见当前值，返回新凭据即落盘（oauth 形态——订阅登录落盘同通道）
    const modded = await cs.modify("openai-codex", async (current) => {
      expect(current).toBeUndefined();
      return { type: "oauth", refresh: "r-1", access: "a-1", expires: 4_102_444_800_000 };
    });
    expect(modded).toMatchObject({ type: "oauth", access: "a-1" });
    expect(await cs.read("openai-codex")).toMatchObject({ type: "oauth", access: "a-1" });

    // modify：返回 undefined = 保持不变
    const unchanged = await cs.modify("openai-codex", async () => undefined);
    expect(unchanged).toMatchObject({ type: "oauth", access: "a-1" });

    // delete：幂等移除
    await cs.delete("openai-codex");
    await cs.delete("openai-codex");
    expect(await cs.read("openai-codex")).toBeUndefined();
    expect(await cs.list()).toEqual([{ providerId: "anthropic", type: "api_key" }]);

    // options 尾参显式接住（TR-175：传与不传行为等价，不因少参吞掉）
    const signal = new AbortController().signal;
    expect(await cs.read("anthropic", { signal })).toMatchObject({ key: "sk-ant-1234" });
    expect(await cs.list({ signal })).toHaveLength(1);
  });
});

describe("② createAuthContext（显式-only：env 恒无，AG-08 免疫）", () => {
  test("宿主 env 有 key 也答无；fileExists 真实现", async () => {
    const had = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-env-should-never-be-used";
    try {
      const ctx = createAuthContext();
      expect(await ctx.env("OPENAI_API_KEY")).toBeUndefined();
      expect(await ctx.env("ANY_VAR_AT_ALL")).toBeUndefined();
      const real = path.join(tmpDir(), "probe.txt");
      writeFileSync(real, "x");
      expect(await ctx.fileExists(real)).toBe(true);
      expect(await ctx.fileExists(path.join(tmpDir(), "nope.txt"))).toBe(false);
    } finally {
      if (had === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = had;
    }
  });
});

describe("③ builtinModels 注入（credentials + authContext → 真解析面）", () => {
  test("oauth 凭据经注入 store 解析出 access token（getAuth）", async () => {
    const store = authStoreIn();
    const { credentials, authContext } = createAuthInjection(store);
    await store.modify("openai-codex", async () => ({
      type: "oauth",
      refresh: "r-token",
      access: "a-token-value",
      expires: Date.now() + 3_600_000,
      accountId: "acc-1",
    }));
    const models = builtinModels({ credentials, authContext });
    const resolved = await models.getAuth("openai-codex");
    expect(resolved).toBeDefined();
    expect(resolved?.auth.apiKey).toBe("a-token-value");
  });

  test("凭据缺失时 env key 不被回落（免疫断言）；显式 overrides.apiKey 仍可解析", async () => {
    const had = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-env-should-never-be-used";
    try {
      const store = authStoreIn();
      const models = builtinModels(createAuthInjection(store));
      // 免疫：宿主 env 有 OPENAI_API_KEY，注入恒无 env → 解析必须为 undefined
      expect(await models.getAuth("openai")).toBeUndefined();
      // 显式覆盖通道（api_key 语义）不受影响
      const explicit = await models.getAuth("openai", { apiKey: "sk-explicit" });
      expect(explicit?.auth.apiKey).toBe("sk-explicit");
    } finally {
      if (had === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = had;
    }
  });
});

describe("④ 子进程装配（buildChildModels 注入——SubAgent 子进程 oauth 解析面）", () => {
  test("authStore 注入后子进程本地 Models 可解析 oauth 凭据（跨进程共读同一 auth.json）", async () => {
    const { buildChildModels } = await import("../../src/adapters/driven/subagent/child/ChildMain");
    const store = authStoreIn();
    await store.modify("openai-codex", async () => ({
      type: "oauth",
      refresh: "r-child",
      access: "a-child-token",
      expires: Date.now() + 3_600_000,
      accountId: "acc-1",
    }));
    const models = buildChildModels({ HELIX_AUTH_PATH: "" }, store);
    const resolved = await models.getAuth("openai-codex");
    expect(resolved?.auth.apiKey).toBe("a-child-token");
    // 无 authStore（旧父进程/测试形态）：不注入，行为不变（构造不炸）
    expect(buildChildModels({})).toBeDefined();
  });
});
