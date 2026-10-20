/**
 * coord 三工具行为测试（U4）：真 CoordinationService + 身份绑定面。
 * 覆盖：claim 回执（含冲突详情与裁决辅助序）/ release 计数 / query 两种形态。
 */

import { describe, expect, test } from "bun:test";
import { CoordinationService } from "../../src/application/services/CoordinationService";
import { WriteFactRegistry } from "../../src/application/services/WriteFactRegistry";
import {
  createCoordClaimTool,
  createCoordQueryTool,
  createCoordReleaseTool,
} from "../../src/adapters/driven/tools/coord/CoordTools";
import type { AgentHarnessTool, AgentToolResult, ExecutionToolContext } from "../../src/adapters/driven/tools/vendor/pi-harness";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { BACKGROUND_CONTEXT } from "../../src/adapters/driven/tools/vendor/pi-harness";

const WS = "/ws";

function service() {
  const events: DomainEvent[] = [];
  const svc = new CoordinationService({
    publish: (e) => events.push(e),
    writeFacts: new WriteFactRegistry({ workspaceRoot: () => WS }),
    planReaderFor: () => undefined,
    workspaceRoot: () => WS,
    now: () => Date.now(),
  });
  return { svc, events };
}

async function run(tool: AgentHarnessTool<ExecutionToolContext, any, undefined>, params: unknown): Promise<string> {
  const r = await tool.execute("tc-1", params, undefined as never, undefined as never, undefined as never, BACKGROUND_CONTEXT);
  return r.content
    .map((c) => (c.type === "text" ? (c as { text: string }).text : ""))
    .join("\n");
}

describe("coord 工具族", () => {
  test("claim：无冲突回执；跨会话冲突回执含对方意图与建议序", async () => {
    const { svc } = service();
    const toolA = createCoordClaimTool({ service: svc, sessionId: "sess-a", instanceId: "main-a" });
    const toolB = createCoordClaimTool({ service: svc, sessionId: "sess-b", instanceId: "main-b" });
    const r1 = await run(toolA, { scope: { projectRoot: "/ws/projA" }, intent: "重构调度器" });
    expect(r1).toContain("已登记占用");
    expect(r1).toContain("无其他会话占用重叠");
    const r2 = await run(toolB, { scope: { projectRoot: "/ws/projA" }, intent: "也想改调度器" });
    expect(r2).toContain("⚠ 与以下占用重叠");
    expect(r2).toContain("重构调度器");
    expect(r2).toContain("isolated spawn"); // 裁决辅助序
  });

  test("claim 身份绑定：工具参数零身份字段（伪造无效——owner 由装配面注入）", async () => {
    const { svc } = service();
    const tool = createCoordClaimTool({ service: svc, sessionId: "sess-a", instanceId: "main-a" });
    await run(tool, { scope: { projectRoot: "/ws/projA" }, intent: "x" });
    const leases = svc.leases();
    expect(leases[0]!.ownerSessionId).toBe("sess-a"); // 参数里没有身份可传
  });

  test("query：概览形态 + scope 冲突面形态", async () => {
    const { svc } = service();
    svc.claim({ ownerSessionId: "sess-b", ownerAgentId: "main-b", scope: { kind: "project", projectRoot: "/ws/projB" }, intent: "B 在改" });
    const tool = createCoordQueryTool({ service: svc, sessionId: "sess-a", instanceId: "main-a" });
    const overview = await run(tool, {});
    expect(overview).toContain("占用概览");
    expect(overview).toContain("/ws/projB");
    const conflicts = await run(tool, { scope: { projectRoot: "/ws/projB" } });
    expect(conflicts).toContain("阻塞冲突面");
    expect(conflicts).toContain("B 在改");
    const clean = await run(tool, { scope: { projectRoot: "/ws/projC" } });
    expect(clean).toContain("无其他会话阻塞占用");
  });

  test("release：计数回执；scope 缺省释放本会话全部", async () => {
    const { svc } = service();
    const tool = createCoordReleaseTool({ service: svc, sessionId: "sess-a", instanceId: "main-a" });
    svc.claim({ ownerSessionId: "sess-a", ownerAgentId: "main-a", scope: { kind: "project", projectRoot: "/ws/projA" }, intent: "x" });
    svc.claim({ ownerSessionId: "sess-a", ownerAgentId: "main-a", scope: { kind: "project", projectRoot: "/ws/projB" }, intent: "y" });
    const r = await run(tool, {});
    expect(r).toContain("已释放 2 个占用租约");
    expect(svc.leases()).toHaveLength(0);
  });

  test("claim 参数校验：scope 两字段全缺 → 响亮报错", async () => {
    const { svc } = service();
    const tool = createCoordClaimTool({ service: svc, sessionId: "sess-a", instanceId: "main-a" });
    expect(run(tool, { scope: {}, intent: "x" })).rejects.toThrow("projectRoot 或 paths");
  });

  test("claim 参数校验：projectRoot 与 paths 同传 → 响亮报错（消除静默窄化，code-review 低危）", async () => {
    const { svc } = service();
    const tool = createCoordClaimTool({ service: svc, sessionId: "sess-a", instanceId: "main-a" });
    expect(
      run(tool, { scope: { projectRoot: "/ws/projA", paths: ["src/**"] }, intent: "x" }),
    ).rejects.toThrow("不可同传");
  });
});

// ── scope 参数校验（低危批：缺失/形状错给可纠错文案，不抛裸 TypeError） ──

describe("coord 工具族 scope 形状守卫", () => {
  test("claim 缺 scope → 文案指明应为对象并给示例（不是 Cannot read properties of undefined）", async () => {
    const { svc } = service();
    const tool = createCoordClaimTool({ service: svc, sessionId: "s1", instanceId: "a1" });
    await expect(run(tool, { intent: "x" })).rejects.toThrow(/scope 应为对象/);
  });

  test("scope.projectRoot 非 string / scope.paths 非 string[] → 各自精确指认", async () => {
    const { svc } = service();
    const claim = createCoordClaimTool({ service: svc, sessionId: "s1", instanceId: "a1" });
    await expect(run(claim, { scope: { projectRoot: 42 }, intent: "x" })).rejects.toThrow(/scope.projectRoot 应为 string/);
    await expect(run(claim, { scope: { paths: [1] }, intent: "x" })).rejects.toThrow(/scope.paths 应为 string\[\]/);
  });

  test("合法 scope 照常放行（守卫不越位）", async () => {
    const { svc } = service();
    const claim = createCoordClaimTool({ service: svc, sessionId: "s1", instanceId: "a1" });
    const text = await run(claim, { scope: { projectRoot: "helix" }, intent: "改 adapters" });
    expect(text).toContain("已登记占用");
  });
});
