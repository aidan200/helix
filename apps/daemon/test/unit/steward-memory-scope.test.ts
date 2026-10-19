/**
 * 长期记忆项目作用域批单测（跨项目隔离：projectScope 字段 + 召回过滤 +
 * 四写入面 scope 赋值 + 存量迁移 + 管理命令展示）。
 *
 * 红绿证据链（brief 测试要求逐条）：
 * 1. resolveMemoryWriteAttrs 纯函数（domain 维度批起单点——scope 随 domain
 *    一致性约束裁定）：explicit 优先（↔ 隐含 project 域）/ preference 缺省
 *    habit+global / progress 缺省绑写时项目 / fact 缺省 general+global /
 *    无项目上下文回落 global；
 * 2. store（真库 :memory:）：存量迁移（旧行 → global + 幂等重跑）+
 *    append projectScope 落库（缺省 global）+ search scopeFilter
 *    （rowid IN pre-filter——他项目最近邻不占 KNN 名额）+ updateEntry
 *    传 scope 重落/不传保持；
 * 3. service 写入面：管家轮 fact 缺省 general → global（domain 一致性约束批
 *    起 fact 不再自动绑项目——项目事实须显式 domain=project）/ 记忆点
 *    habit → global / 人工 append 显式 scope（↔ 隐含 project 域）/ progress
 *    会话足迹单项目 → 绑项目（多项目/无足迹 → global）+ 覆盖更新 scope
 *    随写时重落不新建 + 查重视野带 scope；
 * 4. 召回过滤（真库 + 真 service）：global+本项目入选、他项目不注入、
 *    无 scope 上下文只见 global；
 * 5. 协议面：memory_list 回执 projectScope 透传 + memory_append 显式
 *    projectScope 入参（类型闸 + 透传）。
 *
 * 设计锚点：scope 赋值收口在 StewardMemoryService（入库点——总结器/感知
 * 调用面零签名变化，项目解析经 deps.resolveSessionProject 注入）；召回
 * 过滤是 additive 维度（候选池取数时 rowid IN pre-filter，融合排序/
 * progress 配额/资格闸零改动——E-259 管辖面不触碰）。
 */
import { describe, expect, test } from "bun:test";
import { getLoadablePath } from "sqlite-vec";
import Database from "better-sqlite3";
import { SqliteVecMemoryStore } from "../../src/adapters/driven/steward-memory/SqliteVecMemoryStore";
import {
  StewardMemoryService,
  resolveMemoryWriteAttrs,
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
    resolveDefaultClassifierRecord: () => null,
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

// ── 1. scope 赋值纯函数 ─────────────────────────────────────

describe("项目作用域·resolveMemoryWriteAttrs 纯函数（scope 面——domain 维度批起单点升格，完整约束面见 steward-memory-domain.test）", () => {
  test("① explicit 显式指定优先（任意 kind——人工 append 唯一显式通道；↔ 约束反向隐含 project 域）", () => {
    expect(resolveMemoryWriteAttrs({ kind: "preference", explicit: "helix" })).toEqual({ domain: "project", projectScope: "helix" });
    expect(resolveMemoryWriteAttrs({ kind: "fact", project: "other-proj", explicit: "helix" })).toEqual({ domain: "project", projectScope: "helix" });
    expect(resolveMemoryWriteAttrs({ kind: "progress", explicit: "global" })).toEqual({ domain: "general", projectScope: MEMORY_SCOPE_GLOBAL });
  });

  test("② preference 缺省 habit+global（用户画像跨项目成立——即使写时有项目上下文）", () => {
    expect(resolveMemoryWriteAttrs({ kind: "preference", project: "helix" })).toEqual({ domain: "habit", projectScope: MEMORY_SCOPE_GLOBAL });
    expect(resolveMemoryWriteAttrs({ kind: "preference" })).toEqual({ domain: "habit", projectScope: MEMORY_SCOPE_GLOBAL });
  });

  test("③ progress 缺省绑写时项目（domain=project）；fact 缺省 general+global（domain 一致性约束——项目事实须显式 domain=project）", () => {
    expect(resolveMemoryWriteAttrs({ kind: "progress", project: "helix" })).toEqual({ domain: "project", projectScope: "helix" });
    expect(resolveMemoryWriteAttrs({ kind: "fact", project: "helix" })).toEqual({ domain: "general", projectScope: MEMORY_SCOPE_GLOBAL });
    expect(resolveMemoryWriteAttrs({ kind: "fact" })).toEqual({ domain: "general", projectScope: MEMORY_SCOPE_GLOBAL });
    expect(resolveMemoryWriteAttrs({ kind: "progress" })).toEqual({ domain: "general", projectScope: MEMORY_SCOPE_GLOBAL });
    // 空白串项目名 = 无上下文（防脏值落库）
    expect(resolveMemoryWriteAttrs({ kind: "progress", project: "  " })).toEqual({ domain: "general", projectScope: MEMORY_SCOPE_GLOBAL });
  });
});

// ── 2. store（真库）────────────────────────────────────────

describe("项目作用域·store（SqliteVecMemoryStore 真库）", () => {
  test("④ 存量迁移：旧 schema 库 → 补列 + 旧行 global（零行为变化起步）+ 幂等重跑", () => {
    const dbPath = `/tmp/helix-memory-scope-migrate-${process.pid}.db`;
    require("node:fs").rmSync(dbPath, { force: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      require("node:fs").rmSync(`${dbPath}${suffix}`, { force: true });
    }
    // 搭旧 schema 存量库
    const legacy = new Database(dbPath);
    legacy.exec(oldSchemaSql());
    insertLegacyRow(legacy, "存量事实");
    insertLegacyRow(legacy, "存量偏好");
    legacy.close();
    // 首次构造：补列 → 存量行 global（零行为变化起步）
    const store = new SqliteVecMemoryStore(dbPath, getLoadablePath());
    const entries = store.list();
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.projectScope === MEMORY_SCOPE_GLOBAL)).toBe(true);
    expect(store.count()).toBe(2);
    store.close();
    // 幂等重跑：二次构造零变化（行数/值原样，不重复迁移不抛错）
    const store2 = new SqliteVecMemoryStore(dbPath, getLoadablePath());
    expect(store2.list().every((e) => e.projectScope === MEMORY_SCOPE_GLOBAL)).toBe(true);
    expect(store2.count()).toBe(2);
    store2.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      require("node:fs").rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("⑤ append projectScope 落库：显式项目名往返；缺省 global；list 投影携带", () => {
    const store = new SqliteVecMemoryStore(":memory:", getLoadablePath());
    store.append([
      { kind: "fact", text: "helix 项目事实", source: "t", createdAt: 1, vector: V, projectScope: "helix" },
      { kind: "preference", text: "全局偏好", source: "t", createdAt: 2, vector: V2 },
    ]);
    const entries = store.list();
    expect(entries[0]!.projectScope).toBe("helix");
    expect(entries[1]!.projectScope).toBe(MEMORY_SCOPE_GLOBAL);
    // search 命中也携带投影
    store.close();
  });

  test("⑥ search scopeFilter：global+本项目入选、他项目排除、undefined 全库（兼容既有调用）", () => {
    const store = new SqliteVecMemoryStore(":memory:", getLoadablePath());
    // 距离序：乙(other, 最近) < 甲(global) < 丙(helix) < 丁(global, 远)
    store.append([
      { kind: "fact", text: "乙", source: "t", createdAt: 1, vector: Float32Array.from([1, 0.01, 0]), projectScope: "other" },
      { kind: "fact", text: "甲", source: "t", createdAt: 2, vector: Float32Array.from([1, 0.02, 0]), projectScope: "global" },
      { kind: "fact", text: "丙", source: "t", createdAt: 3, vector: Float32Array.from([1, 0.03, 0]), projectScope: "helix" },
      { kind: "fact", text: "丁", source: "t", createdAt: 4, vector: Float32Array.from([1, 0.04, 0]), projectScope: "global" },
    ]);
    const q = V;
    // helix 视野：global + helix（甲丙丁），other 的乙不注入
    const helixView = store.search(q, 10, ["global", "helix"]);
    expect(helixView.map((h) => h.text)).toEqual(["甲", "丙", "丁"]);
    expect(helixView.every((h) => h.projectScope !== "other")).toBe(true);
    // 无 scope 上下文：只 global
    const globalView = store.search(q, 10, ["global"]);
    expect(globalView.map((h) => h.text)).toEqual(["甲", "丁"]);
    // 他项目视野：不见 global 之外的更多项——other 视野 = 乙 + global
    const otherView = store.search(q, 10, ["global", "other"]);
    expect(otherView.map((h) => h.text)).toEqual(["乙", "甲", "丁"]);
    // undefined = 不过滤（既有调用面兼容——查重等）
    const all = store.search(q, 10);
    expect(all).toHaveLength(4);
    store.close();
  });

  test("⑦ pre-filter 名额语义：k=1 时他项目最近邻不占 KNN 名额（本项目条目入选）", () => {
    const store = new SqliteVecMemoryStore(":memory:", getLoadablePath());
    store.append([
      // 乙(other) 距离最近——post-filter 形态下会独占 k=1 名额
      { kind: "fact", text: "乙", source: "t", createdAt: 1, vector: Float32Array.from([1, 0.01, 0]), projectScope: "other" },
      { kind: "fact", text: "甲", source: "t", createdAt: 2, vector: Float32Array.from([1, 0.02, 0]), projectScope: "helix" },
    ]);
    const hits = store.search(V, 1, ["global", "helix"]);
    expect(hits.map((h) => h.text)).toEqual(["甲"]); // pre-filter：名额给合格行
    store.close();
  });

  test("⑧ updateEntry：传 projectScope 重落（progress 覆盖更新随写时项目）；不传保持原值（人工编辑不改归属）", () => {
    const store = new SqliteVecMemoryStore(":memory:", getLoadablePath());
    store.append([{ kind: "progress", text: "旧进展", source: "session-progress", sessionId: "s1", createdAt: 1, vector: V, projectScope: "proj-a" }]);
    const id = store.list()[0]!.id;
    // 覆盖更新显式重落 scope（随写时项目——不因 scope 分叉新建条目）
    expect(store.updateEntry(id, "新进展", V2, 2000, "proj-b")).toBe(true);
    const after = store.list()[0]!;
    expect(after.projectScope).toBe("proj-b");
    expect(after.text).toBe("新进展");
    expect(store.count()).toBe(1); // 一条会话一条进展——覆盖不新建
    // 不传 scope：保持现值（人工编辑/查重覆盖语义）
    expect(store.updateEntry(id, "再编辑", V2, 3000)).toBe(true);
    expect(store.list()[0]!.projectScope).toBe("proj-b");
    store.close();
  });
});

// ── 3. service 写入面（fake store——参数透传断言）─────────────

/** scope-aware fake store：记录 append/updateEntry/search 全参（含 scope 面）。 */
function scopeFakeStore(opts: { progressId?: number | null } = {}): StewardMemoryPort & {
  appended: StewardMemoryAppendItem[];
  updated: { id: number; text: string; scope?: string }[];
  searchCalls: { topK: number; scopes: readonly string[] | undefined }[];
  seeded: StewardMemoryEntry[];
} {
  const appended: StewardMemoryAppendItem[] = [];
  const updated: { id: number; text: string; scope?: string }[] = [];
  const searchCalls: { topK: number; scopes: readonly string[] | undefined }[] = [];
  const rows: StewardMemoryEntry[] = [];
  return {
    appended,
    updated,
    searchCalls,
    seeded: rows,
    append(items) {
      appended.push(...items);
      const ids: number[] = [];
      for (const item of items) {
        const id = rows.length + 1;
        ids.push(id);
        rows.push({
          id,
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
        });
      }
      return ids;
    },
    search(_q: Float32Array, topK: number, scopes?: readonly string[]) {
      searchCalls.push({ topK, scopes });
      return [];
    },
    list() {
      return rows;
    },
    forget() {
      return false;
    },
    updateEntry(id: number, text: string, _v: Float32Array, _at: number, scope?: string) {
      updated.push({ id, text, scope });
      return true;
    },
    findProgressId() {
      return opts.progressId ?? null;
    },
    markRecalled: () => undefined,
    setPinned: () => false,
    restore: () => false,
    fadeMany: () => undefined,
    count() {
      return rows.length;
    },
    storedDim() {
      return 3;
    },
    resetVectors: () => undefined,
    putVector: () => undefined,
    close: () => undefined,
  };
}

function serviceOf(store: StewardMemoryPort, extra: { resolveSessionProject?: (sid: string) => string | undefined } = {}): StewardMemoryService {
  return new StewardMemoryService({
    config: fakeConfig({ "memory.enabled": "1", "memory.endpointId": "ep-1" }),
    embedding: fakeEmbedding(),
    embeddingConfig: fakeLookup(),
    store,
    ...extra,
  });
}

describe("项目作用域·service 写入面 scope 赋值", () => {
  test("⑨ 管家轮 remember（fact）缺省 domain=general → 恒 global；显式 domain=project → 绑写时项目", async () => {
    const store = scopeFakeStore();
    await serviceOf(store).remember("helix 用 bun test", "fact", "steward-turn");
    expect(store.appended[0]!.projectScope).toBe(MEMORY_SCOPE_GLOBAL);
    // 查重视野 = 写入 scope（global-only）
    expect(store.searchCalls[0]!.scopes).toEqual([MEMORY_SCOPE_GLOBAL]);
    // 项目事实须显式打标 domain=project（缺省推导 fact→general 不再自动绑项目——
    // domain 一致性约束批）
    const storeP = scopeFakeStore();
    await serviceOf(storeP).remember("helix 用 bun test", "fact", "steward-turn", { domain: "project", project: "helix" });
    expect(storeP.appended[0]!.projectScope).toBe("helix");
    expect(storeP.searchCalls[0]!.scopes).toEqual(["helix"]);
  });

  test("⑩ remember preference：project 通道不影响（habit+global）；人工显式 scope（↔ 隐含 project 域）→ 项目", async () => {
    const store = scopeFakeStore();
    const svc = serviceOf(store);
    await svc.remember("回复要简洁", "preference", "steward-turn", { project: "helix" });
    expect(store.appended[0]!.projectScope).toBe(MEMORY_SCOPE_GLOBAL);
    // 人工显式通道：appendMemoryEntry(text, kind, projectScope)
    const outcome = await svc.appendMemoryEntry("helix 仓在 AI_Project 下", "fact", "helix");
    expect(outcome).toEqual({ ok: true });
    expect(store.appended[1]!.projectScope).toBe("helix");
    // 显式 scope 的查重视野 = 项目 scope
    expect(store.searchCalls[1]!.scopes).toEqual(["helix"]);
  });

  test("⑪ 会话总结器记忆点（source=session-summary）→ habit 规则 global", async () => {
    const store = scopeFakeStore();
    await serviceOf(store).rememberSessionMemoryPoint("用户偏好中文回复", "preference", "habit");
    expect(store.appended[0]!.projectScope).toBe(MEMORY_SCOPE_GLOBAL);
  });

  test("⑫ progress：会话足迹单项目 → 绑项目；多项目/无足迹 → global（deps.resolveSessionProject 注入）", async () => {
    // 单项目足迹
    const single = scopeFakeStore();
    await serviceOf(single, { resolveSessionProject: () => "helix" }).recordSessionProgress("sess-1", "正在实现记忆隔离");
    expect(single.appended[0]!.projectScope).toBe("helix");
    // 多项目足迹 → 无单一项目 → global
    const multi = scopeFakeStore();
    await serviceOf(multi, { resolveSessionProject: () => undefined }).recordSessionProgress("sess-1", "跨两个项目的任务");
    expect(multi.appended[0]!.projectScope).toBe(MEMORY_SCOPE_GLOBAL);
    // 解析器缺席（旧装配）→ global
    const absent = scopeFakeStore();
    await serviceOf(absent).recordSessionProgress("sess-1", "无足迹会话");
    expect(absent.appended[0]!.projectScope).toBe(MEMORY_SCOPE_GLOBAL);
  });

  test("⑬ progress 覆盖更新：scope 随写时项目重落（同 id 不新建——不因 scope 分叉）", async () => {
    const store = scopeFakeStore({ progressId: 7 });
    const svc = serviceOf(store, { resolveSessionProject: () => "proj-b" });
    await svc.recordSessionProgress("sess-1", "进展更新");
    expect(store.appended).toHaveLength(0); // 已有 progress 条目 → 覆盖不 append
    expect(store.updated).toEqual([{ id: 7, text: "进展更新", scope: "proj-b" }]);
    // 写时项目变化（会话跨项目）：scope 跟随重落（仍覆盖同一条）
    const store2 = scopeFakeStore({ progressId: 7 });
    await serviceOf(store2, { resolveSessionProject: () => undefined }).recordSessionProgress("sess-1", "回到全局语境");
    expect(store2.updated).toEqual([{ id: 7, text: "回到全局语境", scope: MEMORY_SCOPE_GLOBAL }]);
  });
});

// ── 4. 召回过滤（真库 + 真 service）─────────────────────────

describe("项目作用域·召回过滤（真库端到端）", () => {
  function recallFixture() {
    const store = new SqliteVecMemoryStore(":memory:", getLoadablePath());
    store.append([
      { kind: "fact", text: "全局事实：用户叫思永", source: "t", createdAt: 1, vector: V, projectScope: "global" },
      { kind: "fact", text: "helix 事实：记忆库在 steward_memory.db", source: "t", createdAt: 2, vector: V, projectScope: "helix" },
      { kind: "fact", text: "other 事实：他项目内部进展", source: "t", createdAt: 3, vector: V, projectScope: "other" },
    ]);
    const service = new StewardMemoryService({
      config: fakeConfig({ "memory.enabled": "1", "memory.endpointId": "ep-1" }),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store,
    });
    return { store, service };
  }

  test("⑭ recallSection(query, \"helix\")：global + helix 入选，other 项目条目不注入", async () => {
    const { store, service } = recallFixture();
    const section = await service.recallSection("记忆库在哪", "helix");
    expect(section).toBeDefined();
    expect(section).toContain("用户叫思永"); // global 入选
    expect(section).toContain("steward_memory.db"); // 本项目入选
    expect(section).not.toContain("他项目内部进展"); // 他项目排除
    store.close();
  });

  test("⑮ recallSection(query)（无 scope 上下文）：只见 global", async () => {
    const { store, service } = recallFixture();
    const section = await service.recallSection("记忆库在哪");
    expect(section).toContain("用户叫思永");
    expect(section).not.toContain("steward_memory.db");
    expect(section).not.toContain("他项目内部进展");
    store.close();
  });
});

// ── 5. 协议面（管理命令展示）────────────────────────────────

describe("项目作用域·协议面（memory_list 回执 + memory_append 入参）", () => {
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

  test("⑯ memory_list 回执：projectScope 逐条透传（TR-159 帧级钉死）", () => {
    const entries: StewardMemoryEntry[] = [
      {
        id: 1, kind: "fact", text: "helix 事实", source: "manual", createdAt: 10, updatedAt: 10,
        lastRecalledAt: 0, recallCount: 0, fadedAt: 0, pinned: false, projectScope: "helix",
      },
      {
        id: 2, kind: "preference", text: "全局偏好", source: "manual", createdAt: 20, updatedAt: 20,
        lastRecalledAt: 0, recallCount: 0, fadedAt: 0, pinned: false, projectScope: "global",
      },
    ];
    const { ctx, frames, errors } = frameCtxOf("steward.memory_list", {}, entries);
    handleStewardMemoryList(ctx);
    expect(errors).toEqual([]);
    const frame = frames[0] as unknown as { payload: { entries: Record<string, unknown>[] } };
    const rows = frame.payload.entries;
    expect(rows.find((r) => r.id === 1)!.projectScope).toBe("helix");
    expect(rows.find((r) => r.id === 2)!.projectScope).toBe("global");
  });

  test("⑰ memory_append：projectScope 合法值透传；非法类型打回 invalid_payload", async () => {
    const appendedArgs: unknown[][] = [];
    // 合法透传
    const okCtx = frameCtxOf("steward.memory_append", { text: "helix 事实一条", kind: "fact", projectScope: "helix" }, [], appendedArgs);
    handleStewardMemoryAppend(okCtx.ctx);
    await Promise.resolve();
    expect(appendedArgs).toEqual([["helix 事实一条", "fact", "helix", undefined]]);
    // 非法类型打回
    const badCtx = frameCtxOf("steward.memory_append", { text: "x", projectScope: 42 }, [], appendedArgs);
    handleStewardMemoryAppend(badCtx.ctx);
    expect(badCtx.errors).toHaveLength(1);
    expect(badCtx.errors[0]).toContain("projectScope");
    // 空串打回（防脏值）
    const emptyCtx = frameCtxOf("steward.memory_append", { text: "x", projectScope: "  " }, [], appendedArgs);
    handleStewardMemoryAppend(emptyCtx.ctx);
    expect(emptyCtx.errors).toHaveLength(1);
  });
});

// ── 测试辅助：旧 schema 存量库搭建 ─────────────────────────

function oldSchemaSql(): string {
  return `
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
      session_id TEXT NOT NULL DEFAULT ''
    );
  `;
}

function insertLegacyRow(db: Database.Database, text: string): void {
  db.prepare("INSERT INTO entries(kind, text, source, created_at, updated_at) VALUES ('fact', ?, 'steward-turn', 1000, 1000)").run(text);
}
