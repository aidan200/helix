/**
 * 01-beforetoolcall-approval：实测 beforeToolCall 审批挂起语义。
 *
 * 记录点（brief 第 1 项）：
 * - 钩子签名与 Promise resolve 语义（loop 在 tool_execution_start 之后 await 钩子——
 *   挂起窗口即 [tool_execution_start, tool_execution_end]）；
 * - 挂起期间 steer / abort 是否仍可用；
 * - 超时行为（loop 侧是否存在强制超时）；
 * - 放行（resolve undefined）/ 拒绝（resolve {block:true,reason}）两分支的工具结果差异。
 *
 * 复跑（真实 key，需网络）：bun run 01-beforetoolcall-approval.ts --home .home
 * 干跑（只到建连层）：bun run 01-beforetoolcall-approval.ts --home .home --dry-run
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool } from "@earendil-works/pi-agent-core";
import type { AgentEvent, BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { assembleAgent, bindToolContext, buildModels, dryRunCheck, loadHomeConfig, makeLogger, NodeExecutionEnv, parseSpikeArgs, resolveModel } from "./lib.ts";

const { home, dryRun } = parseSpikeArgs(Bun.argv);
const config = loadHomeConfig(home);
if (dryRun) {
  await dryRunCheck(config);
  console.log("[dry-run] 到 provider 建连层为止，未发真实请求");
  process.exit(0);
}

const SYSTEM_PROMPT = [
  "You are a spike test agent in a sandbox temp directory.",
  "When the user asks to run a command, you MUST call the bash tool exactly once with exactly that command.",
  "After the tool returns, reply in one short sentence.",
].join(" ");

const PROMPT = 'Run this exact command with the bash tool: echo APPROVAL_MARKER_$(date +%s). Call the tool once.';

interface ScenarioResult {
  scenario: string;
  hookEnterAt?: number;
  hookResolveAt?: number;
  toolEndAt?: number;
  toolResult?: string;
  toolIsError?: boolean;
  steerAcceptedWhileSuspended?: boolean;
  steerQueuedAfterRun?: boolean;
  abortedDuringHold?: boolean;
  events: string[];
}

const results: ScenarioResult[] = [];

/** 单场景运行：holdMs 挂起时长；mode 决定放行/拒绝/abort。 */
async function runScenario(
  name: string,
  mode: "approve" | "block" | "abort",
  holdMs: number,
): Promise<ScenarioResult> {
  const log = makeLogger(`01.${name}`);
  const res: ScenarioResult = { scenario: name, events: [] };
  log.script("scenario-start", { mode, holdMs });

  const env = new NodeExecutionEnv({ cwd: mkdtempSync(join(tmpdir(), "spike01-")) });
  const bash = bindToolContext(createBashTool(), { env });
  const models = buildModels();
  const model = resolveModel(models, config.model);

  const agent = assembleAgent({
    models,
    model,
    apiKeys: config.apiKeys,
    systemPrompt: SYSTEM_PROMPT,
    tools: [bash],
    log,
    hooks: {
      beforeToolCall: async (ctx: BeforeToolCallContext, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> => {
        res.hookEnterAt = Date.now();
        log.script("beforeToolCall.enter", { tool: ctx.toolCall.name, args: ctx.args, signalPresent: !!signal });
        return await new Promise<BeforeToolCallResult | undefined>((resolve) => {
          const timer = setTimeout(() => {
            res.hookResolveAt = Date.now();
            log.script("beforeToolCall.resolve", { mode, afterMs: res.hookResolveAt! - res.hookEnterAt! });
            resolve(mode === "block" ? { block: true, reason: "SPIKE_BLOCKED: approval denied by test policy" } : undefined);
          }, holdMs);
          // 钩子按契约自行响应 abort 信号（loop 不替钩子打断）
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            res.hookResolveAt = Date.now();
            res.abortedDuringHold = true;
            log.script("beforeToolCall.resolve(via-abort-signal)", { afterMs: res.hookResolveAt! - res.hookEnterAt! });
            resolve(undefined);
          });
        });
      },
    },
  });

  // 事件序列捕获（程序化断言用），同时经 logger 打时序
  agent.subscribe((event: AgentEvent) => {
    res.events.push(event.type);
    if (event.type === "tool_execution_end") {
      res.toolEndAt = Date.now();
      res.toolResult = JSON.stringify(event.result?.content ?? null).slice(0, 120);
      res.toolIsError = event.isError;
    }
  });

  let steerAt: number | undefined;
  const runP = agent.prompt(PROMPT).catch((err) => log.script("prompt-error", { message: String(err) }));

  // 挂起期间（钩子进入后）注入 steer —— 验证挂起期间 steer 可用
  const waitHookEnter = async () => {
    for (let i = 0; i < 600 && !res.hookEnterAt; i++) await sleep(50);
  };
  await waitHookEnter();
  if (res.hookEnterAt) {
    await sleep(Math.min(1500, holdMs / 3));
    if (mode === "abort") {
      steerAt = Date.now();
      agent.steer({ role: "user", content: "STEER_DURING_SUSPENSION: please stop and say SUSPENDED_OK", timestamp: Date.now() });
      res.steerAcceptedWhileSuspended = agent.hasQueuedMessages();
      log.script("steer(during-suspension)", { accepted: res.steerAcceptedWhileSuspended });
      await sleep(500);
      log.script("abort()", {});
      agent.abort();
    } else if (mode === "approve") {
      steerAt = Date.now();
      agent.steer({ role: "user", content: "STEER_DURING_SUSPENSION: after the tool finishes, just say STEERED_OK", timestamp: Date.now() });
      res.steerAcceptedWhileSuspended = agent.hasQueuedMessages();
      log.script("steer(during-suspension)", { accepted: res.steerAcceptedWhileSuspended });
    }
  }

  await runP;
  await agent.waitForIdle();
  res.steerQueuedAfterRun = agent.hasQueuedMessages();
  log.script("scenario-end", {
    hookHoldMs: res.hookResolveAt && res.hookEnterAt ? res.hookResolveAt - res.hookEnterAt : null,
    toolResult: res.toolResult,
    toolIsError: res.toolIsError,
    eventSeq: res.events.join(" → "),
    steerQueuedAfterRun: res.steerQueuedAfterRun,
  });
  await env.cleanup();
  return res;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// 场景 A：挂起 6s 后放行 —— 同时证明 loop 侧无强制超时（6s 内无 tool_execution_end）
results.push(await runScenario("A-approve-hold6s", "approve", 6000));
// 场景 B：挂起 800ms 后拒绝（block + reason）
results.push(await runScenario("B-block-reason", "block", 800));
// 场景 C：挂起期间 abort —— 钩子经 abort 信号提前 resolve，loop 发现 signal.aborted
results.push(await runScenario("C-abort-during-hold", "abort", 20000));

console.log("\n===== 01 汇总 =====");
for (const r of results) {
  console.log(
    JSON.stringify({
      scenario: r.scenario,
      hookHoldMs: r.hookResolveAt && r.hookEnterAt ? r.hookResolveAt - r.hookEnterAt : null,
      toolIsError: r.toolIsError,
      toolResult: r.toolResult,
      steerAcceptedWhileSuspended: r.steerAcceptedWhileSuspended,
      steerQueuedAfterRun: r.steerQueuedAfterRun,
      abortedDuringHold: r.abortedDuringHold,
      eventSeq: r.events.join(" → "),
    }),
  );
}
