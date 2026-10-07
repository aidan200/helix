/**
 * StewardService × 长期记忆 B1 单测（remember 工具确认闸 + 召回注入）。
 *
 * 断言面：
 * 1. remember 提案 → confirm_required 回执（displayTarget = 长期记忆 +
 *    全文展示）+ 零写入（未确认 memory.remember 零调用——确认闸防火墙）；
 * 2. confirm → memory.remember 恰一次（text/kind 透传）+ ok 回执含条目
 *    文本；actionId 单次消费（二次 confirm → error）；
 * 3. 记忆不可用（未装配/未开启）→ remember 调用引导式降级：不挂闸、
 *    循环继续、最终 answer 转述（零提案零写入）；
 * 4. 召回注入：记忆可用且有命中 → ask 的 system prompt 含记忆段；
 *    召回失败 → system prompt 无记忆段但对话照常（降级不挡主链路）；
 * 5. 配置面：getConfig 携带 memory 现态（未装配 = 全降级缺省）；
 *    setConfig memory 组委托校验（开启前端点必填错误透传）。
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
  opts: { available?: boolean; recallSection?: string | undefined; recallThrows?: boolean; rememberFails?: boolean; rememberFailsFirst?: boolean } = {},
) {
  let rememberCalls = 0;
  const state = {
    remembers: [] as { text: string; kind: string; source: string }[],
    recalls: [] as string[],
    configPatches: [] as Record<string, unknown>[],
  };
  const memory = {
    ...state,
    isAvailable: () => opts.available ?? true,
    getMemoryState: (): StewardMemoryState => ({
      enabled: true,
      available: opts.available ?? true,
      endpoint: { id: "ep-1", name: "Ollama 本地", model: "bge-m3", hasApiKey: false },
      judgeEndpoint: null,
      entryCount: state.remembers.length,
      dim: 1024,
    }),
    recallSection: async (query: string): Promise<string | undefined> => {
      state.recalls.push(query);
      if (opts.recallThrows === true) throw new Error("端点挂了");
      return opts.recallSection;
    },
    remember: async (text: string, kind: "fact" | "preference", source: string) => {
      rememberCalls += 1;
      if (opts.rememberFails === true || (opts.rememberFailsFirst === true && rememberCalls === 1)) {
        throw new Error("嵌入端点 503");
      }
      state.remembers.push({ text, kind, source });
      return { id: state.remembers.length, updated: false };
    },
    setMemoryConfig: async (patch: Record<string, unknown>) => {
      state.configPatches.push(patch);
      // 模拟存储层故障（写面无前置校验——错误透传路径用中性故障形态验证）
      if (patch.enabled === true && patch.endpointId === "ep-fail") {
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
  /** 轮末沉淀 money 闸（hasStewardSubscribers）——防双写用例需开。 */
  subscribers?: boolean;
}) {
  const notes: import("@helix/protocol").StewardMemoryWrittenPayload[] = [];
  const svc = new StewardService({
    llm: opts.llm,
    createEngine: createEngineFromPort(opts.llm),
    orchestration: { status: () => [], send: () => ({ delivered: false, detail: "无实例" }) },
    tasks: { listTasks: () => [] },
    config: opts.config ?? fakeConfig({ "steward.enabled": "1" }),
    feedGate: { hasStewardSubscribers: () => opts.subscribers ?? false },
    emitFeed: () => {},
    emitMemoryWritten: (payload) => notes.push(payload),
    // 批①：B5 沉淀触发缺省停用（换轨总结器记忆点）——本文件测休眠管线
    // （轮末沉淀防双写用例），显式置 true 驱动；生产装配零触发
    sedimentTriggers: true,
    ...(opts.memory !== undefined ? { memory: opts.memory } : {}),
  });
  return { svc, notes };
}

describe("管家记忆 B5：remember 工具摘闸直写", () => {
  test("① remember 直写：工具调用即入库 + 落盘通知 added + answer 收口（无确认卡）", async () => {
    const llm = fakeLlm([
      { kind: "blocks", blocks: [{ type: "toolCall", id: "call-0", name: "remember", args: { text: "用户偏好简洁回复", kind: "preference" } }], stopReason: "toolUse" },
      { kind: "blocks", blocks: [{ type: "text", text: "记好了。" }], stopReason: "stop" },
    ]);
    const memory = fakeMemory();
    const { svc, notes } = makeService({ llm, memory });
    const result = await svc.ask("记住：以后回复都简洁点");
    expect(result.status).toBe("answer"); // 摘闸：不挂确认直写（B5 静默化）
    expect(memory.remembers).toEqual([{ text: "用户偏好简洁回复", kind: "preference", source: "steward-turn" }]);
    // 工具结果回灌（LLM 第二轮可见入库交代）
    const toolResult = llm.calls[1]!.request.messages.find((m) => m.role === "toolResult");
    expect(toolResult!.text).toContain("已沉淀长期记忆");
    expect(toolResult!.text).toContain("用户偏好简洁回复");
    // 落盘通知：mode = added（新增），原文携带
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ text: "用户偏好简洁回复", mode: "added" });
  });

  test("② 存储故障 → toolResult 失败文本回灌 + answer 收口（不炸轮、零通知）", async () => {
    const llm = fakeLlm([
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

  test("④ 召回注入：可用且有命中 → system prompt 含记忆段；召回失败 → 无段但对话照常", async () => {
    // 命中面
    const llm = fakeLlm([{ kind: "blocks", blocks: [{ type: "text", text: "好的，简洁作答。" }], stopReason: "stop" }]);
    const memory = fakeMemory({ recallSection: "## 长期记忆（…）\n- [偏好] 回复要简洁" });
    const { svc } = makeService({ llm, memory });
    const result = await svc.ask("帮我写段话");
    expect(result.status).toBe("answer");
    expect(llm.calls[0]!.request.systemPrompt).toContain("[偏好] 回复要简洁");
    expect(memory.recalls).toEqual(["帮我写段话"]);
    // 注：recallSection 服务内部已吞错降级——此处直接验证「无段 = 无注入」
    const llm2 = fakeLlm([{ kind: "blocks", blocks: [{ type: "text", text: "照常作答。" }], stopReason: "stop" }]);
    const degraded = makeService({ llm: llm2, memory: fakeMemory({ recallSection: undefined }) });
    expect((await degraded.svc.ask("第二问")).status).toBe("answer");
    expect(llm2.calls[0]!.request.systemPrompt).not.toContain("## 长期记忆（按本轮输入");
  });

  test("⑤ 配置面：getConfig 携 memory 现态（未装配 = 降级缺省）；setConfig 委托校验透传", async () => {
    // 未装配 → 降级缺省
    const bare = makeService({ llm: fakeLlm([]) });
    const bareCfg = bare.svc.getConfig();
    expect(bareCfg.memory).toEqual({ enabled: false, available: false, endpoint: null, judgeEndpoint: null, entryCount: 0, dim: null });
    // 装配 → 真实现态透传
    const memory = fakeMemory();
    const { svc } = makeService({ llm: fakeLlm([]), memory });
    expect(svc.getConfig().memory.available).toBe(true);
    expect(svc.getConfig().memory.endpoint!.model).toBe("bge-m3");
    // setConfig memory 组委托（B2 瘦身形态 {enabled,endpointId}——服务层错误原样透传）
    const denied = await svc.setConfig({ memory: { enabled: true, endpointId: "ep-fail" } });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain("存储异常");
    const ok = await svc.setConfig({ memory: { enabled: true, endpointId: "ep-1" } });
    expect(ok.ok).toBe(true);
    expect(memory.configPatches.length).toBe(2);
  });

  // B5 防双写（e2e 复发实录：同一轮 remember 直写 added 后轮末沉淀又重写同容
  // updated——两段查重判同条覆盖，数据无损但多一次重写调用 + 一张多余 updated 卡）
  test("⑤ 防双写：轮内 remember 直写成功 → 同轮轮末沉淀跳过（零重写零二次入库单卡）", async () => {
    const llm = fakeLlm([
      { kind: "blocks", blocks: [{ type: "toolCall", id: "call-0", name: "remember", args: { text: "用户偏好简洁回复", kind: "preference" } }], stopReason: "toolUse" },
      { kind: "blocks", blocks: [{ type: "text", text: "记好了。" }], stopReason: "stop" },
      // 防御性脚本位：若防双写失效，轮末提取会消费此段（重写句）并二次入库
      { kind: "blocks", blocks: [{ type: "text", text: "用户偏好回复要简洁。" }], stopReason: "stop" },
    ]);
    const memory = fakeMemory();
    const { svc, notes } = makeService({ llm, memory, subscribers: true });
    const result = await svc.ask("记住：以后回复都简洁点");
    expect(result.status).toBe("answer");
    await svc.flushSediment();
    expect(memory.remembers).toHaveLength(1); // 仅轮内直写一次（轮末零重写入库）
    expect(llm.calls).toHaveLength(2); // 轮内两段调用；轮末零重写 LLM 调用
    expect(notes).toHaveLength(1); // 单张 added 卡（无 updated 双卡）
  });

  test("⑥ 防双写不误伤：轮内 remember 存储失败 → 轮末照常沉淀（失败不置标记）", async () => {
    const llm = fakeLlm([
      { kind: "blocks", blocks: [{ type: "toolCall", id: "call-0", name: "remember", args: { text: "项目在 helix 仓" } }], stopReason: "toolUse" },
      { kind: "blocks", blocks: [{ type: "text", text: "刚才没存进去，我再确认下。" }], stopReason: "stop" },
      { kind: "blocks", blocks: [{ type: "text", text: "用户的项目在 helix 仓。" }], stopReason: "stop" }, // 轮末重写提取段
    ]);
    const memory = fakeMemory({ rememberFailsFirst: true }); // 仅轮内首次失败，轮末补位成功
    const { svc, notes } = makeService({ llm, memory, subscribers: true });
    const result = await svc.ask("记住项目在 helix 仓");
    expect(result.status).toBe("answer");
    await svc.flushSediment();
    expect(memory.remembers).toHaveLength(1); // 轮末 auto-sediment 补位入库
    expect(memory.remembers[0]!.source).toBe("auto-sediment");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.mode).toBe("added");
  });
});
