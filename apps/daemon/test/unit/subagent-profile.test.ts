import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Model, Models } from "@earendil-works/pi-ai";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { MainSessionProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SteerHooks } from "../../src/adapters/driven/pi-engine/runtime/hooks/SteerHooks";
import { resolveConfigModel, resolveModelSlot } from "../../src/adapters/driven/pi-engine/model-provider";

/**
 * T2.2 单测：SubAgentProfile 结构（AD-2/AD-3）+ AgentProfile.model 槽位与
 * 缺省继承（AD-6）+ config model 解析收束单点（F-14 红线）。
 *
 * - SubAgentProfile：kind=subagent-worker、全工具集（照抄 MainSessionProfile
 *   工具名清单）、single-shot、model undefined、SteerHooks 装配（send→steer）。
 * - resolveModelSlot：未声明 → 同引用透传完整对象（非按 id 重建，防 registry
 *   不含）；声明 "provider/id" → registry 解析；解析失败 fail-fast 报错含 id。
 * - resolveConfigModel：config.model 字符串 → 完整 Model 对象（K4：tmp home
 *   config 覆写，注入 fake 目录避免网络/真实 catalog 漂移）；缺失 fail-fast。
 */

/** 离线 fake 模型目录（同 tools-loop.test.ts 口径，无网络无真实 catalog）。 */
const fakeModel = {
  id: "model",
  name: "Fake Model",
  api: "anthropic-messages",
  provider: "fake",
  baseUrl: "http://localhost-unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
} as unknown as Model<any>;

const fakeModels = {
  getModel: (provider: string, id: string) => (provider === "fake" && id === "model" ? fakeModel : undefined),
  getModels: (provider: string) => (provider === "fake" ? [fakeModel] : []),
  streamSimple: () => {
    throw new Error("不应走到真实流");
  },
} as unknown as Models;

const otherModel = { ...fakeModel, id: "other" } as unknown as Model<any>;

describe("SubAgentProfile 结构（T2.2，AD-2/AD-3）", () => {
  test("kind/lifecycle/model 槽位：subagent-worker + single-shot + model undefined（缺省继承）", () => {
    expect(SubAgentProfile.kind).toBe("subagent-worker");
    expect(SubAgentProfile.lifecycle).toEqual({ mode: "single-shot" });
    expect(SubAgentProfile.model).toBeUndefined();
  });

  test("全工具集：照抄 MainSessionProfile 工具名清单去编排三工具（不新增工具）", () => {
    // T2.3：Main 增 agent_spawn/agent_send/agent_status（编排回口）；SubAgent
    // 不 spawn 孙进程（单层编排）。T3r：Main 增动态族单 browser 工具；H-3：
    // SubAgent 经 wire 转发通道接入同一 daemon CDP 单例（P0-1 子进程不直连
    // 决策不变——RemoteBrowserPort 进程外实现，ownerId = instanceId）。
    // 工具集 = Main 清单去编排三工具
    expect(SubAgentProfile.tools).toEqual(
      MainSessionProfile.tools.filter((t) => !t.startsWith("agent_")),
    );
    expect(SubAgentProfile.tools).toEqual(["bash", "read", "write", "edit", "grep", "web_search", "web_fetch", "browser"]);
  });

  test("hooks 装配 SteerHooks（send→steer 转投接线，AD-7⑤；T1 后为构造器引用声明）", () => {
    expect(SubAgentProfile.hooks.some((H) => H === SteerHooks)).toBe(true);
  });

  test("系统提示：单任务收敛 SOP + closure 协议（五字段结构）", () => {
    const p = SubAgentProfile.systemPrompt;
    expect(p).toContain("SubAgent");
    // closure 协议：五字段名 + 块标记 + done|failed
    for (const field of ["status", "summary", "reportPath", "findings", "taskId"]) {
      expect(p).toContain(field);
    }
    expect(p).toContain("CLOSURE");
    expect(p).toContain("done");
    expect(p).toContain("failed");
  });

  test("AgentProfile.model 槽位既有 profile 不受影响（MainSessionProfile 无声明）", () => {
    expect(MainSessionProfile.model).toBeUndefined();
  });
});

describe("resolveModelSlot：模型槽位与缺省继承（T2.2，AD-6）", () => {
  test("未声明 → 同引用透传完整 Model 对象（非按 id 重建）", () => {
    const resolved = resolveModelSlot(undefined, fakeModel, fakeModels);
    expect(resolved).toBe(fakeModel); // 同引用：完整对象透传（F-14）
  });

  test("透传对象不在 registry 中也可用（按 id 重建会失败的对照场景）", () => {
    // base 是目录外的自定义对象（如测试注入/E 层构造）——继承不受 registry 限制
    const resolved = resolveModelSlot(undefined, otherModel, fakeModels);
    expect(resolved).toBe(otherModel);
  });

  test("声明 provider/id → registry 解析", () => {
    const resolved = resolveModelSlot("fake/model", otherModel, fakeModels);
    expect(resolved).toBe(fakeModel);
  });

  test("声明未知 id → fail-fast 报错含 id", () => {
    expect(() => resolveModelSlot("fake/unknown-id", otherModel, fakeModels)).toThrow(/fake\/unknown-id/);
  });
});

describe("resolveConfigModel：config model 解析收束单点（T2.2，F-14）", () => {
  const tmpDirs: string[] = [];

  test("config.model 字符串 → 完整 Model 对象（深度相等目录条目）", () => {
    const resolved = resolveConfigModel("fake/model", fakeModels);
    expect(resolved).toEqual(fakeModel);
  });

  test("K4：默认模型字符串（T2.3 迁 SQLite 后的组合根入参）→ resolveConfigModel 全链", () => {
    // T2.3（AD-2）：model 位不在 config.json——组合根从默认模型存储取字符串
    // （此处直接以字符串模拟 DefaultModelStore.current() 产物）→ 解析单点
    const defaultModelStr = "fake/model";
    const resolved = resolveConfigModel(defaultModelStr, fakeModels);
    expect(resolved).toEqual(fakeModel); // 完整对象（此后全链路透传，不再散落读字符串）
  });

  test("model 缺失/为空 → 中文 fail-fast", () => {
    expect(() => resolveConfigModel(undefined, fakeModels)).toThrow(/model/);
    expect(() => resolveConfigModel("", fakeModels)).toThrow(/model/);
    expect(() => resolveConfigModel("   ", fakeModels)).toThrow(/model/);
  });

  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });
});
