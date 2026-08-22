import { describe, expect, test } from "bun:test";
import {
  encodeLine,
  parseChildLine,
  parseParentLine,
  truncateToolResult,
  TOOL_RESULT_MAX_BYTES,
} from "../../src/adapters/driven/subagent/transport/wire";
import type {
  ChildOutboundLine,
  SendLine,
  ToolResponseLine,
} from "../../src/adapters/driven/subagent/transport/wire";

/**
 * H-3①：wire 两型帧（tool-req 上行 / tool-res 下行）编解码单测。
 *
 * - tool-req：子进程 RemoteBrowserPort 转发请求（args = 位置参数数组，
 *   全 JSON 可序列化）——经 parseChildLine 与既有五型同通道上行；
 * - tool-res：daemon 回执（ok 判别字段；value/error 互斥）——下行经
 *   parseParentLine（parseSendLine 泛化）解码，send 行同通道兼容；
 * - 坏行容错：非 JSON / 形状非法 → undefined（与既有 parse 纪律同口径）。
 */

describe("wire ① tool-req 上行帧（ChildOutboundLine 增型）", () => {
  test("编码→解码往返：instanceId/reqId/method/args 逐字段保留", () => {
    const line: ChildOutboundLine = {
      type: "tool-req",
      instanceId: "agent-7",
      reqId: 3,
      method: "openTab",
      args: ["https://example.com", "agent-7"],
    };
    const decoded = parseChildLine(encodeLine(line));
    expect(decoded).toEqual(line);
  });

  test("args 空数组 / 嵌套 JSON 值（files 数组）往返", () => {
    const noArgs: ChildOutboundLine = { type: "tool-req", instanceId: "a", reqId: 1, method: "listTabs", args: [] };
    expect(parseChildLine(encodeLine(noArgs))).toEqual(noArgs);
    const files: ChildOutboundLine = {
      type: "tool-req",
      instanceId: "a",
      reqId: 2,
      method: "setFilesInTab",
      args: ["tab-1", "input[type=file]", ["/tmp/a.png", "/tmp/b.png"]],
    };
    expect(parseChildLine(encodeLine(files))).toEqual(files);
  });
});

describe("wire ① tool-res 下行帧（parseParentLine）", () => {
  test("ok:true 回执往返（value 任意 JSON，含 undefined 缺席形态）", () => {
    const res: ToolResponseLine = { type: "tool-res", reqId: 3, ok: true, value: { tabId: "tab-new" } };
    expect(parseParentLine(encodeLine(res))).toEqual(res);
    const noValue: ToolResponseLine = { type: "tool-res", reqId: 4, ok: true, value: null };
    expect(parseParentLine(encodeLine(noValue))).toEqual(noValue);
  });

  test("ok:false 回执往返（error 文案透传）", () => {
    const res: ToolResponseLine = { type: "tool-res", reqId: 5, ok: false, error: "tab tab-9 不属于实例 agent-1（或不存在）" };
    expect(parseParentLine(encodeLine(res))).toEqual(res);
  });

  test("send 行兼容（泛化后既有 steer 通道零回归）", () => {
    const send: SendLine = { type: "send", text: "补充指示" };
    expect(parseParentLine(encodeLine(send))).toEqual(send);
  });

  test("坏行容错：非 JSON / 未知 type / 形状非法 → undefined", () => {
    expect(parseParentLine("{这不是json")).toBeUndefined();
    expect(parseParentLine(JSON.stringify({ type: "mystery" }))).toBeUndefined();
    expect(parseParentLine(JSON.stringify({ type: "send" }))).toBeUndefined(); // 缺 text
    expect(parseParentLine(JSON.stringify({ type: "tool-res", reqId: 1 }))).toBeUndefined(); // 缺 ok
    expect(parseParentLine(JSON.stringify({ type: "tool-res", reqId: "x", ok: true, value: 1 }))).toBeUndefined(); // reqId 非数
    expect(parseParentLine(JSON.stringify({ type: "tool-res", reqId: 1, ok: false }))).toBeUndefined(); // 缺 error
  });
});

describe("wire ① 既有帧型零回归", () => {
  test("五型上行帧 + 坏行容错行为不变", () => {
    const started: ChildOutboundLine = { type: "started", instanceId: "a", pid: 1, model: { id: "m" } };
    expect(parseChildLine(encodeLine(started))).toEqual(started);
    const closure: ChildOutboundLine = {
      type: "closure",
      instanceId: "a",
      closure: { status: "done", summary: "s", reportPath: null, findings: [], taskId: null },
    };
    expect(parseChildLine(encodeLine(closure))).toEqual(closure);
    expect(parseChildLine("{坏行")).toBeUndefined();
    expect(parseChildLine(JSON.stringify({ noType: true }))).toBeUndefined();
  });
});

describe("wire ① tool-res 出口截断（truncateToolResult，行 JSON 无流控保护）", () => {
  test("上限内原样透传（含 undefined → null 归一）", () => {
    expect(truncateToolResult({ tabId: "t" })).toEqual({ tabId: "t" });
    expect(truncateToolResult("短文本")).toBe("短文本");
    expect(truncateToolResult(undefined)).toBeNull();
  });

  test("超上限 → 截断字符串 + 标记（字节严格封顶）", () => {
    const big = "x".repeat(300_000);
    const out = truncateToolResult(big, 1024) as string;
    expect(typeof out).toBe("string");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(1024 + 100); // 截断体 + 标记尾
    expect(out).toMatch(/…\[截断：原始 \d+ 字节超 1024 上限\]$/);
  });

  test("默认上限常量 = 256KB", () => {
    expect(TOOL_RESULT_MAX_BYTES).toBe(256 * 1024);
  });
});
