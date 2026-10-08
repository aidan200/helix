/**
 * 批E：编码 agent 记忆消费面工具化——memory_search 只读工具契约单测。
 *
 * 行为面（brief 逐条）：
 * 1. 注册双面：CoreToolExecutor memorySearch 槽 → resolveTools 可解析
 *    "memory_search"（注册面契约；profile 声明面奇偶归 profile-slim 契约测试）；
 * 2. query 必填（任务意图/类型描述）：缺席/空白 → 结构化报错（kg 同族）；
 * 3. 语义检索管线（真 StewardMemoryService + SqliteVecMemoryStore）：
 *    embedding → vec0 KNN 候选池（scope 预过滤 global+project，E-264 口径）
 *    → 过淡忘 → 资格闸 → kind 过滤（排除 progress——批B/D 边界维持）
 *    → cosine×strength 融合排序 → topK 截断（MEMORY_SEARCH_TOP_K 常量）；
 * 4. markRecalled 回写（预授权裁决：工具主动检索 = 真的用上了）；
 * 5. 失败静默降级（检索异常 → 降级文案不炸；记忆不可用 → 引导文案）；
 * 6. 体量护栏（capToolResultText 4000 兑底）；
 * 7. 回执形态：逐条 id/kind/text/score/updatedAt 紧凑列表（kg 工具风格）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { getLoadablePath } from "sqlite-vec";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  StewardMemoryService,
  MEMORY_SCOPE_GLOBAL,
  MEMORY_SEARCH_TOP_K,
} from "../../src/application/steward/StewardMemoryService";
import { capToolResultText, TOOL_RESULT_MAX_CHARS } from "../../src/application/steward/StewardService";
import { SqliteVecMemoryStore } from "../../src/adapters/driven/steward-memory/SqliteVecMemoryStore";
import { createMemorySearchTool } from "../../src/adapters/driven/tools/memory-search/MemorySearchTool";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";
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

/** 确定性假嵌入：按文本关键词给定向量（cosine 可控）。 */
const V_TEST = Float32Array.from([1, 0, 0]);
const V_BROWSER = Float32Array.from([0, 1, 0]);

function vectorFor(text: string): Float32Array {
  return text.includes("测试") ? V_TEST : V_BROWSER;
}

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
      return { vectors: texts.map((t) => vectorFor(t)), dim: 3 };
    },
  };
}

interface Rig {
  readonly service: StewardMemoryService;
  readonly store: SqliteVecMemoryStore;
  dispose(): void;
}

function makeRig(config: Record<string, string> = {}): Rig {
  const root = mkdtempSync(path.join(tmpdir(), "memory-search-it-"));
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

/** 直写条目（向量按文本关键词派生——与 query 同源假嵌入）。 */
function seed(rig: Rig, item: Omit<StewardMemoryAppendItem, "vector" | "source" | "createdAt"> & { createdAt?: number; source?: string }): void {
  rig.store.append([
    {
      kind: item.kind,
      text: item.text,
      source: item.source ?? "steward-turn",
      createdAt: item.createdAt ?? NOW - DAY,
      vector: vectorFor(item.text),
      sessionId: item.sessionId,
      projectScope: item.projectScope ?? MEMORY_SCOPE_GLOBAL,
    },
  ]);
}

function makeTool(rig: Rig, projectOf: () => string | undefined = () => undefined) {
  return createMemorySearchTool({ service: rig.service, projectOf });
}

async function run(tool: ReturnType<typeof makeTool>, params: Record<string, unknown>): Promise<string> {
  const result = await tool.execute("tc-1", params as never, () => {}, { env: undefined as never }, undefined as never, undefined as never);
  return result.content.map((b) => (b as { type: string; text?: string }).text ?? "").join("\n");
}

describe("memory_search 工具·注册契约", () => {
  test("① 工具名/参数面：name = memory_search；query 必填单参数", () => {
    const rig = makeRig();
    const tool = makeTool(rig);
    expect(tool.name).toBe("memory_search");
    expect((tool.parameters as { required?: string[] }).required).toEqual(["query"]);
    expect(Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties)).toEqual(["query"]);
  });

  test("② CoreToolExecutor 注册面：memorySearch 槽注入 → resolveTools 可解析；未注入 → 抛错（声明=注册铁律）", () => {
    const rig = makeRig();
    const withTool = new CoreToolExecutor({ cwd: tmpdir(), memorySearch: { service: rig.service, projectOf: () => undefined } });
    expect(withTool.resolveTools(["memory_search"])).toHaveLength(1);
    const without = new CoreToolExecutor({ cwd: tmpdir() });
    expect(() => without.resolveTools(["memory_search"])).toThrow("不在注册表");
  });
});

describe("memory_search 工具·检索行为（真管线）", () => {
  test("③ query 必填：缺席/空白 → 结构化报错（不静默）", async () => {
    const rig = makeRig();
    const tool = makeTool(rig);
    seed(rig, { kind: "preference", text: "用户偏好测试先红后绿" });
    await expect(run(tool, {})).rejects.toThrow("query");
    await expect(run(tool, { query: "   " })).rejects.toThrow("query");
  });

  test("④ 语义命中 + kind 过滤：progress 即使语义最强也不返回；preference/fact 返回", async () => {
    const rig = makeRig();
    seed(rig, { kind: "progress", text: "测试迁移进行中", projectScope: "projA", sessionId: "sess-1", createdAt: NOW });
    seed(rig, { kind: "preference", text: "用户偏好测试先红后绿" });
    seed(rig, { kind: "fact", text: "测试栈是 bun test", projectScope: "projA" });
    const out = await run(makeTool(rig, () => "projA"), { query: "本任务的测试要求" });
    expect(out).toContain("用户偏好测试先红后绿");
    expect(out).toContain("测试栈是 bun test");
    expect(out).not.toContain("测试迁移进行中");
    expect(out).not.toContain("progress");
  });

  test("⑤ scope 过滤：global + 当前项目入选、他项目排除、无项目上下文仅 global（projectOf 单点供给，工具参数无 project）", async () => {
    const rig = makeRig();
    seed(rig, { kind: "preference", text: "全局偏好：测试要求先结论后展开" });
    seed(rig, { kind: "fact", text: "projA 的测试事实", projectScope: "projA" });
    seed(rig, { kind: "fact", text: "projB 的测试事实", projectScope: "projB" });

    const withProject = await run(makeTool(rig, () => "projA"), { query: "测试相关记忆" });
    expect(withProject).toContain("全局偏好");
    expect(withProject).toContain("projA 的测试事实");
    expect(withProject).not.toContain("projB 的测试事实");

    const noProject = await run(makeTool(rig), { query: "测试相关记忆" });
    expect(noProject).toContain("全局偏好");
    expect(noProject).not.toContain("projA 的测试事实");
    expect(noProject).not.toContain("projB 的测试事实");
  });

  test("⑥ 资格闸：语义无关（cosine 0）不返回 → 无命中文案", async () => {
    const rig = makeRig();
    seed(rig, { kind: "preference", text: "浏览器操作偏好" }); // 向量 [0,1,0]
    const out = await run(makeTool(rig), { query: "测试要求" }); // 向量 [1,0,0]
    expect(out).toContain("无");
    expect(out).not.toContain("浏览器操作偏好");
  });

  test("⑦ topK 常量截断：MEMORY_SEARCH_TOP_K = 5；6 条合格只回 5（融合排序取头部）", async () => {
    expect(MEMORY_SEARCH_TOP_K).toBe(5);
    const rig = makeRig();
    for (let i = 1; i <= 6; i += 1) {
      seed(rig, { kind: "fact", text: `测试事实 ${i}`, createdAt: NOW - i * DAY });
    }
    const out = await run(makeTool(rig), { query: "测试" });
    const rows = out.split("\n").filter((l) => l.startsWith("- ["));
    expect(rows).toHaveLength(5);
    expect(out).not.toContain("测试事实 6"); // 最旧（strength 最弱）落选
  });

  test("⑧ markRecalled 回写：幸存者 recallCount +1 / lastRecalledAt 刷新（预授权：工具主动检索=真的用上了）", async () => {
    const rig = makeRig();
    seed(rig, { kind: "preference", text: "用户偏好测试先红后绿" });
    seed(rig, { kind: "fact", text: "projA 的测试事实", projectScope: "projB" }); // 落选（scope）
    const before = rig.store.list().map((e) => ({ id: e.id, recallCount: e.recallCount, lastRecalledAt: e.lastRecalledAt }));
    await run(makeTool(rig), { query: "测试要求" });
    const after = rig.store.list();
    expect(after[0]!.recallCount).toBe(before[0]!.recallCount + 1);
    expect(after[0]!.lastRecalledAt).toBe(NOW);
    expect(after[1]!.recallCount).toBe(before[1]!.recallCount); // 落选者不记（防马太）
  });

  test("⑨ 回执形态：紧凑行列表含 id/kind 标签/text/score/updatedAt（kg 风格）", async () => {
    const rig = makeRig();
    seed(rig, { kind: "preference", text: "用户偏好测试先红后绿" });
    const out = await run(makeTool(rig), { query: "测试要求" });
    expect(out).toContain("命中 1 条");
    expect(out).toMatch(/- \[偏好\] 用户偏好测试先红后绿/);
    expect(out).toMatch(/id=\d+/);
    expect(out).toMatch(/score=(0|1)\.\d{2}/);
    expect(out).toMatch(/updatedAt=\d{4}-\d{2}-\d{2}/);
    // 权威声明句（与批D 段头同族——冲突时以任务为准）
    expect(out).toContain("以任务指令为准");
  });

  test("⑩ 体量护栏：超长条目 → capToolResultText 截断（4000 字符兑底）", async () => {
    const rig = makeRig();
    seed(rig, { kind: "fact", text: `测试事实：${"长".repeat(6000)}` });
    const out = await run(makeTool(rig), { query: "测试" });
    expect(out.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS + 100);
    expect(out).toContain("已截断");
  });
});

describe("memory_search 工具·降级面", () => {
  test("⑪ 记忆不可用（enabled 关）→ 引导文案（不炸、不静默空转）", async () => {
    const rig = makeRig({ "memory.enabled": "0" });
    seed(rig, { kind: "preference", text: "用户偏好测试先红后绿" });
    const out = await run(makeTool(rig), { query: "测试" });
    expect(out).toContain("未启用或未配置");
  });

  test("⑫ 检索异常（embedding 抛错）→ 降级文案不炸主链路（失败静默空结果）", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "memory-search-deg-"));
    const store = new SqliteVecMemoryStore(path.join(root, "memory.db"), getLoadablePath());
    rigs.push({ service: {} as never, store, dispose: () => { store.close(); rmSync(root, { recursive: true, force: true }); } });
    const failingEmbedding: EmbeddingPort = {
      endpointLabel: () => "fake",
      async embed(): Promise<EmbeddingResult> {
        throw new Error("endpoint down");
      },
    };
    const service = new StewardMemoryService({
      config: fakeConfig({ "memory.enabled": "1", "memory.endpointId": "ep-1" }),
      embedding: failingEmbedding,
      embeddingConfig: fakeLookup(),
      store,
      clock: () => NOW,
    });
    store.append([{ kind: "preference", text: "用户偏好测试先红后绿", source: "steward-turn", createdAt: NOW, vector: V_TEST, projectScope: MEMORY_SCOPE_GLOBAL }]);
    const out = await run(createMemorySearchTool({ service, projectOf: () => undefined }), { query: "测试" });
    expect(out).toContain("降级");
    expect(out).toContain("按任务指令继续"); // 降级不阻断——agent 继续干活
  });

  test("⑬ 存储层异常（search 抛错）→ 同款降级文案", async () => {
    const rig = makeRig();
    seed(rig, { kind: "preference", text: "用户偏好测试先红后绿" });
    const failing: StewardMemoryPort = {
      ...rig.store,
      search: () => {
        throw new Error("boom");
      },
    } as never;
    const service = new StewardMemoryService({
      config: fakeConfig({ "memory.enabled": "1", "memory.endpointId": "ep-1" }),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store: failing,
      clock: () => NOW,
    });
    const out = await run(createMemorySearchTool({ service, projectOf: () => undefined }), { query: "测试" });
    expect(out).toContain("降级");
  });
});
