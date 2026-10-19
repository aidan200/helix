/**
 * SttStreamService 单测（V3b-1 流式转写批；TDD 红绿证据链）。
 *
 * 断言面：
 * - start 全链帧序：onStarted → started(ok) 帧（streamId/provider/model）、
 *   onInterim → interim 帧（prior/text/stash + streamId）、onFinal →
 *   final(ok) 帧 + 会话清理；
 * - 开流前失败（provider 未知/key 未配/open 抛）→ started(error) 帧
 *   （非 final——流未建立，shell 直接回落非流式）；
 * - 开流后失败（onError）→ final(error) 帧；
 * - pending start（buildContext 在途）期间 chunk 缓冲、就绪后依序冲刷；
 * - 连接级单流：重复 start 废弃旧流（abort 旧 session）；chunk/finish/stop
 *   无会话静默；closeSender（断连）abort + 清位；
 * - provider 选择：显式 provider 未知名/缺 key → started error；缺省 =
 *   首个已配 key 的流式 adapter。
 *
 * adapter 全程注入 fake（零真实网络）。
 */
import { describe, expect, test } from "bun:test";
import { SttStreamService, type SttStreamStartOptions } from "../../src/application/stt/SttStreamService";
import type {
  SttStreamCallbacks,
  SttStreamOpenOptions,
  SttStreamPort,
  SttStreamSession,
} from "../../src/application/ports/outbound/SttStreamPort";
import type { AsrContext } from "../../src/application/stt/VocabularyBuilder";
import type {
  SttStreamFinalEvent,
  SttStreamInterimEvent,
  SttStreamStartedEvent,
} from "@helix/protocol";

const CONTEXT: AsrContext = { terms: [], hint: "Paraformer" };

/** fake 流式 adapter：手动驱动回调；记录 open 参数。 */
class FakeStreamPort implements SttStreamPort {
  readonly providerId = "dashscope";
  readonly model = "qwen3-asr-flash-realtime";
  readonly opens: SttStreamOpenOptions[] = [];
  readonly sessions: FakeSession[] = [];
  failOpen: string | null = null;

  open(options: SttStreamOpenOptions): SttStreamSession {
    if (this.failOpen !== null) throw new Error(this.failOpen);
    this.opens.push(options);
    const s = new FakeSession();
    this.sessions.push(s);
    return s;
  }
}

class FakeSession implements SttStreamSession {
  appended: string[] = [];
  finished = false;
  finishCount = 0;
  aborted = false;
  get dead(): boolean {
    return this.aborted;
  }
  appendAudio(base64Pcm: string): void {
    this.appended.push(base64Pcm);
  }
  finish(): void {
    this.finished = true;
    this.finishCount += 1;
  }
  abort(): void {
    this.aborted = true;
  }
}

interface Rig {
  service: SttStreamService;
  port: FakeStreamPort;
  keys: Map<string, string | undefined>;
  frames: Array<SttStreamStartedEvent | SttStreamInterimEvent | SttStreamFinalEvent>;
  sender: object;
  start(overrides?: Partial<SttStreamStartOptions>): void;
}

function rig(adapters: readonly SttStreamPort[], key = "sk-test", ids: string[] = []): Rig {
  const port = adapters[0] as FakeStreamPort;
  const keys = new Map<string, string | undefined>([["dashscope", key], ["other", "sk-other"]]);
  const frames: Rig["frames"] = [];
  let i = 0;
  const service = new SttStreamService({
    adapters,
    apiKeyOf: (id) => keys.get(id),
    newStreamId: () => ids[i++] ?? `str-${i}`,
  });
  const sender = {};
  return {
    service,
    port,
    keys,
    frames,
    sender,
    start(overrides: Partial<SttStreamStartOptions> = {}) {
      service.start(sender, {
        buildContext: async () => CONTEXT,
        sessionId: "sess-1",
        emit: (frame) => frames.push(frame),
        ...overrides,
      });
    },
  };
}

/** 驱动 microtask（async buildContext 完成）。 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("SttStreamService：start 全链帧序", () => {
  test("onStarted → started(ok)（streamId/provider/model）→ interim → final(ok) 后清理", async () => {
    const r = rig([new FakeStreamPort()]);
    r.start();
    await flush();
    const port = r.port.sessions[0]!;
    const cb = r.port.opens[0]!.callbacks as SttStreamCallbacks;
    cb.onStarted();
    cb.onInterim({ prior: "", text: "帮我", stash: "把" });
    cb.onFinal("帮我把");
    const [started, interim, final] = r.frames as [SttStreamStartedEvent, SttStreamInterimEvent, SttStreamFinalEvent];
    expect(started.type).toBe("stt.stream.started");
    expect(started.payload).toEqual({ status: "ok", streamId: "str-1", provider: "dashscope", model: "qwen3-asr-flash-realtime" });
    expect(interim.type).toBe("stt.stream.interim");
    expect(interim.payload).toEqual({ streamId: "str-1", prior: "", text: "帮我", stash: "把" });
    expect(final.type).toBe("stt.stream.final");
    expect(final.payload).toEqual({ status: "ok", streamId: "str-1", text: "帮我把", provider: "dashscope" });
    // 清理：final 后 chunk 静默（无会话）
    r.service.chunk(r.sender, "AA");
    expect(port.appended).toEqual([]);
    expect(port.aborted).toBe(false);
  });

  test("开流前失败 → started(error)（非 final 帧）；无 streamId", async () => {
    const port = new FakeStreamPort();
    port.failOpen = "连接超时";
    const r = rig([port]);
    r.start();
    await flush();
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0]!.type).toBe("stt.stream.started");
    expect(r.frames[0]!.payload).toEqual({ status: "error", reason: expect.stringContaining("连接超时") });
  });

  test("开流后失败（onError 先于 started）→ started(error)（流未就绪语义）", async () => {
    const r = rig([new FakeStreamPort()]);
    r.start();
    await flush();
    const cb = r.port.opens[0]!.callbacks as SttStreamCallbacks;
    cb.onError("上游握手失败");
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0]!.payload).toEqual({ status: "error", reason: "上游握手失败" });
  });

  test("开流后失败（onError 在 started 后）→ final(error) + 清理", async () => {
    const r = rig([new FakeStreamPort()]);
    r.start();
    await flush();
    const cb = r.port.opens[0]!.callbacks as SttStreamCallbacks;
    cb.onStarted();
    cb.onError("60 秒无音频");
    expect(r.frames).toHaveLength(2);
    expect(r.frames[1]!.type).toBe("stt.stream.final");
    expect(r.frames[1]!.payload).toEqual({ status: "error", streamId: "str-1", reason: "60 秒无音频" });
  });

  test("buildContext 失败 → started(error)", async () => {
    const r = rig([new FakeStreamPort()]);
    r.start({ buildContext: async () => Promise.reject(new Error("session.not_found")) });
    await flush();
    expect(r.frames[0]!.payload).toEqual({ status: "error", reason: expect.stringContaining("session.not_found") });
  });
});

describe("SttStreamService：pending start 缓冲与连接级单流", () => {
  test("start 在途（buildContext 未决）chunk 缓冲、就绪后依序冲刷", async () => {
    const r = rig([new FakeStreamPort()]);
    let resolveCtx: (c: AsrContext) => void = () => {};
    r.start({ buildContext: () => new Promise<AsrContext>((res) => (resolveCtx = res)) });
    r.service.chunk(r.sender, "AA1");
    r.service.chunk(r.sender, "AA2");
    await flush();
    expect(r.port.sessions).toHaveLength(0); // 未 open
    resolveCtx(CONTEXT);
    await flush();
    expect(r.port.sessions[0]!.appended).toEqual(["AA1", "AA2"]);
  });

  test("重复 start 废弃旧流（abort）再开新流", async () => {
    const r = rig([new FakeStreamPort()]);
    r.start();
    await flush();
    const first = r.port.sessions[0]!;
    r.start();
    await flush();
    expect(first.aborted).toBe(true);
    expect(r.port.sessions).toHaveLength(2);
  });

  test("finish/stop 委派到会话；无会话静默", async () => {
    const r = rig([new FakeStreamPort()]);
    r.service.finish(r.sender); // 无会话 no-op
    r.service.stop(r.sender);
    r.service.chunk(r.sender, "AA"); // 无会话丢弃
    expect(r.port.sessions).toHaveLength(0);
    r.start();
    await flush();
    r.service.chunk(r.sender, "AA1");
    r.service.finish(r.sender);
    expect(r.port.sessions[0]!.appended).toEqual(["AA1"]);
    expect(r.port.sessions[0]!.finished).toBe(true);
    r.service.stop(r.sender);
    expect(r.port.sessions[0]!.aborted).toBe(true);
  });

  test("pending 期 finish 不丢（评审 F1）：open 就绪后先冲刷 chunk 再补发 upstream.finish()", async () => {
    // 占位句柄的 finish 原为静默 no-op——buildContext 在途期间 shell 发出
    // finish（用户松手）时意图被吞：上游永不收尾，只能等超时/dispose。
    const r = rig([new FakeStreamPort()]);
    let resolveCtx: (c: AsrContext) => void = () => {};
    r.start({ buildContext: () => new Promise<AsrContext>((res) => (resolveCtx = res)) });
    r.service.chunk(r.sender, "AA1");
    r.service.finish(r.sender); // pending 期 finish
    await flush();
    expect(r.port.sessions).toHaveLength(0); // 仍未 open
    resolveCtx(CONTEXT);
    await flush();
    const session = r.port.sessions[0]!;
    expect(session.appended).toEqual(["AA1"]); // 先冲刷缓冲
    expect(session.finished).toBe(true); // 再补发 finish
  });

  test("pending 期重复 finish 只补发一次（意图标记一次性消费）", async () => {
    const r = rig([new FakeStreamPort()]);
    let resolveCtx: (c: AsrContext) => void = () => {};
    r.start({ buildContext: () => new Promise<AsrContext>((res) => (resolveCtx = res)) });
    r.service.finish(r.sender);
    r.service.finish(r.sender);
    resolveCtx(CONTEXT);
    await flush();
    const session = r.port.sessions[0]!;
    expect(session.finishCount).toBe(1); // 就绪后只补发一次（标记已消费）
    r.service.finish(r.sender); // 就绪后的正常 finish 面（幂等，交给上游）
    expect(session.finishCount).toBe(2);
  });

  test("closeSender（连接断开）→ abort + 清位（chunk 不再缓冲）", async () => {
    const r = rig([new FakeStreamPort()]);
    r.start();
    await flush();
    const s = r.port.sessions[0]!;
    r.service.closeSender(r.sender);
    expect(s.aborted).toBe(true);
    r.service.chunk(r.sender, "AA");
    await flush();
    expect(s.appended).toEqual([]);
    expect(r.port.sessions).toHaveLength(1); // 无新开流
  });
});

describe("SttStreamService：provider 选择", () => {
  test("显式未知 provider → started(error)", async () => {
    const r = rig([new FakeStreamPort()]);
    r.start({ provider: "nope" });
    await flush();
    expect(r.frames[0]!.payload).toEqual({ status: "error", reason: expect.stringContaining("nope") });
  });

  test("缺省 = 首个已配 key 的 adapter；全未配 → error（含设置页引导）", async () => {
    const r = rig([new FakeStreamPort()], ""); // 空串同走未配 key 分支
    r.start();
    await flush();
    expect(r.frames[0]!.payload).toEqual({ status: "error", reason: expect.stringContaining("设置页") });
  });

  test("显式 provider 且已配 key → 用该 provider", async () => {
    const port = new FakeStreamPort();
    const r = rig([port], "sk-test");
    r.start({ provider: "dashscope" });
    await flush();
    expect(r.port.opens).toHaveLength(1);
  });
});
