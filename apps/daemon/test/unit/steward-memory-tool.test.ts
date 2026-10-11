/**
 * StewardService × 长期记忆单测（remember 工具直写 + 防双写水位闸 +
 * 召回注入）。B5 轮末提取管线已随换轨删除（批②）——自动沉淀归会话总结器
 * 记忆点产物（TR-247），本文件只测保留面。
 *
 * 断言面：
 * 1. remember 直写：工具调用即入库（source=steward-turn）+ memory_written
 *    通知（added）+ answer 收口（无确认卡）；toolResult 回灌续轮；
 * 2. 存储故障 → toolResult 失败文本回灌 + answer 收口（不炸轮、零通知）；
 * 3. 记忆不可用（未装配/未开启）→ 引导式降级：不挂闸、循环继续、answer
 *    转述（零写入）；
 * 4. 记忆消费工具化（同轨换轨）：机械召回注入退役——system prompt 恒不含
 *    记忆段但含长期记忆纪律句；memory_search 工具轮：命中行回灌 + query
 *    透传（管家提炼重写后的意图）；零命中/降级 → 零命中文案照常作答；
 * 5. 配置面：getConfig 携带 memory 现态（未装配 = 全降级缺省）；
 *    setConfig memory 组委托校验（开启前端点必填错误透传）；
 * 6. 防双写水位闸（explicitRememberedSince 面）：直写成功 → 水位置位
 *    （总结器记忆点本轮让位）；失败 → 不置位（下锚点可补写）；
 * 7. 换轨回归：ask 收口零轮末沉淀（零提取 LLM 调用零自动入库）。
 */
import { describe, expect, test } from "bun:test";
import { createEngineFromPort } from "../helpers/steward/portScriptEngine";
import type {
  StewardLlmPort,
  StewardLlmRequest,
  StewardLlmResponse,
} from "../../src/application/ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { StewardMemoryState } from "../../src/application/steward/StewardMemoryService";
import { StewardService } from "../../src/application/steward/StewardService";

interface LlmCall {
  readonly request: StewardLlmRequest;
  readonly round: number;
}

function fakeLlm(script: readonly StewardLlmResponse[]): StewardLlmPort & { calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    modelId: "deepseek/deepseek-v4-flash",
    calls,
    async complete(request: StewardLlmRequest): Promise<StewardLlmResponse> {
      const round = calls.length;
      calls.push({ request, round });
      const next = script[round];
      if (next === undefined) throw new Error("fake LLM 剧本耗尽");
      return next;
    },
  };
}

function fakeConfig(initial: Record<string, string> = {}): RuntimeConfigPort & { kv: Map<string, string> } {
  const kv = new Map(Object.entries(initial));
  return {
    kv,
    get: (key) => kv.get(key),
    set: async (key, value) => {
      kv.set(key, value);
    },
  };
}

/** fake 记忆面（StewardMemoryService 形态——只实现本测试消费的方法子集）。 */
function fakeMemory(
  opts: { available?: boolean; recallSection?: string | undefined; recallThrows?: boolean; rememberFails?: boolean } = {},
) {
  let rememberCalls = 0;
  /** 防双写水位（镜像 StewardMemoryService 语义：显式源——非 auto-sediment/
   *  session-summary——写入成功置位；explicitRememberedSince 契约测试面）。 */
  let lastExplicitRememberAt = -1;
  const state = {
    remembers: [] as { text: string; kind: string; source: string; scope?: { project?: string; explicit?: string; domain?: string } }[],
    recalls: [] as string[],
    configPatches: [] as Record<string, unknown>[],
  };
  const memory = {
    ...state,
    isAvailable: () => opts.available ?? true,
    getMemoryState: (): StewardMemoryState => ({
      enabled: true,
      available: opts.available ?? true,
      judgeEndpoint: null,
      entryCount: state.remembers.length,
      dim: 1024,
    }),
    recallSection: async (query: string): Promise<string | undefined> => {
      state.recalls.push(query);
      if (opts.recallThrows === true) throw new Error("端点挂了");
      return opts.recallSection;
    },
    remember: async (
      text: string,
      kind: "fact" | "preference",
      source: string,
      scope?: { project?: string; explicit?: string; domain?: string },
    ) => {
      rememberCalls += 1;
      if (opts.rememberFails === true) {
        throw new Error("嵌入端点 503");
      }
      state.remembers.push({ text, kind, source, scope });
      if (source !== "auto-sediment" && source !== "session-summary") lastExplicitRememberAt = Date.now();
      return { id: state.remembers.length, updated: false };
    },
    explicitRememberedSince: (since: number) => lastExplicitRememberAt >= since,
    setMemoryConfig: async (patch: Record<string, unknown>) => {
      state.configPatches.push(patch);
      // 模拟存储层故障（写面无前置校验——错误透传路径用中性故障形态验证）
      if (patch.enabled === true && patch.judgeEndpointId === "ep-fail") {
        return { ok: false as const, error: "嵌入端点写入失败（存储异常）" };
      }
      return { ok: true as const };
    },
  };
  // StewardService deps 声明为 StewardMemoryService 具体类——测试形态豁免
  // （fake 结构覆盖消费面方法子集）。
  return memory as unknown as import("../../src/application/steward/StewardMemoryService").StewardMemoryService &
    typeof state;
}

function makeService(opts: {
  llm: StewardLlmPort;
  memory?: ReturnType<typeof fakeMemory>;
  config?: RuntimeConfigPort;
  memoryProject?: () => string | undefined;
}) {
  const notes: import("@helix/protocol").StewardMemoryWrittenPayload[] = [];
  const svc = new StewardService({
    llm: opts.llm,
    createEngine: createEngineFromPort(opts.llm),
    orchestration: { status: () => [], send: () => ({ delivered: false, detail: "无实例" }) },
    tasks: { listTasks: () => [] },
    config: opts.config ?? fakeConfig({ "steward.enabled": "1" }),
    feedGate: { hasStewardSubscribers: () => false },
    emitFeed: () => {},
    emitMemoryWritten: (payload) => notes.push(payload),
    ...(opts.memory !== undefined ? { memory: opts.memory } : {}),
    ...(opts.memoryProject !== undefined ? { memoryProject: opts.memoryProject } : {}),
  });
  return { svc, notes };
}

describe("管家记忆：remember 工具直写（换轨后保留面）", () => {
  test("① remember 直写：工具调用即入库 + 落盘通知 added + answer 收口（无确认卡）", async () => {
    const llm = fakeLlm([
      { kind: "blocks", blocks: [{ type: "toolCall", id: "call-0", name: "remember", args: { text: "用户偏好简洁回复", kind: "preference" } }], stopReason: "toolUse" },
      { kind: "blocks", blocks: [{ type: "text", text: "记好了。" }], stopReason: "stop" },
    ]);
    const memory = fakeMemory();
    const { svc, notes } = makeService({ llm, memory });
    const result = await svc.ask("记住：以后回复都简洁点");
    expect(result.status).toBe("answer"); // 摘闸：不挂确认直写（B5 静默化）
    expect(memory.remembers).toEqual([
      { text: "用户偏好简洁回复", kind: "preference", source: "steward-turn", scope: { domain: "habit" } },
    ]);
    // 工具结果回灌（LLM 第二轮可见入库交代）
    const toolResult = llm.calls[1]!.request.messages.find((m) => m.role === "toolResult");
    expect(toolResult!.text).toContain("已沉淀长期记忆");
    expect(toolResult!.text).toContain("用户偏好简洁回复");
    // 落盘通知：mode = added（新增），原文携带
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ text: "用户偏好简洁回复", mode: "added" });
  });

  test("①b remember 直写 domain 透传（domain 维度批）：缺省按 kind 推导（preference→habit / fact→general）+ 项目通道照传；显式 domain 优先", async () => {
    // fact 缺省 domain → general（服务层一致性约束对 general 强制 global）
    const llm = fakeLlm([
      { kind: "blocks", blocks: [{ type: "toolCall", id: "call-0", name: "remember", args: { text: "helix 仓用 bun test", kind: "fact" } }], stopReason: "toolUse" },
      { kind: "blocks", blocks: [{ type: "text", text: "记好了。" }], stopReason: "stop" },
    ]);
    const memory = fakeMemory();
    const { svc } = makeService({ llm, memory, memoryProject: () => "helix" });
    await svc.ask("记住：helix 仓用 bun test");
    expect(memory.remembers[0]!.scope).toEqual({ project: "helix", domain: "general" });
    // 显式 domain=project 优先（项目事实显式打标 → 服务层绑定写时项目）
    const llmP = fakeLlm([
      { kind: "blocks", blocks: [{ type: "toolCall", id: "call-0", name: "remember", args: { text: "helix 记忆库在 steward_memory.db", kind: "fact", domain: "project" } }], stopReason: "toolUse" },
      { kind: "blocks", blocks: [{ type: "text", text: "记好了。" }], stopReason: "stop" },
    ]);
    const memoryP = fakeMemory();
    const { svc: svcP } = makeService({ llm: llmP, memory: memoryP, memoryProject: () => "helix" });
    await svcP.ask("记住：helix 记忆库位置");
    expect(memoryP.remembers[0]!.scope).toEqual({ project: "helix", domain: "project" });
    // preference 缺省 → habit；项目缺席也照传推导域
    const llm2 = fakeLlm([
      { kind: "blocks", blocks: [{ type: "toolCall", id: "call-0", name: "remember", args: { text: "用户偏好简洁回复", kind: "preference" } }], stopReason: "toolUse" },
      { kind: "blocks", blocks: [{ type: "text", text: "记好了。" }], stopReason: "stop" },
    ]);
    const memory2 = fakeMemory();
    const { svc: svc2 } = makeService({ llm: llm2, memory: memory2 });
    await svc2.ask("记住：用户偏好简洁回复");
    expect(memory2.remembers[0]!.scope).toEqual({ domain: "habit" });
  });

  test("② 存储故障 → toolResult 失败文本回灌 + answer 收口（不炸轮、零通知）", async () => {    const llm = fakeLlm([
      { kind: "blocks", blocks: [{ type: "toolCall", id: "call-0", name: "remember", args: { text: "项目在 helix 仓" } }], stopReason: "toolUse" },
      { kind: "blocks", blocks: [{ type: "text", text: "记忆服务这会儿存不进去，稍后再试。" }], stopReason: "stop" },
    ]);
    const memory = fakeMemory({ rememberFails: true });
    const { svc, notes } = makeService({ llm, memory });
    const result = await svc.ask("记住项目在 helix 仓");
    expect(result.status).toBe("answer"); // 故障被工具结果吸收，轮照常收口
    expect(memory.remembers.length).toBe(0);
    const toolResult = llm.calls[1]!.request.messages.find((m) => m.role === "toolResult");
    expect(toolResult!.text).toContain("记忆沉淀失败");
    expect(notes).toHaveLength(0); // 未落盘零通知
  });

  test("③ 记忆不可用 → 引导式降级：不挂闸、循环继续、answer 转述", async () => {
    const llm = fakeLlm([
      { kind: "blocks", blocks: [{ type: "toolCall", id: "call-0", name: "remember", args: { text: "用户偏好简洁" } }], stopReason: "toolUse" },
      { kind: "blocks", blocks: [{ type: "text", text: "记忆功能未开启——你可以在设置 → 通用 → 管家开启。" }], stopReason: "stop" },
    ]);
    const memory = fakeMemory({ available: false });
    const { svc } = makeService({ llm, memory });
    const result = await svc.ask("记住我偏好简洁");
    expect(result.status).toBe("answer");
    expect(memory.remembers.length).toBe(0);
    // 引导文本回灌工具轮（LLM 第二轮请求可见 toolResult）
    const toolResult = llm.calls[1]!.request.messages.find((m) => m.role === "toolResult");
    expect(toolResult!.text).toContain("未启用或未配置");
  });

  test("④ 记忆消费工具化（同轨换轨）：机械注入退役（system prompt 恒不含记忆段但含纪律句）；memory_search 工具轮命中行回灌 + query 透传；零命中文案照常作答", async () => {
    // 注入退役面：记忆可用且有命中，system prompt 也不含记忆段（消费改走工具，
    // 零工具调用零检索）
    const llmA = fakeLlm([{ kind: "blocks", blocks: [{ type: "text", text: "好的，简洁作答。" }], stopReason: "stop" }]);
    const memoryA = fakeMemory({ recallSection: "## 长期记忆（…）\n- [偏好] 回复要简洁" });
    const { svc: svcA } = makeService({ llm: llmA, memory: memoryA });
    const resultA = await svcA.ask("帮我写段话");
    expect(resultA.status).toBe("answer");
    expect(llmA.calls[0]!.request.systemPrompt).not.toContain("## 长期记忆");
    expect(llmA.calls[0]!.request.systemPrompt).toContain("长期记忆纪律（判断前必查）");
    expect(memoryA.recalls).toEqual([]);
    // 工具面：LLM 主动 memory_search → 工具结果回灌召回行 + query 透传
    //（query = 管家提炼重写后的意图，非转写原文）
    const llm = fakeLlm([
      { kind: "blocks", blocks: [{ type: "toolCall", id: "call-0", name: "memory_search", args: { query: "写作偏好 简洁" } }], stopReason: "toolUse" },
      { kind: "blocks", blocks: [{ type: "text", text: "按你偏好的简洁风格写好了。" }], stopReason: "stop" },
    ]);
    const memory = fakeMemory({ recallSection: "## 长期记忆（…）\n- [偏好] 回复要简洁" });
    const { svc } = makeService({ llm, memory });
    const result = await svc.ask("帮我写段话");
    expect(result.status).toBe("answer");
    expect(memory.recalls).toEqual(["写作偏好 简洁"]);
    const toolResult = llm.calls[1]!.request.messages.find((m) => m.role === "toolResult");
    expect(toolResult!.text).toContain("[偏好] 回复要简洁");
    // 零命中（recallSection undefined——含服务内部降级）→ 零命中文案回灌，对话照常
    const llm2 = fakeLlm([
      { kind: "blocks", blocks: [{ type: "toolCall", id: "call-0", name: "memory_search", args: { query: "别的主题" } }], stopReason: "toolUse" },
      { kind: "blocks", blocks: [{ type: "text", text: "照常作答。" }], stopReason: "stop" },
    ]);
    const degraded = makeService({ llm: llm2, memory: fakeMemory({ recallSection: undefined }) });
    expect((await degraded.svc.ask("第二问")).status).toBe("answer");
    const toolResult2 = llm2.calls[1]!.request.messages.find((m) => m.role === "toolResult");
    expect(toolResult2!.text).toContain("无相关记忆命中");
  });

  test("⑤ 配置面：getConfig 携 memory 现态（未装配 = 降级缺省）；setConfig 委托校验透传", async () => {
    // 未装配 → 降级缺省（批1：endpoint 摘除——回执不回 endpointId）
    const bare = makeService({ llm: fakeLlm([]) });
    const bareCfg = bare.svc.getConfig();
    expect(bareCfg.memory).toEqual({ enabled: false, available: false, judgeEndpoint: null, entryCount: 0, dim: null });
    // 装配 → 真实现态透传
    const memory = fakeMemory();
    const { svc } = makeService({ llm: fakeLlm([]), memory });
    expect(svc.getConfig().memory.available).toBe(true);
    expect(svc.getConfig().memory.dim).toBe(1024);
    // setConfig memory 组委托（批1 收编形态 {enabled,judgeEndpointId,…}——服务层错误原样透传）
    const denied = await svc.setConfig({ memory: { enabled: true, judgeEndpointId: "ep-fail" } });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain("存储异常");
    const ok = await svc.setConfig({ memory: { enabled: true } });
    expect(ok.ok).toBe(true);
    expect(memory.configPatches.length).toBe(2);
  });

  // 防双写水位闸（explicitRememberedSince 面——原轮标识比对的防双写标记
  // 语义由 StewardMemoryService.explicitRememberedSince 水位闸承接）：
  // 轮内显式 remember 与总结器记忆点是两条写路径，同轮双写产生重复噪音
  // （e2e 复发实录：同一偏好 added+updated 双卡）——显式优先、记忆点让位
  test("⑥ 防双写水位闸：轮内 remember 直写成功 → explicitRememberedSince 置位（总结器记忆点本轮让位）", async () => {
    const llm = fakeLlm([
      { kind: "blocks", blocks: [{ type: "toolCall", id: "call-0", name: "remember", args: { text: "用户偏好简洁回复", kind: "preference" } }], stopReason: "toolUse" },
      { kind: "blocks", blocks: [{ type: "text", text: "记好了。" }], stopReason: "stop" },
    ]);
    const memory = fakeMemory();
    expect(memory.explicitRememberedSince(0)).toBe(false); // 写前：水位未置
    const { svc, notes } = makeService({ llm, memory });
    const result = await svc.ask("记住：以后回复都简洁点");
    expect(result.status).toBe("answer");
    expect(memory.remembers).toHaveLength(1); // 仅轮内直写一次
    expect(notes).toHaveLength(1); // 单张 added 卡
    // 防双写闸置位：总结器记忆点产物经 explicitRememberedSince 判本轮
    // 显式写过 → 跳过（用户刚教过的不再由总结器代写）
    expect(memory.explicitRememberedSince(0)).toBe(true);
  });

  test("⑦ 防双写不误伤：轮内 remember 存储失败 → 水位不置位（总结器记忆点下锚点可补写）", async () => {
    const llm = fakeLlm([
      { kind: "blocks", blocks: [{ type: "toolCall", id: "call-0", name: "remember", args: { text: "项目在 helix 仓" } }], stopReason: "toolUse" },
      { kind: "blocks", blocks: [{ type: "text", text: "刚才没存进去，我再确认下。" }], stopReason: "stop" },
    ]);
    const memory = fakeMemory({ rememberFails: true });
    const { svc, notes } = makeService({ llm, memory });
    const result = await svc.ask("记住项目在 helix 仓");
    expect(result.status).toBe("answer");
    expect(memory.remembers).toHaveLength(0); // 失败不入库
    expect(notes).toHaveLength(0); // 零通知
    // 失败不置位（防双写不误伤）：总结器记忆点下锚点仍可补写该内容
    expect(memory.explicitRememberedSince(0)).toBe(false);
  });

  test("⑧ 换轨回归：ask 收口零轮末沉淀（B5 管线已删——零提取 LLM 调用零自动入库）", async () => {
    const llm = fakeLlm([
      { kind: "blocks", blocks: [{ type: "text", text: "好的。" }], stopReason: "stop" },
    ]);
    const memory = fakeMemory();
    const { svc, notes } = makeService({ llm, memory });
    const result = await svc.ask("以后回复要简洁");
    expect(result.status).toBe("answer");
    expect(llm.calls).toHaveLength(1); // 仅主答——零轮末提取 LLM 调用
    expect(memory.remembers).toHaveLength(0); // 零自动入库（自动沉淀归总结器记忆点）
    expect(notes).toHaveLength(0);
  });
});
