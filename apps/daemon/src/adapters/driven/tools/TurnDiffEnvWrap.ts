/**
 * env.writeFile 写前快照包装（T2 turn diff 数据链）。
 *
 * CoreToolExecutor 全工具共享单 NodeExecutionEnv 实例——edit/edit-lines/
 * pi-write 落盘都走 env.writeFile(path, content, signal)。本包装在 writeFile
 * 前调 hook(path, content)（读旧内容快照 + 记账），hook 异常吞咽（diff
 * 失败不影响写入），hook 缺省原样返回（行为零差）。
 *
 * 【包装形态——spread 陷阱防御】NodeExecutionEnv 是 class（方法在原型上），
 * 纯对象 spread `{...env}` 会丢全部原型方法。此处用
 * Object.assign(Object.create(proto), ownProps) —— 原型方法经继承存活、
 * own 字段（cwd/shellEnv/activeChildPids 等）复制，writeFile 以自有属性
 * 遮蔽原型方法。对 plain-object 假 env（测试形态）同样成立。
 *
 * 与 notifyWrite/onEditApplied（E-48 写后挂点）分层共存：本钩子在 env 层
 * **写前**触发（快照语义——必须先于落盘读到原文），零冲突。
 */

/** 包装目标的最小结构面（NodeExecutionEnv 的 writeFile 切片）。 */
export interface EnvWriteTarget {
  writeFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<unknown>;
}

/** 写前钩子：writeFile 落盘前触发（此时磁盘仍是旧内容——快照时序锚）。 */
export type EnvWriteHook = (path: string, content: string | Uint8Array) => void | Promise<void>;

/**
 * 包装 env：writeFile 前 await hook(path, content)（异常吞咽），其余成员
 * 原样（原型继承 + own 复制）。hook 缺省 → 返回原 env（零包装零差）。
 */
export function wrapEnvForDiff<T extends EnvWriteTarget>(base: T, hook: EnvWriteHook | undefined): T {
  if (hook === undefined) return base;
  const wrapped = Object.assign(Object.create(Object.getPrototypeOf(base)) as T, base);
  (wrapped as T & EnvWriteTarget).writeFile = async (path, content, abortSignal) => {
    try {
      await hook(path, content);
    } catch {
      /* hook 异常吞咽：diff 链失败不波及写入 */
    }
    return base.writeFile(path, content, abortSignal);
  };
  return wrapped;
}
