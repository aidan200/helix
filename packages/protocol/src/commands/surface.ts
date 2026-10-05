/**
 * surface 族命令（M0 表面协议地基批，additive；上行 = 表面→daemon）。
 *
 * 链路：shell surface adapter 连接就绪 → surface.register（SurfaceDescriptor
 * 自述——capabilities 含 navigate）→ daemon SurfaceRegistry 登记（幂等覆盖；
 * 断连自动等效注销）→ surface.registered 点对点回执（daemon 分配 connId
 * 身份）。页面级事件（activated/navigated）经 surface.event 上行（感知开关
 * 默认 off——off 时 adapter 不上报）；动作执行回执经 surface.action.result
 * 上行（D7-1 seq 对账）。
 *
 * 全部为全局命令（信封省略 sessionId——E-84 命令信封纪律；表面是连接级
 * 概念，与会话路由位无关）。
 */
import type { CommandFrame } from "../envelope";
import type { SurfaceDescriptor, SurfaceEventUplinkPayload } from "../events/surface";

/** surface.register 载荷。 */
export interface SurfaceRegisterPayload {
  /** 表面自述（kind ∈ 命名空间 + capabilities 非空动词清单 + 可选 policy）。 */
  descriptor: SurfaceDescriptor;
}

/** surface.register：表面注册/自述（幂等重注册 = 覆盖 descriptor；点对点
 *  回执 surface.registered）。 */
export interface SurfaceRegisterCommand extends CommandFrame<SurfaceRegisterPayload> {
  type: "surface.register";
}

/** surface.unregister：表面注销（对称语义；断连自动等效）。 */
export interface SurfaceUnregisterCommand extends CommandFrame<Record<string, never>> {
  type: "surface.unregister";
}

/** surface.event：页面级事件上行（感知开关默认 off——off 时表面不上报；
 *  daemon 归一盖章 surfaceId 后进 Registry observe 面）。 */
export interface SurfaceEventCommand extends CommandFrame<SurfaceEventUplinkPayload> {
  type: "surface.event";
}

/** surface.action.result 载荷（D7-1 执行回执）。 */
export interface SurfaceActionResultPayload {
  /** 对账动作 seq（surface.action 帧携带的单调序号）。 */
  seq: number;
  /** 执行成败（呈现即回 true——如 navigate 建议卡已 toast）。 */
  ok: boolean;
  /** 结果说明（可选；失败原因/呈现细节）。 */
  detail?: string;
}

/** surface.action.result：动作执行回执上行（registry pending 销账；未知
 *  seq 静默丢弃——迟到回执无害）。 */
export interface SurfaceActionResultCommand extends CommandFrame<SurfaceActionResultPayload> {
  type: "surface.action.result";
}
