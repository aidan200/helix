/**
 * entities/workspace —— 门禁上下文（W3；设计稿 §2.1 / brief 任务 1）。
 *
 * 三相：connecting（连接/门禁判定中——workspace.get 回执前）→ main（bound，
 * 主壳渲染）/ gate（null，选择页）。驱动帧：workspace.get.result（点对点门禁
 * 快照分流）、workspace.open.result（绑定回执）、connection.error（open 在途
 * 时的结构化错误——错误码 + message 供页面行内展示，前端不重复实现校验）、
 * workspace_changed（广播跟随——W3 只保 current 一致，刷新链归 W4）。
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
  /** 门禁 store（phase/current/recents/notice/opening/openError）。 */
  state: WorkspaceState;
  /** 显式绑定写面：open-started + workspace.open 发出（send 失败本地合成
   *  错误码——提交禁用态即时收口）；成功/失败回执驱动 reducer。 */
  openWorkspace: (root: string) => boolean;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ deps, children }: { deps: WorkspaceDeps; children: ReactNode }) {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, createInitialWorkspaceState);
  // 帧消费面读点（connection.error 的 opening 单飞门控判据）
  const stateRef = useRef(state);
  stateRef.current = state;

  // 连接就绪 → 自动 workspace.get 一次（重连重发；webStatus 先例）：
  // get-started 同时重置 open 在途/行内错误（断连期回执永不达防卡死）
  const { connected, sendGet } = deps;
  useEffect(() => {
    if (connected) {
      dispatch({ type: "get-started" });
      sendGet();
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
          case "connection.error":
            if (stateRef.current.opening) {
              dispatch({
                type: "open-failed",
                error: { code: e.payload.code, message: e.payload.message },
              });
            }
            return;
        }
      }),
    [subscribe],
  );

  const sendOpen = deps.sendOpen;
  const openWorkspace = useCallback(
    (root: string) => {
      dispatch({ type: "open-started" });
      const ok = sendOpen(root);
      if (!ok) dispatch({ type: "open-failed", error: { code: "send-failed", message: "" } });
      return ok;
    },
    [sendOpen],
  );

  const value = useMemo(() => ({ state, openWorkspace }), [state, openWorkspace]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
