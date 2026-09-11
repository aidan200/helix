/**
 * bash 写感知 env 包装（U0b——照 SandboxEnvWrap 零侵入装饰模式）。
 *
 * 包装面：仅 exec（bash 唯一通道）——前快照 → 原执行（内层可能是沙箱
 * 改写后的命令——本包装在最外层，看到的原始 command，快照口径覆盖
 * 沙箱执行）→ 后快照差集 → 剔除他人 precise 写 → onObserved 出口。
 *
 * 与沙箱正交：沙箱是约束（写不出去），本层是感知（写了什么）——
 * 沙箱 off 时感知照常工作（walk 面兜 git 面）。
 *
 * 零侵入保证：runtime 未注入 → 返回原 env（引用不变零差）。
 * 异常纪律：快照/感知全程吞异常——感知失败绝不影响命令执行结果。
 *
 * 归属剔除：diff 结果剔除时间窗内其他 agent 的 precise 写（他人工具
 * 写的文件不误归本命令）。残余歧义（跨进程 bash 真并发双方都算自己）
 * 不标记——消费方全部是并集语义（护栏放行/足迹注入「碰过就算」），
 * 无害（设计文档 U0b L228 口径）。
 */

import {
  diffBashSnapshots,
  planBashSnapshot,
  takeBashSnapshot,
  type BashSnapshot,
} from "../writefact/bashSnapshot";
import type { WriteConfidence } from "../../../domain/writefact/types";

/** 单条观察到的写（裸事实——归属/会话由出口回调装配方补全）。 */
export interface BashObservedWrite {
  readonly path: string;
  readonly confidence: WriteConfidence;
  readonly at: number;
}

/** bash 感知运行时注入面（装配层构造；CoreToolExecutor 可选槽）。 */
export interface BashSenseRuntime {
  /** 观察出口（main → registry.recordMany；subagent → wire bash-fact 行）。 */
  readonly onObserved: (observed: readonly BashObservedWrite[]) => void;
  /** 他人 precise 写路径查询（归属剔除；缺省恒空——子进程侧跨进程并发归父侧并集语义）。 */
  readonly preciseSince?: (cutoffMs: number) => readonly string[];
  /** 时钟注入（测试确定性）。 */
  readonly now?: () => number;
}

/** 包装目标最小结构面。 */
export interface BashSenseEnvTarget {
  cwd: string;
  exec(
    command: string,
    options?: Record<string, unknown>,
  ): Promise<{ ok: boolean } & Record<string, unknown>>;
}

/** 包装 env：exec 前后快照差集感知。runtime 缺省 → 原 env。 */
export function wrapEnvForBashSense<T extends BashSenseEnvTarget>(base: T, runtime: BashSenseRuntime | undefined): T {
  if (runtime === undefined) return base;
  const now = runtime.now ?? (() => Date.now());

  const wrapped = Object.assign(Object.create(Object.getPrototypeOf(base)) as T, base);
  const w = wrapped as T & BashSenseEnvTarget;

  w.exec = async (command: string, options?: Record<string, unknown>) => {
    const t0 = now();
    // 前快照（失败 → undefined，执行后走 L1 降级或零记录）
    let before: BashSnapshot | undefined;
    try {
      const plan = planBashSnapshot(command, base.cwd);
      before = await takeBashSnapshot(plan, base.cwd);
    } catch {
      before = undefined;
    }
    const settle = async (): Promise<void> => {
      try {
        if (before === undefined) {
          // 前快照失败 → L1 uncertain 降级（静态提取兜底）
          const plan = planBashSnapshot(command, base.cwd);
          const facts = plan.l1Paths.map((p) => ({ path: p, confidence: "uncertain" as const, at: now() }));
          if (facts.length > 0) runtime.onObserved(facts);
          return;
        }
        const after = await takeBashSnapshot(before.plan, base.cwd);
        const changed = diffBashSnapshots(before, after);
        if (changed.length === 0) return;
        const excluded = runtime.preciseSince?.(t0) ?? [];
        const facts: BashObservedWrite[] = changed
          .filter((p) => !excluded.includes(p))
          .map((p) => ({ path: p, confidence: "inferred" as const, at: now() }));
        if (facts.length > 0) runtime.onObserved(facts);
      } catch {
        // 感知失败吞异常——绝不影响命令结果
      }
    };
    try {
      const result = await base.exec(command, options);
      await settle();
      return result;
    } catch (err) {
      // 命令失败也可能已部分写入——照做后处理再抛原错误
      await settle();
      throw err;
    }
  };

  return wrapped;
}
