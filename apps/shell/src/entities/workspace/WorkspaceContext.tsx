/**
 * entities/workspace —— 门禁上下文（W3；设计稿 §2.1 / brief 任务 1）。
 *
 * 三相：connecting（连接/门禁判定中——workspace.get 回执前）→ main（bound，
 * 主壳渲染）/ gate（null，选择页）。驱动帧：workspace.get.result（点对点门禁
 * 快照分流）、workspace.open.result（绑定回执）、connection.error（open 在途
 * 时的结构化错误——错误码 + message 供页面行内展示，前端不重复实现校验）、
 * workspace_changed（广播跟随——W4 刷新链归各数据消费面）。
 *
 * 切换流（W4；设计稿 §2.3）：startSwitch（主壳入口 → gate 带取消逃逸）/
 * cancelSwitch（取消回主壳）；首启 gate 无逃逸语义不变（入口来源区分）。
 *
 * 依赖注入（AG-15：entities 跨 slice 零互引）：连接就绪与 workspace 命令/
 * 帧订阅面由 app 层从 SessionContext 提取注入（SessionProvider 的
 * TransportFactory 注入同构）——本域不 import entities/session。
 *
 * 门禁语义（brief 任务 5）：gate 态下主壳不渲染即无 kg/session 消费者
 * （结构保证）；本域只发 workspace.get/open。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import type { ReactNode } from "react";
import type { EventEnvelope } from "@helix/protocol";
import { commandOfConnectionError } from "@/shared/lib/command-error";
import {
  createInitialWorkspaceState,
  workspaceReducer,
  type WorkspaceState,
} from "./model/workspace-store";

export type { WorkspacePhase, WorkspaceState, WorkspaceOpenError } from "./model/workspace-store";

/** provider 依赖面（app 层注入）。 */
export interface WorkspaceDeps {
  /** 连接就绪（conn === "connected"；SessionProvider 连接状态机派生）。 */
  connected: boolean;
  /** workspace.get 门禁读面发送。 */
  sendGet: () => boolean;
  /** workspace.open 绑定写面发送。 */
  sendOpen: (root: string) => boolean;
  /** workspace 族帧订阅（两结果帧 + changed 广播 + connection.error）。 */
  subscribe: (listener: (e: EventEnvelope) => void) => () => void;
}

interface WorkspaceContextValue {
  /** 门禁 store（phase/current/recents/notice/opening/openError/switching）。 */
  state: WorkspaceState;
  /** 显式绑定写面：open-started + workspace.open 发出（send 失败本地合成
   *  错误码——提交禁用态即时收口）；成功/失败回执驱动 reducer。 */
  openWorkspace: (root: string) => boolean;
  /** 进入切换流（W4 主壳入口）：phase=gate + switching=true（带取消逃逸）；
   *  仅 main 态入口应调（首启 gate 无此入口——无逃逸语义不变）。 */
  startSwitch: () => void;
  /** 取消切换流：回主壳（绑定未变；open 在途时取消钮禁用防半途帧）。 */
  cancelSwitch: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/** get 帧发送失败的退避重试延迟（每连接世代一次机会；下次连接迁移另给）。 */
const GET_RETRY_DELAY_MS = 500;

export function WorkspaceProvider({ deps, children }: { deps: WorkspaceDeps; children: ReactNode }) {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, createInitialWorkspaceState);
  // 帧消费面读点（connection.error 的 opening 单飞门控判据）——渲染体不写
  // ref（SessionContext 纪律同构：并发渲染废弃腿不再可能写入陈旧值；提交后
  // effect 同步，读点（帧事件处理器）均在 effect 之后执行，滞后一个提交可接受）
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // 连接就绪 → 自动 workspace.get 一次（重连重发；webStatus 先例）：
  // get-started 同时重置 open 在途/行内错误（断连期回执永不达防卡死）
  const { connected, sendGet } = deps;
  /** 发送失败退避重试已用（每连接世代一次）——防失败自激循环。 */
  const getRetriedRef = useRef(false);
  useEffect(() => {
    if (!connected) {
      getRetriedRef.current = false; // 连接世代复位（下次就绪重新给一次重试额度）
      return;
    }
    dispatch({ type: "get-started" });
    // send 返回值必消费（TR-84：=== false 严格判 = 帧未发出）——conn 刚迁
    // connected 而 socket 已断的窗口里 get 帧被丢，phase 会停在 connecting 屏
    // 直到下次连接迁移；此处一次退避重试，仍失败则如实停在连接屏（不谎报）。
    if (sendGet() === false && !getRetriedRef.current) {
      getRetriedRef.current = true;
      const timer = setTimeout(() => {
        sendGet();
      }, GET_RETRY_DELAY_MS);
      return () => clearTimeout(timer);
    }
  }, [connected, sendGet]);

  // workspace 族帧消费（app 层转发的 SessionContext 订阅面）：两命令回执 +
  // changed 广播直进 reducer；connection.error 仅 open 在途时消费（其它命令
  // 错误不污染门禁——trace 单飞先例）
  const { subscribe } = deps;
  useEffect(
    () =>
      subscribe((e) => {
        switch (e.type) {
          case "workspace.get.result":
            dispatch({ type: "get-result", payload: e.payload });
            return;
          case "workspace.open.result":
            dispatch({ type: "open-result", payload: e.payload });
            return;
          case "workspace_changed":
            dispatch({ type: "changed", payload: e.payload });
            return;
          case "connection.error": {
            // 开门在途错误归因（TR-145 尾缀契约，TracePage 先例）：daemon
            // commandError 消息尾缀「（命令 <type>）」固定格式——仅 workspace.open
            // 本身（或旧 daemon 无尾缀容忍）才收口 opening；opening 窗口内其它
            // 命令（含后台自动命令）的错误不误判为 open 失败
            const message = e.payload.message ?? "connection.error";
            const cmd = commandOfConnectionError(message);
            if (stateRef.current.opening && (cmd === undefined || cmd === "workspace.open")) {
              dispatch({
                type: "open-failed",
                error: { code: e.payload.code, message },
              });
            }
            return;
          }
        }
      }),
    [subscribe],
  );

  const sendOpen = deps.sendOpen;
  const openWorkspace = useCallback(
    (root: string) => {
      dispatch({ type: "open-started" });
      const ok = sendOpen(root);
      // TR-84 定式：send 族 `=== false` 严格判（void/undefined 视为已发——
      // 旧 `!ok` 会把 mock/未接线返回 undefined 误判为失败并弹行内错误）
      if (ok === false) dispatch({ type: "open-failed", error: { code: "send-failed", message: "" } });
      return ok;
    },
    [sendOpen],
  );

  const startSwitch = useCallback(() => dispatch({ type: "switch-started" }), []);
  const cancelSwitch = useCallback(() => dispatch({ type: "switch-cancelled" }), []);

  const value = useMemo(
    () => ({ state, openWorkspace, startSwitch, cancelSwitch }),
    [state, openWorkspace, startSwitch, cancelSwitch],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
