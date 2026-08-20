/**
 * handlers/ 共享上下文（T3.2，F-8 解环：ConnState / WsCommandContext 自
 * WsServerAdapter / handlers/model 机械上收——纯 type 搬移，零运行时行为）。
 *
 * 解环前 F-8 三模块静态环：WsServerAdapter → handlers/auth（值导入）→
 * handlers/model（WsCommandContext type 导入）→ WsServerAdapter（ConnState
 * type 导入，回边）。两个类型定义上收本模块后，handlers/* 只依赖本模块
 * （type-only），不再有指回 WsServerAdapter 的边，环解。
 *
 * 本模块依赖纪律：只 import @helix/protocol 类型 + ../EventStream 类型 +
 * application/ports 类型 + bun ServerWebSocket 类型——全部 type-only，
 * 自身不成为任何环的节点。
 */
import type { ServerWebSocket } from "bun";
import type { ConnectionErrorEvent, EventEnvelope } from "@helix/protocol";
import type { ModelPort } from "../../../../application/ports/inbound/ModelPort";
import type { SystemPort } from "../../../../application/ports/inbound/SystemPort";
import type { FrameSender } from "../EventStream";

/** 每连接状态（Bun.serve 泛型，经 server.upgrade 的 data 携带；handlers/ 共用型）。 */
export interface ConnState {
  authed: boolean;
  /** 认证通过后构造的协议帧发送端（EventStream 注册键）。 */
  sender: FrameSender | null;
}

/**
 * model/auth 族命令处理上下文（WsServerAdapter.routeCommand 解构后供出）。
 * 辅助方法与本连接绑定，语义 = WsServerAdapter 同名私有方法（机械转发零行为差）。
 */
export interface WsCommandContext {
  /** 命令来源连接（回执端解析：ws.data.sender ?? rawSender()）。 */
  readonly ws: ServerWebSocket<ConnState>;
  /** 命令类型字面（commandError 回执文案用）。 */
  readonly type: string;
  /** 命令 payload（routeCommand 已解构为 Record）。 */
  readonly payload: Record<string, unknown>;
  /** 命令信封（会话作用域命令的 sessionId 路由位，v0.2）。 */
  readonly envelope: { sessionId?: unknown };
  /** 模型/认证管理入口（AD-2 回口，只转发不决策）。 */
  readonly model: ModelPort;
  /** 缺省会话回退源（system.getStatus().sessionId，v0 兼容读）。 */
  readonly system: SystemPort;
  /** 命令错误回执（connection.error 帧；语义 = WsServerAdapter.commandError）。 */
  commandError(type: string, code: ConnectionErrorEvent["payload"]["code"], message: string): void;
  /** 模型/认证命令错误码映射（契约 C §4；语义 = WsServerAdapter.modelErrorCode）。 */
  modelErrorCode(err: Error): ConnectionErrorEvent["payload"]["code"];
  /** 构造本连接协议帧发送端（readyState 守卫；语义 = WsServerAdapter.rawSender）。 */
  rawSender(): FrameSender;
  /** 立即发帧（语义 = WsServerAdapter.sendNow）。 */
  sendNow(sender: FrameSender, frame: EventEnvelope): void;
}
