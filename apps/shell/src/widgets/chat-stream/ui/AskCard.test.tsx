// @vitest-environment jsdom
/**
 * AskCard 权限申请卡测试（中危 F3a：kind 分发 default 兜底）。
 *
 * AskKind 是 additive 扩展面（协议自述「新增消费者 = 新增 kind 成员」）——
 * 未知/新增 kind 不得返回 undefined 抛错整树崩（全应用无 ErrorBoundary），
 * 按头注契约「缺省 kind 一律按 permission_request 处理」回落渲染命令卡。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { createInitialSessionState, type SessionState } from "@/entities/session/model/session-reducer";
import type { PendingAskDto } from "@helix/protocol";

const answerAsk = vi.fn();
const stateRef: { current: SessionState } = { current: createInitialSessionState() };
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return { ...orig, useSession: () => ({ state: stateRef.current, answerAsk }) };
});

import AskCard from "./AskCard";

afterEach(cleanup);
localStorage.setItem("helix-lang", "zh-CN");

function askWith(kind: PendingAskDto["kind"]): PendingAskDto {
  return {
    askId: "ask-1",
    ...(kind !== undefined ? { kind } : {}),
    command: "rm -rf /tmp/probe",
    reason: "清理探针目录",
    instanceId: "agent-x",
    expiresAt: Date.now() + 60_000,
  };
}

function stateWith(ask: PendingAskDto | null): SessionState {
  return { ...createInitialSessionState(), sessionId: "s1", view: "ready", pendingAsk: ask };
}

describe("AskCard kind 分发兜底", () => {
  it("未知 kind（additive 新成员）→ 不抛错，按 permission_request 口径回落渲染命令卡", () => {
    stateRef.current = stateWith(askWith("yolo-future-kind" as PendingAskDto["kind"]));
    expect(() => render(<I18nProvider><AskCard /></I18nProvider>)).not.toThrow();
    expect(screen.getByText("rm -rf /tmp/probe")).toBeTruthy();
    expect(screen.getByText("清理探针目录")).toBeTruthy();
  });

  it("kind=permission_request 正常渲染命令卡（回归锚）", () => {
    stateRef.current = stateWith(askWith("permission_request"));
    render(<I18nProvider><AskCard /></I18nProvider>);
    expect(screen.getByText("rm -rf /tmp/probe")).toBeTruthy();
  });
});
