/**
 * stt 族命令处理（语音输入批 V1 Phase 1 + V3b-1 流式批；handlers/ 落位 =
 * handlers/web.ts 点对点结果帧先例）。
 *
 * - stt.transcribe → 词汇表装配（P1 会话源 + P3 基础词表）→ SttPort 转写
 *   → stt.transcribe.result 点对点回执（sendNow 直发发起连接，TR-AD-21
 *   模式）；
 * - stt.stream.start/chunk/finish/stop（V3b-1）→ SttStreamService 连接级
 *   单流生命周期（词汇表装配同源 buildSttContext；帧组装在 service，
 *   帧序 = 上游回调序——TR-188/189 纪律）；
 * - 会话归属自查：信封 sessionId 携带时经 directory.resolveTarget 校验
 *   （不存在的会话 → error 回执而非静默裸转写——前端不传不该传的）；
 *   省略 = 无会话裸转写（词汇表仅基础词表）；
 * - provider 选择：非流式 selectSttProvider（纯函数，V1）；流式在
 *   SttStreamService 内同构选择（仅流式 capable 清单）；
 * - 回执两判别：ok = 转写文本；error = 业务失败（key 未配/网络/provider
 *   拒绝——reason 含引导）。payload 级错误（audio 非法）走 commandError
 *   通道（协议面错误语义，web.start skipped 判别先例同构）。
 */
import type { SttStreamFrame, SttStreamService } from "../../../../application/stt/SttStreamService";
import type { SttTranscribeResultEvent } from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { ErrorCode } from "@helix/protocol";
import type { SttPort } from "../../../../application/ports/outbound/SttPort";
import type { SessionEntryData } from "../../../../domain/session/SessionSnapshot";
import type { AsrContext } from "../../../../application/stt/VocabularyBuilder";
import {
  BASE_VOCABULARY,
  buildAsrContext,
  extractSessionTokens,
} from "../../../../application/stt/VocabularyBuilder";
import type { SessionDirectoryPort } from "../../../../application/ports/inbound/SessionDirectoryPort";
import type { SttCommandContext } from "./context";
import { reportInternalFailure } from "./payload-guards";

/** P1 会话源采样条数（最近 N 条 user/assistant 消息；> 新近度窗口 10 覆盖衰减梯度）。 */
export const SESSION_SOURCE_MESSAGES = 16;

/**
 * provider 选择（纯函数）：显式 provider 指定优先（注册表内找不到 →
 * unknown 错误）；缺省 = 装配优先序内首个已配 key 的 provider；全部未配
 * → no_key 错误（reason 由调用方组装引导文案）。
 */
export function selectSttProvider(
  providers: readonly SttPort[],
  apiKeyOf: (providerId: string) => string | undefined,
  requested?: string,
): { port: SttPort; configured: true } | { port: undefined; configured: false; reason: string } {
  if (requested !== undefined) {
    const found = providers.find((p) => p.providerId === requested);
    if (found === undefined) {
      return {
        port: undefined,
        configured: false,
        reason: `未知 STT provider "${requested}"（可用：${providers.map((p) => p.providerId).join(" / ")}）`,
      };
    }
    if ((apiKeyOf(found.providerId) ?? "") === "") {
      return {
        port: undefined,
        configured: false,
        reason: `provider "${found.providerId}" 未录入 API key（请经设置页语音输入区 auth.set_key 录入）`,
      };
    }
    return { port: found, configured: true };
  }
  const withKey = providers.find((p) => (apiKeyOf(p.providerId) ?? "") !== "");
  if (withKey === undefined) {
    return {
      port: undefined,
      configured: false,
      reason: `全部 STT provider 未录入 API key（${providers.map((p) => `"${p.providerId}"`).join(" / ")}——请经设置页语音输入区 auth.set_key 录入）`,
    };
  }
  return { port: withKey, configured: true };
}

/**
 * 词汇表装配（transcribe 与 stream.start 同源）：信封 sessionId 携带时
 * 归属自查 + P1 会话源采样；省略 = 裸转写（仅基础词表）。
 */
async function buildSttContext(
  directory: SessionDirectoryPort,
  envelopeSessionId: string | undefined,
): Promise<{ sessionId: string | undefined; context: AsrContext }> {
  let sessionId: string | undefined;
  let sessionTerms: string[] = [];
  if (envelopeSessionId !== undefined) {
    sessionId = await directory.resolveTarget(envelopeSessionId); // 不存在 → session.not_found 抛错
    const view = await directory.getSessionView(sessionId);
    const recent = view.session.entries
      .filter((e): e is Extract<SessionEntryData, { role: unknown }> => "role" in e && (e.role === "user" || e.role === "assistant"))
      .slice(-SESSION_SOURCE_MESSAGES)
      .reverse(); // 最近在前（extractSessionTokens 新近度衰减口径）
    sessionTerms = [...extractSessionTokens(recent.map((e) => e.text)).values()].map((t) => t.term);
  }
  const context = buildAsrContext({ sessionTerms, baseTerms: BASE_VOCABULARY });
  return { sessionId, context };
}

/** stt.transcribe（会话作用域可选命令）：词汇表装配 + 转写 + 点对点回执。 */
export function handleSttTranscribe(ctx: SttCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const audio = ctx.payload.audio;
  if (typeof audio !== "string" || !audio.startsWith("data:audio/")) {
    return ctx.commandError(
      ctx.type,
      "command.invalid_payload",
      "payload.audio 应为 base64 data URL（data:audio/…;base64,…）",
    );
  }
  if (ctx.payload.provider !== undefined && typeof ctx.payload.provider !== "string") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.provider 应为 string");
  }
  if (ctx.payload.language !== undefined && typeof ctx.payload.language !== "string") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.language 应为 string");
  }
  const provider = typeof ctx.payload.provider === "string" && ctx.payload.provider !== ""
    ? ctx.payload.provider
    : undefined;
  const language = typeof ctx.payload.language === "string" && ctx.payload.language !== ""
    ? ctx.payload.language
    : undefined;

  const run = async (): Promise<void> => {
    const envelopeSessionId =
      typeof ctx.envelope.sessionId === "string" && ctx.envelope.sessionId !== ""
        ? ctx.envelope.sessionId
        : undefined;
    const { sessionId, context } = await buildSttContext(ctx.directory, envelopeSessionId);

    const selection = selectSttProvider(ctx.stt.providers, ctx.stt.apiKeyOf, provider);
    if (!selection.configured) {
      const frame: SttTranscribeResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: sessionId ?? SYSTEM_SESSION_ID,
        channel: "stt",
        type: "stt.transcribe.result",
        payload: { status: "error", reason: selection.reason },
      };
      ctx.sendNow(sender, frame);
      return;
    }

    let result;
    try {
      result = await selection.port.transcribe({ audio, language, context });
    } catch (err) {
      const frame: SttTranscribeResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: sessionId ?? SYSTEM_SESSION_ID,
        channel: "stt",
        type: "stt.transcribe.result",
        payload: { status: "error", reason: (err as Error).message },
      };
      ctx.sendNow(sender, frame);
      return;
    }
    const frame: SttTranscribeResultEvent = {
      v: PROTOCOL_VERSION,
      sessionId: sessionId ?? SYSTEM_SESSION_ID,
      channel: "stt",
      type: "stt.transcribe.result",
      payload: {
        status: "ok",
        text: result.text,
        provider: selection.port.providerId,
        ...(result.language !== undefined ? { language: result.language } : {}),
      },
    };
    ctx.sendNow(sender, frame);
  };
  void run().catch((err) => {
    // F2 归位（session.ts:137-139 判别先例）：session.not_found 只覆盖
    // resolveTarget 会话不存在；buildSttContext/组帧等意外异常归
    // daemon.internal（服务端故障非会话缺失，原全量 not_found 误导排障）。
    const code =
      (err as { code?: ErrorCode }).code === "session.not_found" ? "session.not_found" : "daemon.internal";
    ctx.commandError(ctx.type, code, `stt.transcribe 执行失败：${(err as Error).message}`);
  });
}

// ── 流式转写批（V3b-1）：stt.stream 四命令（生命周期全在 SttStreamService）──

/** 流式面解析（stt.stream.* 仅在 stream 装配后路由可达——routeCommand 门控）。 */
function streamServiceOf(ctx: SttCommandContext): SttStreamService | undefined {
  return ctx.stt.stream?.service;
}

/** 信封 sessionId 可选解析（stt.transcribe 同口径；省略 = 无会话裸转写）。 */
function envelopeSessionIdOf(ctx: SttCommandContext): string | undefined {
  return typeof ctx.envelope.sessionId === "string" && ctx.envelope.sessionId !== ""
    ? ctx.envelope.sessionId
    : undefined;
}

/**
 * stt.stream.start（全局命令；会话作用域可选）：开流。连接级单流（重复
 * start 废旧流）；词汇表装配异步在途（buildSttContext 同源——P1 会话源
 * + corpus 偏置）；帧经 sendNow 点对点直发发起连接。
 */
export function handleSttStreamStart(ctx: SttCommandContext): void {
  const service = streamServiceOf(ctx);
  if (service === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", `命令未装配：${ctx.type}`);
  }
  if (ctx.payload.language !== undefined && typeof ctx.payload.language !== "string") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.language 应为 string");
  }
  if (ctx.payload.provider !== undefined && typeof ctx.payload.provider !== "string") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.provider 应为 string");
  }
  const language = typeof ctx.payload.language === "string" && ctx.payload.language !== "" ? ctx.payload.language : undefined;
  const provider = typeof ctx.payload.provider === "string" && ctx.payload.provider !== "" ? ctx.payload.provider : undefined;
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const envelopeSessionId = envelopeSessionIdOf(ctx);
  const emit = (frame: SttStreamFrame): void => ctx.sendNow(sender, frame);
  service.start(sender, {
    language,
    provider,
    sessionId: envelopeSessionId ?? SYSTEM_SESSION_ID,
    buildContext: async () => (await buildSttContext(ctx.directory, envelopeSessionId)).context,
    emit,
  });
}

/** stt.stream.chunk（全局命令）：音频块上行（base64 PCM 16k mono；无 ack）。 */
export function handleSttStreamChunk(ctx: SttCommandContext): void {
  const service = streamServiceOf(ctx);
  if (service === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", `命令未装配：${ctx.type}`);
  }
  const audio = ctx.payload.audio;
  if (typeof audio !== "string" || audio === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.audio 应为非空 string（base64 PCM 16k mono）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  service.chunk(sender, audio);
}

/** stt.stream.finish（全局命令）：正常收口（终帧经 stt.stream.final 下发）。 */
export function handleSttStreamFinish(ctx: SttCommandContext): void {
  const service = streamServiceOf(ctx);
  if (service === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", `命令未装配：${ctx.type}`);
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  service.finish(sender);
}

/** stt.stream.stop（全局命令）：中止（不期终帧；断连自动等效）。 */
export function handleSttStreamStop(ctx: SttCommandContext): void {
  const service = streamServiceOf(ctx);
  if (service === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", `命令未装配：${ctx.type}`);
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  service.stop(sender);
}
