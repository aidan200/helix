/**
 * StewardVoiceLayer —— 管家全局光球层（B2 全局语音批；设计稿
 * docs/temp/helix-steward-global-redesign.md §3.2，D1=A）。
 *
 * 形态（E-135 浮层三分法第 1 档：真全屏语义——fixed 视口层，AppRoutes
 * 独立挂载 .app-shell 兄弟位，路由切换不卸载，z 序压过 StewardDock/
 * scanline；**不做 OS 级置顶**——组件按独立 root 设计保留升 B3 可能）：
 * - **StewardOrb** 光球（右下角 ~96px；手绘帧动画雪碧图皮面——用户作图
 *   orb.png 216²/6×6 网格/36px 帧）：相位=动画序列（waking 待机循环 /
 *   listening 倾听转换+循环 / thinking 疑问开场→思考两段式（图布局
 *   (3,1)(3,2) 物理相邻即为此衔接）/ speaking 说话转换+循环（welcome 相位
 *   已随欢迎词工坊批退役——欢迎语期待机驻留） /
 *   muted·closing 冻结当前帧）；帧停点=background-position 逐 keyframe
 *   steps（E-124 合规：animation 简写全常量）；RMS=整图微缩放
 *   --stv-lv 由本组件预计算（var 只入 transform 不入 animation）；
 *   36px 帧硬边放大（image-rendering: pixelated）——详见 app.css .stv 段注；
 * - **StewardCaption** 字幕条（光球上方，玻璃族）：用户行（interim 灰/
 *   final 实）与管家行（ask.delta 聚合）弱区分，最新在下（短驻批：上限
 *   2 行 + TTL 6s 驻留——静置自动移除，流式更新刷新保活；行全空且无
 *   interim 时容器整面隐藏，气泡只在事件发生期可见）；**过程活动行**
 *   （过程可见语音面批：ask 在途期 askActivity 投影——思考中/正在调用
 *   {tool} 状态行（思考仅「思考中」状态行——用户裁决不显思考内容），interim 同构不入栈零历史；
 *   流式回答开始即退场（面板同构）；活动行在场容器驻留——长工具期
 *   用户行被 TTL 驱逐后反馈不断流）；纯 fixed 文本层
 *   零滚动容器（E-124 WKWebView sticky 坑）；
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
import { useStewardHealth, type StewardHealthComponent } from "../model/useStewardHealth";
import { useStewardActions } from "../model/useStewardActions";
import { deriveOrbPhase } from "../model/steward-voice-machine";
import { parseVoiceCommand, resolveVoiceCommand, isStopIntentPhrase, type VoiceCardTarget } from "../model/voice-command";
import { captionEvict, captionPush, captionUpdateTail, CAPTION_EVICT_TICK_MS, type CaptionLine } from "../model/caption-log";
import { inputAnnotate, inputConfirm, inputEvict, inputHearing, inputResolve, type InputNote, type InputRow } from "../model/input-pipeline";
import type { StewardPanelItem } from "../model/steward-store";
import { useI18n } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";
import { readVoiceprintThresholdPref } from "@/shared/lib/voice-pref";
import { getStewardVoiceprintService, type VoiceprintGate } from "../voiceprint/model/steward-voiceprint";

/** 光球淡出时长（ms；reduced-motion 直切不等待）。 */
export const ORB_FADE_MS = 180;

/** 光球在场信号续报间隔（ms；批 4a——daemon 侧 presence TTL 缺省 90s，
 *  60s 续报留 30s 余量；断连/崩溃残留靠 TTL 自然过期）。 */
export const PRESENCE_RENEW_MS = 60_000;

export interface StewardVoiceLayerProps {
  /** app 层 steward-open-signal 接线计数（递增即唤起——app 层订阅信号推进）。 */
  readonly wakeSignal?: number;
  /** 声纹校验门（链路重排批：每轮 final 总闸——「这句话是注册主人说的吗」；
   *  缺省 = 生产单例；测试注入假 gate）。 */
  readonly voiceprintGate?: VoiceprintGate;
}

const StewardVoiceLayer = function StewardVoiceLayer({ wakeSignal = 0, voiceprintGate }: StewardVoiceLayerProps) {
  const { t } = useI18n();
  // ── 口令数据面：useStewardActions 副实例（帧驱动同构副本——与
  //    ConfirmStack 单实例各自订阅同一帧源，卡栈状态同步演进）──
  const actions = useStewardActions();
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  // ── 字幕行栈（呈现面数据；管家输出区——用户输入归左侧输入流水）──
  const [lines, setLines] = useState<readonly CaptionLine[]>([]);
  const pushLine = useCallback((kind: CaptionLine["kind"], text: string) => {
    setLines((prev) => captionPush(prev, kind, text));
  }, []);

  // ── 输入流水（光球分区批，用户裁决：左侧=用户输入流水）——每句一行随
  //    判定链推进色态（hearing 灰→confirmed 白→done 绿/failed 红/rejected
  //    警示色带闸门注记），短驻驱逐。──
  const [inputRows, setInputRows] = useState<readonly InputRow[]>([]);

  // ── 语音口令（D3=b）：final 整句拦截——口令本地解析 + 卡栈快照裁决 +
  //    动作执行（既有命令）+ 回读（say + 字幕）；非口令句 submitUtterance
  //    发问。── 声纹总闸（链路重排批：机械→声纹→Jev→LLM）：每轮 final
  //    过 verifyGate（注册了才有验证环节，未注册即刻 skip 放行）；reject
  //    只上字幕不出声 + 整轮终止（零执行零 ask）；skip 照旧放行。──
  const sayRef = useRef<(text: string) => void>(() => undefined);
  const gateRef = useRef<VoiceprintGate>(voiceprintGate ?? getStewardVoiceprintService());
  gateRef.current = voiceprintGate ?? getStewardVoiceprintService();
  const confirmCardWithReadback = useCallback(
    (target: VoiceCardTarget) => {
      const ok = actionsRef.current.confirmCard(target.actionId);
      const reply = ok ? t("steward.voice.cmdConfirmOk", { target: target.agentId }) : t("chat.modelsConfig.sendFailToast");
      setLines((prev) => captionPush(prev, "steward", reply));
      sayRef.current(reply);
    },
    [t],
  );

  /** 声纹放行后的派发内核：口令本地消费 + 回读；聊天句经 submitUtterance
   *  发问（hook 内 source 归类 + planTranscript 回退）。 */
  const submitUtteranceRef = useRef<(text: string) => void>(() => undefined);
  // 意图窗动作面 ref（onFinalText 异步判定后回调——定义先于 sv，赋值在后）
  const svExecStopRef = useRef<() => void>(() => undefined);
  const svCloseWindowRef = useRef<() => void>(() => undefined);
  const dispatchAfterGate = useCallback(
    (text: string) => {
      setInputRows((prev) => inputResolve(prev, { state: "done" })); // 确认输入→成功色（转写成功短驻消失）
      const command = parseVoiceCommand(text);
      if (command === null) {
        submitUtteranceRef.current(text); // 聊天句：发问（voice-duplex 归类在 hook 内）
        return;
      }
      // 口语应答词（alias——protocol 单源词族，闸门对应修复批）：无待确认卡时
      // 按聊天句透传（与 daemon 漏斗「无卡原样走 LLM」同径——「好的」不当
      // 「没有待确认的卡片」误报，顺接对话语境）；有卡才当口令消费（消费面
      // 与 resolveVoiceCommand 同一快照判定：awaiting 在场即绑定栈顶）。
      if (command.alias === true) {
        const hasAwaiting = actionsRef.current.cards.some((c) => c.kind !== "memory" && c.state === "awaiting");
        if (!hasAwaiting) {
          submitUtteranceRef.current(text);
          return;
        }
      }
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
          confirmCardWithReadback(target); // 声纹总闸已验（前置）——直接执行
          return;
        }
        actionsRef.current.cancelCard(target.actionId);
        reply = t("steward.voice.cmdCancelOk", { target: target.agentId });
      }
      setLines((prev) => captionPush(prev, "steward", reply)); // 回读字幕
      sayRef.current(reply); // 回读音频（money 闸内判）
    },
    [pushLine, t, confirmCardWithReadback],
  );
  const onFinalText = useCallback(
    (text: string, ctx?: { bargeInIntent: boolean }): "consumed" | "pass" => {
      setInputRows((prev) => inputConfirm(prev, text)); // 用户行入左侧输入流水（确认输入=白色态）
      // 声纹总闸（链路重排批：机械→声纹→Jev→LLM）：每轮必验，不区分口令/
      // 聊天/有无卡；本句 PCM 同步取（final 定稿时点环尾部即本句）。barge-in
      // 意图窗内 fromMark 取样（开窗锚——duck 期自声污染防御，选段只含插话）。
      // reject 只上字幕不出声（用户裁决）+ 整轮终止；skip 照旧放行（授权链零劣化）。
      const pcm = svLastUtterancePcmRef.current?.({ fromMark: ctx?.bargeInIntent === true }) ?? null;
      void (async () => {
        let decision;
        try {
          decision = await gateRef.current.verifyGate(pcm);
        } catch {
          decision = { kind: "skip" as const, reason: "inference-error" as const };
        }
        if (decision.kind === "reject") {
          // 旁人/非注册主人：意图窗内也不真停不排队（用户需求：其他人的语音
          // 不打断）——窗收位恢复音量，字幕沿用声纹拒绝文案（闸门对应修复批：
          // 附相似度 pct——reject 三因（真旁人/阈值未达/取样段偏差）可辨）。
          if (ctx?.bargeInIntent) svCloseWindowRef.current();
          setInputRows((prev) =>
            inputResolve(prev, {
              state: "rejected",
              note: {
                kind: "voiceprint-reject",
                pct: Math.round(decision.score * 100),
                th: Math.round(readVoiceprintThresholdPref()),
              },
            }),
          );
          return;
        }
        // 停止词本地消费（链路重排批：机械→声纹→词表——声纹总闸已过，reject
        // 整轮终止在前）：词表命中即真停。窗内外同径 executeBargeInStop（幂等；
        // 非窗内 asking 期喊停 = 中止在途轮，idle 空气喊停 = 停播 no-op）。
        // 零 submitUtterance 零回读。批 3b 起 executeBargeInStop 携 scope=all
        // 全停（裁决乙：语音停止词全部全停——abort 当前 + 清空 daemon 队列）。
        if (isStopIntentPhrase(text)) {
          svExecStopRef.current();
          return;
        }
        if (ctx?.bargeInIntent) {
          // 意图窗未命中丢弃（裁决 #2：播报期单向广播，唯一合法打断 = 停止词
          // ——词表外表达当环境音处理，不排队不插话不判官；用户要插话等播完
          // 后双工续听正常说。卡栈口令同径：播报中「取消/确认」丢弃，先喊停
          // 再说口令（卡不随 run 死，播报停后口令照常可用）。零字幕零回读
          // （用户行已在 pushLine——丢弃无需确认文案）。
          svCloseWindowRef.current();
          return;
        }
        dispatchAfterGate(text);
      })();
      return "consumed"; // 一律本地消费（意图窗插话不直发 ask——排队面处理；聊天句由 dispatch 自派发）
    },
    [pushLine, t, dispatchAfterGate],
  );

  const sv = useStewardVoice({ onFinalText, welcomeText: t("steward.voice.welcome") });
  // ── presence 上行（批 4a：光球在场信号——E-250 接点）：duplex 边沿上报 +
  //    在场期周期续报（daemon 侧 TTL 90s 防断连残留；恒发通道——管家域信号
  //    不受表面感知开关门）。──
  const { topology, sendSurfaceEvent } = useSession() as {
    topology?: { active?: { conn?: string } };
    sendSurfaceEvent?: (event: {
      kind: "presence";
      origin: "user";
      page: string;
      detail?: Record<string, unknown>;
    }) => boolean;
  };
  const presenceConn = topology?.active?.conn ?? "connecting";
  useEffect(() => {
    if (presenceConn !== "connected") return;
    sendSurfaceEvent?.({
      kind: "presence",
      origin: "user",
      page: "steward-orb",
      detail: { component: "orb", visible: sv.duplexActive },
    });
    if (!sv.duplexActive) return; // 离场帧后零续报（timer 不启）
    const timer = setInterval(() => {
      sendSurfaceEvent?.({
        kind: "presence",
        origin: "user",
        page: "steward-orb",
        detail: { component: "orb", visible: true },
      });
    }, PRESENCE_RENEW_MS);
    return () => clearInterval(timer);
  }, [presenceConn, sv.duplexActive, sendSurfaceEvent]);
  sayRef.current = sv.say;
  submitUtteranceRef.current = sv.submitUtterance;
  // 意图窗动作面 ref 转发（onFinalText 定义先于 sv——与 say/submit 同构）
  svExecStopRef.current = sv.executeBargeInStop;
  svCloseWindowRef.current = sv.closeBargeInIntentWindow;
  const svLastUtterancePcmRef = useRef(sv.lastUtterancePcm);
  svLastUtterancePcmRef.current = sv.lastUtterancePcm; // 授权点取本句音频（onFinalText 定义先于 sv——ref 转发）

  // ── dropped 输入流水注记（光球分区批）：useSteward 的 dropNoticeSeq 递增
  //    （addressee 判「非对管家说」静默丢弃）→ 最近已发问行翻 rejected 贴
  //    「非交流意图」注记（零播报——旁人零出声裁决不动；短驻 TTL 自清）。──
  const lastDropNoticeRef = useRef(0);
  useEffect(() => {
    if (typeof sv.dropNoticeSeq !== "number" || sv.dropNoticeSeq <= lastDropNoticeRef.current) return;
    lastDropNoticeRef.current = sv.dropNoticeSeq;
    setInputRows((prev) => inputAnnotate(prev, { kind: "judge-reject" }));
  }, [sv.dropNoticeSeq]);

  // ── 输入流水驱动（光球分区批）：interim → hearing 原位推进；voiceError
  //    （转写失败）→ failed 红色态贴 asr-fail 注记。──
  useEffect(() => {
    if (sv.interim === null || sv.interim === "") return;
    setInputRows((prev) => inputHearing(prev, sv.interim ?? ""));
  }, [sv.interim]);
  const lastVoiceErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (typeof sv.voiceError !== "string" || sv.voiceError === "" || sv.voiceError === lastVoiceErrorRef.current) return;
    lastVoiceErrorRef.current = sv.voiceError;
    setInputRows((prev) => inputResolve(prev, { state: "failed", note: { kind: "asr-fail" } }));
  }, [sv.voiceError]);

  // ── 行 TTL 驱逐（短驻批 + 分区批）：duplex 活跃期周期驱逐静置超时行
  //    （captionEvict/inputEvict 无淘汰原引用返回——tick 空转零重渲）。──
  useEffect(() => {
    if (!sv.duplexActive) return;
    const timer = setInterval(() => {
      setLines((prev) => captionEvict(prev, Date.now()));
      setInputRows((prev) => inputEvict(prev, Date.now()));
    }, CAPTION_EVICT_TICK_MS);
    return () => clearInterval(timer);
  }, [sv.duplexActive]);

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

  // ── ③ 语音触达（语音闭环批）：弹卡即播——新确认卡弹出 × 双工会话活跃 →
  //    短句播报（TR-243 零点击原则：语音期双手不在键鼠，触达顺语音通道回来）；
  //    会话外弹卡零播报且不回溯补播（弹卡时点判据）；memory 通知卡（无操作
  //    面）零播报；同卡幂等（daemon 登记簿重放/快照对账零重播）。──
  const announcedCardsRef = useRef<Set<string>>(new Set());
  const announceText = t("steward.voice.cardPending");
  useEffect(() => {
    for (const card of actions.cards) {
      if (card.kind !== "action") continue;
      if (announcedCardsRef.current.has(card.actionId)) continue;
      announcedCardsRef.current.add(card.actionId);
      if (!sv.duplexActive) continue; // 会话外弹卡：不播不补（时点判据）
      pushLine("steward", announceText); // say + 字幕同径（口令回读同构）
      sayRef.current(announceText);
    }
  }, [actions.cards, sv.duplexActive, announceText, pushLine]);

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
    userSpeaking: sv.userSpeaking,
    notifSpeaking: sv.notifSpeaking,
  });

  // 点击（D5）：speaking → 停读；listening/muted → 临时静音切换（恢复）
  const onOrbClick = useCallback(() => {
    if (sv.speaking) {
      sv.stopSpeaking();
      return;
    }
    sv.toggleMute();
  }, [sv]);

  // ── 光球角标（健康角标批）：左上 TTS 队列计数 + 右上故障组件徽标（降级
  //    清单非空才显；语义汇总进按钮 aria-label，角标本体纯视觉）。──
  //    hook 必须在早退（orbPhase===null）之前——条件早退后挂钩 = hook 数
  //    跨渲染漂移（React 报错，关麦淡出测试抓过）。
  const health = useStewardHealth();
  if (orbPhase === null) return null;
  // 分区批：interim 由左侧输入流水 hearing 行承载（不重复渲染）
  // ── 过程活动行（过程可见语音面批；TR-241 语音版）：ask 在途期思考/工具
  //    状态入字幕——不入 CaptionLine 栈（interim 同构：呈现层实时消费零
  //    历史，生命周期 = askActivity 本体）。退场契约面板同构：流式回答
  //    开始（streamingText 非空）活动行退场——流式文字即反馈；收口
  //    （askActivity null）即消失。工具态醒目面批（用户裁决：当前工具
  //    一眼可辨）——tool 相位独立分支：accent 亮色 + 工具名 mono 胶囊
  //    badge（data-tool="on" 驱动；面板仍用 activityTool 整句不变）。──
  const streamingActive = sv.streamingText !== null && sv.streamingText !== "";
  void streamingActive; // （分区批：流式不再影响过程行显隐——保留判定供后续发言态样式复用）
  // ── 回合过程行（分区批，用户裁决「回合中的过程输出也要显示」）：本回合
  //    （最近 user 条目之后）tool 过程条目投影——工具行（running=醒目态 /
  //    done=弱化态）；思考只显「思考中」状态行（用户裁决：思考内容不上
  //    气泡，留在左侧面板可展开）；流式发言开始不退场（推翻旧「流式即
  //    反馈」退场契约——过程输出全程可见，非只显终态）；回合在途
  //    （askActivity 在）才显——光球只显当前发生的。──
  const turnRows = ((): Extract<StewardPanelItem, { kind: "tool" }>[] => {
    if (sv.askActivity === null) return [];
    let start = 0;
    for (let i = sv.items.length - 1; i >= 0; i -= 1) {
      if (sv.items[i]!.kind === "user") {
        start = i + 1;
        break;
      }
    }
    return sv.items
      .slice(start)
      .filter((it): it is Extract<StewardPanelItem, { kind: "tool" }> => it.kind === "tool")
      .slice(-4);
  })();
  const healthLabelOf: Record<StewardHealthComponent, string> = {
    judge: t("steward.voice.orbHealthJudge"),
    tts: t("steward.voice.orbHealthTts"),
    stt: t("steward.voice.orbHealthStt"),
    llm: t("steward.voice.orbHealthLlm"),
  };
  const healthLabels = health.degraded.map((d) => healthLabelOf[d.component]);
  const healthTitle =
    healthLabels.length > 0 ? t("steward.voice.orbHealthTitle", { list: healthLabels.join("·") }) : undefined;
  const showActivity = sv.askActivity !== null;
  const hasRunningTool = turnRows.some((r) => r.kind === "tool" && r.resultSummary === null);
  // 短驻批：行全空且无活动无回合行 → 字幕容器不渲染（事件发生期外零气泡面）
  const captionVisible = lines.length > 0 || showActivity || turnRows.length > 0;
  const noteTextOf = (note: InputNote): string =>
    note.kind === "voiceprint-reject"
      ? t("steward.voice.inputVoiceprintReject", { pct: note.pct, th: note.th })
      : note.kind === "judge-reject"
        ? t("steward.voice.inputJudgeReject")
        : t("steward.voice.inputAsrFail");
  // RMS 微缩放系数（E-124：calc 乘法不进 CSS——组件端预计算成现成 scale
  // 值，CSS 只吃 --stv-lv；与 P1 均衡嘴三变量同源同 clamp）
  const lv = Math.max(0.15, sv.level);
  return (
    <div
      className={fading ? "stv stv-fading" : "stv"}
      data-testid="steward-voice-layer"
      data-fading={fading ? "on" : "off"}
    >
      {captionVisible && (
        <div className="stv-caption" data-testid="steward-caption" aria-live="polite">
          {lines.map((line) => (
            <div key={line.id} className="stv-line" data-kind={line.kind}>
              {line.text}
            </div>
          ))}
          {/* 过程活动行（不入栈——最新在下语义：栈行 → 过程状态 → 摘要 →
              interim（打断新输入时排最下））；aria-live 容器顺带播报状态变化。
              工具态醒目面批：data-tool=on 独立分支——前缀 + mono 胶囊
              badge（一眼可辨当前工具；app.css accent/glow 段） */}
          {/* 回合过程行（分区批：上方气泡=管家输出——思考状态/工具/发言全程可见；
              思考内容不上气泡（用户裁决：只显「思考中」）；
              工具行 running=accent 醒目态（data-tool=on）/done=弱化态（data-tool=done），
              与错误提示面无关——错误只走输入流水红色态与健康徽标） */}
          {turnRows.map((row) => (
            <div
              key={`turn-tool-${row.toolCallId}`}
              className="stv-line stv-activity"
              data-kind="activity"
              data-tool={row.resultSummary === null ? "on" : "done"}
              data-testid="steward-activity"
            >
              {row.resultSummary === null ? t("steward.activityToolPrefix") : ""}
              <span className="stv-tool-badge" data-testid="steward-tool-badge">
                {row.name}
              </span>
            </div>
          ))}
          {showActivity && (sv.askActivity?.phase === "thinking" || !hasRunningTool) && (
            <div className="stv-line stv-activity" data-kind="activity" data-testid="steward-activity">
              {t("steward.thinking")}
            </div>
          )}
        </div>
      )}
      {/* 左侧输入流水（分区批，用户裁决：拟输入不与管家输出混排）——每句
          一行随判定链推进色态：hearing 灰（实时解析）→ confirmed 白（确认
          输入）→ done 主题成功色 / failed 主题错误色 / rejected 警示色+闸门
          注记（声纹未过带相似度与阈值、非交流意图、转写失败）；短驻消失。 */}
      {inputRows.length > 0 && (
        <div className="stv-input" data-testid="steward-input" aria-live="polite">
          {inputRows.map((row) => (
            <div
              key={row.id}
              className="stv-inrow"
              data-state={row.state}
              data-interim={row.state === "hearing" ? "on" : "off"}
              data-testid="steward-input-row"
            >
              {row.text}
              {row.note !== null && (
                <span className="stv-inote" data-note={row.note.kind} data-testid="steward-input-note">
                  {noteTextOf(row.note)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        className={`stv-orb stv-phase-${orbPhase}${sv.muted ? " stv-muted" : ""}`}
        data-testid="steward-orb"
        data-phase={orbPhase}
        style={{ "--stv-lv": (0.98 + lv * 0.05).toFixed(3) } as React.CSSProperties}
        aria-label={
          (sv.muted ? t("steward.voice.orbMuted") : sv.speaking ? t("steward.voice.orbStopRead") : t("steward.voice.orbLabel")) +
          (healthTitle === undefined ? "" : `；${healthTitle}`)
        }
        title={sv.speaking ? t("steward.voice.orbStopRead") : healthTitle}
        onClick={onOrbClick}
      >
        {/* 帧动画雪碧图皮面（单层——orb.png 6×6 网格，相位动画与帧表全在
            app.css .stv 段；纯皮面 aria-hidden）*/}
        <span className="stv-sprite" aria-hidden="true" />
        {/* 光球角标（健康角标批）：左上 TTS 队列计数（>0 才显）+ 右上故障
            组件徽标（title 携简因）——纯视觉面，语义并入按钮 aria-label */}
        {sv.ttsQueue > 0 && (
          <span
            className="stv-badge stv-queue"
            data-testid="steward-tts-queue"
            title={t("steward.voice.orbQueueBadge", { n: sv.ttsQueue })}
            aria-hidden="true"
          >
            {sv.ttsQueue}
          </span>
        )}
        {healthLabels.length > 0 && (
          <span className="stv-badge stv-health" data-testid="steward-health-badge" title={health.degraded.map((d) => d.reason ?? healthLabelOf[d.component]).join("；")} aria-hidden="true">
            {healthLabels.join("·")}
          </span>
        )}
      </button>
    </div>
  );
};

export default StewardVoiceLayer;
