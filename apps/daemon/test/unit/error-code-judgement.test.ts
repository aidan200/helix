import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ErrorCode } from "@helix/protocol";
import { ImageValidationError } from "../../src/application/services/images";
import { SteerTargetNotRunningError } from "../../src/application/services/ChatService";
import {
  SessionNotFoundError,
  SessionDeleteInProgressError,
} from "../../src/application/services/SessionRegistry";
import { ModelNotFoundError, ProviderNotFoundError } from "../../src/application/services/ModelService";
import { handleChatSend, handleChatSteer } from "../../src/adapters/driving/ws-server/handlers/chat";
import {
  handleSessionLoadHistory,
  handleSessionDelete,
} from "../../src/adapters/driving/ws-server/handlers/session";
import { WsServerAdapter } from "../../src/adapters/driving/ws-server/WsServerAdapter";
import type {
  ChatCommandContext,
  SessionCommandContext,
} from "../../src/adapters/driving/ws-server/handlers/context";

/**
 * T1.5（CL-2 功能点 5 / R-2.5，D12-2）：错误判别 err.name 字符串 → err.code
 * 码匹配（additive）。
 * - TP-1.5a：6 错误类各挂 readonly code（类型 = protocol ErrorCode 联合，
 *   application 白名单含 @helix/protocol）；无 code 旧对象判别路径不回归
 *   （TR-AD-23① additive 缺省语义 = 既有行为）；
 * - TP-1.5b：6 判别点等价断言——同一错误注入 → 回码/消息与基线一致
 *   （改造前后期望值不变，天然绿；变红即等价破坏）；
 * - TP-1.5c：结构断言——ws-server 目录 `name === "` 判别模式零残留
 *   （先红：现状 6 判别点 9 行命中）；
 * - TP-1.5e①：结构断言——ChatService `void t;` 零残留（D12-1，typecheck
 *   面 + 本 grep 面双守护）。
 *
 * 判别点 6 处（ex4 F-2 全表）：chat.ts:55/67/93、session.ts:126/147-153、
 * WsServerAdapter.ts:592-598 modelErrorCode。handler 级等价断言经最小 ctx
 * 桩注入错误（判别逻辑在 handler 模块函数内，观察点 = commandError 记录面
 * / console.warn 既有可观测面）。
 */

const srcRoot = path.join(import.meta.dir, "..", "..", "src");

/** 目录递归 .ts 清单（结构断言扫描面）。 */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    if (rel.endsWith(".ts")) out.push(path.normalize(rel));
  }
  return out;
}

/** 命中行清单（file:line: 行文本）。 */
function grepLines(file: string, re: RegExp): string[] {
  const hits: string[] = [];
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (re.test(line)) hits.push(`${i + 1}: ${line.trim()}`);
    });
  return hits;
}

describe("TP-1.5a：6 错误类携带 protocol ErrorCode（additive code 判别契约）", () => {
  test("错误构造带 code，值 = 各自既有回码映射", () => {
    // 编译期锚：code 类型 = protocol ErrorCode 联合（AF-8 解读：协议错误类型
    // 供给 additive code 字段——payload/§16 登记面零变化）
    const pairs: ReadonlyArray<readonly [ErrorCode, Error & { readonly code: ErrorCode }]> = [
      ["command.invalid_payload", new ImageValidationError("图片超限")],
      ["command.invalid_payload", new SteerTargetNotRunningError("目标非运行中")],
      ["session.not_found", new SessionNotFoundError("s-404")],
      ["session.delete_in_progress", new SessionDeleteInProgressError("s-409")],
      ["model_not_found", new ModelNotFoundError("prov/no-such")],
      ["provider_not_found", new ProviderNotFoundError("no-such-provider")],
    ];
    for (const [expected, err] of pairs) {
      expect(err.code, `${err.constructor.name}.code`).toBe(expected);
    }
  });
});

describe("TP-1.5b/TP-1.5a：判别点等价 + 无 code 旧对象兜底（handler 级注入）", () => {
  /** commandError 记录项（等价断言观察点：回码 + 消息透传）。 */
  type Recorded = { type: string; code: ErrorCode; message: string };

  /**
   * 捕获 console.warn + commandError（回执不命中的既有可观测路径断言用）。
   * 微任务链 flush 后返回两观察面。
   */
  async function capture(
    drive: (errors: Recorded[]) => void,
  ): Promise<{ errors: Recorded[]; warns: string[] }> {
    const errors: Recorded[] = [];
    const warns: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };
    try {
      drive(errors);
      await new Promise((r) => setTimeout(r, 0)); // flush catch 回调（异步链）
      return { errors, warns };
    } finally {
      console.warn = original;
    }
  }

  const recordingError = (errors: Recorded[]) => (type: string, code: ErrorCode, message: string) => {
    errors.push({ type, code, message });
  };

  const dummySender = { send: () => undefined };

  /** chat.send 桩（reject 注入 sendMessage / startDraftSession 双路径）。 */
  function chatSendCtx(payload: Record<string, unknown>, reject: unknown, errors: Recorded[]): unknown {
    return {
      ws: { data: { sender: dummySender } },
      type: "chat.send",
      payload: { text: "hi", ...payload },
      envelope: payload.draft === true ? {} : { sessionId: "s1" },
      chat: {
        sendMessage: () => Promise.reject(reject),
      },
      directory: {
        startDraftSession: () => Promise.reject(reject),
      },
      commandError: recordingError(errors),
    };
  }

  /** chat.steer 桩。 */
  function steerCtx(reject: unknown, errors: Recorded[]): unknown {
    return {
      ws: { data: { sender: dummySender } },
      type: "chat.steer",
      payload: { text: "hi", instanceId: "inst-1" },
      envelope: { sessionId: "s1" },
      chat: {
        steer: () => Promise.reject(reject),
      },
      commandError: recordingError(errors),
    };
  }

  /** session.loadHistory 桩（resolveTarget 拒绝注入判别点④）。 */
  function loadHistoryCtx(reject: unknown, errors: Recorded[]): unknown {
    return {
      ws: { data: { sender: dummySender } },
      type: "session.loadHistory",
      payload: { beforeEntryId: "e1", limit: 10 },
      envelope: { sessionId: "s1" },
      directory: {
        resolveTarget: () => Promise.reject(reject),
      },
      commandError: recordingError(errors),
    };
  }

  /** session.delete 桩（deleteSession 拒绝注入判别点⑤）。 */
  function deleteCtx(reject: unknown, errors: Recorded[]): unknown {
    return {
      ws: { data: { sender: dummySender } },
      type: "session.delete",
      payload: {},
      envelope: { sessionId: "s1" },
      directory: {
        deleteSession: () => Promise.reject(reject),
      },
      commandError: recordingError(errors),
    };
  }

  test("判别点①：草稿链 ImageValidationError → command.invalid_payload + 消息透传", async () => {
    const err = new ImageValidationError("第 1 张图片不是合法的 base64 data URL");
    const { errors } = await capture((errors) => {
      handleChatSend(chatSendCtx({ draft: true }, err, errors) as ChatCommandContext);
    });
    expect(errors).toEqual([
      { type: "chat.send", code: "command.invalid_payload", message: "第 1 张图片不是合法的 base64 data URL" },
    ]);
  });

  test("判别点②：既有会话 ImageValidationError → command.invalid_payload；无 code 旧对象走 daemon.internal 回执 + console.warn（H5 行为升级）", async () => {
    const plain = new Error("boom（无 code 旧对象）");
    const { errors, warns } = await capture((errors) => {
      handleChatSend(chatSendCtx({}, plain, errors) as ChatCommandContext);
    });
    // H5：兑底也回执 daemon.internal（客户端零感知静默失败修复）+ warn 保留
    expect(errors).toEqual([{ type: "chat.send", code: "daemon.internal", message: "boom（无 code 旧对象）" }]);
    expect(warns.some((w) => w.includes("boom"))).toBe(true);

    const imgErr = new ImageValidationError("图片附件最多 4 张（收到 5 张）");
    const { errors: errors2 } = await capture((errors) => {
      handleChatSend(chatSendCtx({}, imgErr, errors) as ChatCommandContext);
    });
    expect(errors2).toEqual([
      { type: "chat.send", code: "command.invalid_payload", message: "图片附件最多 4 张（收到 5 张）" },
    ]);
  });

  test("判别点③：steer SteerTargetNotRunningError → command.invalid_payload；无 code 旧对象 daemon.internal + console.warn（H5 行为升级）", async () => {
    const steerErr = new SteerTargetNotRunningError("实例 inst-1 非运行中");
    const { errors } = await capture((errors) => {
      handleChatSteer(steerCtx(steerErr, errors) as ChatCommandContext);
    });
    expect(errors).toEqual([
      { type: "chat.steer", code: "command.invalid_payload", message: "实例 inst-1 非运行中" },
    ]);

    const plain = new Error("plain-boom");
    const { errors: errors2, warns } = await capture((errors) => {
      handleChatSteer(steerCtx(plain, errors) as ChatCommandContext);
    });
    // H5：兑底同回执 daemon.internal + warn 保留
    expect(errors2).toEqual([{ type: "chat.steer", code: "daemon.internal", message: "plain-boom" }]);
    expect(warns.some((w) => w.includes("plain-boom"))).toBe(true);
  });

  test("判别点④：loadHistory 二元映射——SessionNotFoundError → session.not_found；无 code 旧对象 → session.invalid_cursor", async () => {
    const { errors } = await capture((errors) => {
      handleSessionLoadHistory(loadHistoryCtx(new SessionNotFoundError("s1"), errors) as SessionCommandContext);
    });
    expect(errors).toEqual([{ type: "session.loadHistory", code: "session.not_found", message: "会话 s1 不存在" }]);

    const { errors: errors2 } = await capture((errors) => {
      handleSessionLoadHistory(loadHistoryCtx(new Error("游标不在主轴"), errors) as SessionCommandContext);
    });
    expect(errors2).toEqual([
      { type: "session.loadHistory", code: "session.invalid_cursor", message: "游标不在主轴" },
    ]);
  });

  test("判别点⑤：delete 三元链——delete_in_progress / not_found / 兑底 invalid_payload", async () => {
    const cases: ReadonlyArray<[unknown, Recorded]> = [
      [
        new SessionDeleteInProgressError("s1"),
        { type: "session.delete", code: "session.delete_in_progress", message: "会话 s1 删除进行中（重复请求）" },
      ],
      [new SessionNotFoundError("s1"), { type: "session.delete", code: "session.not_found", message: "会话 s1 不存在" }],
      [
        new Error("库删除失败（无 code）"),
        { type: "session.delete", code: "command.invalid_payload", message: "库删除失败（无 code）" },
      ],
    ];
    for (const [reject, expected] of cases) {
      const { errors } = await capture((errors) => {
        handleSessionDelete(deleteCtx(reject, errors) as SessionCommandContext);
      });
      expect(errors).toEqual([expected]);
    }
  });

  test("判别点⑥：modelErrorCode 集中映射——三专用码 + 无 code 旧对象兑底 invalid_payload", () => {
    // 纯映射函数（无实例态）：prototype 直呼，免整适配器装配（ws-server 真链
    // 等价由既有 integration 测试钉死——ws-server.test.ts model_not_found /
    // provider_not_found 注入）
    const modelErrorCode = (
      WsServerAdapter.prototype as unknown as { modelErrorCode: (err: Error) => ErrorCode }
    ).modelErrorCode;
    expect(modelErrorCode(new SessionNotFoundError("s1"))).toBe("session.not_found");
    expect(modelErrorCode(new ModelNotFoundError("prov/x"))).toBe("model_not_found");
    expect(modelErrorCode(new ProviderNotFoundError("prov"))).toBe("provider_not_found");
    expect(modelErrorCode(new Error("unknown（无 code 旧对象）"))).toBe("command.invalid_payload");
  });
});

describe("TP-1.5c 结构断言：err.name 字符串判别零残留（先红：现状 6 判别点）", () => {
  test("ws-server 目录 `name === \"` 判别模式零命中（\\b 词边界防 pathname 误伤）", () => {
    const wsDir = path.join(srcRoot, "adapters", "driving", "ws-server");
    const hits: string[] = [];
    for (const rel of listTsFiles(wsDir)) {
      hits.push(...grepLines(path.join(wsDir, rel), /\bname === "/).map((l) => `${rel}:${l}`));
    }
    expect(hits, `err.name 字符串判别残留（应改 err.code 码匹配）：\n${hits.join("\n")}`).toEqual([]);
  });
});

describe("TP-1.5e① 结构断言：settleRunEnd void t 消除（D12-1）", () => {
  test("ChatService 源码 `void t;` 零残留（与 finishOpenTurn 同构直接语句调用）", () => {
    const file = path.join(srcRoot, "application", "services", "ChatService.ts");
    const hits = grepLines(file, /\bvoid t;/);
    expect(hits, `void t 残留（应改直接语句调用不接返回值）：\n${hits.join("\n")}`).toEqual([]);
  });
});
