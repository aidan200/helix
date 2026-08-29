/**
 * workspace 批（W1 workspace 绑定闭环）：三面契约登记守护。
 *
 * 覆盖：命令目录（workspace.get / workspace.open）+ 事件目录（两个点对点
 * 结果帧 + workspace_changed 广播）+ EVENT_CHANNELS 通道归属（workspace
 * 新通道）+ payload 类型面编译期可达。SoT 文档面（PROTOCOL.md §15.10/
 * §16.10 计数与登记锚）由 sot-consistency.test.ts ①~⑤ 断言兜底。
 */
import { describe, expect, test } from "bun:test";
import { COMMAND_TYPES, EVENT_CHANNELS, EVENT_TYPES } from "../../src/index";
import type {
  CommandEnvelope,
  EventEnvelope,
  WorkspaceChangedEvent,
  WorkspaceGetCommand,
  WorkspaceGetResultEvent,
  WorkspaceOpenCommand,
  WorkspaceOpenResultEvent,
  WorkspaceRecent,
} from "../../src/index";

describe("workspace 批（W1）：命令/事件/通道登记", () => {
  test("命令目录：workspace.get / workspace.open 登记且排序在 kg 族之后（task 批前尾段）", () => {
    expect(COMMAND_TYPES).toContain("workspace.get");
    expect(COMMAND_TYPES).toContain("workspace.open");
    const kgEnd = COMMAND_TYPES.findIndex((t) => t === "kg.projects");
    expect(COMMAND_TYPES.indexOf("workspace.get")).toBe(kgEnd + 1);
    expect(COMMAND_TYPES.indexOf("workspace.open")).toBe(kgEnd + 2);
  });

  test("事件目录：两个结果帧 + workspace_changed 广播登记", () => {
    expect(EVENT_TYPES).toContain("workspace.get.result");
    expect(EVENT_TYPES).toContain("workspace.open.result");
    expect(EVENT_TYPES).toContain("workspace_changed");
  });

  test("通道归属：workspace 族三事件全部挂 workspace 新通道", () => {
    expect(EVENT_CHANNELS["workspace.get.result"]).toBe("workspace");
    expect(EVENT_CHANNELS["workspace.open.result"]).toBe("workspace");
    expect(EVENT_CHANNELS["workspace_changed"]).toBe("workspace");
  });

  test("信封判别：workspace 命令/事件帧可窄化（编译期）+ 判别字段运行时校验", () => {
    const cmd: CommandEnvelope = {
      v: "0.11",
      type: "workspace.open",
      payload: { root: "/tmp/somewhere" },
    };
    expect(cmd.type).toBe("workspace.open");
    if (cmd.type === "workspace.open") expect(cmd.payload.root).toBe("/tmp/somewhere");

    const getCmd: WorkspaceGetCommand = { v: "0.11", type: "workspace.get", payload: {} };
    expect(getCmd.type).toBe("workspace.get");

    const changed: EventEnvelope = {
      v: "0.11",
      sessionId: "system",
      channel: "workspace",
      type: "workspace_changed",
      payload: { root: "/tmp/somewhere" },
    };
    expect(changed.type).toBe("workspace_changed");
    if (changed.type === "workspace_changed") expect(changed.payload.root).toBe("/tmp/somewhere");

    // 点对点结果帧 channel 字面量窄化（编译期守护）
    const getResult: WorkspaceGetResultEvent = {
      v: "0.11",
      sessionId: "system",
      channel: "workspace",
      type: "workspace.get.result",
      payload: { current: null, recents: [] },
    };
    expect(getResult.type).toBe("workspace.get.result");

    const openResult: WorkspaceOpenResultEvent = {
      v: "0.11",
      sessionId: "system",
      channel: "workspace",
      type: "workspace.open.result",
      payload: { root: "/tmp/somewhere", projects: [] },
    };
    expect(openResult.type).toBe("workspace.open.result");

    const recent: WorkspaceRecent = {
      root: "/tmp/somewhere",
      name: "somewhere",
      lastUsedAt: "2026-08-27T00:00:00.000Z",
      valid: true,
    };
    expect(recent.valid).toBe(true);
  });
});
