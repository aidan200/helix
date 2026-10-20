/**
 * StewardService 单测共享夹具（steward-service*.test.ts 三文件共用）——
 * 纯位置迁移自 steward-service.test.ts（P1 体量门拆分批，测试逻辑零改动）。
 * 剧本化 fake LLM / fake 配置 / fake 编排 / makeService 装配面。
 */
import { createEngineFromPort } from "../../helpers/steward/portScriptEngine";
import type {
  StewardLlmPort,
  StewardLlmRequest,
  StewardLlmResponse,
} from "../../../src/application/ports/outbound/StewardLlmPort";
import type {
  AgentOrchestrationPort,
  AgentInstanceStatus,
} from "../../../src/application/ports/inbound/AgentOrchestrationPort";
import type { RuntimeConfigPort } from "../../../src/application/ports/outbound/RuntimeConfigPort";
import type { StewardFeedPayload } from "@helix/protocol";
import { StewardService } from "../../../src/application/steward/StewardService";
import { StewardDialogMemory } from "../../../src/application/steward/StewardDialogMemory";
import { fakeDialogStore } from "./fake-steward-dialog-store";

// ── fakes ─────────────────────────────────────────────────

export interface LlmCall {
  readonly request: StewardLlmRequest;
  readonly round: number;
}

/** 剧本化 fake LLM：按调用序出队响应；断言面记录全部调用（A1 扩：
 *  响应携 thinking 时先回调 onThinking 段级——模拟 adapter 块终态回调序）。 */
export function fakeLlm(script: readonly StewardLlmResponse[]): StewardLlmPort & { calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    modelId: "deepseek/deepseek-v4-flash",
    calls,
    async complete(
      request: StewardLlmRequest,
      _onDelta?: (chunk: string) => void,
      onThinking?: (block: string) => void,
    ): Promise<StewardLlmResponse> {
      const round = calls.length;
      calls.push({ request, round });
      const next = script[round];
      if (next === undefined) throw new Error("fake LLM 剧本耗尽");
      if (onThinking !== undefined && next.kind === "blocks") {
        for (const b of next.blocks) {
          if (b.type === "thinking" && b.text !== "") onThinking(b.text);
        }
      }
      return next;
    },
  };
}

/** 流式剧本轮（V2.5 体验批）：响应 + 可选增量 chunk 序列（text 生成段）。 */
export interface ScriptedTurn {
  readonly response: StewardLlmResponse;
  /** 逐 chunk 调 onDelta 的序列（工具轮缺省 = 静默零 delta）。 */
  readonly chunks?: readonly string[];
  /** chunks 后抛错（模拟中途失败）。 */
  readonly failAfterChunks?: boolean;
}

/** 流式 fake LLM：complete(request, onDelta) 双参面——逐 chunk 回调后出队响应。 */
export function streamingLlm(script: readonly ScriptedTurn[]): StewardLlmPort & { calls: (LlmCall & { onDelta?: (chunk: string) => void })[] } {
  const calls: (LlmCall & { onDelta?: (chunk: string) => void })[] = [];
  return {
    modelId: "deepseek/deepseek-v4-flash",
    calls,
    async complete(request: StewardLlmRequest, onDelta?: (chunk: string) => void): Promise<StewardLlmResponse> {
      const round = calls.length;
      calls.push({ request, round, onDelta });
      const next = script[round];
      if (next === undefined) throw new Error("fake LLM 剧本耗尽");
      if (onDelta !== undefined && next.chunks !== undefined) {
        for (const c of next.chunks) onDelta(c);
      }
      if (next.failAfterChunks === true) throw new Error("模拟模型中断");
      return next.response;
    },
  };
}

export function fakeConfig(initial: Record<string, string> = {}): RuntimeConfigPort & { kv: Map<string, string> } {
  const kv = new Map(Object.entries(initial));
  return {
    kv,
    get: (key: string) => kv.get(key),
    set: async (key: string, value: string) => {
      kv.set(key, value);
    },
  };
}

export function fakeOrchestration(statuses: readonly AgentInstanceStatus[] = []) {
  const sends: { agentId: string; message: string }[] = [];
  const orchestration = {
    sends,
    status: (agentId?: string): AgentInstanceStatus[] =>
      agentId === undefined ? [...statuses] : statuses.filter((s) => s.agentId === agentId),
    send: (agentId: string, message: string): { delivered: boolean; detail: string } => {
      sends.push({ agentId, message });
      const target = statuses.find((s) => s.agentId === agentId && s.state === "running");
      if (target === undefined) return { delivered: false, detail: `实例 ${agentId} 非运行中` };
      return { delivered: true, detail: "已投递（turn 边界注入生效）" };
    },
  };
  return orchestration as unknown as Pick<AgentOrchestrationPort, "status" | "send"> & typeof orchestration;
}

export function makeService(opts: {
  llm: StewardLlmPort;
  orchestration?: ReturnType<typeof fakeOrchestration>;
  config?: RuntimeConfigPort;
  feedSubscribers?: number;
}) {
  const orchestration = opts.orchestration ?? fakeOrchestration([
    {
      agentId: "agent-1",
      state: "running",
      displayState: "active",
      profileKind: "subagent-worker",
      task: "修复登录超时",
    },
    {
      agentId: "agent-2",
      state: "done",
      displayState: "done",
      profileKind: "subagent-worker",
      task: "写单测",
      summary: "已完成：8 用例全绿",
    },
  ]);
  const config = opts.config ?? fakeConfig({ "steward.enabled": "1" });
  const dialogStore = fakeDialogStore();
  const feeds: StewardFeedPayload[] = [];
  const svc = new StewardService({
    llm: opts.llm,
    createEngine: createEngineFromPort(opts.llm),
    orchestration,
    tasks: {
      listTasks: () => [
        {
          jobId: "job-1",
          type: "code-fix",
          title: "修复登录超时",
          status: "running",
          projects: ["helix"],
          createdBy: "chat",
          createdAt: "2026-09-19T02:00:00.000Z",
          updatedAt: "2026-09-19T02:10:00.000Z",
          progress: { stageName: "实现", batchesDone: 2, batchesTotal: 4, percent: 50 },
          error: null,
        },
      ],
    },
    config,
    dialog: new StewardDialogMemory(dialogStore),
    feedGate: { hasStewardSubscribers: () => (opts.feedSubscribers ?? 1) > 0 },
    emitFeed: (payload) => feeds.push(payload),
  });
  return { svc, orchestration, config, feeds, dialogStore };
}

export const toolCall = (name: string, args: Record<string, unknown>, round = 0): StewardLlmResponse => ({ kind: "blocks", blocks: [{ type: "toolCall", id: `call-${round}`,
  name,
  args }], stopReason: "toolUse" });
