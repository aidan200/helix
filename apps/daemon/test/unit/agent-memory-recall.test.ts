/**
 * 编码 agent 长期记忆只读召回批 D 单测（agentRecallSection）。
 *
 * 消费面语义（与管家 recallSection 的分野）：
 * 1. 轻管线：无 query 语义检索（系统提示组装链同步定格、装配时无用户
 *    输入、embedding HTTP 不进秒回链）——scope + kind 过滤 → strength
 *    排序 → 常量 topK 截断；
 * 2. kind 过滤：preference + fact 注入、progress 排除（progress 是管家域
 *    ——编码 agent 的「最近工作」来自会话上下文与任务面）；
 * 3. scope 过滤（E-264 原语同源）：global + 本项目；无项目上下文仅 global；
 * 4. 不记 markRecalled（E-259 幸存者回写只归管家消费面——防编码 agent
 *    高频轮次把条目强度刷爆）；
 * 5. 失败静默降级（召回异常零注入不炸组装链——与管家同族纪律）；
 * 6. topK 代码常量（E-261：不新增 memory.* 键——运营参数升级等真需求
 *    出现再 additive）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { getLoadablePath } from "sqlite-vec";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  StewardMemoryService,
  MEMORY_SCOPE_GLOBAL,
  AGENT_MEMORY_RECALL_TOP_K,
} from "../../src/application/steward/StewardMemoryService";
import { SqliteVecMemoryStore } from "../../src/adapters/driven/steward-memory/SqliteVecMemoryStore";
import type {
  StewardMemoryPort,
  StewardMemoryAppendItem,
} from "../../src/application/ports/outbound/StewardMemoryPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { EmbeddingPort, EmbeddingResult } from "../../src/application/ports/outbound/EmbeddingPort";
import type { EmbeddingConfigLookup } from "../../src/application/steward/StewardMemoryService";
import type { EmbeddingEndpointRecord } from "../../src/application/embedding/EmbeddingConfigService";

const NOW = 1_800_000_000_000;
const DAY = 24 * 3_600_000;
const V = Float32Array.from([1, 0, 0]);

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
  return { resolveRecord: (endpointId) => (endpointId === ENDPOINT_RECORD.id ? ENDPOINT_RECORD : null) };
}

function fakeEmbedding(): EmbeddingPort {
  return {
    endpointLabel: () => "fake",
    async embed(texts: readonly string[]): Promise<EmbeddingResult> {
      return { vectors: texts.map(() => V), dim: 3 };
    },
  };
}

interface Rig {
  readonly service: StewardMemoryService;
  readonly store: SqliteVecMemoryStore;
  dispose(): void;
}

function makeRig(config: Record<string, string> = {}): Rig {
  const root = mkdtempSync(path.join(tmpdir(), "agent-memory-it-"));
  const dbPath = path.join(root, "memory.db");
  const store = new SqliteVecMemoryStore(dbPath, getLoadablePath());
  const service = new StewardMemoryService({
    config: fakeConfig({
      "memory.enabled": "1",
      "memory.endpointId": "ep-1",
      ...config,
    }),
    embedding: fakeEmbedding(),
    embeddingConfig: fakeLookup(),
    store,
    clock: () => NOW,
  });
  const rig: Rig = {
    service,
    store,
    dispose: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  rigs.push(rig);
  return rig;
}

const rigs: Rig[] = [];
afterAll(() => {
  for (const r of rigs) r.dispose();
  rigs.length = 0;
});

/** 直写条目（向量面假填——agentRecallSection 不消费向量）。 */
function seed(rig: Rig, item: Omit<StewardMemoryAppendItem, "vector" | "source" | "createdAt"> & { createdAt?: number; source?: string }): void {
  rig.store.append([
    {
      kind: item.kind,
      text: item.text,
      source: item.source ?? "steward-turn",
      createdAt: item.createdAt ?? NOW - DAY,
      vector: V,
      sessionId: item.sessionId,
      projectScope: item.projectScope ?? MEMORY_SCOPE_GLOBAL,
    },
  ]);
}

describe("编码 agent 召回·agentRecallSection", () => {
  test("① 段格式：段头权威声明句（项目现实归 kg）+ 条目短句行", () => {
    const rig = makeRig();
    seed(rig, { kind: "preference", text: "用户偏好中文注释与简洁文风" });
    seed(rig, { kind: "fact", text: "用户的主力机是 macOS", projectScope: "projA" });
    const section = rig.service.agentRecallSection("projA");
    expect(section).toBeDefined();
    expect(section).toContain("用户偏好与工作状态");
    // 权威声明（E-260 同族：项目现实以知识图谱约束为准）
    expect(section).toContain("知识图谱");
    expect(section).toContain("任务"); // 与任务指令冲突时以任务为准
    expect(section).toContain("- [偏好] 用户偏好中文注释与简洁文风");
    expect(section).toContain("- [事实] 用户的主力机是 macOS");
  });

  test("② scope：global+本项目入选、他项目排除、无项目上下文仅 global", () => {
    const rig = makeRig();
    seed(rig, { kind: "preference", text: "全局偏好：回答先给结论" });
    seed(rig, { kind: "fact", text: "projA 的事实", projectScope: "projA" });
    seed(rig, { kind: "fact", text: "projB 的事实", projectScope: "projB" });

    const withProject = rig.service.agentRecallSection("projA")!;
    expect(withProject).toContain("全局偏好");
    expect(withProject).toContain("projA 的事实");
    expect(withProject).not.toContain("projB 的事实");

    const noProject = rig.service.agentRecallSection()!;
    expect(noProject).toContain("全局偏好");
    expect(noProject).not.toContain("projA 的事实");
    expect(noProject).not.toContain("projB 的事实");
  });

  test("③ progress 不注入（kind 过滤——即使最新最强也不占位）", () => {
    const rig = makeRig();
    seed(rig, { kind: "progress", text: "会话进展：正在迁移配置面", projectScope: "projA", sessionId: "sess-1", createdAt: NOW });
    seed(rig, { kind: "preference", text: "偏好甲" });
    const section = rig.service.agentRecallSection("projA")!;
    expect(section).not.toContain("会话进展");
    expect(section).toContain("偏好甲");
  });

  test("④ topK 常量截断（AGENT_MEMORY_RECALL_TOP_K = 3；5 条合格只回 3）", () => {
    expect(AGENT_MEMORY_RECALL_TOP_K).toBe(3);
    const rig = makeRig();
    for (let i = 1; i <= 5; i += 1) {
      seed(rig, { kind: "fact", text: `候选事实 ${i}`, createdAt: NOW - i * DAY, projectScope: "projA" });
    }
    const section = rig.service.agentRecallSection("projA")!;
    const lines = section.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines).toHaveLength(3);
    // strength 降序（越新越强）
    expect(lines[0]).toContain("候选事实 1");
    expect(lines[2]).toContain("候选事实 3");
    expect(section).not.toContain("候选事实 4");
  });

  test("⑤ 排序：pinned 恒满浮顶；同分（manual 恒满）时 updatedAt 新优先；kind 无排序特权（pinned fact 不被 preference 压过）", () => {
    const rig = makeRig();
    seed(rig, { kind: "fact", text: "最旧的普通事实", createdAt: NOW - 30 * DAY });
    const entries = rig.store.list();
    rig.store.setPinned(entries[0]!.id, true, NOW); // 旧但置顶 → 恒满强度浮顶
    seed(rig, { kind: "preference", text: "旧手动偏好条目", createdAt: NOW - 2 * DAY, source: "manual" });
    seed(rig, { kind: "preference", text: "新手动偏好条目", createdAt: NOW - DAY, source: "manual" });
    seed(rig, { kind: "fact", text: "新手动事实条目", createdAt: NOW - DAY, source: "manual" });
    const section = rig.service.agentRecallSection()!;
    const lines = section.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines[0]).toContain("最旧的普通事实"); // pinned 浮顶（fact 不被 preference 压过）
    // strength 同分（manual 恒满）：updatedAt 新优先
    expect(lines[1]).toContain("新手动偏好条目");
    expect(lines[2]).toContain("新手动事实条目");
    expect(section).not.toContain("旧手动偏好条目"); // topK=3 截断落选（最旧的 manual 恒满条）
  });

  test("⑥ 服务异常（store.list 抛错）→ undefined 静默不炸；不可用（enabled 关）→ undefined 零调用", () => {
    const rig = makeRig();
    seed(rig, { kind: "preference", text: "偏好甲" });
    const failing: StewardMemoryPort = {
      ...rig.store,
      list: () => {
        throw new Error("boom");
      },
    } as never;
    const svc = new StewardMemoryService({
      config: fakeConfig({ "memory.enabled": "1", "memory.endpointId": "ep-1" }),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store: failing,
      clock: () => NOW,
    });
    expect(svc.agentRecallSection("projA")).toBeUndefined();

    const disabled = makeRig({ "memory.enabled": "0" });
    seed(disabled, { kind: "preference", text: "偏好乙" });
    expect(disabled.service.agentRecallSection("projA")).toBeUndefined();
  });

  test("⑦ 不记 markRecalled（幸存者回写只归管家消费面）", () => {
    const rig = makeRig();
    seed(rig, { kind: "preference", text: "偏好甲" });
    seed(rig, { kind: "fact", text: "事实乙", projectScope: "projA" });
    const before = rig.store.list().map((e) => ({ id: e.id, lastRecalledAt: e.lastRecalledAt, recallCount: e.recallCount }));
    const section = rig.service.agentRecallSection("projA");
    expect(section).toBeDefined();
    const after = rig.store.list();
    for (let i = 0; i < before.length; i += 1) {
      expect(after[i]!.recallCount).toBe(before[i]!.recallCount);
      expect(after[i]!.lastRecalledAt).toBe(before[i]!.lastRecalledAt);
    }
  });
});
