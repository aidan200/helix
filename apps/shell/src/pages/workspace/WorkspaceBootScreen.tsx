/**
 * 门禁 connecting 占位（W3；brief 任务 2；W6b 终端化改版；W6o 双形态）。
 *
 * phase=connecting（workspace.get 门禁判定前）的全屏占位，与静态 index.html
 * 启动屏同一视觉语言：直接复用 index.html head <style> 持久存在的
 * .app-boot-loader/.boot-term/.bl/.boot-cursor 类名渲染（零重复 CSS 定义）。
 *
 * 双形态（W6o，App.tsx 门禁 hold 消费）：
 * - variant="full"（首启）：完整 16 行序列——前 15 行装饰文案（文案/--d
 *   与 index.html 静态序列逐行同源对齐；v1/index.html 同源英文梗，硬编码
 *   不走 i18n）+ 末行为活状态（正在连接（第 N 次尝试）/ 重连中 + 光标）。
 *   任何形态、任何启动时长，终端动画都是开场。
 * - variant="status"（会话中重连）：仅活状态行 + 光标（现行为——中途
 *   daemon 挂掉不重播整套序列，防打扰）。
 *
 * 活状态行（两形态共用）：connecting → workspace.boot.connecting（重试
 * >1 次附「第 N 次尝试」，chat.banner.reconnectAttempt 键复用）；
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
  { d: "0.10s", node: <>helix v2 — boot sequence</> },
  { d: "0.18s", node: <>spinning up the daemon…</> },
  { d: "0.26s", node: <>attaching sidecar <i>...........</i> <b>OK</b></> },
  { d: "0.34s", node: <>opening websocket <i>...........</i> <b>OK</b></> },
  { d: "0.42s", node: <>binding workspace <i>...........</i> <b className="warn">PENDING</b></> },
  { d: "0.50s", node: <>consulting the kg <i>...........</i> <b>0 NODES</b></> },
  { d: "0.58s", node: <>git blame --auto <i>............</i> <b className="warn">NOT ME</b></> },
  { d: "0.66s", node: <>npm install motivation <i>......</i> <b className="err">404</b></> },
  { d: "0.74s", node: <>asking llm to behave <i>........</i> <b className="err">IT LIED</b></> },
  { d: "0.82s", node: <>herding sub-agents <i>..........</i> <b className="warn">MOSTLY</b></> },
  { d: "0.90s", node: <>indexing excuses <i>...........</i> <b>OK</b></> },
  { d: "0.98s", node: <>calibrating cyan glow <i>.......</i> <b>SHINY</b></> },
  { d: "1.06s", node: <>hydrating toasts <i>............</i> <b>CRISPY</b></> },
  { d: "1.14s", node: <>petting rubber duck <i>..........</i> <b>QUACK</b></> },
  { d: "1.22s", node: <>all systems nominal <i>..........</i> <b className="warn">PROBABLY</b></> },
];

/** 活状态主行文案：connecting → 连接中（重试 >1 次附「第 N 次尝试」）。 */
function connectingLine(t: (key: string, vars?: Record<string, string | number>) => string, attempts: number): string {
  const base = t("workspace.boot.connecting");
  if (attempts <= 1) return base;
  return `${base}（${t("chat.banner.reconnectAttempt", { n: attempts })}）`;
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
    // 首启：15 行装饰序列 + 末行活状态（--d 1.30s = index.html 第 16 行节奏；
    // disconnected 时末行切换重连文案，16 行恒定）。光标随末行，入场延迟
    // 沿用静态屏 1.5s 默认（按 16 行节奏调的，无需内联提前）。
    const live =
      state.conn === "disconnected" ? t("workspace.boot.reconnecting") : connectingLine(t, state.connAttempts);
    return (
      <div className="app-boot-loader" data-wsgate-boot="connecting">
        <div className="boot-term">
          {BOOT_SEQ.map((line, i) => (
            <span className="bl" key={i} style={{ "--d": line.d } as CSSProperties}>
              &gt; {line.node}
            </span>
          ))}
          <span className="bl" style={{ "--d": "1.30s" } as CSSProperties}>
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
  const lines = [connectingLine(t, state.connAttempts)];
  if (state.conn === "disconnected") lines.push(t("workspace.boot.reconnecting"));

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
