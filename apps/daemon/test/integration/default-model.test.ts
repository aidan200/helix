import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createDaemon } from "../../src/infrastructure/container";
import { createPaths } from "../../src/infrastructure/paths";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { DefaultModelStore } from "../../src/adapters/driven/sqlite-session/DefaultModelStore";

/**
 * AD-2 默认模型 SQLite 持久化（T2.3 brief TDD 组2）：
 * - default_model 单行表经 WriteQueue 单写通道（AG-06）读写；
 * - 幂等：新库建表、旧库（无表）打开后补建（CREATE IF NOT EXISTS 守护）；
 * - 新会话继承当前默认（会话运行时构建时解析——set_default 后新草稿会话
 *   拿到新默认；既有会话不跟随，per-session 语义）。
 */

const tmpRoots: string[] = [];

function tmpHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-default-model-"));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("DefaultModelStore（default_model 表，WriteQueue 单写通道）", () => {
  test("读写往返：未设置 → undefined（fallback 生效）；set 后持久化；覆盖更新", async () => {
    const home = tmpHome();
    const dbPath = createPaths(home).dbPath();
    const queue = new WriteQueue(dbPath);
    const store = new DefaultModelStore(queue, "anthropic/claude-sonnet-4-5");
    try {
      expect(store.stored()).toBeUndefined();
      expect(store.current()).toBe("anthropic/claude-sonnet-4-5"); // fallback
      await store.set("anthropic/claude-haiku-4-5");
      expect(store.stored()).toBe("anthropic/claude-haiku-4-5");
      expect(store.current()).toBe("anthropic/claude-haiku-4-5");
      await store.set("openai/gpt-5.2");
      expect(store.stored()).toBe("openai/gpt-5.2");
    } finally {
      await queue.close();
    }
  });

  test("落盘可跨实例观测（重开队列读同值）+ 旧库（无表）补建幂等", async () => {
    const home = tmpHome();
    const dbPath = createPaths(home).dbPath();
    const q1 = new WriteQueue(dbPath);
    await new DefaultModelStore(q1, "fallback").set("anthropic/claude-opus-4-6");
    await q1.close();

    const q2 = new WriteQueue(dbPath); // 同一 db 重开（模拟 daemon 重启）
    const store2 = new DefaultModelStore(q2, "fallback");
    expect(store2.stored()).toBe("anthropic/claude-opus-4-6");
    await q2.close();
  });
});

describe("新会话继承默认（daemon 集成，真引擎构造期解析）", () => {
  test("set_default 后新建草稿会话 → 引擎 currentModel = 新默认；既有会话不跟随", async () => {
    const home = tmpHome();
    // 生产模式（不注入 engine）→ 真引擎装配（构造期无网络请求）
    const daemon = await createDaemon({
      home,
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    try {
      const before = await daemon.model.getDefault();
      expect(before.model).toBe("anthropic/claude-sonnet-4-5"); // builtin 默认兜底

      const firstSession = daemon.registry.currentSessionId();
      expect(daemon.registry.peek(firstSession)!.chatService.currentModel).toBe("anthropic/claude-sonnet-4-5");

      // 切默认 → 既有会话不跟随
      await daemon.model.setDefault("anthropic/claude-haiku-4-5");
      expect(daemon.registry.peek(firstSession)!.chatService.currentModel).toBe("anthropic/claude-sonnet-4-5");

      // 新草稿会话 → 继承新默认（engineFor 构建期解析当前默认）
      const { sessionId } = await daemon.directory.startDraftSession("继承默认测试");
      await until(() => daemon.registry.peek(sessionId) !== undefined);
      expect(daemon.registry.peek(sessionId)!.chatService.currentModel).toBe("anthropic/claude-haiku-4-5");

      // model.get：会话模型 ≠ 默认 → isDefault 区分（契约 C §1.1）
      const info = await daemon.model.getModel(firstSession);
      expect(info).toEqual({
        model: "anthropic/claude-sonnet-4-5",
        isDefault: false,
        defaultModel: "anthropic/claude-haiku-4-5",
      });
      const infoNew = await daemon.model.getModel(sessionId);
      expect(infoNew.isDefault).toBe(true);
    } finally {
      await daemon.shutdown();
    }
  });
});

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}
