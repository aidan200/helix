/**
 * 02-steer-tool-concurrency：实测 steer 与工具长执行的并发行为。
 *
 * 记录点（brief 第 2 项）：
 * - steer 消息入队时机（工具执行中可入队？）；
 * - 当前 turn 是否被打断（长工具是否跑完）；
 * - drain 发生在哪个边界（turn 结束/工具批结束）——看 steer 消息的 message_start 出现在哪个事件之后；
 * - 事件序列（agent 事件类型时序）；
 * - 附加：abort 工具执行中 → 会话是否仍可继续（非销毁）。
 *
 * 复跑（真实 key，需网络）：bun run 02-steer-tool-concurrency.ts --home .home
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool } from "@earendil-works/pi-agent-core";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
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
  "When the user asks to run a command, call the bash tool exactly once with exactly that command.",
  "After the tool returns, reply briefly.",
].join(" ");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 场景 1：工具长执行（sleep 10）期间 steer×2（默认 one-at-a-time drain） ----------
{
  const log = makeLogger("02.steer");
  const env = new NodeExecutionEnv({ cwd: mkdtempSync(join(tmpdir(), "spike02-")) });
  const bash = bindToolContext(createBashTool(), { env });
  const models = buildModels();
  const agent = assembleAgent({
    models,
    model: resolveModel(models, config.model),
    apiKeys: config.apiKeys,
    systemPrompt: SYSTEM_PROMPT,
    tools: [bash],
    log,
    steeringMode: "one-at-a-time", // 默认值，显式写出
  });

  let toolStartedAt = 0;
  let toolEndedAt = 0;
  const marks: string[] = [];
  agent.subscribe((e: AgentEvent) => {
    if (e.type === "tool_execution_start") toolStartedAt = Date.now();
    if (e.type === "tool_execution_end") toolEndedAt = Date.now();
  });

  log.script("scenario-start", { desc: "工具 sleep 10 执行中 steer×2，观察 drain 时机与边界" });
  const runP = agent
    .prompt("Run this exact command with the bash tool: sleep 10 && echo SLOW_DONE. Then tell me the output in one sentence.")
    .catch((err) => log.script("prompt-error", { message: String(err) }));

  // 等工具真正开跑，再注入 steer（确保 steer 与工具执行并发）
  for (let i = 0; i < 1200 && !toolStartedAt; i++) await sleep(50);
  if (toolStartedAt) {
    log.script("tool-running", { afterToolStartMs: Date.now() - toolStartedAt });
    await sleep(1500);
    agent.steer({ role: "user", content: "STEER_1: stop waiting on slow commands. Do not call any more tools. Just reply with the single word PIVOTED.", timestamp: Date.now() });
    log.script("steer#1-enqueued", { duringToolExec: !toolEndedAt, hasQueued: agent.hasQueuedMessages() });
    await sleep(500);
    agent.steer({ role: "user", content: "STEER_2: acknowledge briefly that you saw this second steering note.", timestamp: Date.now() });
    log.script("steer#2-enqueued", { duringToolExec: !toolEndedAt, hasQueued: agent.hasQueuedMessages() });
  } else {
    log.script("no-tool-start", {});
  }

  await runP;
  await agent.waitForIdle();
  log.script("scenario-end", {
    toolDurationMs: toolEndedAt && toolStartedAt ? toolEndedAt - toolStartedAt : null,
    marks: marks.join(","),
    finalMessages: agent.state.messages.length,
    lastAssistant: JSON.stringify((agent.state.messages.at(-1) as any)?.content ?? null).slice(0, 160),
  });
  await env.cleanup();
}

// ---------- 场景 2：工具执行中 abort → 会话仍可继续 ----------
{
  const log = makeLogger("02.abort");
  const env = new NodeExecutionEnv({ cwd: mkdtempSync(join(tmpdir(), "spike02b-")) });
  const bash = bindToolContext(createBashTool(), { env });
  const models = buildModels();
  const agent = assembleAgent({
    models,
    model: resolveModel(models, config.model),
    apiKeys: config.apiKeys,
    systemPrompt: SYSTEM_PROMPT,
    tools: [bash],
    log,
  });

  let toolStartedAt = 0;
  agent.subscribe((e: AgentEvent) => {
    if (e.type === "tool_execution_start") toolStartedAt = Date.now();
  });

  log.script("scenario-start", { desc: "工具 sleep 15 执行中 abort，验证会话非销毁可继续" });
  const runP = agent.prompt("Run this exact command with the bash tool: sleep 15 && echo NEVER_SEE_THIS. Then tell me the output.").catch((err) => log.script("prompt-error", { message: String(err) }));
  for (let i = 0; i < 1200 && !toolStartedAt; i++) await sleep(50);
  await sleep(2000);
  log.script("abort()", { duringToolExec: !!toolStartedAt });
  agent.abort();
  await runP;
  await agent.waitForIdle();
  log.script("after-abort", { isStreaming: agent.state.isStreaming, messages: agent.state.messages.length, errorMessage: agent.state.errorMessage ?? null });

  // abort 后继续对话（会话非销毁的关键证据）
  await agent.prompt("Reply with exactly: STILL_ALIVE");
  await agent.waitForIdle();
  const last = agent.state.messages.at(-1) as any;
  log.script("scenario-end", {
    postAbortReply: JSON.stringify(last?.content ?? null).slice(0, 120),
    conversationContinues: /STILL_ALIVE|alive/i.test(JSON.stringify(last?.content ?? "")),
    finalMessages: agent.state.messages.length,
  });
  await env.cleanup();
}
