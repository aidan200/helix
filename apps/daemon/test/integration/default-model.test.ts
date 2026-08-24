import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Database } from "bun:sqlite";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { createPaths } from "../../src/infrastructure/paths";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { RuntimeConfigStore } from "../../src/adapters/driven/sqlite-session/RuntimeConfigStore";
import { DefaultModelStore } from "../../src/adapters/driven/sqlite-session/DefaultModelStore";

/**
 * P1 T1（mode-framework）：默认模型存储底座迁 runtime_config KV 表。
 * - RuntimeConfigStore：runtime_config KV 表经 WriteQueue 单写通道（AG-06）读写；
 * - DefaultModelStore：RuntimeConfigPort 之上 default_model 键的语义包装
 *   + builtin 兜底（组合根注入 fallback，stored/current/set 签名保持）；
 * - 旧 default_model 单行表 → KV 启动期守护迁移（拷贝 + drop 事务包裹，
 *   幂等：旧表不存在即 no-op；KV 已有键则旧值不覆盖）；
 * - 新会话继承当前默认（ModelService 行为不变，只换存储底座——
 *   set_default 后新草稿会话拿到新默认；既有会话不跟随，per-session 语义）。
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

/** 离线只读探针：表是否存在（独立连接，不经被测对象）。 */
function tableExists(dbPath: string, table: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== null
    );
  } finally {
    db.close();
  }
}

/** 离线只读探针：runtime_config KV 原值。 */
function kvOf(dbPath: string, key: string): string | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT value FROM runtime_config WHERE key = ?").get(key) as
      | { value: string }
      | null;
    return row === null ? undefined : row.value;
  } finally {
    db.close();
  }
}

/** 预置旧形态库文件：default_model 单行表（AD-2 时代 DDL）+ 可选行。 */
function seedLegacyDefaultModel(dbPath: string, model?: string): void {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec(
      "CREATE TABLE default_model (" +
        "id INTEGER PRIMARY KEY CHECK (id = 1), " +
        "model TEXT NOT NULL, " +
        "updated_at TEXT NOT NULL)",
    );
    if (model !== undefined) {
      db.run(
        "INSERT INTO default_model (id, model, updated_at) VALUES (1, ?, '2024-01-01T00:00:00.000Z')",
        [model],
      );
    }
  } finally {
    db.close();
  }
}

describe("RuntimeConfigStore（runtime_config KV 表，WriteQueue 单写通道）", () => {
  test("KV 读写往返：未设 → undefined；set 后可读；覆盖更新；键间互不影响；重开持久化", async () => {
    const dbPath = createPaths(tmpHome()).dbPath();
    const queue = new WriteQueue(dbPath);
    const kv = new RuntimeConfigStore(queue);
    try {
      expect(kv.get("default_model")).toBeUndefined();
      expect(kv.get("ui.lastSeenVersion")).toBeUndefined();
      await kv.set("default_model", "anthropic/claude-haiku-4-5");
      await kv.set("ui.lastSeenVersion", "0.1.0");
      expect(kv.get("default_model")).toBe("anthropic/claude-haiku-4-5");
      expect(kv.get("ui.lastSeenVersion")).toBe("0.1.0"); // 通用键非默认模型专用
      await kv.set("default_model", "openai/gpt-5.2"); // 覆盖更新（upsert 语义）
      expect(kv.get("default_model")).toBe("openai/gpt-5.2");
      expect(kv.get("ui.lastSeenVersion")).toBe("0.1.0");
    } finally {
      await queue.close();
    }
    const queue2 = new WriteQueue(dbPath); // 同一 db 重开（模拟 daemon 重启）
    const kv2 = new RuntimeConfigStore(queue2);
    expect(kv2.get("default_model")).toBe("openai/gpt-5.2");
    await queue2.close();
  });

  test("新库直建 runtime_config 表；default_model 旧表不再建", async () => {
    const dbPath = createPaths(tmpHome()).dbPath();
    const queue = new WriteQueue(dbPath);
    await queue.close();
    expect(tableExists(dbPath, "runtime_config")).toBe(true);
    expect(tableExists(dbPath, "default_model")).toBe(false);
  });
});

describe("DefaultModelStore（KV 包装：default_model 键 + builtin 兜底）", () => {
  test("未设置 → stored undefined / current 走 fallback；set → 落 runtime_config 表；覆盖更新", async () => {
    const dbPath = createPaths(tmpHome()).dbPath();
    const queue = new WriteQueue(dbPath);
    const store = new DefaultModelStore(new RuntimeConfigStore(queue), "anthropic/claude-sonnet-4-5");
    try {
      expect(store.stored()).toBeUndefined();
      expect(store.current()).toBe("anthropic/claude-sonnet-4-5"); // builtin 兜底
      await store.set("anthropic/claude-haiku-4-5");
      expect(store.stored()).toBe("anthropic/claude-haiku-4-5");
      expect(store.current()).toBe("anthropic/claude-haiku-4-5");
      // 底座即 KV：包装写的就是 runtime_config 的 default_model 键
      expect(kvOf(dbPath, "default_model")).toBe("anthropic/claude-haiku-4-5");
      await store.set("openai/gpt-5.2");
      expect(store.stored()).toBe("openai/gpt-5.2");
    } finally {
      await queue.close();
    }
  });

  test("落盘可跨实例观测（重开队列读同值）", async () => {
    const dbPath = createPaths(tmpHome()).dbPath();
    const q1 = new WriteQueue(dbPath);
    await new DefaultModelStore(new RuntimeConfigStore(q1), "fallback").set("anthropic/claude-opus-4-6");
    await q1.close();

    const q2 = new WriteQueue(dbPath); // 同一 db 重开（模拟 daemon 重启）
    const store2 = new DefaultModelStore(new RuntimeConfigStore(q2), "fallback");
    expect(store2.stored()).toBe("anthropic/claude-opus-4-6");
    await q2.close();
  });
});

describe("旧 default_model 表 → runtime_config 迁移（启动期守护，幂等）", () => {
  test("旧表有值 → 打开即迁入 KV 并 drop 旧表；二次打开幂等、迁移后正常可写", async () => {
    const dbPath = createPaths(tmpHome()).dbPath();
    seedLegacyDefaultModel(dbPath, "anthropic/claude-opus-4-6");

    const q1 = new WriteQueue(dbPath); // 打开 = 启动期守护迁移
    const store = new DefaultModelStore(new RuntimeConfigStore(q1), "fallback");
    expect(store.stored()).toBe("anthropic/claude-opus-4-6"); // 旧值进 KV
    expect(tableExists(dbPath, "default_model")).toBe(false); // 旧表已 drop
    await q1.close();

    // 二次打开（重启）：旧表已无 → no-op，KV 值完好
    const q2 = new WriteQueue(dbPath);
    const store2 = new DefaultModelStore(new RuntimeConfigStore(q2), "fallback");
    expect(store2.stored()).toBe("anthropic/claude-opus-4-6");
    await store2.set("openai/gpt-5.2"); // 迁移后照常可写
    expect(kvOf(dbPath, "default_model")).toBe("openai/gpt-5.2");
    await q2.close();
  });

  test("KV 已有键 → 旧表值不覆盖（KV 优先）；空旧表 → 仅 drop、fallback 生效", async () => {
    // 双表并置形态：runtime_config 先有 default_model 键 + 旧表仍有值
    const dbPath = createPaths(tmpHome()).dbPath();
    seedLegacyDefaultModel(dbPath, "anthropic/claude-opus-4-6");
    {
      const db = new Database(dbPath);
      db.exec("CREATE TABLE IF NOT EXISTS runtime_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.run("INSERT INTO runtime_config (key, value) VALUES ('default_model', 'openai/gpt-5.2')");
      db.close();
    }
    const queue = new WriteQueue(dbPath);
    const store = new DefaultModelStore(new RuntimeConfigStore(queue), "fallback");
    expect(store.stored()).toBe("openai/gpt-5.2"); // KV 优先，旧表值不覆写
    expect(tableExists(dbPath, "default_model")).toBe(false); // 旧表仍清理
    await queue.close();

    // 空旧表（无行）：drop 后无键 → fallback
    const dbPath2 = createPaths(tmpHome()).dbPath();
    seedLegacyDefaultModel(dbPath2);
    const queue2 = new WriteQueue(dbPath2);
    const store2 = new DefaultModelStore(new RuntimeConfigStore(queue2), "fallback");
    expect(store2.stored()).toBeUndefined();
    expect(store2.current()).toBe("fallback");
    expect(tableExists(dbPath2, "default_model")).toBe(false);
    await queue2.close();
  });
});

describe("新会话继承默认（daemon 集成，真引擎构造期解析）", () => {
  test("set_default 后新建草稿会话 → 引擎 currentModel = 新默认；既有会话不跟随", async () => {
    const home = tmpHome();
    // 生产模式（不注入 engine）→ 真引擎装配（构造期无网络请求）
    const daemon = await createTestDaemon({
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
      // T4 转正复用注记：startDraftSession 命中零条目当前草稿时直接复用
      //（其引擎在构建期解析的是旧默认；客户端另可经 chat.send draft 的
      // model 字段显式选定）。本用例验证「新建会话继承新默认」，故先把
      // firstSession 变为有内容会话（聚合直追加——本测试为生产模式真引擎
      // 装配，不发消息不联网），使 draft 链走 createFresh 新建路径。
      daemon.registry.peek(firstSession)!.chatService.sessionView.appendUserEntry("让首个会话脱离零条目草稿态");
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

describe("daemon 启动迁移（旧库 default_model 表 → KV，全链路）", () => {
  test("预置旧表库 → createTestDaemon 启动 → getDefault 迁移值、旧表已清；重启幂等", async () => {
    const home = tmpHome();
    seedLegacyDefaultModel(createPaths(home).dbPath(), "anthropic/claude-opus-4-6");
    const daemon = await createTestDaemon({
      home,
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    try {
      expect((await daemon.model.getDefault()).model).toBe("anthropic/claude-opus-4-6");
      expect(tableExists(createPaths(home).dbPath(), "default_model")).toBe(false);
      await daemon.model.setDefault("anthropic/claude-haiku-4-5"); // 迁移后照常可写
    } finally {
      await daemon.shutdown();
    }
    // 重启（同 home）：迁移幂等（无旧表可迁），KV 值保持
    const daemon2 = await createTestDaemon({
      home,
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    try {
      expect((await daemon2.model.getDefault()).model).toBe("anthropic/claude-haiku-4-5");
    } finally {
      await daemon2.shutdown();
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
