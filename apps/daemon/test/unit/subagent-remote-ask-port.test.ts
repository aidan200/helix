import { describe, expect, test } from "bun:test";
import { RemoteAskPort } from "../../src/adapters/driven/subagent/child/RemoteAskPort";
import type { ChildOutboundLine, ToolResponseLine } from "../../src/adapters/driven/subagent/transport/wire";

/**
 * RemoteAskPort（permission_request 仲裁转发的子进程侧）。
 *
 * 转发机制（pending 表 / reqId / 超时 / 退出清场）已上收到 RemoteToolBridge
 * 与 RemoteBrowserPort 同源（低危批：两份 ~50 行同构实现合一）。本测试钉住
 * ask 侧的对外契约：上行帧形状、四态回执关联、超时拒绝、退出清场。
 */

function harness(timeoutMs = 50) {
  const lines: ChildOutboundLine[] = [];
  const port = new RemoteAskPort("agent-1", (line) => lines.push(line), timeoutMs);
  return { port, lines };
}

const toolRes = (reqId: number, ok: boolean, value?: unknown, error?: string): ToolResponseLine =>
  ({ type: "tool-res", reqId, ok, ...(ok ? { value } : { error }) }) as ToolResponseLine;

describe("RemoteAskPort（ask.request 转发）", () => {
  test("① 上行帧：method=ask.request + args=[command, reason]；回执 ok → 四态值透传", async () => {
    const { port, lines } = harness();
    const pending = port.request({ sessionId: "s", instanceId: "agent-1", command: "rm -rf build", reason: "清理产物" });
    const req = lines[0] as { type: string; reqId: number; method: string; args: unknown[]; instanceId: string };
    expect(req.type).toBe("tool-req");
    expect(req.method).toBe("ask.request");
    expect(req.args).toEqual(["rm -rf build", "清理产物"]);
    expect(req.instanceId).toBe("agent-1");
    // reqId 区间与 browser 转发错开（父侧按行回显 reqId，区间隔离免互踩）
    expect(req.reqId).toBeGreaterThan(1_000_000);
    port.handleResponse(toolRes(req.reqId, true, "approved"));
    expect(await pending).toBe("approved");
  });

  test("② 回执 ok:false → 拒绝并带父侧 error 文案", async () => {
    const { port, lines } = harness();
    const pending = port.request({ sessionId: "s", instanceId: "agent-1", command: "x", reason: "y" });
    const reqId = (lines[0] as { reqId: number }).reqId;
    port.handleResponse(toolRes(reqId, false, undefined, "仲裁不可用"));
    await expect(pending).rejects.toThrow("仲裁不可用");
  });

  test("③ 超时（daemon 无回执）→ 拒绝文案含「ask 转发超时」；迟到回执静默", async () => {
    const { port, lines } = harness(20);
    const pending = port.request({ sessionId: "s", instanceId: "agent-1", command: "x", reason: "y" });
    const reqId = (lines[0] as { reqId: number }).reqId;
    await expect(pending).rejects.toThrow(/ask 转发超时/);
    expect(() => port.handleResponse(toolRes(reqId, true, "approved"))).not.toThrow(); // 迟到静默
  });

  test("④ rejectAll（子进程退出清场）→ 在飞全拒 + reason 透传；后到回执静默", async () => {
    const { port, lines } = harness(10_000);
    // 先挂 settle 捕获（同步 rejectAll 会先落地，后挂会触发 unhandled rejection）
    const a = port.request({ sessionId: "s", instanceId: "agent-1", command: "a", reason: "r" });
    const aErr = a.then(() => null, (e: Error) => e);
    const b = port.request({ sessionId: "s", instanceId: "agent-1", command: "b", reason: "r" });
    const bErr = b.then(() => null, (e: Error) => e);
    const ids = lines.map((l) => (l as { reqId: number }).reqId);
    port.rejectAll("子进程退出清场");
    expect((await aErr)?.message).toBe("子进程退出清场");
    expect((await bErr)?.message).toBe("子进程退出清场");
    expect(() => port.handleResponse(toolRes(ids[0]!, true, "approved"))).not.toThrow();
  });
});
