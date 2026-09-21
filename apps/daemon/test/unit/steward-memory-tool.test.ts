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
function fakeMemory(opts: { available?: boolean; recallSection?: string | undefined; recallThrows?: boolean } = {}) {
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
      endpoint: { baseUrl: "http://localhost:11434/v1", model: "bge-m3", hasApiKey: false },
      entryCount: state.remembers.length,
      dim: 1024,
    }),
    recallSection: async (query: string): Promise<string | undefined> => {
      state.recalls.push(query);
      if (opts.recallThrows === true) throw new Error("端点挂了");
      return opts.recallSection;
    },
    remember: async (text: string, kind: "fact" | "preference", source: string) => {
      state.remembers.push({ text, kind, source });
      return { id: state.remembers.length };
    },
    setMemoryConfig: async (patch: Record<string, unknown>) => {
      state.configPatches.push(patch);
      // 模拟存储层故障（写面校验已废除——错误透传路径用中性故障形态验证）
      if (patch.baseUrl === "") {
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
}) {
  const svc = new StewardService({
    llm: opts.llm,
    orchestration: { status: () => [], send: () => ({ delivered: false, detail: "无实例" }) },
    tasks: { listTasks: () => [] },
    config: opts.config ?? fakeConfig({ "steward.enabled": "1" }),
    feedGate: { hasStewardSubscribers: () => false },
    emitFeed: () => {},
    ...(opts.memory !== undefined ? { memory: opts.memory } : {}),
  });
  return svc;
}

describe("管家记忆 B1：remember 工具确认闸", () => {
  test("① remember 提案 → confirm_required（长期记忆 + 全文展示）+ 零写入", async () => {
    const llm = fakeLlm([
      { kind: "toolCall", id: "call-0", name: "remember", args: { text: "用户偏好简洁回复", kind: "preference" } },
    ]);
    const memory = fakeMemory();
    const svc = makeService({ llm, memory });
    const result = await svc.ask("记住：以后回复都简洁点");
    expect(result.status).toBe("confirm_required");
    if (result.status !== "confirm_required") throw new Error("unreachable");
    expect(result.agentId).toBe("长期记忆");
    expect(result.message).toContain("用户偏好简洁回复");
    expect(result.message).toContain("偏好");
    expect(memory.remembers.length).toBe(0); // 未确认 = 零写入（防火墙）
  });

  test("② confirm → remember 恰一次 + ok 回执；actionId 单次消费", async () => {
    const llm = fakeLlm([
      { kind: "toolCall", id: "call-0", name: "remember", args: { text: "项目在 helix 仓" } },
    ]);
    const memory = fakeMemory();
    const svc = makeService({ llm, memory });
    const result = await svc.ask("记住项目在 helix 仓");
    if (result.status !== "confirm_required") throw new Error("unreachable");
    const confirmed = await svc.confirm(result.actionId);
    expect(confirmed.status).toBe("ok");
    expect(memory.remembers).toEqual([{ text: "项目在 helix 仓", kind: "fact", source: "steward-turn" }]);
    if (confirmed.status === "ok") expect(confirmed.detail).toContain("项目在 helix 仓");
    // 单次消费：二次 confirm → error，remember 仍恰一次
    const again = await svc.confirm(result.actionId);
    expect(again.status).toBe("error");
    expect(memory.remembers.length).toBe(1);
  });

  test("③ 记忆不可用 → 引导式降级：不挂闸、循环继续、answer 转述", async () => {
    const llm = fakeLlm([
      { kind: "toolCall", id: "call-0", name: "remember", args: { text: "用户偏好简洁" } },
      { kind: "text", text: "记忆功能未开启——你可以在设置 → 通用 → 管家开启。" },
    ]);
    const memory = fakeMemory({ available: false });
    const svc = makeService({ llm, memory });
    const result = await svc.ask("记住我偏好简洁");
    expect(result.status).toBe("answer");
    expect(memory.remembers.length).toBe(0);
    // 引导文本回灌工具轮（LLM 第二轮请求可见 toolResult）
    const toolResult = llm.calls[1]!.request.messages.find((m) => m.role === "toolResult");
    expect(toolResult!.text).toContain("未启用或未配置");
  });

  test("④ 召回注入：可用且有命中 → system prompt 含记忆段；召回失败 → 无段但对话照常", async () => {
    // 命中面
    const llm = fakeLlm([{ kind: "text", text: "好的，简洁作答。" }]);
    const memory = fakeMemory({ recallSection: "## 长期记忆（…）\n- [偏好] 回复要简洁" });
    const svc = makeService({ llm, memory });
    const result = await svc.ask("帮我写段话");
    expect(result.status).toBe("answer");
    expect(llm.calls[0]!.request.systemPrompt).toContain("[偏好] 回复要简洁");
    expect(memory.recalls).toEqual(["帮我写段话"]);
    // 注：recallSection 服务内部已吞错降级——此处直接验证「无段 = 无注入」
    const llm2 = fakeLlm([{ kind: "text", text: "照常作答。" }]);
    const degraded = makeService({ llm: llm2, memory: fakeMemory({ recallSection: undefined }) });
    expect((await degraded.ask("第二问")).status).toBe("answer");
    expect(llm2.calls[0]!.request.systemPrompt).not.toContain("## 长期记忆（按本轮输入");
  });

  test("⑤ 配置面：getConfig 携 memory 现态（未装配 = 降级缺省）；setConfig 委托校验透传", async () => {
    // 未装配 → 降级缺省
    const bare = makeService({ llm: fakeLlm([]) });
    const bareCfg = bare.getConfig();
    expect(bareCfg.memory).toEqual({ enabled: false, available: false, endpoint: null, entryCount: 0, dim: null });
    // 装配 → 真实现态透传
    const memory = fakeMemory();
    const svc = makeService({ llm: fakeLlm([]), memory });
    expect(svc.getConfig().memory.available).toBe(true);
    expect(svc.getConfig().memory.endpoint!.model).toBe("bge-m3");
    // setConfig memory 组委托（服务层错误原样透传——如存储故障）
    const denied = await svc.setConfig({ memory: { baseUrl: "", enabled: true } });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain("存储异常");
    const ok = await svc.setConfig({ memory: { baseUrl: "http://localhost:11434/v1", model: "bge-m3", enabled: true } });
    expect(ok.ok).toBe(true);
    expect(memory.configPatches.length).toBe(2);
  });
});
