/**
 * 管家记忆 progress 批单测（会话内容级感知 M2：存储层 + 服务层）。
 *
 * 红绿证据链（brief 测试要求逐条）：
 * 1. store（真库 :memory:）：session_id 列 additive 往返 + findProgressId
 *    精确定位（kind=progress 限定）+ 覆盖更新组合原语；
 * 2. recordSessionProgress：首写全字段（kind=progress/source=session-progress/
 *    sessionId）+ 同 session 覆盖不增条 + 不可用静默 false + 文本卫生（空/截断）；
 * 3. 召回面：progress 行文 [进展] + sid 锚（LLM 跳 read_session 的凭据——
 *    完整不截断）+ progressQuota 配额（progress 挤占防护）。
 *
 * 设计锚点：progress 写入不走两段查重（sessionKey 精确匹配取代相似度
 * 判定——同一会话的进展是演进状态，覆盖即语义）。
 */
import { describe, expect, test } from "bun:test";
import { getLoadablePath } from "sqlite-vec";
import { SqliteVecMemoryStore } from "../../src/adapters/driven/steward-memory/SqliteVecMemoryStore";
import { StewardMemoryService } from "../../src/application/steward/StewardMemoryService";
import type { StewardMemoryPort, StewardMemoryAppendItem, StewardMemoryEntry } from "../../src/application/ports/outbound/StewardMemoryPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { EmbeddingPort, EmbeddingResult } from "../../src/application/ports/outbound/EmbeddingPort";
import type { EmbeddingConfigLookup } from "../../src/application/steward/StewardMemoryService";
import type { EmbeddingEndpointRecord } from "../../src/application/embedding/EmbeddingConfigService";

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
  const kv = new Map(ObjectEntries(initial));
  return {
    get: (key: string) => kv.get(key),
    set: async (key: string, value: string) => {
      kv.set(key, value);
    },
  };
}
function ObjectEntries(r: Record<string, string>): [string, string][] {
  return Object.keys(r).map((k) => [k, r[k]!] as [string, string]);
}

function fakeLookup(): EmbeddingConfigLookup {
  return { resolveRecord: (endpointId) => (endpointId === ENDPOINT_RECORD.id ? ENDPOINT_RECORD : null) };
}

function fakeEmbedding(): EmbeddingPort {
  return {
    endpointLabel: () => "fake",
    async embed(texts: readonly string[]): Promise<EmbeddingResult> {
      return { vectors: texts.map((_, i) => (i === 0 ? V : V2)), dim: 3 };
    },
  };
}

/** 可编程 fake store（Port 形状——findProgressId 可注入返回值）。 */
function fakeStore(opts: { hits?: readonly StewardMemoryEntry[]; progressId?: number | null } = {}): StewardMemoryPort & {
  appended: StewardMemoryAppendItem[];
  updated: { id: number; text: string }[];
} {
  const appended: StewardMemoryAppendItem[] = [];
  const updated: { id: number; text: string }[] = [];
  const noopStore = {
    appended,
    updated,
    append(items: readonly StewardMemoryAppendItem[]) {
      appended.push(...items);
    },
    search(): readonly import("../../src/application/ports/outbound/StewardMemoryPort").StewardMemoryHit[] {
      return [];
    },
    list(): readonly StewardMemoryEntry[] {
      return [];
    },
    forget(_id: number) {
      return false;
    },
    updateEntry(id: number, text: string) {
      updated.push({ id, text });
      return true;
    },
    findProgressId(_sessionId: string): number | null {
      return opts.progressId ?? null;
    },
    markRecalled: () => undefined,
    setPinned: () => false,
    restore: () => false,
    fadeMany: () => undefined,
    count: () => 0,
    storedDim: () => 3,
    resetVectors: () => undefined,
    putVector: () => undefined,
    close: () => undefined,
  };
  return { ...noopStore, appended, updated } as unknown as StewardMemoryPort & { appended: StewardMemoryAppendItem[]; updated: { id: number; text: string }[] };
}

// ── 1. store（真库）────────────────────────────────────────

describe("progress 批·store（SqliteVecMemoryStore 真库）", () => {
  test("① session_id 列 additive：append 带 sessionId 往返；旧形态不带（undefined）", () => {
    const store = new SqliteVecMemoryStore(":memory:", getLoadablePath());
    store.append([
      { kind: "progress", text: "三档亮度已交付", source: "session-progress", sessionId: "sess-abc", createdAt: 1000, vector: V },
      { kind: "fact", text: "项目在 helix 仓", source: "steward-turn", createdAt: 2000, vector: V2 },
    ]);
    const entries = store.list();
    expect(entries[0]!.kind).toBe("progress");
    expect(entries[0]!.sessionId).toBe("sess-abc");
    expect(entries[1]!.sessionId).toBeUndefined();
    store.close();
  });

  test("② findProgressId：session_id + kind=progress 精确命中；非 progress 同 session 不命中；无 → null", () => {
    const store = new SqliteVecMemoryStore(":memory:", getLoadablePath());
    store.append([
      { kind: "progress", text: "会话甲进展", source: "session-progress", sessionId: "sess-a", createdAt: 1000, vector: V },
      { kind: "fact", text: "会话甲相关事实", source: "steward-turn", sessionId: "sess-a", createdAt: 1100, vector: V2 },
    ]);
    expect(store.findProgressId("sess-a")).toBe(1);
    expect(store.findProgressId("sess-b")).toBeNull();
    store.close();
  });

  test("③ 覆盖更新组合：append → findProgressId → updateEntry → 文本更新且条目数不变", () => {
    const store = new SqliteVecMemoryStore(":memory:", getLoadablePath());
    store.append([{ kind: "progress", text: "初版进展", source: "session-progress", sessionId: "sess-a", createdAt: 1000, vector: V }]);
    const id = store.findProgressId("sess-a")!;
    expect(store.updateEntry(id, "更新后的进展", V2, 2000)).toBe(true);
    expect(store.count()).toBe(1);
    expect(store.list()[0]!.text).toBe("更新后的进展");
    store.close();
  });
});

// ── 2. recordSessionProgress（服务层）───────────────────────

describe("progress 批·StewardMemoryService.recordSessionProgress", () => {
  function makeService(opts: {
    kv?: Record<string, string>;
    progressId?: number | null;
  } = {}) {
    const store = fakeStore({ progressId: opts.progressId });
    const service = new StewardMemoryService({
      config: fakeConfig({ "steward.memory.enabled": "1", "steward.memory.endpointId": "ep-1", ...(opts.kv ?? {}) }),
      embeddingConfig: fakeLookup(),
      embedding: fakeEmbedding(),
      store,
    });
    return { service, store };
  }

  test("① 首写：kind=progress + source=session-progress + sessionId 全字段；返回 true", async () => {
    const { service, store } = makeService();
    const ok = await service.recordSessionProgress("sess-abc", "三档亮度方案已交付，等用户确认帧率");
    expect(ok).toBe(true);
    expect(store.appended).toHaveLength(1);
    const item = store.appended[0]!;
    expect(item.kind).toBe("progress");
    expect(item.source).toBe("session-progress");
    expect(item.sessionId).toBe("sess-abc");
    expect(item.text).toBe("三档亮度方案已交付，等用户确认帧率");
  });

  test("② 同 session 覆盖：findProgressId 命中 → updateEntry 不 append（条目不增）", async () => {
    const { service, store } = makeService({ progressId: 7 });
    const ok = await service.recordSessionProgress("sess-abc", "帧率已确认，开始实现");
    expect(ok).toBe(true);
    expect(store.appended).toHaveLength(0);
    expect(store.updated).toEqual([{ id: 7, text: "帧率已确认，开始实现" }]);
  });

  test("③ 不可用静默 false（记忆开关关——旁路生产不抛错）", async () => {
    const store = fakeStore();
    const service = new StewardMemoryService({
      config: fakeConfig({ "steward.memory.endpointId": "ep-1" }),
      embeddingConfig: fakeLookup(),
      embedding: fakeEmbedding(),
      store,
    });
    await expect(service.recordSessionProgress("sess-a", "进展")).resolves.toBe(false);
    expect(store.appended).toHaveLength(0);
  });

  test("④ 文本卫生：空文本 false；超 120 字符截断", async () => {
    const { service, store } = makeService();
    await expect(service.recordSessionProgress("sess-a", "  ")).resolves.toBe(false);
    const long = "长".repeat(200);
    await expect(service.recordSessionProgress("sess-a", long)).resolves.toBe(true);
    const text = store.appended[0]!.text;
    expect([...text].length).toBeLessThanOrEqual(121);
    expect(text.endsWith("…")).toBe(true);
  });
});

// ── 3. 召回面（配额 + 行文）────────────────────────────────

describe("progress 批·召回（progressQuota + 行文）", () => {
  function entry(i: number, kind: StewardMemoryEntry["kind"], sessionId?: string): StewardMemoryEntry {
    return {
      id: i,
      kind,
      text: `条目${i}`,
      source: "session-progress",
      createdAt: 1000 * i,
      updatedAt: 1000 * i,
      lastRecalledAt: 0,
      recallCount: 0,
      fadedAt: 0,
      pinned: false,
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
  }

  test("① progress 行文 [进展] + sid 锚（完整不截断）；fact/preference 标签不变", async () => {
    const pool = [entry(1, "progress", "sess-uuid-full-1234"), entry(2, "preference"), entry(3, "fact")];
    const store = {
      ...fakeStore(),
      search: () => pool.map((e) => ({ ...e, score: 0.9 })),
    } as unknown as StewardMemoryPort;
    const service = new StewardMemoryService({
      config: fakeConfig({ "steward.memory.enabled": "1", "steward.memory.endpointId": "ep-1" }),
      embeddingConfig: fakeLookup(),
      embedding: fakeEmbedding(),
      store,
    });
    const section = await service.recallSection("最近在干嘛");
    expect(section).toBeDefined();
    expect(section).toContain("[进展] 条目1（sid: sess-uuid-full-1234）");
    expect(section).toContain("[偏好] 条目2");
    expect(section).toContain("[事实] 条目3");
    expect(section).not.toContain("[偏好] 条目1");
  });

  test("② progressQuota：池内 progress 超配额时让位非 progress（top5 内 progress ≤ 2）", async () => {
    const pool = [
      entry(1, "progress", "sess-a"),
      entry(2, "progress", "sess-b"),
      entry(3, "progress", "sess-c"),
      entry(4, "progress", "sess-d"),
      entry(5, "fact"),
      entry(6, "preference"),
      entry(7, "fact"),
    ];
    const store = {
      ...fakeStore(),
      search: () => pool.map((e) => ({ ...e, score: 0.9 })),
    } as unknown as StewardMemoryPort;
    const service = new StewardMemoryService({
      config: fakeConfig({ "steward.memory.enabled": "1", "steward.memory.endpointId": "ep-1" }),
      embeddingConfig: fakeLookup(),
      embedding: fakeEmbedding(),
      store,
      // 固定时钟：融合排序强度确定性（时间敏感 flake 消除——真实时钟下
      // updatedAt 比值随时间漂移导致池序不稳定）
      clock: () => 1_000_000,
    });
    const section = await service.recallSection("最近在干嘛");
    expect(section).toBeDefined();
    const progressLines = section!.split("\n").filter((l) => l.includes("[进展]"));
    expect(progressLines).toHaveLength(2);
    // 固定时钟下融合排序 = updatedAt 降序（强度锚点）：7,6,5,4,3,2,1——
    // 配额选择取前两 progress（4、3），后续 progress（2、1）让位非 progress
    expect(section).toContain("条目7");
    expect(section).toContain("条目6");
    expect(section).toContain("条目5");
    expect(section).not.toContain("条目2");
    expect(section).not.toContain("条目1");
  });
});
