/**
 * 长期记忆 domain 维度批单测（kind × domain 正交：habit/general/project）。
 *
 * 红绿证据链（brief 测试要求逐条）：
 * 1. schema 迁移幂等：旧库补列 domain + 存量打标缺省（progress→project、
 *    其余→habit）；重复构造不重复迁移不改值（幂等可重跑）；新写入显式落值；
 * 2. 一致性约束单点（resolveMemoryWriteAttrs）：domain=project ↔ projectScope
 *    必绑定；无项目上下文 → 回落 general+global + warn；habit/general 强制
 *    global（显式 scope 冲突同款修正 + warn）；缺省推导 preference→habit /
 *    fact→general / progress→project；显式 projectScope（无 domain）反向
 *    隐含 project 域（↔ 双向约束——E-264 显式通道不因 domain 缺省断链）；
 * 3. 总结器结构化产物解析（[{text,kind,domain}]）：正常三产物 / 无效元素
 *    过滤 / 旧纯文本形态容错（回落 preference+habit = 旧固定语义）/ 烂输出
 *    整体丢弃下轮重试语义回归；rememberMemoryPoint 逐条收 kind+domain；
 * 4. remember domain 缺省推导与显式优先（服务写入面单点收口）；
 * 5. memory_search domain 过滤（命中/不传=全域/闸语义不变）——见
 *    memory-search-tool.test.ts domain 过滤族；
 * 7. 协议回执 domain 逐字段透传断言（TR-159 帧级钉死）+ memory_append
 *    domain 入参类型闸与透传。
 *
 * 设计锚点：一致性约束只活在 resolveMemoryWriteAttrs 一个单点（写入面四路
 * 径同源）；domain 过滤是召回候选池 additive 过滤维度（scope 预过滤同层
 * rowid IN 形态），融合排序/progress 配额/资格闸/半衰期零改动（E-259 不触碰）。
 */
import { describe, expect, test } from "bun:test";
import { getLoadablePath } from "sqlite-vec";
import Database from "better-sqlite3";
import { SqliteVecMemoryStore } from "../../src/adapters/driven/steward-memory/SqliteVecMemoryStore";
import {
  StewardMemoryService,
  resolveMemoryWriteAttrs,
  deriveMemoryDomain,
  MEMORY_SCOPE_GLOBAL,
} from "../../src/application/steward/StewardMemoryService";
import type {
  StewardMemoryPort,
  StewardMemoryAppendItem,
  StewardMemoryEntry,
} from "../../src/application/ports/outbound/StewardMemoryPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { EmbeddingPort, EmbeddingResult } from "../../src/application/ports/outbound/EmbeddingPort";
import type { EmbeddingConfigLookup } from "../../src/application/steward/StewardMemoryService";
import type { EmbeddingEndpointRecord } from "../../src/application/embedding/EmbeddingConfigService";
import { handleStewardMemoryAppend, handleStewardMemoryList } from "../../src/adapters/driving/ws-server/handlers/steward";
import type { StewardCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";
import type { StewardService } from "../../src/application/steward/StewardService";
import type { EventEnvelope } from "@helix/protocol";

const V = Float32Array.from([1, 0, 0]);
const V2 = Float32Array.from([0, 1, 0]);

const ENDPOINT_RECORD: EmbeddingEndpointRecord = {
  id: "ep-1",
  name: "fake-embedding",
  kind: "embedding",
  baseUrl: "http://localhost:1",
  model: "text-embedding-fake",
};

function fakeConfig(initial: Record<string, string> = {}): RuntimeConfigPort {
  const kv = new Map(Object.entries(initial));
  return {
    get: (key: string) => kv.get(key),
    set: async (key: string, value: string) => {
      kv.set(key, value);
    },
  };
}

function fakeLookup(): EmbeddingConfigLookup {
  return {
    resolveRecord: (endpointId) => (endpointId === ENDPOINT_RECORD.id ? ENDPOINT_RECORD : null),
    resolveDefault: () => ({ baseUrl: ENDPOINT_RECORD.baseUrl, model: ENDPOINT_RECORD.model }),
  };
}

function fakeEmbedding(): EmbeddingPort {
  return {
    endpointLabel: () => "fake",
    async embed(texts: readonly string[]): Promise<EmbeddingResult> {
      return { vectors: texts.map((_, i) => (i === 0 ? V : V2)), dim: 3 };
    },
  };
}

// ── 1. schema 迁移（真库）──────────────────────────────────

describe("domain 维度·schema 迁移（幂等 + 存量打标缺省）", () => {
  test("① 旧库补列：progress→project、其余→habit；重复构造幂等不改值", () => {
    const dbPath = `/tmp/helix-memory-domain-migrate-${process.pid}.db`;
    for (const suffix of ["", "-wal", "-shm"]) {
      require("node:fs").rmSync(`${dbPath}${suffix}`, { force: true });
    }
    // 搭旧 schema 存量库（无 domain 列）：progress 1 条 + fact/preference 各 1 条
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE entries(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT 0,
        last_recalled_at INTEGER NOT NULL DEFAULT 0,
        recall_count INTEGER NOT NULL DEFAULT 0,
        faded_at INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        session_id TEXT NOT NULL DEFAULT '',
        project_scope TEXT NOT NULL DEFAULT 'global'
      );
    `);
    legacy
      .prepare("INSERT INTO entries(kind, text, source, created_at, session_id) VALUES ('progress', '存量进展', 'session-progress', 1000, 's1')")
      .run();
    legacy.prepare("INSERT INTO entries(kind, text, source, created_at) VALUES ('fact', '存量事实', 'steward-turn', 2000)").run();
    legacy.prepare("INSERT INTO entries(kind, text, source, created_at) VALUES ('preference', '存量偏好', 'auto-sediment', 3000)").run();
    legacy.close();

    // 首次构造：补列 + 存量打标（progress→project、其余→habit）
    const store = new SqliteVecMemoryStore(dbPath, getLoadablePath());
    const byText = new Map(store.list().map((e) => [e.text, e]));
    expect(byText.get("存量进展")!.domain).toBe("project");
    expect(byText.get("存量事实")!.domain).toBe("habit");
    expect(byText.get("存量偏好")!.domain).toBe("habit");
    store.close();

    // 幂等重跑：二次构造零动作（值原样不重复迁移）——迁移后新写入的显式值
    // 不被重放覆盖（缺省打标只在补列当次生效）
    const store2 = new SqliteVecMemoryStore(dbPath, getLoadablePath());
    store2.append([{ kind: "fact", text: "迁移后新写", source: "t", createdAt: 4000, vector: V, domain: "general" }]);
    store2.close();
    const store3 = new SqliteVecMemoryStore(dbPath, getLoadablePath());
    const byText3 = new Map(store3.list().map((e) => [e.text, e]));
    expect(byText3.get("存量进展")!.domain).toBe("project");
    expect(byText3.get("存量事实")!.domain).toBe("habit");
    expect(byText3.get("迁移后新写")!.domain).toBe("general");
    expect(store3.count()).toBe(4);
    store3.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      require("node:fs").rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("② 新写入 domain 落库往返（append/list/search 投影携带）", () => {
    const store = new SqliteVecMemoryStore(":memory:", getLoadablePath());
    store.append([
      { kind: "preference", text: "习惯条目", source: "t", createdAt: 1, vector: V, domain: "habit" },
      { kind: "fact", text: "项目事实", source: "t", createdAt: 2, vector: V2, domain: "project", projectScope: "helix" },
    ]);
    const entries = store.list();
    expect(entries[0]!.domain).toBe("habit");
    expect(entries[1]!.domain).toBe("project");
    const hits = store.search(V, 10);
    expect(hits.find((h) => h.text === "项目事实")!.domain).toBe("project");
    store.close();
  });
});

// ── 2. 一致性约束单点 ─────────────────────────────────────

describe("domain 维度·一致性约束单点（resolveMemoryWriteAttrs）", () => {
  test("③ domain=project ↔ projectScope 必绑定：项目通道/显式通道取名", () => {
    const warns: string[] = [];
    const warn = (m: string) => warns.push(m);
    expect(resolveMemoryWriteAttrs({ kind: "fact", domain: "project", project: "helix", warn })).toEqual({
      domain: "project",
      projectScope: "helix",
    });
    // explicit 显式名优先于项目通道
    expect(resolveMemoryWriteAttrs({ kind: "fact", domain: "project", project: "other", explicit: "helix", warn })).toEqual({
      domain: "project",
      projectScope: "helix",
    });
    expect(warns).toEqual([]);
  });

  test("④ domain=project 无项目上下文 → 回落 general+global + warn", () => {
    const warns: string[] = [];
    expect(
      resolveMemoryWriteAttrs({ kind: "progress", domain: "project", warn: (m) => warns.push(m) }),
    ).toEqual({ domain: "general", projectScope: MEMORY_SCOPE_GLOBAL });
    expect(warns).toHaveLength(1);
    // 空白项目名 = 无上下文（同款回落）
    const warns2: string[] = [];
    expect(
      resolveMemoryWriteAttrs({ kind: "fact", domain: "project", project: "  ", warn: (m) => warns2.push(m) }),
    ).toEqual({ domain: "general", projectScope: MEMORY_SCOPE_GLOBAL });
    expect(warns2).toHaveLength(1);
  });

  test("⑤ habit/general 强制 global：显式 scope 冲突 → 修正 + warn", () => {
    const warns: string[] = [];
    expect(
      resolveMemoryWriteAttrs({ kind: "fact", domain: "general", explicit: "helix", warn: (m) => warns.push(m) }),
    ).toEqual({ domain: "general", projectScope: MEMORY_SCOPE_GLOBAL });
    expect(warns).toHaveLength(1);
    // 项目通道同款强制 global（修正 + warn）
    const warns2: string[] = [];
    expect(
      resolveMemoryWriteAttrs({ kind: "preference", domain: "habit", project: "helix", warn: (m) => warns2.push(m) }),
    ).toEqual({ domain: "habit", projectScope: MEMORY_SCOPE_GLOBAL });
    expect(warns2).toHaveLength(1);
    // 无冲突不 warn
    const warns3: string[] = [];
    expect(resolveMemoryWriteAttrs({ kind: "fact", domain: "general", warn: (m) => warns3.push(m) })).toEqual({
      domain: "general",
      projectScope: MEMORY_SCOPE_GLOBAL,
    });
    expect(warns3).toEqual([]);
  });

  test("⑥ 缺省推导：preference→habit / fact→general / progress→project；显式 projectScope 反向隐含 project 域", () => {
    expect(deriveMemoryDomain("preference")).toBe("habit");
    expect(deriveMemoryDomain("fact")).toBe("general");
    expect(deriveMemoryDomain("progress")).toBe("project");
    expect(resolveMemoryWriteAttrs({ kind: "preference" })).toEqual({ domain: "habit", projectScope: MEMORY_SCOPE_GLOBAL });
    expect(resolveMemoryWriteAttrs({ kind: "fact" })).toEqual({ domain: "general", projectScope: MEMORY_SCOPE_GLOBAL });
    // 显式 projectScope（无 domain）→ ↔ 反向蕴含：绑定即项目域（E-264 显式通道不因缺省断链）
    expect(resolveMemoryWriteAttrs({ kind: "fact", explicit: "helix" })).toEqual({ domain: "project", projectScope: "helix" });
    // 显式 "global" 哨兵不是具体项目名 → 推导域
    expect(resolveMemoryWriteAttrs({ kind: "fact", explicit: MEMORY_SCOPE_GLOBAL })).toEqual({
      domain: "general",
      projectScope: MEMORY_SCOPE_GLOBAL,
    });
    // progress 固定 domain=project（无项目会话回落 general——同 ④）
    expect(resolveMemoryWriteAttrs({ kind: "progress", project: "helix" })).toEqual({ domain: "project", projectScope: "helix" });
    expect(resolveMemoryWriteAttrs({ kind: "progress" })).toEqual({ domain: "general", projectScope: MEMORY_SCOPE_GLOBAL });
    // 显式 domain 优先于推导
    expect(resolveMemoryWriteAttrs({ kind: "fact", domain: "project", project: "helix" })).toEqual({
      domain: "project",
      projectScope: "helix",
    });
    expect(resolveMemoryWriteAttrs({ kind: "preference", domain: "project", explicit: "helix" })).toEqual({
      domain: "project",
      projectScope: "helix",
    });
  });
});

// ── 3. 服务写入面（四路径 domain 落点）─────────────────────

/** scope/domain-aware fake store：记录 append/update 全参。 */
function domainFakeStore(): StewardMemoryPort & {
  appended: StewardMemoryAppendItem[];
  updated: { id: number; text: string; scope?: string }[];
} {
  const appended: StewardMemoryAppendItem[] = [];
  const updated: { id: number; text: string; scope?: string }[] = [];
  const rows: StewardMemoryEntry[] = [];
  return {
    appended,
    updated,
    append(items) {
      appended.push(...items);
      for (const item of items) {
        rows.push({
          id: rows.length + 1,
          kind: item.kind,
          text: item.text,
          source: item.source,
          createdAt: item.createdAt,
          updatedAt: item.createdAt,
          lastRecalledAt: item.createdAt,
          recallCount: 0,
          fadedAt: 0,
          pinned: false,
          ...(item.sessionId !== undefined ? { sessionId: item.sessionId } : {}),
          ...(item.projectScope !== undefined ? { projectScope: item.projectScope } : {}),
          ...(item.domain !== undefined ? { domain: item.domain } : {}),
        });
      }
    },
    search: () => [],
    list: () => rows,
    forget: () => false,
    updateEntry(id: number, text: string, _v: Float32Array, _at: number, scope?: string) {
      updated.push({ id, text, scope });
      return true;
    },
    findProgressId: () => null,
    markRecalled: () => undefined,
    setPinned: () => false,
    restore: () => false,
    fadeMany: () => undefined,
    count: () => rows.length,
    storedDim: () => 3,
    resetVectors: () => undefined,
    putVector: () => undefined,
    close: () => undefined,
  };
}

function serviceOf(
  store: StewardMemoryPort,
  extra: {
    resolveSessionProject?: (sid: string) => string | undefined;
    warns?: string[];
  } = {},
): StewardMemoryService {
  return new StewardMemoryService({
    config: fakeConfig({ "memory.enabled": "1", "memory.endpointId": "ep-1" }),
    embedding: fakeEmbedding(),
    embeddingConfig: fakeLookup(),
    store,
    ...(extra.resolveSessionProject !== undefined ? { resolveSessionProject: extra.resolveSessionProject } : {}),
    ...(extra.warns !== undefined ? { logger: { warn: (m: string) => extra.warns!.push(m) } } : {}),
  });
}

describe("domain 维度·服务写入面（remember 缺省推导与显式优先）", () => {
  test("⑦ remember 缺省推导：preference→habit / fact→general（scope 恒 global）", async () => {
    const store = domainFakeStore();
    const svc = serviceOf(store);
    await svc.remember("用户偏好简洁回复", "preference", "steward-turn");
    await svc.remember("helix 用 bun test", "fact", "steward-turn");
    expect(store.appended[0]!.domain).toBe("habit");
    expect(store.appended[0]!.projectScope).toBe(MEMORY_SCOPE_GLOBAL);
    expect(store.appended[1]!.domain).toBe("general");
    expect(store.appended[1]!.projectScope).toBe(MEMORY_SCOPE_GLOBAL);
  });

  test("⑧ remember 显式 domain 优先：domain=project + 项目通道 → 绑项目；general+项目通道 → 强制 global + warn", async () => {
    const warns: string[] = [];
    const store = domainFakeStore();
    const svc = serviceOf(store, { warns });
    await svc.remember("helix 记忆库在 steward_memory.db", "fact", "steward-turn", { domain: "project", project: "helix" });
    expect(store.appended[0]!.domain).toBe("project");
    expect(store.appended[0]!.projectScope).toBe("helix");
    await svc.remember("测试命令是 bun test", "fact", "steward-turn", { project: "helix" });
    expect(store.appended[1]!.domain).toBe("general");
    expect(store.appended[1]!.projectScope).toBe(MEMORY_SCOPE_GLOBAL);
    expect(warns.length).toBeGreaterThanOrEqual(1); // 静默修正 + warn（不抛错）
  });

  test("⑨ rememberSessionMemoryPoint(text, kind, domain)：domain=project 取会话项目（resolveSessionProject 归约）；无项目回落 general+global + warn", async () => {
    const store = domainFakeStore();
    const svc = serviceOf(store, { resolveSessionProject: () => "helix" });
    await svc.rememberSessionMemoryPoint("helix 的测试约定写在 kg 里", "fact", "project", "sess-1");
    expect(store.appended[0]!.domain).toBe("project");
    expect(store.appended[0]!.projectScope).toBe("helix");
    expect(store.appended[0]!.source).toBe("session-summary");

    const warns: string[] = [];
    const store2 = domainFakeStore();
    const svc2 = serviceOf(store2, { resolveSessionProject: () => undefined, warns });
    await svc2.rememberSessionMemoryPoint("跨项目的用户习惯", "preference", "habit", "sess-2");
    await svc2.rememberSessionMemoryPoint("无项目会话的项目事实", "fact", "project", "sess-2");
    expect(store2.appended[0]!.domain).toBe("habit");
    expect(store2.appended[0]!.projectScope).toBe(MEMORY_SCOPE_GLOBAL);
    expect(store2.appended[1]!.domain).toBe("general"); // 回落
    expect(store2.appended[1]!.projectScope).toBe(MEMORY_SCOPE_GLOBAL);
    expect(warns).toHaveLength(1);
  });

  test("⑩ appendMemoryEntry：domain 缺省推导（缺省 general——kind 缺省 fact）；显式 projectScope 反向隐含 project；domain+scope 冲突修正", async () => {
    const warns: string[] = [];
    const store = domainFakeStore();
    const svc = serviceOf(store, { warns });
    // 缺省（kind 缺省 fact → general）
    expect(await svc.appendMemoryEntry("手动事实")).toEqual({ ok: true });
    expect(store.appended[0]!.domain).toBe("general");
    expect(store.appended[0]!.projectScope).toBe(MEMORY_SCOPE_GLOBAL);
    // 显式 projectScope（无 domain）→ ↔ 反向蕴含 project 域（E-264 显式通道）
    expect(await svc.appendMemoryEntry("helix 仓在 AI_Project 下", "fact", "helix")).toEqual({ ok: true });
    expect(store.appended[1]!.domain).toBe("project");
    expect(store.appended[1]!.projectScope).toBe("helix");
    // 显式 domain=general + 显式 scope 冲突 → 强制 global + warn
    expect(await svc.appendMemoryEntry("冲突写入", "fact", "helix", "general")).toEqual({ ok: true });
    expect(store.appended[2]!.domain).toBe("general");
    expect(store.appended[2]!.projectScope).toBe(MEMORY_SCOPE_GLOBAL);
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  test("⑪ progress 固定 domain=project（无项目会话回落 general）——recordSessionProgress 落点", async () => {
    const single = domainFakeStore();
    await serviceOf(single, { resolveSessionProject: () => "helix" }).recordSessionProgress("sess-1", "正在实现 domain 维度");
    expect(single.appended[0]!.domain).toBe("project");
    expect(single.appended[0]!.projectScope).toBe("helix");

    const warns: string[] = [];
    const multi = domainFakeStore();
    await serviceOf(multi, { resolveSessionProject: () => undefined, warns }).recordSessionProgress("sess-1", "跨项目任务");
    expect(multi.appended[0]!.domain).toBe("general");
    expect(multi.appended[0]!.projectScope).toBe(MEMORY_SCOPE_GLOBAL);
    expect(warns).toHaveLength(1);
  });
});

// ── 4. 召回行文透传 domain（展示用）────────────────────────

describe("domain 维度·召回行文透传（融合排序不动）", () => {
  test("⑫ recallSection 行文携带 domain 标签（习惯/通用/项目）", async () => {
    const store = new SqliteVecMemoryStore(":memory:", getLoadablePath());
    store.append([
      { kind: "preference", text: "用户要求回复简洁", source: "t", createdAt: 1, vector: V, domain: "habit", projectScope: "global" },
      { kind: "fact", text: "helix 用 bun test", source: "t", createdAt: 2, vector: V, domain: "project", projectScope: "helix" },
    ]);
    const service = new StewardMemoryService({
      config: fakeConfig({ "memory.enabled": "1", "memory.endpointId": "ep-1" }),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store,
      clock: () => 1_800_000_000_000,
    });
    const section = await service.recallSection("测试习惯", "helix");
    expect(section).toContain("回复简洁");
    expect(section).toContain("习惯");
    expect(section).toContain("项目");
    store.close();
  });
});

// ── 5. 协议面（memory_list 回执 domain 透传 + memory_append 入参）──

describe("domain 维度·协议面（TR-159 逐字段透传）", () => {
  function frameCtxOf(
    type: string,
    payload: Record<string, unknown>,
    entries: readonly StewardMemoryEntry[],
    appendedArgs: unknown[][] = [],
  ): { ctx: StewardCommandContext; frames: EventEnvelope[]; errors: string[] } {
    const frames: EventEnvelope[] = [];
    const errors: string[] = [];
    const sender = { id: "conn-1" };
    const service = {
      listMemoryEntries: () => entries,
      appendMemoryEntry: (...args: unknown[]) => {
        appendedArgs.push(args);
        return Promise.resolve({ ok: true as const });
      },
    } as unknown as StewardService;
    const ctx = {
      ws: { data: { sender } },
      type,
      payload,
      steward: { service, stream: { subscribeSteward: () => {}, unsubscribeSteward: () => {} } },
      commandError: (_t: string, _c: string, message: string) => {
        errors.push(message);
      },
      rawSender: () => sender,
      sendNow: (_s: unknown, frame: EventEnvelope) => {
        frames.push(frame);
      },
    } as unknown as StewardCommandContext;
    return { ctx, frames, errors };
  }

  function entry(partial: Partial<StewardMemoryEntry> & Pick<StewardMemoryEntry, "id">): StewardMemoryEntry {
    return {
      kind: "fact",
      text: `条目 ${partial.id}`,
      source: "steward-turn",
      createdAt: partial.id * 10,
      updatedAt: partial.id * 10,
      lastRecalledAt: 0,
      recallCount: 0,
      fadedAt: 0,
      pinned: false,
      ...partial,
    };
  }

  test("⑬ memory_list 回执：domain 逐条透传（帧级断言钉死——漏拷即红）", () => {
    const entries = [
      entry({ id: 1, domain: "habit", projectScope: "global" }),
      entry({ id: 2, domain: "project", projectScope: "helix" }),
    ];
    const { ctx, frames, errors } = frameCtxOf("steward.memory_list", {}, entries);
    handleStewardMemoryList(ctx);
    expect(errors).toEqual([]);
    const frame = frames[0] as unknown as { payload: { entries: Record<string, unknown>[] } };
    expect(frame.payload.entries.find((r) => r.id === 1)!.domain).toBe("habit");
    expect(frame.payload.entries.find((r) => r.id === 2)!.domain).toBe("project");
  });

  test("⑭ memory_append：domain 合法值透传；非法值打回 invalid_payload", async () => {
    const appendedArgs: unknown[][] = [];
    const okCtx = frameCtxOf(
      "steward.memory_append",
      { text: "helix 事实一条", kind: "fact", projectScope: "helix", domain: "project" },
      [],
      appendedArgs,
    );
    handleStewardMemoryAppend(okCtx.ctx);
    await Promise.resolve();
    expect(appendedArgs).toEqual([["helix 事实一条", "fact", "helix", "project"]]);
    const badCtx = frameCtxOf("steward.memory_append", { text: "x", domain: "workspace" }, [], appendedArgs);
    handleStewardMemoryAppend(badCtx.ctx);
    expect(badCtx.errors).toHaveLength(1);
    expect(badCtx.errors[0]).toContain("domain");
  });
});
