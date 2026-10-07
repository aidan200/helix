/**
 * 管家开放 kg 只读工具单测（批A）：kg_search / kg_get。
 *
 * 断言面（任务 brief 测试点逐条）：
 * 1. 注册面：两工具进 toolSpecs/getProfile（描述非空）且出现在 LLM 工具投影；
 * 2. 只读红线（突变式）：注册集不含任何 kg 写原语（write/update/propose/
 *    decide 类名字全拒，kg 前缀家族白名单 = {kg_search, kg_get}）；
 * 3. 执行体：命中 → 结果文本过 capToolResultText 体量护栏；kg 库缺席
 *    （absent）/ kg 源未装配 → 引导式降级文案、isError 不置、不抛错不炸轮；
 * 4. project 参数缺省/显式两条路径（缺省口径与 memoryProject 同源：单项目
 *    workspace → 该项目（未建索引引导式降级）；多项目/未绑定/未注入 → 聚合
 *    兜底保留（结果分块带【项目】头——适配器层 steward-kg-source.test 已测）。
 *    显式走 workspace-scan/scanProjects 口径解析，未建索引引导式降级）；
 * 5. system prompt 路由段含 kg 工具引导行 + 「已知项目显式传 project」强化
 *    引导；
 * 6. 工具面计数断言显式更新（steward-service/steward-profile 两处既有断言
 *    按显式契约变更更新，见交付报告）。
 */
import { describe, expect, test } from "bun:test";
import { createEngineFromPort } from "../helpers/steward/portScriptEngine";
import type {
  StewardLlmPort,
  StewardLlmRequest,
  StewardLlmResponse,
} from "../../src/application/ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { StewardToolSpec } from "../../src/application/ports/outbound/StewardToolSpec";
import {
  StewardService,
  TOOL_RESULT_MAX_CHARS,
  TOOL_RESULT_TRUNCATION_MARK,
  type StewardKgSource,
  type StewardProjectsSource,
  type StewardSessionMetaRow,
} from "../../src/application/steward/StewardService";

// ── fakes（steward-surface-tools.test.ts 同构） ──────────────

function fakeLlm(script: readonly StewardLlmResponse[]): StewardLlmPort & { calls: { request: StewardLlmRequest }[] } {
  const calls: { request: StewardLlmRequest }[] = [];
  let round = 0;
  return {
    modelId: "deepseek/deepseek-v4-flash",
    calls,
    async complete(request: StewardLlmRequest): Promise<StewardLlmResponse> {
      calls.push({ request });
      const next = script[round];
      round += 1;
      if (next === undefined) throw new Error("fake LLM 剧本耗尽");
      return next;
    },
  };
}

function fakeConfig(initial: Record<string, string> = {}): RuntimeConfigPort {
  const kv = new Map(Object.entries(initial));
  return {
    get: (key: string) => kv.get(key),
    set: async (key: string, value: string) => {
      kv.set(key, value);
    },
  };
}

const toolCall = (id: string, name: string, args: Record<string, unknown>): StewardLlmResponse => ({
  kind: "blocks",
  blocks: [{ type: "toolCall", id, name, args }],
  stopReason: "toolUse",
});

const say = (text: string): StewardLlmResponse => ({
  kind: "blocks",
  blocks: [{ type: "text", text }],
  stopReason: "stop",
});

/** kg 只读检索面 fake（调用记录 = project 双路径判据）。 */
function fakeKg(opts?: {
  projects?: readonly string[];
  searchText?: string;
  getText?: string;
  getThrows?: Error;
  searchThrows?: Error;
}) {
  const searchCalls: { q: string; projectRoot?: string }[] = [];
  const getCalls: { nodeId: string; projectRoot?: string }[] = [];
  const source: StewardKgSource = {
    kgProjects: () => opts?.projects ?? ["/w/helix"],
    search: async (q, projectRoot) => {
      searchCalls.push({ q, ...(projectRoot !== undefined ? { projectRoot } : {}) });
      if (opts?.searchThrows !== undefined) throw opts.searchThrows;
      return opts?.searchText ?? `命中 1 条（q="${q}）：\n- **示例规则** [rule] — 示例摘要\n  ↳ kg get TR-1`;
    },
    get: async (nodeId, projectRoot) => {
      getCalls.push({ nodeId, ...(projectRoot !== undefined ? { projectRoot } : {}) });
      if (opts?.getThrows !== undefined) throw opts.getThrows;
      return opts?.getText ?? `TR-1 示例规则 [rule] — confirmed\ndigest: 示例摘要`;
    },
  };
  return { source, searchCalls, getCalls };
}

/** kg 项目解析面 fake（workspace-scan/scanProjects 口径的收窄面）。 */
function fakeProjects(map: Record<string, string | undefined>, indexed: readonly string[] = ["/w/helix"]): StewardProjectsSource {
  return {
    resolve: (project) => map[project],
    hasIndex: (projectRoot) => indexed.includes(projectRoot),
  };
}

interface Rig {
  svc: StewardService;
  llm: ReturnType<typeof fakeLlm>;
  kg: ReturnType<typeof fakeKg> | undefined;
  tools: StewardToolSpec[];
  tool(name: string): StewardToolSpec;
}

function makeRig(opts: {
  script?: readonly StewardLlmResponse[];
  kg?: ReturnType<typeof fakeKg> | undefined;
  /** 显式传 null = 不装配 kg 源（降级路径）。 */
  kgOff?: boolean;
  projects?: StewardProjectsSource;
  /** 当前项目口径注入（生产 = container memoryProject：workspace 绑定根 +
   *  一级目录扫描的单项目判定；单项目 → 项目名，多项目/未绑定 → undefined）。 */
  memoryProject?: () => string | undefined;
}): Rig {
  const script = opts.script ?? [say("ok")];
  const llm = fakeLlm(script);
  const kg = opts.kgOff === true ? undefined : (opts.kg ?? fakeKg());
  const tools: StewardToolSpec[] = [];
  const svc = new StewardService({
    llm,
    createEngine: (options) => {
      tools.push(...options.tools);
      return createEngineFromPort(llm)(options);
    },
    orchestration: {
      status: () => [],
      send: () => ({ delivered: false, detail: "kg 工具面零递话" }),
    },
    tasks: { listTasks: () => [] },
    config: fakeConfig({ "steward.enabled": "1" }),
    feedGate: { hasStewardSubscribers: () => true },
    emitFeed: () => {},
    sessions: {
      sessionExists: async () => true,
      readSessionTail: async () => undefined,
      deliverToSession: async () => ({ delivered: true, detail: "已送达" }),
      listSessionMetadata: async () => [] as readonly StewardSessionMetaRow[],
      startDraftSession: async () => ({ sessionId: "sess-draft" }),
      createTitledSession: async () => ({ sessionId: "sess-new" }),
    },
    ...(kg !== undefined ? { kg: kg.source } : {}),
    ...(opts.projects !== undefined ? { projects: opts.projects } : {}),
    ...(opts.memoryProject !== undefined ? { memoryProject: opts.memoryProject } : {}),
  });
  return {
    svc,
    llm,
    kg,
    tools,
    tool(name: string): StewardToolSpec {
      const found = tools.find((t) => t.name === name);
      if (found === undefined) throw new Error(`未捕获工具：${name}（createEngine 未触发或未注册）`);
      return found;
    },
  };
}

/** 触发一次 ask 让 createEngine 落地（工具执行体经捕获的 toolSpec 直调）。 */
async function warm(rig: Rig): Promise<void> {
  await rig.svc.ask("warm");
}

// ── 1. 注册面 ────────────────────────────────────────────────

describe("kg_search / kg_get 注册面", () => {
  test("两工具进 getProfile 工具清单（描述非空）", async () => {
    const rig = makeRig({});
    const profile = rig.svc.getProfile();
    for (const name of ["kg_search", "kg_get"]) {
      const tool = profile.tools.find((t) => t.name === name);
      expect(tool, `缺工具：${name}`).toBeDefined();
      expect(tool!.description.length).toBeGreaterThan(0);
    }
  });

  test("两工具进 LLM 工具投影（ask 携带）", async () => {
    const rig = makeRig({ script: [say("ok")] });
    await rig.svc.ask("hi");
    const names = rig.llm.calls[0]!.request.tools.map((t) => t.name);
    expect(names).toContain("kg_search");
    expect(names).toContain("kg_get");
  });
});

// ── 2. 只读红线（突变式） ────────────────────────────────────

describe("只读红线：工具面零 kg 写原语（突变验证）", () => {
  test("kg 前缀家族白名单 = {kg_search, kg_get}；write/update/propose/decide 类 kg 名全拒", () => {
    const names = makeRig({}).svc.getProfile().tools.map((t) => t.name);
    const kgNames = names.filter((n) => n.toLowerCase().includes("kg"));
    expect(kgNames.sort()).toEqual(["kg_get", "kg_search"]);
    // 突变式：任何写动词混进 kg 命名即红（将来悄悄加 kg_update/kg_write 等必炸）
    expect(names.some((n) => /kg/i.test(n) && /(write|update|propose|decide|create|delete|apply|upsert|set|insert|edit)/i.test(n))).toBe(false);
    // 显式点名封闭写原语（createKgTool 写面家族与 kg-update 工具名）
    for (const forbidden of ["kg_update", "kg-update", "kg_write", "kg_propose", "kg_decide", "update_kg", "write_kg", "propose_kg", "kg_set", "kg_create", "kg_delete"]) {
      expect(names, `写原语泄漏：${forbidden}`).not.toContain(forbidden);
    }
  });
});

// ── 3. 执行体：命中护栏 / absent 降级 ────────────────────────

describe("执行体：体量护栏与引导式降级", () => {
  test("命中 → 结果文本逐字透传；病理体量过 capToolResultText 护栏（截断 + 标记）", async () => {
    const huge = "x".repeat(TOOL_RESULT_MAX_CHARS + 500);
    const rig = makeRig({ script: [say("warm")], kg: fakeKg({ searchText: huge, getText: huge }) });
    await warm(rig);
    const search = await rig.tool("kg_search").execute({ q: "规则" }, { toolCallId: "t1" });
    expect(search.text).toBe(`${huge.slice(0, TOOL_RESULT_MAX_CHARS)}${TOOL_RESULT_TRUNCATION_MARK}`);
    expect(search.text.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS + TOOL_RESULT_TRUNCATION_MARK.length);
    const get = await rig.tool("kg_get").execute({ nodeId: "TR-1" }, { toolCallId: "t2" });
    expect(get.text.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS + TOOL_RESULT_TRUNCATION_MARK.length);
    expect(get.text.endsWith(TOOL_RESULT_TRUNCATION_MARK)).toBe(true);
    // 短结果逐字透传（护栏不误伤）
    const rig2 = makeRig({ script: [say("warm")], kg: fakeKg({ searchText: "短结果" }) });
    await warm(rig2);
    const short = await rig2.tool("kg_search").execute({ q: "规则" }, { toolCallId: "t3" });
    expect(short.text).toBe("短结果");
  });

  test("kg 库缺席（absent：kgProjects 空集）→ 引导式降级文案、isError 不置、零查询不抛错", async () => {
    const rig = makeRig({ script: [say("warm")], kg: fakeKg({ projects: [] }) });
    await warm(rig);
    const result = await rig.tool("kg_search").execute({ q: "规则" }, { toolCallId: "t1" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("索引");
    expect(rig.kg!.searchCalls).toHaveLength(0); // absent 先行短路，零查询
  });

  test("kg 源未装配 → 引导式降级文案、不抛错（对话主链路零影响）", async () => {
    const rig = makeRig({ script: [say("warm")], kgOff: true });
    await warm(rig);
    const result = await rig.tool("kg_search").execute({ q: "规则" }, { toolCallId: "t1" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("知识");
    const get = await rig.tool("kg_get").execute({ nodeId: "TR-1" }, { toolCallId: "t2" });
    expect(get.isError).toBeUndefined();
  });

  test("kg_get：命中透传 / nodeId 缺失打回（必填显式）/ 查无节点引导不抛错", async () => {
    const rig = makeRig({
      script: [say("warm")],
      kg: fakeKg({ getThrows: new Error("节点 E-999 不存在（id 必须取自 kg search 返回行——先 search 再 get）") }),
    });
    await warm(rig);
    const hit = makeRig({ script: [say("warm")], kg: fakeKg({ getText: "TR-1 全文" }) });
    await warm(hit);
    expect((await hit.tool("kg_get").execute({ nodeId: "TR-1" }, { toolCallId: "t1" })).text).toBe("TR-1 全文");
    const missing = await rig.tool("kg_get").execute({}, { toolCallId: "t2" });
    expect(missing.text).toContain("nodeId");
    const absent = await rig.tool("kg_get").execute({ nodeId: "E-999" }, { toolCallId: "t3" });
    expect(absent.isError).toBeUndefined();
    expect(absent.text).toContain("不存在");
  });

  test("端到端：LLM 工具轮 kg_search → 结果回灌 → answer 收口（不炸轮；单项目 workspace 缺省只查该项目）", async () => {
    const rig = makeRig({
      script: [toolCall("c1", "kg_search", { q: "规则" }), say("项目的规则是……")],
      memoryProject: () => "helix",
    });
    const result = await rig.svc.ask("这个项目的规则是什么？");
    expect(result.status).toBe("answer");
    expect(rig.kg!.searchCalls).toEqual([{ q: "规则", projectRoot: "/w/helix" }]);
    const toolResult = rig.llm.calls[1]!.request.messages.find(
      (m): m is Extract<typeof m, { role: "toolResult" }> => m.role === "toolResult" && m.name === "kg_search",
    );
    expect(toolResult).toBeDefined();
    expect(toolResult!.text).toContain("kg get TR-1");
  });
});

// ── 4. project 参数缺省/显式双路径（缺省口径与 memoryProject 同源）──

describe("project 缺省：单项目 workspace → 只查该项目（memoryProject 同源）", () => {
  test("单项目 workspace 缺省 → 只查该项目（kg 域含他项目也不混入）", async () => {
    const rig = makeRig({
      script: [say("warm")],
      memoryProject: () => "helix",
      kg: fakeKg({ projects: ["/w/helix", "/w/other"] }),
      projects: fakeProjects({ helix: "/w/helix", other: "/w/other" }, ["/w/helix", "/w/other"]),
    });
    await warm(rig);
    await rig.tool("kg_search").execute({ q: "架构" }, { toolCallId: "t1" });
    // projectRoot 钉到当前项目——适配器按它过滤行（steward-kg-source.test 已测），
    // 他项目（/w/other）结果不进入本轮。
    expect(rig.kg!.searchCalls).toEqual([{ q: "架构", projectRoot: "/w/helix" }]);
    await rig.tool("kg_get").execute({ nodeId: "TR-1" }, { toolCallId: "t2" });
    expect(rig.kg!.getCalls).toEqual([{ nodeId: "TR-1", projectRoot: "/w/helix" }]);
  });

  test("单项目 workspace 当前项目未建索引 → 引导式降级点名项目，零查询", async () => {
    const rig = makeRig({
      script: [say("warm")],
      memoryProject: () => "bare",
      kg: fakeKg({ projects: [] }),
      projects: fakeProjects({ bare: "/w/bare" }, []),
    });
    await warm(rig);
    const result = await rig.tool("kg_search").execute({ q: "架构" }, { toolCallId: "t1" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("bare");
    expect(result.text).toContain("索引");
    expect(rig.kg!.searchCalls).toHaveLength(0);
  });
});

describe("project 缺省：多项目/未绑定/未注入 → 聚合兜底保留", () => {
  test("多项目 workspace 缺省 → 聚合兜底（projectRoot 缺省，行为不劣化）", async () => {
    const rig = makeRig({
      script: [say("warm")],
      memoryProject: () => undefined,
      kg: fakeKg({ projects: ["/w/helix", "/w/other"] }),
      projects: fakeProjects({ helix: "/w/helix", other: "/w/other" }, ["/w/helix", "/w/other"]),
    });
    await warm(rig);
    await rig.tool("kg_search").execute({ q: "架构" }, { toolCallId: "t1" });
    expect(rig.kg!.searchCalls).toEqual([{ q: "架构" }]);
  });

  test("多项目 workspace 仅一个 kg 项目 → 缺省聚合（不再按 kg 域计数窄化伪装「当前项目」）", async () => {
    const rig = makeRig({
      script: [say("warm")],
      memoryProject: () => undefined,
      kg: fakeKg({ projects: ["/w/helix"] }),
      projects: fakeProjects({ helix: "/w/helix", other: "/w/other" }, ["/w/helix"]),
    });
    await warm(rig);
    await rig.tool("kg_search").execute({ q: "架构" }, { toolCallId: "t1" });
    expect(rig.kg!.searchCalls).toEqual([{ q: "架构" }]);
  });

  test("memoryProject 未注入（旧装配面）→ 缺省聚合兜底", async () => {
    const rig = makeRig({ script: [say("warm")] });
    await warm(rig);
    await rig.tool("kg_search").execute({ q: "架构" }, { toolCallId: "t1" });
    expect(rig.kg!.searchCalls).toEqual([{ q: "架构" }]);
  });
});

describe("显式 project 参数（行为不变）", () => {
  test("显式 project → workspace-scan 口径解析到项目根", async () => {
    const rig = makeRig({
      script: [say("warm")],
      kg: fakeKg({ projects: ["/w/helix", "/w/other"] }),
      projects: fakeProjects({ helix: "/w/helix", other: "/w/other" }, ["/w/helix", "/w/other"]),
    });
    await warm(rig);
    await rig.tool("kg_search").execute({ q: "架构", project: "other" }, { toolCallId: "t1" });
    expect(rig.kg!.searchCalls).toEqual([{ q: "架构", projectRoot: "/w/other" }]);
  });

  test("显式 project 不在 workspace → 打回引导，零查询", async () => {
    const rig = makeRig({ script: [say("warm")], projects: fakeProjects({ helix: "/w/helix" }) });
    await warm(rig);
    const result = await rig.tool("kg_search").execute({ q: "架构", project: "ghost" }, { toolCallId: "t1" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("ghost");
    expect(rig.kg!.searchCalls).toHaveLength(0);
  });

  test("显式 project 未建 kg 索引（absent）→ 引导式降级，零查询", async () => {
    const rig = makeRig({
      script: [say("warm")],
      projects: fakeProjects({ helix: "/w/helix", bare: "/w/bare" }, ["/w/helix"]),
    });
    await warm(rig);
    const result = await rig.tool("kg_search").execute({ q: "架构", project: "bare" }, { toolCallId: "t1" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("索引");
    expect(rig.kg!.searchCalls).toHaveLength(0);
  });
});

// ── 5. system prompt 路由段 ──────────────────────────────────

describe("system prompt 路由段增量", () => {
  test("路由段含「问项目知识 → kg 工具」引导行（kg_search/kg_get 点名）", async () => {
    const rig = makeRig({ script: [say("ok")] });
    await rig.svc.ask("hi");
    const prompt = rig.llm.calls[0]!.request.systemPrompt;
    expect(prompt).toContain("kg_search");
    expect(prompt).toContain("kg_get");
    expect(prompt).toContain("项目知识");
    // 既有路由语义不动（人格段/路由反判例行仍在）
    expect(prompt).toContain("路由反判例行");
    expect(prompt).toContain("不代答工作上下文");
  });

  test("路由段强化引导：已知项目时显式传 project + 多项目缺省聚合分块标注说明", async () => {
    const rig = makeRig({ script: [say("ok")] });
    await rig.svc.ask("hi");
    const prompt = rig.llm.calls[0]!.request.systemPrompt;
    expect(prompt).toContain("显式传 project");
    expect(prompt).toContain("多项目");
    expect(prompt).toContain("【项目");
  });
});
