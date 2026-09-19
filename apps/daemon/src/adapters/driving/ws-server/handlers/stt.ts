/**
 * stt 族命令处理（语音输入批 V1 Phase 1；handlers/ 落位 = handlers/web.ts
 * 点对点结果帧先例）。
 *
 * - stt.transcribe → 词汇表装配（P1 会话源 + P3 基础词表）→ SttPort 转写
 *   → stt.transcribe.result 点对点回执（sendNow 直发发起连接，TR-AD-21
 *   模式）；
 * - 会话归属自查：信封 sessionId 携带时经 directory.resolveTarget 校验
 *   （不存在的会话 → error 回执而非静默裸转写——前端不传不该传的）；
 *   省略 = 无会话裸转写（词汇表仅基础词表）；
 * - provider 选择（selectSttProvider 纯函数）：payload.provider 显式指定
 *   优先；缺省 = 装配序（dashscope → siliconflow）内首个已配 key 的
 *   provider；全部未配 → error 回执（含设置页录入引导）；
 * - 回执两判别：ok = 转写文本（草稿回填源）；error = 业务失败（key 未配/
 *   网络/provider 拒绝——reason 含引导）。payload 级错误（audio 非法）走
 *   commandError 通道（协议面错误语义，web.start skipped 判别先例同构）。
 */
import type { SttTranscribeResultEvent } from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { SttPort } from "../../../../application/ports/outbound/SttPort";
import type { SessionEntryData } from "../../../../domain/session/SessionSnapshot";
import {
  BASE_VOCABULARY,
  buildAsrContext,
  extractSessionTokens,
} from "../../../../application/stt/VocabularyBuilder";
import type { SttCommandContext } from "./context";

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
    // 会话归属自查 + P1 会话源：最近 N 条 user/assistant 消息文本（最近在前）
    const envelopeSessionId =
      typeof ctx.envelope.sessionId === "string" && ctx.envelope.sessionId !== ""
        ? ctx.envelope.sessionId
        : undefined;
    let sessionId: string | undefined;
    let sessionTerms: string[] = [];
    if (envelopeSessionId !== undefined) {
      sessionId = await ctx.directory.resolveTarget(envelopeSessionId); // 不存在 → session.not_found 抛错
      const view = await ctx.directory.getSessionView(sessionId);
      const recent = view.session.entries
        .filter((e): e is Extract<SessionEntryData, { role: unknown }> => "role" in e && (e.role === "user" || e.role === "assistant"))
        .slice(-SESSION_SOURCE_MESSAGES)
        .reverse(); // 最近在前（extractSessionTokens 新近度衰减口径）
      sessionTerms = [...extractSessionTokens(recent.map((e) => e.text)).values()].map((t) => t.term);
    }

    const context = buildAsrContext({ sessionTerms, baseTerms: BASE_VOCABULARY });

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
  void run().catch((err) =>
    ctx.commandError(
      ctx.type,
      "session.not_found",
      `stt.transcribe 执行失败：${(err as Error).message}`,
    ),
  );
}
