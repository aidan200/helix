import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import type { Credential } from "../../src/infrastructure/auth-store";

/**
 * AD-2 config.json 瘦身 + 旧配置迁移（T2.3 brief TDD 组6）：
 * - 旧 config（model/apiKeys/port/...）→ 启动迁移：apiKeys → auth.json
 *   （0600，Credential 联合）；model → SQLite default_model；config.json
 *   重写瘦身形态（迁移幂等：二次启动无遗留）；
 * - 五消费点改读新源后 daemon 行为等价：getStatus().model = 迁移值
 *   （会话级数据源）；默认模型经 get_default 读出；
 * - skipConfig 判定新语义（引擎注入与否）+ writeConfig 全字段往返。
 */

const tmpRoots: string[] = [];

function tmpHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-cfg-mig-"));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("旧 config.json 启动迁移（AD-2 取代边界）", () => {
  test("三字段旧配置 → auth.json + SQLite 默认 + 瘦身 config.json；迁移幂等", async () => {
    const home = tmpHome();
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        model: "anthropic/claude-haiku-4-5",
        apiKeys: { anthropic: "sk-mig-1234", openai: "sk-mig-5678" },
        port: 7500,
        maxConcurrent: 5,
        maxQueued: 9,
      }),
      "utf8",
    );
    const daemon = await createTestDaemon({
      home,
      engine: new FakeAgentEngine(),
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    try {
      // ① apiKeys → auth.json（Credential 联合 + 0600）
      const authFile = path.join(home, "auth.json");
      expect(existsSync(authFile)).toBe(true);
      expect(statSync(authFile).mode & 0o777).toBe(0o600);
      const auth = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, Credential>;
      expect(auth.anthropic).toEqual({ type: "api_key", key: "sk-mig-1234" });
      expect(auth.openai).toEqual({ type: "api_key", key: "sk-mig-5678" });

      // ② model → SQLite 默认表（get_default 读面 + engine 子进程源同表）
      expect(daemon.model.getDefault().model).toBe("anthropic/claude-haiku-4-5");

      // ③ config.json 重写瘦身形态（无 model/apiKeys；运行参数保留）
      const slim = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")) as Record<string, unknown>;
      expect(slim.model).toBeUndefined();
      expect(slim.apiKeys).toBeUndefined();
      expect(slim.port).toBe(7500);
      expect(slim.maxConcurrent).toBe(5);
      expect(slim.maxQueued).toBe(9);

      // ④ 行为等价：getStatus().model 数据源改会话级（fake 引擎未上报 →
      //    默认表值）——旧 config.model 语义经新源可达
      expect(daemon.system.getStatus().model).toBe("anthropic/claude-haiku-4-5");

      // ⑤ auth 快照源（SubAgent env 注入面）
      expect(daemon.registry.currentSessionId()).toBeTruthy();
    } finally {
      await daemon.shutdown();
    }

    // ⑥ 幂等：迁移后再启（engine 工厂避免真引擎）→ 无遗留位、值不重复迁移
    const second = await createTestDaemon({
      home,
      engine: new FakeAgentEngine(),
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    try {
      expect(second.model.getDefault().model).toBe("anthropic/claude-haiku-4-5");
      const slim = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")) as Record<string, unknown>;
      expect(slim.model).toBeUndefined();
      const auth = JSON.parse(readFileSync(path.join(home, "auth.json"), "utf8")) as Record<string, Credential>;
      expect(auth.anthropic).toEqual({ type: "api_key", key: "sk-mig-1234" }); // 不被覆盖丢失
    } finally {
      await second.shutdown();
    }
  });

  test("纯旧 model（无 apiKeys）→ 只迁默认模型位", async () => {
    const home = tmpHome();
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ model: "anthropic/claude-opus-4-6", port: 7333 }),
      "utf8",
    );
    const daemon = await createTestDaemon({
      home,
      engine: new FakeAgentEngine(),
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    try {
      expect(daemon.model.getDefault().model).toBe("anthropic/claude-opus-4-6");
      expect(existsSync(path.join(home, "auth.json"))).toBe(false); // 无 key 不建文件
    } finally {
      await daemon.shutdown();
    }
  });

  test("瘦身 config（无遗留位）→ 不触发迁移路径，auth.json 不动", async () => {
    const home = tmpHome();
    writeFileSync(path.join(home, "config.json"), JSON.stringify({ port: 7333 }), "utf8");
    const daemon = await createTestDaemon({
      home,
      engine: new FakeAgentEngine(),
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    try {
      expect(daemon.model.getDefault().model).toBe("anthropic/claude-sonnet-4-5"); // builtin 兜底
      expect(existsSync(path.join(home, "auth.json"))).toBe(false);
    } finally {
      await daemon.shutdown();
    }
  });
});

describe("skipConfig 判定新语义（T2.3 定稿：engine 注入与否）", () => {
  test("注入 engine（测试 Fake 形态）→ 无 SubagentLauncher 真体；缺省 → 真体（离线解析 builtin 默认）", async () => {
    const homeA = tmpHome();
    const fake = await createTestDaemon({
      home: homeA,
      engine: new FakeAgentEngine(),
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    try {
      expect(fake.subagentLauncher).toBeUndefined(); // Fake 形态：占位替身
      expect(fake.model.getDefault().model).toBe("anthropic/claude-sonnet-4-5");
    } finally {
      await fake.shutdown();
    }

    const homeB = tmpHome();
    const prod = await createTestDaemon({
      home: homeB,
      skipConfig: true, // 跳过 config 文件读面；真引擎模式仍由 engine 缺省判定
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    try {
      expect(prod.subagentLauncher).toBeDefined(); // 真体（默认模型 builtin 解析，无网络）
      // 真引擎 currentModel 可观测（AgentInstanceDto.model 填充链主实例槽位）
      const view = prod.registry.currentView();
      expect(view.instances![0]!.model).toBe("anthropic/claude-sonnet-4-5");
      expect(prod.system.getStatus().model).toBe("anthropic/claude-sonnet-4-5");
    } finally {
      await prod.shutdown();
    }
  });
});
