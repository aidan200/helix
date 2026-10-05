/**
 * StewardSurfacePort —— 管家消费面表面能力出口（outbound；M2 四泛型工具）。
 *
 * application 中立形状（零 CDP/协议执行细节）：surface_list / snapshot /
 * read / act 四泛型工具的执行体依赖面；实现 = application/surface/
 * SurfaceActionService（组合 SurfaceRegistry act 管道 + browser adapter
 * 读面）。act 是**确认闸后**的执行入口（risk 三级闸判定在 StewardService
 * 消费面——SurfaceRiskGate），本端口只管执行与回执。
 */
import type { SurfaceRisk } from "@helix/protocol";

/** 表面清单行（surface_list 动态发现：surfaceId + 能力协商面）。 */
export interface StewardSurfaceInfo {
  readonly surfaceId: string;
  readonly kind: string;
  readonly label: string;
  readonly capabilities: readonly string[];
}

/** act 执行请求（确认闸放行后的动作——risk 已定档）。 */
export interface StewardSurfaceActRequest {
  readonly surfaceId: string;
  readonly verb: string;
  readonly args: Record<string, unknown>;
  readonly risk: SurfaceRisk;
}

/** act 执行回执（D7-1：seq 回执锚 + 成败 + 说明）。 */
export interface StewardSurfaceActResult {
  readonly ok: boolean;
  readonly seq: number;
  readonly detail: string;
}

/** 只读面结果（snapshot/read）。 */
export interface StewardSurfaceReadResult {
  readonly ok: boolean;
  readonly text: string;
}

export interface StewardSurfacePort {
  /** 表面清单（动态发现表面与能力——D4 不加工具膨胀）。 */
  list(): Promise<readonly StewardSurfaceInfo[]>;
  /** 表面快照（页面状态摘要——read 类免确认）。 */
  snapshot(surfaceId: string): Promise<StewardSurfaceReadResult>;
  /** 表面内容读取（可选 selector/长度上限——read 类免确认）。 */
  read(surfaceId: string, opts: { selector?: string; maxChars?: number }): Promise<StewardSurfaceReadResult>;
  /** 动作执行（同一动作管道：Registry act 路由 + seq 回执）。 */
  act(request: StewardSurfaceActRequest): Promise<StewardSurfaceActResult>;
}
