/**
 * 系统通知分流桥（系统通知 P0）——App 级零 UI 常驻件：「窗口前台 toast /
 * 窗口后台系统通知」的分流接线方。
 *
 * 覆盖三事件面（两帧）：
 * - `steward.notify`（任务终态 + 管家感知同帧）：title/body 原样透传（文案单源
 *   在 daemon，kg TR-249 白话铁律；前端零二次生成）；与 StewardNotifyToast
 *   同构订阅点但**不改其现有逻辑**（toast 路径前台行为零变化）；
 * - `chat.turn.completed`（主会话回合完成）：窗口不在前台时发（会话在不在
 *   monitor 后台档都发——窗口失焦时活跃会话的回合完成同样是「人不在看」，
 *   P0 首验缺口即此：发完消息切走窗口，回完了没人知道）——标题 = 会话名
 *   （monitor 档优先，缺席回退会话目录 topo.list），正文 = 固定白话标签
 *   （不读 turnId/reason 拼文案：UUID 不上通知、不杜撰）。
 *
 * 判据单点在 shared/lib/system-notify（纯函数），本组件只做：订阅 → 读现态
 * （偏好/前台/去重窗）→ 调 shared/api/native-capability 的 seam。原生能力
 * 缺席（纯浏览器 dev）静默休眠，零形态分支（AG-17 词面守护）。
 */
import { useEffect, useRef } from "react";
import type { EventEnvelope, StewardNotifyPayload } from "@helix/protocol";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { hasSystemNotify, nativeSystemNotify } from "@/shared/api/native-capability";
import {
  decideSystemNotify,
  isWindowForeground,
  readSystemNotifyPref,
  SystemNotifyDedup,
} from "@/shared/lib/system-notify";

/** steward.notify 去重键（同 title+body 同窗——与 toast 侧同键构造）。 */
function stewardKey(title: string, body: string): string {
  return `${title}\u0000${body}`;
}

export default function SystemNotifyBridge() {
  const session = useSession() as {
    subscribeStewardFrames?: (listener: (e: EventEnvelope) => void) => () => void;
    subscribeChatTurnFrames?: (listener: (e: EventEnvelope) => void) => () => void;
    topology?: {
      background: Record<string, { title: string }>;
      list?: { sessionId: string; title: string }[];
    };
  };
  const { subscribeStewardFrames, subscribeChatTurnFrames, topology } = session;
  const { t } = useI18n();
  /** 拓扑读点（事件时点读后台会话名/在后台判据——不随渲染重订阅）。 */
  const topologyRef = useRef(topology);
  useEffect(() => {
    topologyRef.current = topology;
  }, [topology]);

  useEffect(() => {
    if (subscribeStewardFrames === undefined || subscribeChatTurnFrames === undefined) return;
    if (!hasSystemNotify()) return; // 纯浏览器 dev：整桥休眠（零形态分支）
    const dedup = new SystemNotifyDedup();

    /** 统一投递面：判定 → 记账 → 原生发（异常上抛但在此收口为静默诊断，
     *  绝不因通知失败影响会话主链）。 */
    const deliver = (
      title: string,
      body: string,
      urgency: "high" | "normal",
      opts?: { sessionForeground?: boolean; voiceCovered?: boolean },
    ) => {
      const now = Date.now();
      const key = stewardKey(title, body);
      // 去重窗记账先于判定（口径同 StewardNotifyToast：先记账再短路）
      const seenAt = urgency === "normal" ? dedup.seenAt(key, now) : undefined;
      const decision = decideSystemNotify(
        { title, body, urgency, ...(opts?.sessionForeground !== undefined ? { sessionForeground: opts.sessionForeground } : {}), ...(opts?.voiceCovered !== undefined ? { voiceCovered: opts.voiceCovered } : {}) },
        { enabled: readSystemNotifyPref(), foreground: isWindowForeground(), seenAt, now },
      );
      if (!decision.send) {
        // 诊断日志（DEV 门控）：skip 原因可见——断链排查不再零痕迹（P0 首验教训）
        if (import.meta.env.DEV) console.info(`[system-notify] skip: ${decision.reason}`);
        return;
      }
      if (urgency === "high") dedup.mark(key, now); // 直发也记账：随后的同内容 normal 不再补发
      void nativeSystemNotify(title, body)
        .then(() => {
          // 诊断日志（DEV 门控）：发送成功可见——「发了但 OS 丢弃」与「根本没发」
          // 在前端面不可分，成功日志是两者判据的分界线（P0 联测教训）
          if (import.meta.env.DEV) console.info(`[system-notify] sent: ${title}`);
        })
        .catch((err: unknown) => {
          // 诊断日志（DEV 门控）：不吞错也不打扰用户——通知失败不影响会话主链
          if (import.meta.env.DEV) console.warn(`[system-notify] native notify failed: ${String(err)}`);
        });
    };

    const offSteward = subscribeStewardFrames((event: EventEnvelope) => {
      if (event.type !== "steward.notify") return;
      const p = event.payload as StewardNotifyPayload;
      // text/sub 守卫（CoordNoticeToast/StewardNotifyToast 同规）
      if (typeof p.title !== "string" || p.title === "") return;
      if (typeof p.body !== "string" || p.body === "") return;
      // voiceCovered 透传（daemon 判定语音会响 → 分流桥跳过系统通知，§17.41）
      deliver(p.title, p.body, p.urgency === "high" ? "high" : "normal", {
        ...(typeof p.voiceCovered === "boolean" ? { voiceCovered: p.voiceCovered } : {}),
      });
    });

    const offTurn = subscribeChatTurnFrames((event: EventEnvelope) => {
      if (event.type !== "chat.turn.completed") return;
      const sid = event.sessionId;
      if (typeof sid !== "string" || sid === "") return;
      const topo = topologyRef.current;
      // 标题源：monitor 档后台态优先，缺席（= 会话正活跃）回退会话目录——
      // 可见性不再按会话分档裁决：窗口失焦时看哪条会话都看不见，统一归
      // decide 的窗口前台闸（前台流式回复本来可见，零二次打扰）
      const title =
        topo?.background?.[sid]?.title ??
        topo?.list?.find((m) => m.sessionId === sid)?.title ??
        "";
      // 正文：assistant 摘录优先（daemon 单源投影，80 码点单行）；缺席
      // （旧 daemon / 本轮无 assistant 文本 / 空 turn）回退固定白话标签
      const rawExcerpt = (event.payload as { lastReplyExcerpt?: unknown }).lastReplyExcerpt;
      const body =
        typeof rawExcerpt === "string" && rawExcerpt !== ""
          ? rawExcerpt
          : t("chat.notify.system.turnDoneBody");
      deliver(
        title !== "" ? title : t("chat.notify.system.untitledSession"),
        body,
        "normal",
      );
    });
    return () => {
      offSteward();
      offTurn();
    };
  }, [subscribeStewardFrames, subscribeChatTurnFrames, t]);

  return null;
}
