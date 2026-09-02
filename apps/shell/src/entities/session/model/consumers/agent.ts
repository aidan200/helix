/**
 * agent 消费者 —— SubAgent 编排生命周期族（agent.* 七 case；C2 拆分，AD-3，T1.1）。
 *
 * 契约 §5.1/§7：四态互斥单值、终态吸收（F1.9：实例不复活，重派 = 新
 * agentId 新卡）；agent.spawned 预算内直跑为主路径（秒回出卡 + channel 开行：
 * spawned / 模型解析行——声明槽位或缺省继承主线模型，AD-6）；agent.killed →
 * failed 单一终态 + terminated 交代（不设第五卡片态，§8-2）；agent.stalled 非
 * 状态迁移（running 上的警示，可再次发生，§8-3）。卡片/行工具经
 * instance-cards.ts / channel.ts 共享（chat 消费者摘要尾窗同源）。
 * agent.state.changed 是主线会话运行态，归 chat 消费者（见其模块头）。
 */
import type { EventEnvelope } from "@helix/protocol";
import { lcItem, withChannel } from "../channel";
import { isTerminal, updateCard } from "../instance-cards";
import type { InstanceCardState, SessionState } from "../state";

/** 本块承接的帧事件 type（dispatcher 注册面）。 */
export const AGENT_EVENT_TYPES = [
  "agent.spawned",
  "agent.queued",
  "agent.started",
  "agent.stalled",
  "agent.completed",
  "agent.failed",
  "agent.killed",
  // park/resume 批：挂起/恢复事件登记消费（无静默吞帧，dispatcher 守护）；
  // parked 卡片形态/徽标归后续波次（本批 no-op——卡片状态不变，恢复仍由
  // agent.started 驱动）
  "agent.parked",
  "agent.resumed",
] as const;

export function applyAgentEvent(s: SessionState, event: EventEnvelope, ts?: number): SessionState {
  switch (event.type) {
    case "agent.spawned": {
      const { agentId, task, profileKind, model, anchorEntryId } = event.payload;
      const existing = s.instances.find((c) => c.instanceId === agentId);
      if (existing) {
        // 终态吸收（重派 = 新 agentId 新卡）；非终态重发仅刷新任务面（channel 不重复开行）
        if (isTerminal(existing.state)) return s;
        return {
          ...s,
          instances: updateCard(s.instances, agentId, (c) => ({
            ...c,
            task,
            profileKind,
            ...(model !== undefined ? { model } : {}),
          })),
        };
      }
      // 预算内直跑为主路径（spawn 秒回即执行；超限时随后 agent.queued 投影转 queued）
      const card: InstanceCardState = {
        instanceId: agentId,
        state: "running",
        task,
        profileKind,
        ...(model !== undefined ? { model } : {}),
        streamSummary: "",
        // CL-1 v0.3 时间轴锚点：DTO 帧直读为唯一权威（daemon spawn 时刻计算下发；
        // null = 流首有效锚，不回落）；shell 零推导（Q-1c）
        anchorEntryId: anchorEntryId ?? null,
      };
      const withCard: SessionState = {
        ...s,
        instances: [...s.instances, card],
        spawnToast: { instanceId: agentId, profileKind }, // F1.5 spawn 秒回 toast
      };
      // channel 开行：spawned + 模型解析（声明槽位/缺省继承主线，AD-6；F1.2）
      return withChannel(withCard, agentId, (next) => [
        lcItem("spawned", ts !== undefined ? { ts } : {})(next()),
        lcItem(
          "modelResolved",
          model !== undefined
            ? { model, slot: "declared", ...(ts !== undefined ? { ts } : {}) }
            : { model: s.model, slot: "inherited", ...(ts !== undefined ? { ts } : {}) },
        )(next()),
      ]);
    }
    case "agent.queued": {
      const { agentId, position } = event.payload;
      // 位次随出队递减由事件重发驱动（不自行计算）；终态吸收
      return {
        ...s,
        instances: updateCard(s.instances, agentId, (c) =>
          isTerminal(c.state) ? c : { ...c, state: "queued", queuedPosition: position, stalledMs: undefined },
        ),
      };
    }
    case "agent.started": {
      const { agentId, startedAtMs } = event.payload;
      return {
        ...s,
        instances: updateCard(s.instances, agentId, (c) =>
          isTerminal(c.state)
            ? c
            : {
                ...c,
                state: "running",
                queuedPosition: undefined,
                stalledMs: undefined,
                // 真实执行时长锚点（daemon 域模型记账；旧剧本缺省不携带 = 保挂载起算兼容）
                ...(startedAtMs !== undefined ? { startedAtMs } : {}),
              },
        ),
      };
    }
    case "agent.stalled": {
      // 非状态迁移（实例仍 running，可再次发生）；仅 running 态记录 + 警示行（§8-3）
      const { agentId, idleMs } = event.payload;
      const card = s.instances.find((c) => c.instanceId === agentId);
      const next: SessionState = {
        ...s,
        instances: updateCard(s.instances, agentId, (c) =>
          c.state === "running" ? { ...c, stalledMs: idleMs } : c,
        ),
      };
      if (!card || card.state !== "running") return next; // 非运行态吸收：无警示行
      return withChannel(next, agentId, (n) => [
        lcItem("stalled", { idleMs, ...(ts !== undefined ? { ts } : {}) })(n()),
      ]);
    }
    case "agent.completed": {
      const { agentId, closure } = event.payload;
      const card = s.instances.find((c) => c.instanceId === agentId);
      const next: SessionState = {
        ...s,
        instances: updateCard(s.instances, agentId, (c) =>
          isTerminal(c.state)
            ? c
            : {
                ...c,
                state: "done",
                closure,
                queuedPosition: undefined,
                stalledMs: undefined,
                streamSummary: "", // 摘要定稿归于 closure：done 卡渲染 closure.summary，尾窗仅 running 态有意义
              },
        ),
      };
      if (!card || isTerminal(card.state)) return next;
      return withChannel(next, agentId, (n) => [{ kind: "closure", seq: n(), closure }]);
    }
    case "agent.failed": {
      const { error, closure } = event.payload;
      const card = s.instances.find((c) => c.instanceId === event.payload.agentId);
      const next: SessionState = {
        ...s,
        instances: updateCard(s.instances, event.payload.agentId, (c) =>
          isTerminal(c.state)
            ? c
            : {
                ...c,
                state: "failed",
                error,
                closure,
                queuedPosition: undefined,
                stalledMs: undefined,
                streamSummary: "", // 同 agent.completed：错误行 = error 字段，尾窗复位
              },
        ),
      };
      if (!card || isTerminal(card.state)) return next;
      return withChannel(next, event.payload.agentId, (n) => [
        lcItem("crashed", { error, ...(ts !== undefined ? { ts } : {}) })(n()),
        { kind: "closure", seq: n(), closure },
      ]);
    }
    case "agent.killed": {
      // kill → failed 单一终态 + terminated 交代（P-2 消费）；不设第五卡片态（§8-2）
      const card = s.instances.find((c) => c.instanceId === event.payload.agentId);
      const next: SessionState = {
        ...s,
        instances: updateCard(s.instances, event.payload.agentId, (c) =>
          isTerminal(c.state)
            ? c
            : {
                ...c,
                state: "failed",
                terminated: true,
                closure: event.payload.closure,
                queuedPosition: undefined,
                stalledMs: undefined,
                streamSummary: "",
              },
        ),
      };
      if (!card || isTerminal(card.state)) return next;
      return {
        ...withChannel(next, event.payload.agentId, (n) => [
          lcItem("terminated", ts !== undefined ? { ts } : {})(n()),
          { kind: "closure", seq: n(), closure: event.payload.closure },
        ]),
        killToast: { instanceId: event.payload.agentId }, // F1.2 终止链末端 toast（一次性）
      };
    }
    // park/resume 批：parked 卡片形态/徽标归后续波次；resumed 最小动作 = 时长
    // 记账对齐（park 期间挂载钟虚增段由 resume 帧的基线+新段起点自动校正）
    case "agent.parked":
      return s;
    case "agent.resumed": {
      const { agentId, startedAtMs, elapsedMs } = event.payload;
      return {
        ...s,
        instances: updateCard(s.instances, agentId, (c) =>
          isTerminal(c.state)
            ? c
            : {
                ...c,
                ...(startedAtMs !== undefined ? { startedAtMs } : {}),
                ...(elapsedMs !== undefined ? { elapsedMs } : {}),
              },
        ),
      };
    }
    default:
      return s;
  }
}
