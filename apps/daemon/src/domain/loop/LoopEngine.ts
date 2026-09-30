/**
 * LoopEngine —— helix 自有 agent loop 执行引擎门面（helix-loop L0 批；
 * Phase 0a 四层拆分后为组合装配面——设计 §2.2「LoopEngine 门面保留
 * （steward 兼容期），内部变为四件的组合装配」）。
 *
 * 公共 API（startRun/LoopEngineDeps/LoopRunResult）形状不变——消费者
 * （管家 StewardService）零感知；内部委派：
 * - kernel/LoopKernel 主循环（run 状态机 + 事件发射）；
 * - kernel/ToolPhase 工具段（暂停闸四态 + terminate 防火墙）；
 * - kernel/AbortSettler E-198 打断善后；
 * - policy/Compaction 轮边界压缩步（经 LoopKernelDeps.compactStep 注入
 *   ——kernel 零 policy import，依赖单向 runtime→policy→kernel→contracts）。
 *
 * Phase 2 起 LoopAgent（runtime/ 层）成为新的组合面，本门面留给管家
 * 直到切换完成。
 */
import type { LoopEventEmitter, LoopStreamFn } from "./contracts";
import { LoopKernel } from "./kernel";
import type { LoopRunHandle, LoopRunInput, ToolRegistry } from "./kernel";
import { createCompactionStep } from "./policy";
import type { LoopCompactionOptions } from "./policy";

export interface LoopEngineDeps {
  readonly streamFn: LoopStreamFn;
  readonly registry: ToolRegistry;
  /** 事件发射通道（同步回调——投影面单点）。 */
  readonly emit: LoopEventEmitter;
  /** runId 发号（缺省内部自增；测试注入）。 */
  readonly newRunId?: () => string;
  /** L1 件一：上下文压缩（阈值触发 + 滚动窗保留 + 配对保护；缺省 = 无压缩）。 */
  readonly compaction?: LoopCompactionOptions;
}

export class LoopEngine {
  private readonly kernel: LoopKernel;

  constructor(deps: LoopEngineDeps) {
    this.kernel = new LoopKernel({
      streamFn: deps.streamFn,
      registry: deps.registry,
      emit: deps.emit,
      newRunId: deps.newRunId,
      compactStep:
        deps.compaction !== undefined ? createCompactionStep({ compaction: deps.compaction, emit: deps.emit }) : undefined,
    });
  }

  /** 启动 run（立即进入循环；返回句柄 promise 在终态/paused 时 settle）。 */
  startRun(input: LoopRunInput): LoopRunHandle {
    return this.kernel.startRun(input);
  }
}
