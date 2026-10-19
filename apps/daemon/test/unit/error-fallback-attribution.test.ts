import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ErrorCode } from "@helix/protocol";
import { SessionNotFoundError } from "../../src/application/services/SessionRegistry";
import { handleConfigSetCompaction } from "../../src/adapters/driving/ws-server/handlers/config";
import { handleKgIndexStatus } from "../../src/adapters/driving/ws-server/handlers/kg";
import { handleTaskDelete } from "../../src/adapters/driving/ws-server/handlers/task";
import { handleDiffGet } from "../../src/adapters/driving/ws-server/handlers/diff";
import { handleSttTranscribe } from "../../src/adapters/driving/ws-server/handlers/stt";
import { handleStewardJudgeStopIntent } from "../../src/adapters/driving/ws-server/handlers/steward";
import { handleAgentKill } from "../../src/adapters/driving/ws-server/handlers/agent";
import { handleChatSend } from "../../src/adapters/driving/ws-server/handlers/chat";
import { handleWebStatus } from "../../src/adapters/driving/ws-server/handlers/web";
import type {
  ChatCommandContext,
  DiffCommandContext,
  KgCommandContext,
  StewardCommandContext,
  SttCommandContext,
  TaskCommandContext,
  WsCommandContext,
  AgentCommandContext,
  WebCommandContext,
} from "../../src/adapters/driving/ws-server/handlers/context";

/**
 * F2 invalid_payload 归位批（评审中危 #7/#8/#9 + 低危代表 agent.ts:29 /
 * chat.ts:53 + 站点 diff.ts:92 / task.ts:301）：
 * - 服务端故障（异步执行失败/意外异常）→ daemon.internal（H5 兑底口径，
 *   与 WsServerAdapter.dispatchCommand 同码同语义）；task 族未分类内部
 *   错误走 task.internal（M7 先例）。
 * - 载荷类判别错误（校验/err.code 判别）保留 command.invalid_payload。
 * - 业务态失败（agent.kill 目标不存在/已终态）→ agent.invalid_state。
 * - 会话不存在（diff.get 未加载 / stt resolveTarget）→ session.not_found。
 *
 * 行为面 = handler 级桩注入（commandError 记录观察点，同 error-code-judgement
 * 先例）；结构面 = handlers/*.ts 全目录扫描，机械保证跨站点统一（防新增命令
 * 族照抄旧兜底复活）。
 */

type Recorded = { type: string; code: ErrorCode; message: string };

const handlersDir = path.join(import.meta.dir, "..", "..", "src", "adapters", "driving", "ws-server", "handlers");

/** 微任务 flush 后收集 commandError 记录（异步链 catch 回调观察点）。 */
async function capture(drive: (errors: Recorded[]) => void): Promise<Recorded[]> {
  const errors: Recorded[] = [];
  drive(errors);
  await new Promise((r) => setTimeout(r, 0));
  return errors;
}

const recorder = (errors: Recorded[]) => (type: string, code: ErrorCode, message: string) => {
  errors.push({ type, code, message });
};

const dummySender = { send: () => undefined };
const wsOf = (sender: unknown = dummySender) => ({ data: { sender } });

describe("F2 归位：异步执行失败兜底 → daemon.internal（H5 口径）", () => {
  test("config.set_compaction：set 拒绝 → daemon.internal 透传 message（config 族 7 站点代表）", async () => {
    const errors = await capture((errors) => {
      handleConfigSetCompaction({
        ws: wsOf() as WsCommandContext["ws"],
        type: "config.set_compaction",
        payload: { reserveTokens: 1000, keepRecentTokens: 2000 },
        compactionConfig: { set: () => Promise.reject(new Error("sqlite busy")) },
        commandError: recorder(errors),
      } as unknown as WsCommandContext);
    });
    expect(errors).toEqual([{ type: "config.set_compaction", code: "daemon.internal", message: "sqlite busy" }]);
  });

  test("kg.index.status：indexStatus 拒绝 → daemon.internal（kg 族 8 站点代表）", async () => {
    const errors = await capture((errors) => {
      handleKgIndexStatus({
        ws: wsOf() as KgCommandContext["ws"],
        type: "kg.index.status",
        payload: { project: "helix" },
        kg: { indexStatus: () => Promise.reject(new Error("kg store 不可用")) },
        commandError: recorder(errors),
      } as unknown as KgCommandContext);
    });
    expect(errors).toEqual([{ type: "kg.index.status", code: "daemon.internal", message: "kg store 不可用" }]);
  });

  test("task.delete：引擎拒绝无 code → task.internal（M7 未分类内部错误先例，站点 task.ts:301）", async () => {
    const errors = await capture((errors) => {
      handleTaskDelete({
        ws: wsOf() as TaskCommandContext["ws"],
        type: "task.delete",
        payload: { jobId: "j1" },
        taskEngine: { deleteTask: () => Promise.reject(new Error("级联删除中断")) },
        commandError: recorder(errors),
      } as unknown as TaskCommandContext);
    });
    expect(errors).toEqual([{ type: "task.delete", code: "task.internal", message: "级联删除中断" }]);
  });

  test("diff.get：查询链拒绝 → daemon.internal（站点 diff.ts:126）", async () => {
    const errors = await capture((errors) => {
      handleDiffGet({
        ws: wsOf() as DiffCommandContext["ws"],
        type: "diff.get",
        payload: {},
        envelope: { sessionId: "s1" },
        diff: {
          stateOf: () => ({}) as never,
          service: { getTurnView: () => Promise.reject(new Error("冻结轮缺失")) },
        },
        commandError: recorder(errors),
      } as unknown as DiffCommandContext);
    });
    expect(errors).toEqual([{ type: "diff.get", code: "daemon.internal", message: "diff 查询失败：冻结轮缺失" }]);
  });

  test("web.status：读面组装拒绝 → daemon.internal（web 族 3 站点代表）", async () => {
    const errors = await capture((errors) => {
      handleWebStatus({
        ws: wsOf() as WebCommandContext["ws"],
        type: "web.status",
        payload: {},
        browser: { getStatus: () => Promise.reject(new Error("cdp 断连")) },
        commandError: recorder(errors),
      } as unknown as WebCommandContext);
    });
    expect(errors).toEqual([{ type: "web.status", code: "daemon.internal", message: "web.status 执行失败：cdp 断连" }]);
  });
});

describe("F2 归位：会话不存在 → session.not_found（不误标 payload/内部）", () => {
  test("diff.get：会话不在 diff 状态表 → session.not_found（站点 diff.ts:92）", async () => {
    const errors = await capture((errors) => {
      handleDiffGet({
        ws: wsOf() as DiffCommandContext["ws"],
        type: "diff.get",
        payload: {},
        envelope: { sessionId: "s-cold" },
        diff: { stateOf: () => undefined, service: { getTurnView: () => Promise.resolve(null) } },
        commandError: recorder(errors),
      } as unknown as DiffCommandContext);
    });
    expect(errors).toEqual([
      { type: "diff.get", code: "session.not_found", message: "会话不存在或未加载：s-cold" },
    ]);
  });

  test("stt.transcribe：resolveTarget 抛 SessionNotFoundError → session.not_found；其余异常 → daemon.internal（评审 #8）", async () => {
    const notFound = await capture((errors) => {
      handleSttTranscribe({
        ws: wsOf() as SttCommandContext["ws"],
        type: "stt.transcribe",
        payload: { audio: "data:audio/webm;base64,AAAA" },
        envelope: { sessionId: "s-gone" },
        directory: { resolveTarget: () => Promise.reject(new SessionNotFoundError("s-gone")) },
        commandError: recorder(errors),
      } as unknown as SttCommandContext);
    });
    expect(notFound).toEqual([
      { type: "stt.transcribe", code: "session.not_found", message: "stt.transcribe 执行失败：会话 s-gone 不存在" },
    ]);

    const internal = await capture((errors) => {
      handleSttTranscribe({
        ws: wsOf() as SttCommandContext["ws"],
        type: "stt.transcribe",
        payload: { audio: "data:audio/webm;base64,AAAA" },
        envelope: { sessionId: "s1" },
        directory: {
          resolveTarget: () => Promise.resolve("s1"),
          getSessionView: () => Promise.reject(new Error("视图组装异常")),
        },
        commandError: recorder(errors),
      } as unknown as SttCommandContext);
    });
    expect(internal).toEqual([
      { type: "stt.transcribe", code: "daemon.internal", message: "stt.transcribe 执行失败：视图组装异常" },
    ]);
  });
});

describe("F2 归位：意外异常不静默（评审 #9 steward.ts:556 + 低危代表 chat.ts:53）", () => {
  test("steward.judge_stop_intent：判定链拒绝 → daemon.internal 回执（不 unhandled rejection）", async () => {
    const errors = await capture((errors) => {
      handleStewardJudgeStopIntent({
        ws: wsOf() as StewardCommandContext["ws"],
        type: "steward.judge_stop_intent",
        payload: { text: "停下来" },
        steward: { service: { judgeStopIntent: () => Promise.reject(new Error("判官不可达")) } },
        commandError: recorder(errors),
      } as unknown as StewardCommandContext);
    });
    expect(errors).toEqual([
      { type: "steward.judge_stop_intent", code: "daemon.internal", message: "steward.judge_stop_intent 执行失败：判官不可达" },
    ]);
  });

  test("chat.send 草稿链 sender 缺失 → daemon.internal 兜底回执（不静默丢首条消息回执）", async () => {
    const errors = await capture((errors) => {
      handleChatSend({
        ws: wsOf(null) as ChatCommandContext["ws"],
        type: "chat.send",
        payload: { text: "hi", draft: true },
        envelope: {},
        directory: { startDraftSession: () => Promise.resolve({ sessionId: "s9" }) },
        commandError: recorder(errors),
      } as unknown as ChatCommandContext);
    });
    expect(errors).toEqual([{ type: "chat.send", code: "daemon.internal", message: expect.stringContaining("sender") }]);
  });
});

describe("F2 归位：业务态失败码（低危代表 agent.ts:29）", () => {
  test("agent.kill：目标不存在/已终态 → agent.invalid_state（非载荷非法）", () => {
    const errors: Recorded[] = [];
    const record = recorder(errors);
    handleAgentKill({
      ws: wsOf() as AgentCommandContext["ws"],
      type: "agent.kill",
      payload: { agentId: "a-gone" },
      orchestration: { kill: () => ({ killed: false, error: "实例 a-gone 不存在（无法 kill）" }) },
      commandError: record,
    } as unknown as AgentCommandContext);
    handleAgentKill({
      ws: wsOf() as AgentCommandContext["ws"],
      type: "agent.kill",
      payload: { agentId: "a-done" },
      orchestration: { kill: () => ({ killed: false, error: "实例 a-done 已终态（done），无需 kill" }) },
      commandError: record,
    } as unknown as AgentCommandContext);
    expect(errors.map((e) => e.code)).toEqual(["agent.invalid_state", "agent.invalid_state"]);
  });
});

describe("F2 结构断言：handlers 全目录异步兜底码统一（跨站点机械保证）", () => {
  /** handlers/*.ts 相对清单。 */
  function listHandlerFiles(): string[] {
    return (readdirSync(handlersDir) as string[]).filter((f) => f.endsWith(".ts"));
  }

  test("invalid_payload 回执透传 err.message 仅允许出现在 err.code 判别分支；「执行失败」兜底不挂 invalid_payload", () => {
    const violations: string[] = [];
    for (const file of listHandlerFiles()) {
      const lines = readFileSync(path.join(handlersDir, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        const passthrough =
          /"command\.invalid_payload"/.test(line) &&
          (/(err as Error)\.message|[^.\w]err\.message/.test(line) || /执行失败/.test(line));
        if (!passthrough) return;
        // 判别分支豁免：前 4 行内出现 .code === "command.invalid_payload"（err.code 码匹配先例）
        const window = lines.slice(Math.max(0, i - 4), i).join("\n");
        if (!/\.code === "command\.invalid_payload"|code === "command\.invalid_payload"/.test(window)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      violations,
      `异步兜底误标 command.invalid_payload 残留（应统一 reportInternalFailure → daemon.internal）：\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
