/**
 * 门禁 connecting 占位（W3；brief 任务 2；W6b 终端化改版；W6o 双形态）。
 *
 * phase=connecting（workspace.get 门禁判定前）的全屏占位，与静态 index.html
 * 启动屏同一视觉语言：直接复用 index.html head <style> 持久存在的
 * .app-boot-loader/.boot-term/.bl/.boot-cursor 类名渲染（零重复 CSS 定义）。
 *
 * 双形态（W6o，App.tsx 门禁 hold 消费；W6p 调参：序列压缩至 0.9s 档、
 * 活状态行改英文终端风硬编码）：
 * - variant="full"（首启）：16 行序列——前 15 行装饰（英文梗硬编码）+
 *   末行活状态（connecting daemon… (attempt N) / reconnecting… + 光标）。
 *   静态 index.html 序列已剥（W6p：dev 第一遍只留主题底色，动画唯一一遍
 *   在此层）——两形态视觉统一为"底色 → 本序列 → gate/main"。
 * - variant="status"（会话中重连）：仅活状态行 + 光标（现行为——中途
 *   daemon 挂掉不重播整套序列，防打扰）。
 *
 * 活状态行（两形态共用，W6p 英文终端风硬编码）：connecting daemon…
 * (attempt N) / reconnecting…；
 * status 形态 disconnected 追加重连行（现行为），full 形态末行切换文案
 * （保持 16 行序列恒定）。conn=error（gave-up）→ 连接失败占位
 * （err-icon + hud-btn——ErrorCard 视觉语言）+ 重试钮（useSession().retry，
 * SM-2 手动重试路径；形态无关）。连接层零改动（重连状态机照常）。
 */
import type { CSSProperties, ReactNode } from "react";
import { useI18n } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";

/** boot 屏形态（W6o）：full = 首启完整序列（App hold 期）；status = 会话中重连。 */
export type WorkspaceBootVariant = "full" | "status";

export interface WorkspaceBootScreenProps {
  /** 形态（W6o）：由 App 门禁 hold 决定——首启 full / 重连 status。 */
  variant: WorkspaceBootVariant;
}

/**
 * 首启序列装饰行（W6o）：文案/`--d` 延迟与 index.html 静态序列前 15 行
 * 逐行同源对齐（第 16 行「ready when you are」由活状态行接替）。
 * v1/index.html 同源英文装饰梗——硬编码不走 i18n（brief 裁决）。
 */
const BOOT_SEQ: readonly { d: string; node: ReactNode }[] = [
  { d: "0.06s", node: <>helix v2 — boot sequence</> },
  { d: "0.11s", node: <>spinning up the daemon…</> },
  { d: "0.16s", node: <>attaching sidecar <i>...........</i> <b>OK</b></> },
  { d: "0.21s", node: <>opening websocket <i>...........</i> <b>OK</b></> },
  { d: "0.26s", node: <>binding workspace <i>...........</i> <b className="warn">PENDING</b></> },
  { d: "0.31s", node: <>consulting the kg <i>...........</i> <b>0 NODES</b></> },
  { d: "0.36s", node: <>git blame --auto <i>............</i> <b className="warn">NOT ME</b></> },
  { d: "0.41s", node: <>npm install motivation <i>......</i> <b className="err">404</b></> },
  { d: "0.46s", node: <>asking llm to behave <i>........</i> <b className="err">IT LIED</b></> },
  { d: "0.51s", node: <>herding sub-agents <i>..........</i> <b className="warn">MOSTLY</b></> },
  { d: "0.56s", node: <>indexing excuses <i>...........</i> <b>OK</b></> },
  { d: "0.61s", node: <>calibrating cyan glow <i>.......</i> <b>SHINY</b></> },
  { d: "0.66s", node: <>hydrating toasts <i>............</i> <b>CRISPY</b></> },
  { d: "0.71s", node: <>petting rubber duck <i>..........</i> <b>QUACK</b></> },
  { d: "0.76s", node: <>all systems nominal <i>..........</i> <b className="warn">PROBABLY</b></> },
];

/**
 * 活状态主行文案（W6p 用户裁决：英文终端风硬编码，与装饰序列统一——
 * 原中文 i18n 行与英文序列混排违和；错误卡片文案保留 i18n）。
 */
function connectingLine(attempts: number): string {
  const base = "connecting daemon…";
  if (attempts <= 1) return base;
  return `${base} (attempt ${attempts})`;
}

const WorkspaceBootScreen = function WorkspaceBootScreen({ variant }: WorkspaceBootScreenProps) {
  const { t } = useI18n();
  const { state, retry } = useSession();

  if (state.conn === "error") {
    return (
      <div className="wsgate" data-wsgate-boot="error">
        <div className="wsgate-panel">
          <div className="err-icon">!</div>
          <div className="wsgate-title">{t("workspace.boot.errorTitle")}</div>
          <div className="wsgate-sub">{t("workspace.boot.errorSub")}</div>
          <button className="hud-btn hud-btn-cyan" type="button" onClick={retry}>
            {t("workspace.boot.retry")}
          </button>
        </div>
      </div>
    );
  }

  if (variant === "full") {
    // 首启：15 行装饰序列 + 末行活状态（--d 0.81s——序列压至 0.9s 档，W6p；
    // disconnected 时末行切换重连文案，16 行恒定）。光标随末行，入场延迟
    // 沿用静态屏 1.5s 默认（按 16 行节奏调的，无需内联提前）。
    const live = state.conn === "disconnected" ? "reconnecting…" : connectingLine(state.connAttempts);
    return (
      <div className="app-boot-loader" data-wsgate-boot="connecting">
        <div className="boot-term">
          {BOOT_SEQ.map((line, i) => (
            <span className="bl" key={i} style={{ "--d": line.d } as CSSProperties}>
              &gt; {line.node}
            </span>
          ))}
          <span className="bl" style={{ "--d": "0.81s" } as CSSProperties}>
            &gt; {live}
            <span className="boot-cursor" />
          </span>
        </div>
      </div>
    );
  }

  // status 形态（会话中重连）：仅活状态行 + 光标（现行为）。
  // 光标随末行（.bl 擦除入场延迟 --d 逐行递增，同静态屏节奏）；1-2 行，
  // 光标 1.5s 默认入场延迟按 16 行节奏调的——内联提前。
  const lines = [connectingLine(state.connAttempts)];
  if (state.conn === "disconnected") lines.push("reconnecting…");

  return (
    <div className="app-boot-loader" data-wsgate-boot="connecting">
      <div className="boot-term">
        {lines.map((line, i) => (
          <span className="bl" key={line} style={{ "--d": `${0.05 + i * 0.08}s` } as CSSProperties}>
            &gt; {line}
            {i === lines.length - 1 && (
              <span className="boot-cursor" style={{ animationDelay: "0.5s" }} />
            )}
          </span>
        ))}
      </div>
    </div>
  );
};

export default WorkspaceBootScreen;
