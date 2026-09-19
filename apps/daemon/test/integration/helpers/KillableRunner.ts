/**
 * 挂起形态 InstanceRunner（agent-ws.test.ts 同构抽出，语音播报批 V2 复用）：
 * launch 挂起不收口——closure 由测试 forceClosure 驱动（时序可控）。
 */
import type { AgentEngineEvent } from "../../../src/application/ports/outbound/AgentEnginePort";
import type {
  InstanceRunner,
  InstanceRunnerCallbacks,
  InstanceClosureOutcome,
} from "../../../src/application/services/InstanceRunner";

export class KillableRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  private readonly closed = new Set<string>();
  readonly kills: string[] = [];
  setCallbacks(cb: InstanceRunnerCallbacks): void {
    this.callbacks = cb;
  }
  launch(): void {
    // 挂起：closure 由测试驱动
  }
  send(): void {
    /* 本文件不覆盖 send */
  }
  kill(instanceId: string): void {
    this.kills.push(instanceId);
  }
  emitEngineEvent(instanceId: string, event: AgentEngineEvent): void {
    this.callbacks?.onInstanceEvent(instanceId, event);
  }
  forceClosure(instanceId: string, outcome: InstanceClosureOutcome): void {
    if (this.closed.has(instanceId)) return;
    this.closed.add(instanceId);
    this.callbacks?.onInstanceClosure(instanceId, outcome);
  }
}
