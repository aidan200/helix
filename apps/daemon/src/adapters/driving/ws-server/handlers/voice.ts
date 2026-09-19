/**
 * voice 族命令处理（语音播报批 V2 TTS；handlers/ 落位 = handlers/stt.ts
 * 点对点结果帧先例）。
 *
 * - voice.synthesize → TtsPort 合成 → voice.synthesize.result 点对点回执
 *   （sendNow 直发发起连接，TR-AD-21 模式）——设置页「试听」面；
 *   payload 校验：text 非空 string（≤500 字符防御上限）；
 * - voice.subscribe / voice.unsubscribe → EventStream 连接级订阅位登记
 *   （BroadcastService money gate 的数据面——零订阅连接 = 零合成零花费）；
 *   断连自动等效（detach 清位）；
 * - 回执两判别：ok = 音频 data URL（试听播放源）；error = 业务失败
 *   （key 未配/网络/provider 拒绝——reason 含引导）。payload 级错误
 *   （text 非法）走 commandError 通道（协议面错误语义，stt 先例同构）。
 */
import type { VoiceSynthesizeResultEvent } from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { VoiceCommandContext } from "./context";

/** 试听文本防御上限（设置页固定短句；广播路径经模板截断不经此处）。 */
const SYNTHESIZE_TEXT_MAX = 500;

/** voice.synthesize（全局命令）：一次性合成 + 点对点回执。 */
export function handleVoiceSynthesize(ctx: VoiceCommandContext): void {
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const text = ctx.payload.text;
  if (typeof text !== "string" || text.trim() === "") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.text 应为非空 string");
  }
  if (text.length > SYNTHESIZE_TEXT_MAX) {
    return ctx.commandError(ctx.type, "command.invalid_payload", `payload.text 超长（≤${SYNTHESIZE_TEXT_MAX} 字符）`);
  }
  if (ctx.payload.voice !== undefined && typeof ctx.payload.voice !== "string") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.voice 应为 string");
  }
  if (ctx.payload.language !== undefined && typeof ctx.payload.language !== "string") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.language 应为 string");
  }
  const voice = typeof ctx.payload.voice === "string" && ctx.payload.voice !== "" ? ctx.payload.voice : undefined;
  const language = typeof ctx.payload.language === "string" && ctx.payload.language !== "" ? ctx.payload.language : undefined;

  const run = async (): Promise<void> => {
    // key 缺失不在此预检——adapter 是 fail-fast 权威（同款中文引导错误经
    // catch 转发回执；fake TTSPort 注入形态（集成测试）不受真体 key 面影响）
    let result;
    try {
      result = await ctx.voice.tts.synthesize({ text, ...(voice !== undefined ? { voice } : {}), ...(language !== undefined ? { language } : {}) });
    } catch (err) {
      const frame: VoiceSynthesizeResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "voice",
        type: "voice.synthesize.result",
        payload: { status: "error", reason: (err as Error).message },
      };
      ctx.sendNow(sender, frame);
      return;
    }
    const frame: VoiceSynthesizeResultEvent = {
      v: PROTOCOL_VERSION,
      sessionId: SYSTEM_SESSION_ID,
      channel: "voice",
      type: "voice.synthesize.result",
      payload: {
        status: "ok",
        audio: result.audio,
        provider: ctx.voice.tts.providerId,
        ...(voice !== undefined ? { voice } : {}),
      },
    };
    ctx.sendNow(sender, frame);
  };
  void run().catch((err) =>
    ctx.commandError(ctx.type, "command.invalid_payload", `voice.synthesize 执行失败：${(err as Error).message}`),
  );
}

/** voice.subscribe（全局命令）：连接级播报订阅登记（音色偏好随命令携带）。 */
export function handleVoiceSubscribe(ctx: VoiceCommandContext): void {
  if (ctx.payload.voice !== undefined && typeof ctx.payload.voice !== "string") {
    return ctx.commandError(ctx.type, "command.invalid_payload", "payload.voice 应为 string");
  }
  const voice = typeof ctx.payload.voice === "string" && ctx.payload.voice !== "" ? ctx.payload.voice : undefined;
  // 订阅登记用 attach 注册的同一 sender（task.subscribe 先例：sender 缺席 = 握手未完成，静默无效）
  const sender = ctx.ws.data.sender;
  if (sender !== undefined && sender !== null) ctx.voice.stream.subscribeVoice(sender, voice);
}

/** voice.unsubscribe（全局命令）：连接级播报订阅清位（断连自动等效）。 */
export function handleVoiceUnsubscribe(ctx: VoiceCommandContext): void {
  const sender = ctx.ws.data.sender;
  if (sender !== undefined && sender !== null) ctx.voice.stream.unsubscribeVoice(sender);
}
