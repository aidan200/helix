import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { PiAgentEngineAdapter } from "../../src/adapters/driven/pi-engine/PiAgentEngineAdapter";
import { MainSessionProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { buildModels, resolveConfigModel } from "../../src/adapters/driven/pi-engine/model-provider";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";
import { TOOL_PROMPT_SNIPPETS } from "../../src/adapters/driven/tools/ToolPromptSnippets";
import { FakeBrowserPort } from "../mocks/FakeBrowserPort";
import { kgToolsStub } from "../helpers/kgToolsStub";
import { codegraphToolStub } from "../helpers/codegraphToolStub";
import { taskCreateStub } from "../helpers/taskCreateStub";
import { planToolStub } from "../helpers/planToolStub";
import { createPaths } from "../../src/infrastructure/paths";

/**
 * M6 T2 生效链（组合根接线）：
 * - toggle applied → 重算该 kind 全部活跃 runtime 的 systemPrompt（组装器产物）
 *   + setTools（getEffectiveTools 重 resolve）——FakeLLM 链路捕获（真引擎链，
 *   机械判据 = streamFn 第二参 llmContext 的 systemPrompt / tools 名单）；
 * - toggle skipped（未知名）→ 不触发刷新；
 * - main model 槽位：读面四级链生效（下一装配/新会话），活跃 runtime 不强推
 *   ——实现取舍（见任务 report）；
 * - SubAgent spawn 快照容器级：生产 launcher spawn 时刻读组合根缓存（toggle
 *   后更新），kind 隔离（main toggle 不动 subagent 快照）。
 */

const tmpRoots: string[] = [];

function tmpHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-t2-refresh-"));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** 造 user 层技能（<home>/skills/<name>/SKILL.md）。 */
function installSkill(home: string, name: string, description: string): string {
  const skillDir = path.join(createPaths(home).skillsHome(), name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n正文`,
    "utf8",
  );
  return skillDir;
}

/** 捕获型 FakeLLM 引擎（真适配器 + 真 CoreToolExecutor resolve 注入；编排口桩使 8 工具全注册——镜像生产 engineFor 接线）。 */
function makeCapturingEngine(seen: Array<{ systemPrompt?: string; tools: string[] }>, toolCwd: string): PiAgentEngineAdapter {
  const orchestration = {
    spawn: (task: string) => ({ status: "rejected", error: `测试桩不 spawn：${task}` }) as const,
    send: (agentId: string, message: string) => ({ delivered: false, detail: `测试桩不投递：${agentId} ${message}` }),
    status: () => [],
    kill: (agentId: string) => ({ killed: false, error: `测试桩不 kill：${agentId}` }),
    inspect: () => null,
    park: () => ({ parked: false as const, error: "测试桩不挂起" }),
    resume: () => ({ resumed: false as const, error: "测试桩不恢复" }),
  };
  const streamFn: StreamFn = (model: Model<any>, context) => {
    const ctx = context as unknown as { systemPrompt?: string; tools?: Array<{ name: string }> };
    seen.push({ systemPrompt: ctx.systemPrompt, tools: (ctx.tools ?? []).map((t) => t.name) });
    const stream = createAssistantMessageEventStream();
    const final: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    } as unknown as AssistantMessage;
    void (async () => {
      stream.push({ type: "start", partial: final });
      stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: final });
      stream.push({ type: "done", reason: "stop", message: final });
    })();
    return stream;
  };
  const executor = new CoreToolExecutor({
    cwd: toolCwd,
    orchestration,
    // T3r：MainSessionProfile 声明动态族单 browser 工具——注册桩保持 resolveTools 可装配
    browser: new FakeBrowserPort(),
    // T3.3：main 全集声明 kg 双工具——替身保持可装配
    kg: kgToolsStub(toolCwd),
    // W1-B：main 全集声明 codegraph——替身保持可装配
    codegraph: codegraphToolStub(toolCwd),
    // T2.4：main 全集声明 task_create——替身保持可装配
    taskCreate: taskCreateStub(),
    // main-session plan 批：main 全集声明 plan 三名——替身保持可装配
    plan: planToolStub(),
  });
  return new PiAgentEngineAdapter({
    profile: MainSessionProfile,
    model: resolveConfigModel("anthropic/claude-sonnet-4-5", buildModels()),
    apiKeys: { anthropic: "sk-test" },
    models: buildModels(),
    streamFnOverride: streamFn,
    resolveTools: (names) => executor.resolveTools(names),
  });
}

const MAIN_TOOLS = [
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "web_search",
  "web_fetch",
  "agent_spawn",
  "agent_send",
  "agent_status",
  "agent_inspect", // T3-B
  "agent_park", // ⑤ 链 C：挂起（P1 仅 main）
  "agent_resume", // ⑤ 链 C：恢复（P1 仅 main）
  "browser",
  "kg", // T3.3：kg 双工具
  "kg-update",
  "codegraph", // W1-B（R5/R7）：codegraph 只读工具
  "task_create", // T2.4：chat 第二创建入口（AD-7，仅 main）
  "plan_create", // main-session plan 批：主会话同含 plan 三名（两域同构）
  "plan_update",
  "plan_read",
];
const SUB_TOOLS = ["bash", "read", "write", "edit", "grep", "web_search", "web_fetch", "browser", "kg", "codegraph", "plan_create", "plan_update", "plan_read"]; // H-3：+browser；T3.3：+kg；T1.4：+plan 三工具（AD-6①；main-session plan 批起 Main 同含——两域同构）；W1-B：+codegraph；D8 W-R6：-kg-update（写面收权）

describe("toggle → 活跃 runtime 刷新（FakeLLM 链路捕获，M6 T2 acceptance ③）", () => {
  test("① main tool toggle：下一 run 的 systemPrompt 与 tools 同步收缩；skipped 不刷新", async () => {
    const home = tmpHome();
    const workspace = tmpHome();
    const seen: Array<{ systemPrompt?: string; tools: string[] }> = [];
    const engine = makeCapturingEngine(seen, workspace);
    const daemon = await createTestDaemon({
      home,
      engine,
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
      toolCwd: workspace,
      builtinSkillsDir: tmpHome(), // T5：空目录隔离随仓内置技能（恰等断言不感知 builtin 面）
    });
    try {
      // run 1：注入引擎形态的初始提示 = 测试 profile 常量（瘦身 base，无工具
      // 清单——生产 engineFor 在装配时即读组装快照，注入形态由 toggle 刷新链
      // 推送组装产物，见 run 2）
      await daemon.chat.sendMessage("first");
      expect(seen[0]!.systemPrompt).toContain("主会话助手");
      expect(seen[0]!.systemPrompt).not.toContain("可用工具");
      expect(seen[0]!.tools).toEqual(MAIN_TOOLS);

      // toggle 关 grep → 活跃 runtime 直改（systemPrompt 重算 + tools 重 resolve）
      const outcome = await daemon.resource.toggle("main-session", "tool", "grep", false);
      expect(outcome).toEqual({ status: "applied" });
      await daemon.chat.sendMessage("second");
      expect(seen[1]!.systemPrompt).not.toContain("- grep:");
      expect(seen[1]!.systemPrompt).toContain(`- bash: ${TOOL_PROMPT_SNIPPETS["bash"]!}`);
      expect(seen[1]!.systemPrompt).toContain(`- agent_spawn: ${TOOL_PROMPT_SNIPPETS["agent_spawn"]!}`);
      expect(seen[1]!.systemPrompt).toContain("主会话助手"); // base 段不动
      expect(seen[1]!.systemPrompt).not.toContain("可用技能"); // 无技能目录
      expect(seen[1]!.tools).toEqual(MAIN_TOOLS.filter((t) => t !== "grep")); // 能力+提示双断

      // 未知名 toggle → skipped，不触发刷新（下一 run 提示不变）
      const skipped = await daemon.resource.toggle("main-session", "tool", "no-such-tool", false);
      expect(skipped).toEqual({ status: "skipped", reason: "unknown-name" });
      await daemon.chat.sendMessage("third");
      expect(seen[2]!.systemPrompt).toBe(seen[1]!.systemPrompt);
      expect(seen[2]!.tools).toEqual(seen[1]!.tools);
    } finally {
      await daemon.shutdown();
    }
  });

  test("② skill toggle：技能段随生效集出现/消失（引导语 + name 子块）", async () => {
    const home = tmpHome();
    const workspace = tmpHome();
    installSkill(home, "hello-skill", "组合根验证技能");
    const seen: Array<{ systemPrompt?: string; tools: string[] }> = [];
    const engine = makeCapturingEngine(seen, workspace);
    const daemon = await createTestDaemon({
      home,
      engine,
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
      toolCwd: workspace,
      builtinSkillsDir: tmpHome(), // T5：空目录隔离随仓内置技能（恰等断言不感知 builtin 面）
    });
    try {
      // run 1：注入引擎形态初始 = base 常量（无段落）
      await daemon.chat.sendMessage("first");
      expect(seen[0]!.systemPrompt).not.toContain("可用技能");

      // 关技能 → 刷新推送组装产物：技能段整体省略，工具段在（工具 toggle 不涉）
      await daemon.resource.toggle("main-session", "skill", "hello-skill", false);
      await daemon.chat.sendMessage("second");
      expect(seen[1]!.systemPrompt).not.toContain("可用技能");
      expect(seen[1]!.systemPrompt).not.toContain("hello-skill");
      expect(seen[1]!.systemPrompt).toContain("可用工具"); // 工具段不受技能 toggle 影响

      // 重开 → 技能段恢复（引导语 + name 子块）
      await daemon.resource.toggle("main-session", "skill", "hello-skill", true);
      await daemon.chat.sendMessage("third");
      expect(seen[2]!.systemPrompt).toContain("可用技能");
      expect(seen[2]!.systemPrompt).toContain("- name: hello-skill");
      expect(seen[2]!.systemPrompt).toMatch(/全文/); // 引导语在
    } finally {
      await daemon.shutdown();
    }
  });

  test("③ kind 隔离：subagent toggle 不推 main runtime（main 提示不变）", async () => {
    const home = tmpHome();
    const workspace = tmpHome();
    const seen: Array<{ systemPrompt?: string; tools: string[] }> = [];
    const engine = makeCapturingEngine(seen, workspace);
    const daemon = await createTestDaemon({
      home,
      engine,
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
      toolCwd: workspace,
      builtinSkillsDir: tmpHome(), // T5：空目录隔离随仓内置技能（恰等断言不感知 builtin 面）
    });
    try {
      await daemon.chat.sendMessage("first");
      await daemon.resource.toggle("subagent-worker", "tool", "grep", false);
      await daemon.chat.sendMessage("second");
      // main 会话不受 subagent kind 变更影响：toggle 前后两 run 提示逐字相同
      expect(seen[1]!.systemPrompt).toBe(seen[0]!.systemPrompt);
      expect(seen[1]!.tools).toEqual(MAIN_TOOLS);
    } finally {
      await daemon.shutdown();
    }
  });
});

describe("main model 槽位：读面生效 + 活跃 runtime 不强推（M6 T2 实现取舍）", () => {
  test("④ setModel(main) → 当前会话模型不动（不强推）；重启后新会话读槽位（下一装配生效）", async () => {
    const home = tmpHome();
    const workspace = tmpHome();
    const daemon1 = await createTestDaemon({
      home,
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
      toolCwd: workspace,
      builtinSkillsDir: tmpHome(), // T5：空目录隔离随仓内置技能（恰等断言不感知 builtin 面）
    });
    try {
      const sid = daemon1.registry.currentSessionId();
      expect(daemon1.registry.peek(sid)!.chatService.currentModel).toBe("anthropic/claude-sonnet-4-5");
      await daemon1.resource.setModel("main-session", "anthropic/claude-haiku-4-5");
      // 活跃 runtime 不强推：currentModel 观测值不变（下一装配/新会话生效）
      expect(daemon1.registry.peek(sid)!.chatService.currentModel).toBe("anthropic/claude-sonnet-4-5");
    } finally {
      await daemon1.shutdown();
    }

    // 重启同 home：新会话装配读槽位（四级链：per-session 覆盖 > kind 槽位 > default_model）
    const daemon2 = await createTestDaemon({
      home,
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
      toolCwd: workspace,
      builtinSkillsDir: tmpHome(), // T5：空目录隔离随仓内置技能（恰等断言不感知 builtin 面）
    });
    try {
      const sid2 = daemon2.registry.currentSessionId();
      expect(daemon2.registry.peek(sid2)!.chatService.currentModel).toBe("anthropic/claude-haiku-4-5");
    } finally {
      await daemon2.shutdown();
    }
  });
});

describe("SubAgent spawn 快照容器级（生产 launcher，M6 T2 acceptance ④）", () => {
  test("⑤ spawn 时刻读组合根缓存；subagent toggle 后新 spawn 跟随；main toggle 不动 subagent 快照", async () => {
    const home = tmpHome();
    const workspace = tmpHome();
    installSkill(home, "hello-skill", "容器级快照技能");
    const daemon = await createTestDaemon({
      home,
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
      toolCwd: workspace,
      builtinSkillsDir: tmpHome(), // T5：空目录隔离随仓内置技能（恰等断言不感知 builtin 面）
    });
    const real = Bun.spawn;
    const calls: Array<{ env: Record<string, string | undefined> }> = [];
    (Bun as unknown as { spawn: unknown }).spawn = (opts: {
      cmd: readonly string[];
      env: Record<string, string | undefined>;
    }) => {
      calls.push({ env: { ...opts.env } });
      return {
        pid: 42000 + Math.floor(Math.random() * 900),
        exited: Promise.resolve(0),
        stdout: (async function* () {})(),
        stdin: { write: () => true },
      } as unknown as ReturnType<typeof Bun.spawn>;
    };
    try {
      // spawn #1：subagent 生效集默认全集 + 技能段
      daemon.orchestration.spawn("任务一");
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0]!.env["HELIX_TOOLS_JSON"]!)).toEqual(SUB_TOOLS);
      expect(calls[0]!.env["HELIX_SYSTEM_PROMPT"]).toContain("- name: hello-skill");
      expect(calls[0]!.env["HELIX_SYSTEM_PROMPT"]).toContain("SubAgent worker");

      // subagent kind toggle 关 grep → 新 spawn 代际生效
      await daemon.resource.toggle("subagent-worker", "tool", "grep", false);
      daemon.orchestration.spawn("任务二");
      expect(JSON.parse(calls[1]!.env["HELIX_TOOLS_JSON"]!)).toEqual(SUB_TOOLS.filter((t) => t !== "grep"));

      // main kind toggle 不动 subagent 快照（kind 隔离；已 spawn 实例 env 已定格）
      await daemon.resource.toggle("main-session", "tool", "grep", false);
      daemon.orchestration.spawn("任务三");
      expect(JSON.parse(calls[2]!.env["HELIX_TOOLS_JSON"]!)).toEqual(SUB_TOOLS.filter((t) => t !== "grep"));
      expect(calls[2]!.env["HELIX_SYSTEM_PROMPT"]).toBe(calls[1]!.env["HELIX_SYSTEM_PROMPT"]);
      // 定格面：spawn #1 的 env 历史值不受后续任何 toggle 影响
      expect(JSON.parse(calls[0]!.env["HELIX_TOOLS_JSON"]!)).toEqual(SUB_TOOLS);
    } finally {
      (Bun as unknown as { spawn: unknown }).spawn = real;
      await daemon.shutdown();
    }
  });
});
