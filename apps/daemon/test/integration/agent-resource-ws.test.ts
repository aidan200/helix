import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import { createPaths } from "../../src/infrastructure/paths";
import {
  cleanupAgentConfigTmp,
  helloHandshake,
  makeRig,
  TestClient,
} from "../helpers/agent-config-rig";

/**
 * agent 资源命令族全链集成（体量治理拆分自 agent-config-ws.test.ts）：
 * - agent.base_prompt.get：base 段系统提示词懒查询读面（五 kind 全可读）；
 * - agent.skill_content.get：skill 正文懒查询读面（全文含 frontmatter）；
 * - agent.skill.create：用户级技能创建写面（applied + 落盘 + list 重拉可见）。
 */

afterAll(() => {
  cleanupAgentConfigTmp();
});

describe("agent.base_prompt.get（base prompt 批：base 段系统提示词懒查询读面）", () => {
  test("⑬ 五 kind 全可读：点对点回执 basePrompt = profile 静态声明单源（kg-writer 含图谱产出型后缀 / reviewer 含评审纪律后缀）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      const kinds = ["main-session", "subagent-worker", "orchestrator", "subagent-kg-writer", "subagent-code-reviewer"] as const;
      for (const kind of kinds) {
        const at = client.frames.length;
        client.send({ v: PROTOCOL_VERSION, type: "agent.base_prompt.get", payload: { profileKind: kind } });
        const result = await client.expectAfter("agent.base_prompt.get.result", at);
        expect(result.v).toBe(PROTOCOL_VERSION);
        expect(result.channel).toBe("agent");
        expect(result.sessionId).toBe(SYSTEM_SESSION_ID); // 全局命令：会话无关
        expect(result.payload.profileKind).toBe(kind);
        expect(typeof result.payload.basePrompt).toBe("string");
        expect((result.payload.basePrompt as string).length).toBeGreaterThan(0);
      }
      // 内容锚点：profile 声明单源（主会话角色段 / kg-writer 图谱产出型后缀）
      const at = client.frames.length;
      client.send({ v: PROTOCOL_VERSION, type: "agent.base_prompt.get", payload: { profileKind: "main-session" } });
      const main = await client.expectAfter("agent.base_prompt.get.result", at);
      expect(main.payload.basePrompt).toContain("helix");
      const at2 = client.frames.length;
      client.send({ v: PROTOCOL_VERSION, type: "agent.base_prompt.get", payload: { profileKind: "subagent-kg-writer" } });
      const kgw = await client.expectAfter("agent.base_prompt.get.result", at2);
      expect(kgw.payload.basePrompt).toContain("图谱产出型");
      // D5 reviewer：通用 worker base + 评审纪律后缀（只读评审）
      const at3 = client.frames.length;
      client.send({ v: PROTOCOL_VERSION, type: "agent.base_prompt.get", payload: { profileKind: "subagent-code-reviewer" } });
      const reviewer = await client.expectAfter("agent.base_prompt.get.result", at3);
      expect(reviewer.payload.basePrompt).toContain("只读");
      expect(reviewer.payload.basePrompt).toContain("禁止修改项目代码");
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("⑭ 非法 kind → connection.error{command.invalid_payload}（连接保持——后续命令仍可通）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({ v: PROTOCOL_VERSION, type: "agent.base_prompt.get", payload: { profileKind: "bogus" } });
      await client.waitForInvalidPayload("agent.base_prompt.get");
      client.send({ v: PROTOCOL_VERSION, type: "agent.base_prompt.get", payload: {} });
      await client.waitForInvalidPayload("agent.base_prompt.get");
      // 连接保持
      client.send({ v: PROTOCOL_VERSION, type: "agent.base_prompt.get", payload: { profileKind: "orchestrator" } });
      const ok = await client.expect("agent.base_prompt.get.result");
      expect(ok.payload.profileKind).toBe("orchestrator");
    } finally {
      await client.close();
      await rig.dispose();
    }
  });
});

describe("agent.skill_content.get（skill-content 批：skill 正文懒查询读面）", () => {
  test("① 已装技能 → 点对点回执 name/filePath/content 全文（user 层 hello-skill）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);
      await client.expect("session.snapshot");

      client.send({ v: PROTOCOL_VERSION, type: "agent.skill_content.get", payload: { name: "hello-skill" } });
      const result = await client.expect("agent.skill_content.get.result");
      expect(result.channel).toBe("agent");
      const p = result.payload as { name: string; filePath: string; content: string };
      expect(p.name).toBe("hello-skill"); // 请求回显——多行并发展开定向归位
      expect(p.filePath).toContain("hello-skill");
      expect(p.content).toContain("name: hello-skill"); // 全文含 frontmatter（事实源原文）
      expect(p.content).toContain("正文");
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("② 未知技能名 / 缺 name → connection.error{command.invalid_payload}（连接保持——后续命令仍可通）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);

      client.send({ v: PROTOCOL_VERSION, type: "agent.skill_content.get", payload: { name: "no-such-skill" } });
      await client.waitForInvalidPayload("agent.skill_content.get");
      client.send({ v: PROTOCOL_VERSION, type: "agent.skill_content.get", payload: {} });
      await client.waitForInvalidPayload("agent.skill_content.get");
      // 连接保持
      client.send({ v: PROTOCOL_VERSION, type: "agent.skill_content.get", payload: { name: "hello-skill" } });
      const ok = await client.expect("agent.skill_content.get.result");
      expect(ok.payload.name).toBe("hello-skill");
    } finally {
      await client.close();
      await rig.dispose();
    }
  });
});

describe("agent.skill.create（skills 添加批：用户级技能创建写面）", () => {
  test("① 合法全文 → applied{name} + 落盘 <skillsHome>/<name>/SKILL.md + list 重拉可见", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);
      await client.expect("session.snapshot");

      client.send({
        v: PROTOCOL_VERSION,
        type: "agent.skill.create",
        payload: { content: "---\nname: imported-skill\ndescription: 导入技能\n---\n\n## 正文\n" },
      });
      const result = await client.expect("agent.skill.create.result");
      expect(result.channel).toBe("agent");
      expect(result.payload).toEqual({ status: "applied", name: "imported-skill" });
      // 落盘事实（原文含 frontmatter）
      const written = readFileSync(path.join(createPaths(rig.home).skillsHome(), "imported-skill", "SKILL.md"), "utf8");
      expect(written).toContain("name: imported-skill");
      // 下次 list 即见（扫描现拍，无广播）
      client.send({ v: PROTOCOL_VERSION, type: "agent.config.list", payload: {} });
      const list = await client.expect("agent.config.list.result");
      const main = (list.payload as { profiles: { profileKind: string; skills: { name: string; source: string }[] }[] }).profiles.find(
        (p) => p.profileKind === "main-session",
      )!;
      expect(main.skills.some((s) => s.name === "imported-skill" && s.source === "user")).toBe(true);
    } finally {
      await client.close();
      await rig.dispose();
    }
  });

  test("② 四类 skipped 不落盘 + 缺 content → invalid_payload（连接保持）", async () => {
    const rig = await makeRig();
    const client = new TestClient(rig.url);
    try {
      await client.open();
      await helloHandshake(client, rig.token);
      await client.expect("session.snapshot");

      const send = (content: string) =>
        client.send({ v: PROTOCOL_VERSION, type: "agent.skill.create", payload: { content } });
      // 同型帧多发展开：expect() 恒返首帧（不消费），逐条用 expectAfter 锚点推进
      // 同名（rig 预播种 hello-skill）
      let at = client.frames.length;
      send("---\nname: hello-skill\ndescription: 冲突\n---\n\nb");
      expect((await client.expectAfter("agent.skill.create.result", at)).payload).toEqual({ status: "skipped", reason: "already-exists" });
      // 缺 description
      at = client.frames.length;
      send("---\nname: no-desc\n---\n\nb");
      expect((await client.expectAfter("agent.skill.create.result", at)).payload).toEqual({ status: "skipped", reason: "missing-description" });
      // 非法 name（路径穿越）
      at = client.frames.length;
      send("---\nname: ../escape\ndescription: x\n---\n\nb");
      expect((await client.expectAfter("agent.skill.create.result", at)).payload).toEqual({ status: "skipped", reason: "invalid-name" });
      // 无 frontmatter
      at = client.frames.length;
      send("## 直接正文");
      expect((await client.expectAfter("agent.skill.create.result", at)).payload).toEqual({ status: "skipped", reason: "bad-frontmatter" });
      // 缺 content 字段 → invalid_payload + 连接保持（后续命令仍通）
      client.send({ v: PROTOCOL_VERSION, type: "agent.skill.create", payload: {} });
      await client.waitForInvalidPayload("agent.skill.create");
      client.send({ v: PROTOCOL_VERSION, type: "agent.skill_content.get", payload: { name: "hello-skill" } });
      const ok = await client.expect("agent.skill_content.get.result");
      expect(ok.payload.name).toBe("hello-skill");
      // skipped 均未落盘
      expect(existsSync(path.join(createPaths(rig.home).skillsHome(), "no-desc"))).toBe(false);
      expect(existsSync(path.join(createPaths(rig.home).skillsHome(), "escape"))).toBe(false);
    } finally {
      await client.close();
      await rig.dispose();
    }
  });
});
