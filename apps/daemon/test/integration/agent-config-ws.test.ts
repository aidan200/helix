import { afterAll, describe, expect, test } from "bun:test";
import { TOOL_PROMPT_SNIPPETS } from "../../src/adapters/driven/tools/ToolPromptSnippets";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import {
  ANY_MODEL,
  MAIN_TOOLS,
  ORCH_TOOLS,
  SUB_TOOLS,
  cleanupAgentConfigTmp,
  helloHandshake,
  makeRig,
  TestClient,
  tmpHome,
  until,
  type ProfileBlock,
  type Rig,
} from "../helpers/agent-config-rig";

/**
 * M6 T3 agent.config 命令族全链集成（真组合根 + FakeAgentEngine + 真 SQLite
 * + loopback WS；模型目录走 builtin 读面零网络——hasModel 不触远端）：
 * - ① agent.config.list 全 kind / 单 kind → 结果帧数据（tools 全集+启停态；
 *   skills 含 source；diagnostics 坏文件上抛；model 槽位 null 形态）；
 * - ② agent.config.set_enabled 四路径：applied（含 agent.config.changed 广播
 *   发出断言）/ unknown-name skipped / model unknown-model skipped /
 *   model clear（changed name=null）；
 * - ③ 前置校验失败（非法 kind / 缺字段）→ connection.error invalid_payload。
 */

afterAll(() => {
  cleanupAgentConfigTmp();
});

describe("agent.config.list（v0.6 全局命令；点对点结果帧）", () => {
  test("① 全 kind：双块（tools 全集+启停态；skills 含 source；diagnostics 坏文件上抛；model null）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);
      await client.expect("session.snapshot");

      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: {} });
      const result = await client.expect("agent.config.list.result");
      expect(result.v).toBe(PROTOCOL_VERSION);
      expect(result.channel).toBe("agent");
      expect(result.sessionId).toBe(SYSTEM_SESSION_ID); // 全局命令：会话无关
      const profiles = result.payload.profiles as ProfileBlock[];
      expect(profiles).toHaveLength(2); // profiles 双块（main/sub——task-worker 已撤，任务派生 worker 回归 chat 同 kind）
      const [main, sub] = profiles;
      expect(main!.profileKind).toBe("main-session");
      expect(main!.tools.map((t) => t.name)).toEqual(MAIN_TOOLS);
      expect(main!.tools.every((t) => t.enabled)).toBe(true); // 工具缺省无记录 = 全启用
      // tools 行 snippet 一句话说明（ToolPromptSnippets 注册表同源；M6 T4 补登）
      const bashRow = main!.tools.find((t) => t.name === "bash")!;
      expect(bashRow.snippet).toBe(TOOL_PROMPT_SNIPPETS["bash"]!);
      expect(main!.tools.every((t) => t.snippet.length > 0)).toBe(true);
      expect(main!.skills).toEqual([
        {
          name: "hello-skill",
          description: "问候技能",
          filePath: expect.stringContaining("hello-skill"),
          source: "user",
          audience: "agent",
          enabled: false, // 统一启停批：user 技能显式启用制（无行 = 禁用）
        },
      ]);
      expect(main!.diagnostics).toEqual([
        {
          code: expect.stringContaining("metadata"),
          message: expect.any(String),
          path: expect.stringContaining("broken-skill"),
          source: "user",
        },
      ]);
      expect(main!.model).toBeNull(); // 槽位未设 = null（非 undefined——JSON 面）
      expect(sub!.profileKind).toBe("subagent-worker");
      expect(sub!.tools.map((t) => t.name)).toEqual(SUB_TOOLS);
      expect(sub!.model).toBeNull();
      // 任务 SOP 不进 agent 卡技能列表（audience 目录二分——编排归位批）
      expect(main!.skills.every((s) => s.audience === "agent")).toBe(true);
      expect(sub!.skills.every((s) => s.audience === "agent")).toBe(true);
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("② 单 kind：payload.profileKind 过滤 → 单块", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.list",
        payload: { profileKind: "subagent-worker" },
      });
      const result = await client.expect("agent.config.list.result");
      const profiles = result.payload.profiles as ProfileBlock[];
      expect(profiles).toHaveLength(1);
      expect(profiles[0]!.profileKind).toBe("subagent-worker");
      expect(profiles[0]!.tools.map((t) => t.name)).toEqual(SUB_TOOLS);
      // 单 kind 过滤请求不携带 system（agent-roster 批：可选块零变化面）
      expect(result.payload.system).toBeUndefined();
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  // ── agent-roster 批：只读系统派生块读面 ──
  interface SystemBlock {
    profileKind: string;
    tools: { name: string; snippet: string; enabled: boolean }[];
    // 终态：行透传带 enabled 位（builtin 播种开/user 关/task 恒 false）
    skills?: { name: string; description: string; filePath: string; source: string; audience: string; enabled: boolean }[];
    mcpServers?: { name: string; enabled: boolean; state: string; toolCount?: number }[];
    pinnedTools?: string[];
  }

  test("②a 全量 list 携带 system 三块（终态：行透传自身 kind 清单带 enabled 位，写面只读）：orchestrator/kg-writer/reviewer 各自独立装配，不从 worker 派生", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: {} });
      const result = await client.expect("agent.config.list.result");
      const system = result.payload.system as SystemBlock[];
      expect(system).toHaveLength(3); // orchestrator + 派生两块
      // 序固定：orchestrator 在前、kg-writer 次之、reviewer 在后
      const [orch, kgw, reviewer] = system;
      // orchestrator：自身清单透传（tools 行带 enabled 位——静态缺省开）+
      // 槽位 null；无派生说明位
      expect(orch!.profileKind).toBe("orchestrator");
      expect(orch!.tools.length).toBeGreaterThan(0);
      expect(orch!.tools.every((t) => t.enabled === true)).toBe(true); // 行带 enabled 位（透传同构）
      // 技能区 = 自身清单（user 层 hello-skill 在列，显式启用制 enabled=false）
      expect(orch!.skills!.map((s) => s.name)).toEqual(["hello-skill"]);
      expect(orch!.skills!.every((s) => s.enabled === false)).toBe(true);
      // kg-writer：自身 catalog 透传（声明全集含 kg-update）+ pinned 徽标面
      expect(kgw!.profileKind).toBe("subagent-kg-writer");
      expect(kgw!.pinnedTools).toEqual(["kg-update"]);
      expect(kgw!.tools.map((t) => t.name)).toEqual([...SUB_TOOLS.filter((n) => n !== "edit-lines"), "kg-update"]); // F4 接通批：edit-lines 不渗入 kg-writer
      expect(kgw!.tools.every((t) => t.enabled === true)).toBe(true); // 自身差异行缺省开
      // kg-update snippet 注册表同源（main 目录面同名行单源取回）
      const kgUpdate = kgw!.tools.find((t) => t.name === "kg-update")!;
      expect(kgUpdate.snippet).toContain("知识图谱即时落账");
      // D5 reviewer：自身 catalog 透传（声明面已减 write/edit）
      expect(reviewer!.profileKind).toBe("subagent-code-reviewer");
      expect(reviewer!.tools.map((t) => t.name)).toEqual(SUB_TOOLS.filter((n) => n !== "write" && n !== "edit" && n !== "edit-lines"));
      expect(reviewer!.tools.map((t) => t.name)).not.toContain("kg-update");
      expect(reviewer!.tools.every((t) => t.enabled === true)).toBe(true);
      // 派生块技能行 = 自身 kind 清单（含 enabled 位，透传同构；makeRig 空
      // builtin → 无播种面，user 层 hello-skill 显式启用制默认 false）
      const kgwSkills = kgw!.skills ?? [];
      expect(kgwSkills.map((s) => s.name)).toContain("hello-skill");
      expect(kgwSkills.every((s) => s.enabled === false)).toBe(true);
      expect(reviewer!.skills ?? []).toEqual(kgwSkills);
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  // ── 系统派生块技能读面批：三块技能清单派生语义 ──

  /** builtin 目录播种 rig：task 层 SOP + agent 层两技能（成套声明分叉）。 */
  async function makeSeededRig(): Promise<Rig> {
    const home = tmpHome();
    const workspace = tmpHome();
    const builtinDir = tmpHome();
    const mk = (rel: string, frontmatter: string) => {
      const dir = path.join(builtinDir, rel);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "SKILL.md"), `${frontmatter}\n\n正文`, "utf8");
    };
    // task 层：audience=task（kickoff 消费面）
    mk(
      "task/demo-review",
      "---\nname: demo-review\ndescription: 演示任务 SOP\ntask:\n  paramsSchema:\n    projectRoot: { type: string, required: true }\n---",
    );
    // agent 层：无成套声明（恒列）+ 成套声明 plan_create（worker 持有 → 列出）
    mk("agent/plain-skill", "---\nname: plain-skill\ndescription: 无成套声明技能\n---");
    mk("agent/paired-skill", "---\nname: paired-skill\ndescription: 成套声明技能\ntools: [plan_create]\n---");
    const engine = new FakeAgentEngine({});
    const daemon = await createTestDaemon({
      home,
      engine,
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
      toolCwd: workspace,
      builtinSkillsDir: builtinDir,
    });
    const token = readFileSync(path.join(home, "dev-token"), "utf8");
    return {
      home,
      daemon,
      token,
      url: `ws://127.0.0.1:${daemon.ws.port}`,
      dispose: async () => {
        await daemon.shutdown();
        rmSync(home, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
      },
    };
  }

  test("②c 技能读面（终态）：agent 卡仅 agent 受众；builtin 播种五 kind 全开（含系统三块）；系统块技能 = 自身清单带 enabled 位；独立配置不随 worker toggle 联动", async () => {
    const rig = await makeSeededRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: {} });
      const result = await client.expect("agent.config.list.result");
      // profiles 双块（task-worker 已撤）：技能行仅 agent 受众（任务 SOP 不进 agent 卡——目录二分）
      const profiles = result.payload.profiles as ProfileBlock[];
      expect(profiles).toHaveLength(2);
      for (const p of profiles) {
        expect(p.skills.find((s) => s.name === "demo-review")).toBeUndefined();
        expect(p.skills.every((s) => s.audience === "agent")).toBe(true);
      }
      // builtin 播种（可写 kind）：agent 层 enabled=true；task 层不播
      expect(profiles[0]!.skills.find((s) => s.name === "plain-skill")?.enabled).toBe(true);
      const system = result.payload.system as SystemBlock[];
      // orchestrator 块：自身清单透传（agent 受众技能 + enabled 位——播种五
      // kind 全开；task 层不在 agent kind 可见面）
      const orch = system.find((b) => b.profileKind === "orchestrator")!;
      // orchestrator 可见面 = agent + task 受众（demo-review 任务 SOP 在列，
      // 不播种 enabled=false；agent 层 builtin 播种开）
      expect(orch.skills!.find((s) => s.name === "demo-review")?.audience).toBe("task");
      expect(orch.skills!.find((s) => s.name === "demo-review")?.enabled).toBe(false);
      expect(orch.skills!.find((s) => s.name === "plain-skill")?.enabled).toBe(true);
      const kgw = system.find((b) => b.profileKind === "subagent-kg-writer")!;
      // 终态：kg-writer/reviewer = 自身清单（含 enabled 位；builtin 播种全开）
      expect(kgw.skills?.map((s) => s.name).sort()).toEqual(["paired-skill", "plain-skill"]);
      expect(kgw.skills!.every((s) => s.enabled === true)).toBe(true);

      // 禁用 worker 的 plan_create（成套工具）→ 重 list：系统块独立配置不联动
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-worker", resourceType: "tool", name: "plan_create", enabled: false },
      });
      await client.expect("agent.config.set_enabled.result");
      const at = client.frames.length; // 区分新旧同型帧：重拉后的新 list 帧
      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: {} });
      const after = await client.expectAfter("agent.config.list.result", at);
      const systemAfter = after.payload.system as SystemBlock[];
      const kgwAfter = systemAfter.find((b) => b.profileKind === "subagent-kg-writer")!;
      // 独立配置终态：worker toggle 不影响 kg-writer 清单与启停位（差异行隔离）
      expect(kgwAfter.skills?.map((s) => s.name).sort()).toEqual(["paired-skill", "plain-skill"]);
      expect(kgwAfter.skills!.every((s) => s.enabled === true)).toBe(true);
      // kind 隔离：orchestrator 块不受 worker toggle 影响
      const orchAfter = systemAfter.find((b) => b.profileKind === "orchestrator")!;
      expect(orchAfter.tools.length).toBe(orch.tools.length);
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("②b 独立配置终态：禁用 worker 工具 → 系统三块工具清单不受影响（差异行隔离，不再派生联动）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      // 禁用 worker 的 grep（agent.config.changed 全局广播不阻塞回执序）
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-worker", resourceType: "tool", name: "grep", enabled: false },
      });
      await client.expect("agent.config.set_enabled.result");
      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: {} });
      const result = await client.expect("agent.config.list.result");
      const system = result.payload.system as SystemBlock[];
      // 终态：kg-writer 读自身差异行（无禁用记录 → 全量 enabled=true），
      // 不随 worker toggle 收窄
      const kgw = system.find((b) => b.profileKind === "subagent-kg-writer")!;
      expect(kgw.tools.map((t) => t.name)).toEqual([...SUB_TOOLS.filter((n) => n !== "edit-lines"), "kg-update"]); // F4 接通批：edit-lines 不渗入 kg-writer
      expect(kgw.tools.every((t) => t.enabled === true)).toBe(true);
      // kind 隔离：orchestrator 同样不受 worker toggle 影响
      const orch = system.find((b) => b.profileKind === "orchestrator")!;
      expect(orch.tools.some((t) => t.name === "grep")).toBe(true);
      // D5 reviewer：独立全量（write/edit 声明面已减）
      const reviewer = system.find((b) => b.profileKind === "subagent-code-reviewer")!;
      expect(reviewer.tools.map((t) => t.name)).toEqual(SUB_TOOLS.filter((n) => n !== "write" && n !== "edit" && n !== "edit-lines"));
      expect(reviewer.tools.some((t) => t.name === "grep")).toBe(true);
    } finally {
      await client.close();
      await rig.dispose();
    }
  });
});

describe("agent.config.set_enabled（v0.6 全局命令；四路径回执形态）", () => {
  test("③ applied：tool 禁用 → 结果帧 applied + agent.config.changed 广播 + 落库生效", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "main-session", resourceType: "tool", name: "grep", enabled: false },
      });
      const applied = await client.expect("agent.config.set_enabled.result");
      expect(applied.payload).toEqual({ status: "applied" });
      // applied → 广播发出（发起连接同收：daemon 级全局配置，订阅无关全连接）
      const changed = await client.expectAfter("agent.config.changed", client.frames.indexOf(applied));
      expect(changed.channel).toBe("agent");
      expect(changed.sessionId).toBe(SYSTEM_SESSION_ID);
      expect(changed.payload).toEqual({
        profileKind: "main-session",
        resourceType: "tool",
        name: "grep",
        enabled: false,
      });
      // 落库生效（合取面收窄；T2 刷新链既有测试面，此处只验数据域）
      expect(rig.daemon.resource.getEffectiveTools("main-session").includes("grep")).toBe(false);
      expect(rig.daemon.resource.getEffectiveTools("subagent-worker").includes("grep")).toBe(true);
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("④ unknown-name skipped：全集外名（subagent 禁 agent_spawn）→ skipped 回执 + 零广播零落库", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-worker", resourceType: "tool", name: "agent_spawn", enabled: false },
      });
      const skipped = await client.expect("agent.config.set_enabled.result");
      expect(skipped.payload).toEqual({ status: "skipped", reason: "unknown-name" });
      await new Promise((r) => setTimeout(r, 150));
      expect(client.frames.filter((f) => f.type === "agent.config.changed")).toHaveLength(0); // skipped 零广播
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("⑤ model unknown-model skipped：目录外模型 → skipped 回执 + 零广播（ModelService.setModel 先例）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "main-session", resourceType: "model", name: "nope/no-such-model", enabled: true },
      });
      const skipped = await client.expect("agent.config.set_enabled.result");
      expect(skipped.payload).toEqual({ status: "skipped", reason: "unknown-model" });
      await new Promise((r) => setTimeout(r, 150));
      expect(client.frames.filter((f) => f.type === "agent.config.changed")).toHaveLength(0);
      expect(rig.daemon.resource.modelSlot("main-session")).toBeUndefined(); // 未落库
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("⑥⑦ model set/clear：set → applied+changed(name=id)；clear → applied+changed(name=null)；list 槽位往返", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      // set 槽位
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-worker", resourceType: "model", name: ANY_MODEL, enabled: true },
      });
      const set = await client.expect("agent.config.set_enabled.result");
      expect(set.payload).toEqual({ status: "applied" });
      const changedSet = await client.expectAfter("agent.config.changed", client.frames.indexOf(set));
      expect(changedSet.payload).toEqual({
        profileKind: "subagent-worker",
        resourceType: "model",
        name: ANY_MODEL,
        enabled: true,
      });
      expect(rig.daemon.resource.modelSlot("subagent-worker")).toBe(ANY_MODEL);

      // clear 槽位
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-worker", resourceType: "model", name: "-", enabled: false },
      });
      const clear = await client.expectAfter("agent.config.set_enabled.result", client.frames.indexOf(changedSet));
      expect(clear.payload).toEqual({ status: "applied" });
      const changedClear = await client.expectAfter("agent.config.changed", client.frames.indexOf(clear));
      expect(changedClear.payload).toEqual({
        profileKind: "subagent-worker",
        resourceType: "model",
        name: null, // clear = name null
        enabled: false,
      });
      expect(rig.daemon.resource.modelSlot("subagent-worker")).toBeUndefined();

      // list 槽位现状随写面往返（set → 读回 → clear → null）
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "main-session", resourceType: "model", name: ANY_MODEL, enabled: true },
      });
      await client.expectAfter("agent.config.set_enabled.result", client.frames.indexOf(changedClear));
      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: { profileKind: "main-session" } });
      const list1 = await client.expectAfter("agent.config.list.result", client.frames.length - 1);
      expect((list1.payload.profiles as ProfileBlock[])[0]!.model).toBe(ANY_MODEL);
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "main-session", resourceType: "model", name: "-", enabled: false },
      });
      await client.expectAfter("agent.config.set_enabled.result", client.frames.length - 1);
      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: { profileKind: "main-session" } });
      const list2 = await client.expectAfter("agent.config.list.result", client.frames.length - 1);
      expect((list2.payload.profiles as ProfileBlock[])[0]!.model).toBeNull();
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("⑧ skill applied：已装技能启停 → applied + changed(resourceType=skill)", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "main-session", resourceType: "skill", name: "hello-skill", enabled: false },
      });
      const applied = await client.expect("agent.config.set_enabled.result");
      expect(applied.payload).toEqual({ status: "applied" });
      const changed = await client.expectAfter("agent.config.changed", client.frames.indexOf(applied));
      expect(changed.payload).toEqual({
        profileKind: "main-session",
        resourceType: "skill",
        name: "hello-skill",
        enabled: false,
      });
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  // T1.3（thinking 批 AD-6 配置资源扩维）：thinking 槽位型 set/clear 全链——
  // 零前置校验（helix 不做档位校验，SoT 在 pi-ai）+ changed 广播 + list 块往返。
  test("⑫ thinking set/clear：applied + changed(resourceType=thinking) + list 块 thinkingLevel 往返；kind 隔离", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      // 未配置 = null（读面钉死 null 非 undefined）
      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: { profileKind: "subagent-worker" } });
      const list0 = await client.expect("agent.config.list.result");
      expect((list0.payload.profiles as ProfileBlock[])[0]!.thinkingLevel).toBeNull();

      // set 槽位（无目录校验面——任意档位字符串透传）
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-worker", resourceType: "thinking", name: "xhigh", enabled: true },
      });
      const set = await client.expectAfter("agent.config.set_enabled.result", client.frames.indexOf(list0));
      expect(set.payload).toEqual({ status: "applied" });
      const changedSet = await client.expectAfter("agent.config.changed", client.frames.indexOf(set));
      expect(changedSet.payload).toEqual({
        profileKind: "subagent-worker",
        resourceType: "thinking",
        name: "xhigh",
        enabled: true,
      });
      expect(rig.daemon.resource.thinkingSlot("subagent-worker")).toBe("xhigh");
      // kind 隔离：main-session 不传染
      expect(rig.daemon.resource.thinkingSlot("main-session")).toBeUndefined();

      // clear 槽位
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-worker", resourceType: "thinking", name: "-", enabled: false },
      });
      const clear = await client.expectAfter("agent.config.set_enabled.result", client.frames.indexOf(changedSet));
      expect(clear.payload).toEqual({ status: "applied" });
      const changedClear = await client.expectAfter("agent.config.changed", client.frames.indexOf(clear));
      expect(changedClear.payload).toEqual({
        profileKind: "subagent-worker",
        resourceType: "thinking",
        name: null,
        enabled: false,
      });
      expect(rig.daemon.resource.thinkingSlot("subagent-worker")).toBeUndefined();

      // list 块随写面往返
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-worker", resourceType: "thinking", name: "low", enabled: true },
      });
      await client.expectAfter("agent.config.set_enabled.result", client.frames.indexOf(changedClear));
      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: { profileKind: "subagent-worker" } });
      const list1 = await client.expectAfter("agent.config.list.result", client.frames.length - 1);
      expect((list1.payload.profiles as ProfileBlock[])[0]!.thinkingLevel).toBe("low");
    } finally {
      await client.close();
      await rig.dispose();
    }
  });
});

describe("agent.config 前置校验（payload 形状）", () => {
  test("⑨ 非法 kind / 缺字段 → connection.error{command.invalid_payload}（连接保持）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "global", resourceType: "tool", name: "grep", enabled: false },
      });
      await client.waitForInvalidPayload("agent.config.set_enabled");

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "main-session", resourceType: "hook", name: "steer", enabled: true },
      });
      await client.waitForInvalidPayload("agent.config.set_enabled");

      client.send({ v: PROTOCOL_VERSION, type: "agent.config.set_enabled", payload: { profileKind: "main-session" } });
      await client.waitForInvalidPayload("agent.config.set_enabled");

      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: { profileKind: "bogus" } });
      await client.waitForInvalidPayload("agent.config.list");

      // 编排归位批：orchestrator 归位系统只读 kind——tool/skill/mcp-server
      // 启停写面拒绝（read_only）；model/thinking 槽位型放行（独立配置）
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "orchestrator", resourceType: "tool", name: "grep", enabled: false },
      });
      await until(
        () => client.frames.some((f) => f.type === "connection.error" && f.payload.code === "agent.config.read_only"),
        3000,
        "等待 read_only 拒绝（orchestrator tool）",
      );
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "orchestrator", resourceType: "model", name: "-", enabled: false },
      });
      {
        const applied = await client.expect("agent.config.set_enabled.result");
        expect(applied.payload.status).toBe("applied");
      }
      // R7 系统槽位批：kg-writer 的 model/thinking 槽位可写（独立配置）；
      // tool/skill 启停仍拒。此处 clear model 槽位 → applied 回执（不再 read_only）。
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-kg-writer", resourceType: "model", name: "-", enabled: false },
      });
      await client.expect("agent.config.set_enabled.result");
      // kg-writer tool 启停仍拒（read_only）
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-kg-writer", resourceType: "tool", name: "grep", enabled: false },
      });
      {
        const at = client.frames.length;
        await until(
          () => client.frames.slice(at).some((f) => f.type === "connection.error" && f.payload.code === "agent.config.read_only"),
          3000,
          "等待 read_only 拒绝（kg-writer tool）",
        );
      }
      // D5 reviewer 同例：model 槽位可写（独立配置），tool 启停仍拒（read_only）
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-code-reviewer", resourceType: "model", name: "-", enabled: false },
      });
      await client.expect("agent.config.set_enabled.result");
      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.config.set_enabled",
        payload: { profileKind: "subagent-code-reviewer", resourceType: "tool", name: "grep", enabled: false },
      });
      {
        const at = client.frames.length;
        await until(
          () => client.frames.slice(at).some((f) => f.type === "connection.error" && f.payload.code === "agent.config.read_only"),
          3000,
          "等待 read_only 拒绝（reviewer tool）",
        );
      }
      // 连接保持 + 零落库（只读 kind 无用户可写面）
      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: { profileKind: "main-session" } });
      await client.expect("agent.config.list.result");
      expect(rig.daemon.resource.getEffectiveTools("subagent-worker").includes("grep")).toBe(true);
    } finally {
      await client.close();
      await rig.dispose();
    }
  });
});

