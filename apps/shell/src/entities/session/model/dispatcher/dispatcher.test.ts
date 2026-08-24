/**
 * dispatcher 事件消费者注册表单测（AD-3 前端形态；C2 拆分 T1.1；F(4.0).1；
 * v0.2 真消费接线扩展 T3.1）。
 *
 * 机械判据（brief 决策消解）：
 * ① register(type → handler) 映射结构存在，route 按 type 查询；
 * ② 协议全部事件 type 均被消费：会话 store 级（route）或拓扑级清单族
 *    （directory；T3.1 两层结构）——无静默吞帧；
 * ③ 未注册 type → undefined（主 reducer 保持原状态 = 原 applyEvent default 语义）；
 * ④ 族路由正确：type → 对应族消费者 apply 函数（v0.2 新增 model/history
 *    真消费；list 族归 directory 拓扑级）。
 */
import { describe, expect, it } from "vitest";
import { EVENT_TYPES } from "@helix/protocol";
import type { EventEnvelope } from "@helix/protocol";
import { route, register } from "./index";
import { SESSION_DIRECTORY_EVENT_TYPES } from "../consumers/directory";
import { MODEL_CONFIG_EVENT_TYPES } from "../consumers/model-config";
import { AGENT_CONFIG_EVENT_TYPES } from "../consumers/agent-config";
import { WEB_EVENT_TYPES } from "../consumers/web-status";
import type { SessionState } from "../state";
import { applyConnEvent } from "../consumers/conn";
import { applyChatEvent } from "../consumers/chat";
import { applyAgentEvent } from "../consumers/agent";
import { applyThinkingUsageEvent } from "../consumers/thinking-usage";
import { applySnapshotEvent } from "../consumers/snapshot";
import { applyHistoryEvent } from "../consumers/history";
import { applyModelChangedEvent } from "../consumers/model";
import { applyThinkingLevelEvent } from "../consumers/thinking-level";

describe("dispatcher 事件消费者注册表（AD-3；C2 拆分）", () => {
  it("协议全部事件 type（EVENT_TYPES）均被消费：route（会话 store 级）或 directory/modelConfig/agentConfig/web（拓扑级）", () => {
    const directoryTypes = new Set<string>(SESSION_DIRECTORY_EVENT_TYPES);
    const modelConfigTypes = new Set<string>(MODEL_CONFIG_EVENT_TYPES);
    const agentConfigTypes = new Set<string>(AGENT_CONFIG_EVENT_TYPES);
    const webTypes = new Set<string>(WEB_EVENT_TYPES);
    for (const type of EVENT_TYPES) {
      expect(
        route(type) !== undefined || directoryTypes.has(type) || modelConfigTypes.has(type) || agentConfigTypes.has(type) || webTypes.has(type),
        `未消费事件 type：${type}`,
      ).toBe(true);
    }
  });

  it("route 未注册 type → undefined（主 reducer 保持原状态）", () => {
    expect(route("nonexistent.type")).toBeUndefined();
  });

  it("register(type → handler) 形态：登记后可查、同 type 后注册覆盖", () => {
    const a = (s: SessionState) => s;
    const b = (s: SessionState, _e: EventEnvelope) => s;
    register({ types: ["test.dummy"], apply: a });
    expect(route("test.dummy")).toBe(a);
    register({ types: ["test.dummy"], apply: b });
    expect(route("test.dummy")).toBe(b);
  });

  it("族路由正确：type → 对应族消费者 apply 函数", () => {
    // conn（帧驱动 connection.*；conn 语义归 conn 块）
    expect(route("connection.welcome")).toBe(applyConnEvent);
    expect(route("connection.error")).toBe(applyConnEvent);
    // chat+steer（含 engine.error/tool.call.*/agent.state.changed 归 chat 族定稿）
    expect(route("chat.stream.delta")).toBe(applyChatEvent);
    expect(route("steer.queued")).toBe(applyChatEvent);
    expect(route("engine.error")).toBe(applyChatEvent);
    expect(route("tool.call.started")).toBe(applyChatEvent);
    expect(route("agent.state.changed")).toBe(applyChatEvent);
    // agent 编排族 7 case
    expect(route("agent.spawned")).toBe(applyAgentEvent);
    expect(route("agent.killed")).toBe(applyAgentEvent);
    // thinking/usage/compaction 4 case
    expect(route("thinking.stream.delta")).toBe(applyThinkingUsageEvent);
    expect(route("compaction.completed")).toBe(applyThinkingUsageEvent);
    expect(route("usage.recorded")).toBe(applyThinkingUsageEvent);
    // session 快照 1 case
    expect(route("session.snapshot")).toBe(applySnapshotEvent);
    // v0.2 新增真消费（T3.1）：model 徽标态 / loadHistory 前插
    expect(route("model.changed")).toBe(applyModelChangedEvent);
    // thinking.changed（thinking 批①，T2.1）：会话 store 级消费者（thinking 切片）
    expect(route("thinking.changed")).toBe(applyThinkingLevelEvent);
    expect(route("session.loadHistory.result")).toBe(applyHistoryEvent);
    // 拓扑级清单族（directory）：不入本注册表，经 dispatcher/frame.ts 前置路由
    expect(route("session.list.result")).toBeUndefined();
    expect(route("session.list_changed")).toBeUndefined();
    // 拓扑级模型/厂商配置族（model-config；T3.3 真消费）：同上前置路由
    for (const type of MODEL_CONFIG_EVENT_TYPES) {
      expect(route(type), `配置族不应注册会话 store 面：${type}`).toBeUndefined();
    }
    // v0.6 agent.config 族（M6 T4 真消费收口）：三 type 全走拓扑级前置路由
    // （dispatcher/frame.ts 参照 model 族）——changed 接真消费（agentConfig
    // 失效重拉信号），两结果帧拓扑级直通（真消费归页面查询链，trace.query.result
    // 先例；T3 registry no-op 占位已注销，T3 遗留②）
    for (const type of AGENT_CONFIG_EVENT_TYPES) {
      expect(route(type), `agent.config 族不应注册会话 store 面：${type}`).toBeUndefined();
    }
    expect(route("agent.config.changed")).toBeUndefined();
    expect(route("agent.config.list.result")).toBeUndefined();
    expect(route("agent.config.set_enabled.result")).toBeUndefined();
    // v0.7 web 族（T4 联网状态图标）：三 type 全走拓扑级前置路由——
    // result/changed 写真消费（topology.webStatus），stop.result 直通
    for (const type of WEB_EVENT_TYPES) {
      expect(route(type), `web 族不应注册会话 store 面：${type}`).toBeUndefined();
    }
  });
});
