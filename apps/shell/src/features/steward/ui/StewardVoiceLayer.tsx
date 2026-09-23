/**
 * StewardVoiceLayer —— 管家全局光球层（B2 全局语音批；设计稿
 * docs/temp/helix-steward-global-redesign.md §3.2，D1=A）。
 *
 * 形态（E-135 浮层三分法第 1 档：真全屏语义——fixed 视口层，AppRoutes
 * 独立挂载 .app-shell 兄弟位，路由切换不卸载，z 序压过 StewardDock/
 * scanline；**不做 OS 级置顶**——组件按独立 root 设计保留升 B3 可能）：
 * - **StewardOrb** 光球（右下角 ~96px）：相位状态机呈现（deriveOrbPhase：
 *   waking→welcome→listening→thinking→speaking→closing）+ RMS 波形环
 *   （level 驱动 scaleY）+ 呼吸动画（transform/opacity only，E-124）；
 *   相位色彩走 accent/violet/error 通道 token 零内联 hex；
 * - **StewardCaption** 字幕条（光球上方，玻璃族）：用户行（interim 灰/
 *   final 实）与管家行（ask.delta 聚合）弱区分，堆叠渐隐最新在下（上限
 *   4 行）；纯 fixed 文本层零滚动容器（E-124 WKWebView sticky 坑）；
 *   视觉=用户裁决例外（直角/无边框/满窗高，溢出裁顶保最新行——
 *   详见 app.css .stv-caption 段注）；
 * - 点击行为（D5）：speaking 点击 = 停读；listening/muted 点击 = 临时
 *   静音切换；
 * - 欢迎语：进入双工字幕同步（TTS 归 hook say 链）；
 * - 语音口令（D3=b）：final 整句本地解析（voice-command 纯函数）→ 既有
 *   steward.confirm/steward.cancel（零新协议帧）+ 动作后回读（say + 字幕）；
 *   卡栈快照取 useStewardActions 副实例（帧驱动同构副本——B1 多听众
 *   扇出面先例，与 ConfirmStack 各自订阅同一帧源）；
 * - wakeSignal（app 层 steward-open-signal 接线计数）：递增 → 唤起光球
 *   （不弹面板——B2 唤醒语义）；已在会话幂等零重开。
 *
 * 生命周期：关麦（duplex 落）→ 0.18s 淡出（reduced-motion 直切）→ 卸载
 * 光球/字幕 DOM；duplex=false 零渲染（app 壳级轻驻留）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useStewardVoice } from "../model/useStewardVoice";
import { useStewardActions } from "../model/useStewardActions";
import { deriveOrbPhase } from "../model/steward-voice-machine";
import { parseVoiceCommand, resolveVoiceCommand } from "../model/voice-command";
import { captionPush, captionUpdateTail, type CaptionLine } from "../model/caption-log";
import { useI18n } from "@/shared/i18n";

/** 光球淡出时长（ms；reduced-motion 直切不等待）。 */
export const ORB_FADE_MS = 180;

export interface StewardVoiceLayerProps {
  /** app 层 steward-open-signal 接线计数（递增即唤起——app 层订阅信号推进）。 */
  readonly wakeSignal?: number;
}

const StewardVoiceLayer = function StewardVoiceLayer({ wakeSignal = 0 }: StewardVoiceLayerProps) {
  const { t } = useI18n();
  // ── 口令数据面：useStewardActions 副实例（帧驱动同构副本——与
  //    ConfirmStack 单实例各自订阅同一帧源，卡栈状态同步演进）──
  const actions = useStewardActions();
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  // ── 字幕行栈（呈现面数据；interim 实时行不入栈）──
  const [lines, setLines] = useState<readonly CaptionLine[]>([]);
  const pushLine = useCallback((kind: CaptionLine["kind"], text: string) => {
    setLines((prev) => captionPush(prev, kind, text));
  }, []);

  // ── 语音口令（D3=b）：final 整句拦截——口令本地解析 + 卡栈快照裁决 +
  //    动作执行（既有命令）+ 回读（say + 字幕）；非口令句 pass 走 ask。──
  const sayRef = useRef<(text: string) => void>(() => undefined);
  const onFinalText = useCallback(
    (text: string): "consumed" | "pass" => {
      pushLine("user", text); // 用户行入字幕（final 实——口令句也是说出的话）
      const command = parseVoiceCommand(text);
      if (command === null) return "pass"; // 聊天句：零拦截
      const result = resolveVoiceCommand(command, actionsRef.current.cards);
      let reply: string;
      if (result.kind === "none") {
        reply =
          result.reason === "noCards"
            ? t("steward.voice.cmdNoCards")
            : result.reason === "notFound"
              ? t("steward.voice.cmdNotFound", { n: result.seq ?? 0 })
              : t("steward.voice.cmdSettled", { n: result.seq ?? 0 });
      } else if (result.kind === "cancelAll") {
        for (const target of result.targets) actionsRef.current.cancelCard(target.actionId);
        reply = t("steward.voice.cmdCancelAllOk", { n: result.targets.length });
      } else {
        const target = result.targets[0]!;
        if (result.kind === "confirm") {
          const ok = actionsRef.current.confirmCard(target.actionId);
          reply = ok ? t("steward.voice.cmdConfirmOk", { target: target.agentId }) : t("chat.modelsConfig.sendFailToast");
        } else {
          actionsRef.current.cancelCard(target.actionId);
          reply = t("steward.voice.cmdCancelOk", { target: target.agentId });
        }
      }
      setLines((prev) => captionPush(prev, "steward", reply)); // 回读字幕
      sayRef.current(reply); // 回读音频（money 闸内判）
      return "consumed";
    },
    [pushLine, t],
  );

  const sv = useStewardVoice({ onFinalText, welcomeText: t("steward.voice.welcome") });
  sayRef.current = sv.say;

  // ── 欢迎语字幕（进入双工：steward 行入栈——TTS 归 hook 欢迎语链）──
  const welcomedForRef = useRef(false);
  useEffect(() => {
    if (!sv.duplexActive) {
      welcomedForRef.current = false; // 会话收场复位（下轮再欢迎）
      return;
    }
    if (welcomedForRef.current) return;
    welcomedForRef.current = true;
    setLines((prev) => captionPush(prev, "steward", t("steward.voice.welcome")));
  }, [sv.duplexActive, t]);

  // ── 管家流式行：streamingText 增量入字幕（in-place 更新不涨行）；终态
  //    权威文本（items 末尾 assistant）定格同一行。──
  useEffect(() => {
    if (sv.streamingText === null || sv.streamingText === "") return;
    setLines((prev) => captionUpdateTail(prev, "steward", sv.streamingText ?? ""));
  }, [sv.streamingText]);
  const lastAssistantRef = useRef<string | null>(null);
  useEffect(() => {
    for (let i = sv.items.length - 1; i >= 0; i -= 1) {
      const item = sv.items[i]!;
      if (item.kind === "assistant") {
        if (item.text !== lastAssistantRef.current) {
          lastAssistantRef.current = item.text;
          setLines((prev) => captionUpdateTail(prev, "steward", item.kind === "assistant" ? item.text : ""));
        }
        return;
      }
    }
  }, [sv.items]);

  // ── wakeSignal 接线（app 层 steward-open-signal 计数消费）：递增 →
  //    唤起光球（duplex 开——不弹面板）；已在会话幂等零重开。──
  const lastSignalRef = useRef(wakeSignal);
  useEffect(() => {
    if (wakeSignal <= lastSignalRef.current) return;
    lastSignalRef.current = wakeSignal;
    if (sv.duplexActive) return; // 已在会话：无感幂等
    sv.toggleWake();
  }, [wakeSignal, sv]);

  // ── 光球淡出窗（D6）：duplex 落 → 0.18s closing → 卸载 DOM；
  //    reduced-motion 直切（零 timer）。──
  const [orbMounted, setOrbMounted] = useState(false);
  useEffect(() => {
    if (sv.duplexActive) {
      setOrbMounted(true);
      return;
    }
    if (!orbMounted) return;
    const reduced =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setOrbMounted(false);
      return;
    }
    const timer = setTimeout(() => setOrbMounted(false), ORB_FADE_MS);
    return () => clearTimeout(timer);
  }, [sv.duplexActive, orbMounted]);

  const fading = orbMounted && !sv.duplexActive;
  const orbPhase = deriveOrbPhase({
    phase: sv.phase,
    duplex: sv.duplexActive,
    fading,
    welcome: sv.welcomeActive,
  });

  // 点击（D5）：speaking → 停读；listening/muted → 临时静音切换（恢复）
  const onOrbClick = useCallback(() => {
    if (sv.speaking) {
      sv.stopSpeaking();
      return;
    }
    sv.toggleMute();
  }, [sv]);

  if (orbPhase === null) return null;
  const showInterim = sv.interim !== null && sv.interim !== "";
  return (
    <div
      className={fading ? "stv stv-fading" : "stv"}
      data-testid="steward-voice-layer"
      data-fading={fading ? "on" : "off"}
    >
      <div className="stv-caption" data-testid="steward-caption" aria-live="polite">
        {lines.map((line) => (
          <div key={line.id} className="stv-line" data-kind={line.kind}>
            {line.text}
          </div>
        ))}
        {showInterim && (
          <div className="stv-line stv-interim" data-kind="user" data-interim="on" data-testid="steward-interim">
            {sv.interim}
          </div>
        )}
      </div>
      <button
        type="button"
        className={`stv-orb stv-phase-${orbPhase}${sv.muted ? " stv-muted" : ""}`}
        data-testid="steward-orb"
        data-phase={orbPhase}
        style={{ "--stv-lv": Math.max(0.15, sv.level).toFixed(3) } as React.CSSProperties}
        aria-label={sv.muted ? t("steward.voice.orbMuted") : sv.speaking ? t("steward.voice.orbStopRead") : t("steward.voice.orbLabel")}
        title={sv.speaking ? t("steward.voice.orbStopRead") : undefined}
        onClick={onOrbClick}
      >
        <span className="stv-orb-ring" aria-hidden="true" />
        <span className="stv-orb-core" aria-hidden="true" />
      </button>
    </div>
  );
};

export default StewardVoiceLayer;
