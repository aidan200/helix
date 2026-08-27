/**
 * entities/workspace —— 门禁状态机（W3；设计稿 §2.1 / brief 任务 1）。
 *
 * 三相：connecting（连接/门禁判定中——workspace.get 回执前）→ main（bound，
 * 主壳渲染）/ gate（null，选择页）。驱动帧：workspace.get.result（点对点门禁
 * 快照分流）、workspace.open.result（绑定回执）、connection.error（open 在途
 * 时的结构化错误——错误码 + message 供页面行内展示，前端不重复实现校验）、
 * workspace_changed（广播跟随——W3 只保 current 一致，刷新链归 W4）。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import type {
  WorkspaceChangedPayload,
  WorkspaceGetResultPayload,
  WorkspaceOpenResultPayload,
  WorkspaceRecent,
} from "@helix/protocol";

/** 门禁三相（互斥；设计稿 §2.1 启动门禁状态机）。 */
export type WorkspacePhase = "connecting" | "gate" | "main";

/** open 失败结构化错误（daemon 回执 code + message；send 失败本地合成码）。 */
export interface WorkspaceOpenError {
  code: string;
  message: string;
}

/** 门禁 store（provider 唯一持有；页面经 useWorkspace 消费）。 */
export interface WorkspaceState {
  phase: WorkspacePhase;
  /** 当前绑定（规范形 root）；null = 未绑定。 */
  current: { root: string } | null;
  /** 最近使用（MRU 序，daemon 惰性探测标 valid；失效项前端置灰）。 */
  recents: WorkspaceRecent[];
  /** get 降级说明（恢复失败等；daemon 生成的用户可读文本，直接展示）。 */
  notice: string | null;
  /** open 提交中（输入区/列表禁用态）。 */
  opening: boolean;
  /** open 失败行内错误（错误码区分文案；成功/新提交清空）。 */
  openError: WorkspaceOpenError | null;
}

export type WorkspaceAction =
  | { type: "get-started" }
  | { type: "get-result"; payload: WorkspaceGetResultPayload }
  | { type: "open-started" }
  | { type: "open-result"; payload: WorkspaceOpenResultPayload }
  | { type: "open-failed"; error: WorkspaceOpenError }
  | { type: "changed"; payload: WorkspaceChangedPayload };

export function createInitialWorkspaceState(): WorkspaceState {
  return {
    phase: "connecting",
    current: null,
    recents: [],
    notice: null,
    opening: false,
    openError: null,
  };
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    // 连接就绪（含重连重发——webStatus 先例）：重置 open 在途与行内错误
    //（open 在途断连时错误回执永不达，防提交按钮永久禁用）；phase 不回退
    //（新 get-result 到达再翻转，避免重连瞬间主壳闪选择页）。
    case "get-started":
      return { ...state, opening: false, openError: null };
    case "get-result": {
      const { current, recents, notice } = action.payload;
      return {
        ...state,
        phase: current !== null ? "main" : "gate",
        current,
        recents: [...recents],
        notice: notice ?? null,
        opening: false,
      };
    }
    case "open-started":
      return { ...state, opening: true, openError: null };
    case "open-result":
      return {
        ...state,
        phase: "main",
        current: { root: action.payload.root },
        opening: false,
        openError: null,
        notice: null,
      };
    case "open-failed":
      return { ...state, opening: false, openError: action.error };
    // changed 广播：绑定已变更（open 成功/幂等重开）——current 跟随 +
    // 在途/行内错误收口（旧错误不再有意义）；gate 态收到同样跟随进 main
    //（广播先于点对点回执到达 / 他端绑定的防御性一致）。
    case "changed":
      return {
        ...state,
        phase: "main",
        current: { root: action.payload.root },
        opening: false,
        openError: null,
      };
  }
}
