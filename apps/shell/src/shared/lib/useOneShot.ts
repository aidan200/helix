/**
 * useOneShot —— 一次性意图槽消费 hook（StrictMode 双效应幂等收口）。
 *
 * # 为什么存在
 * 「reducer 状态槽承载一次性意图（如 restoreToast）→ effect 消费弹 toast +
 * dispatch 清槽」是本项目反复出现的模式（restore/spawn/kill toast 三处）。
 * 该模式有一个固有裂缝：dispatch 清槽经 React 异步渲染管线生效，而
 * StrictMode（dev）双效应在同一次提交内同步重跑 effect——第二遍看到的
 * 槽值还是旧渲染快照，于是同一份意图被消费两次（实证 2026-10-05 会话
 * ba24d84c 开启时弹两条相同恢复提示）。React 只保证渲染一致性，不保证
 * effect 恰好执行一次；幂等责任必须由消费端收口。
 *
 * 本 hook 把守卫做成单点基础设施（替代散装 ref——TracePage/AgentPage 的
 * mount 去重是动作语义不收编；ChatPage 三处 toast 槽消费收编于此）：
 * - claimed ref 同步占位（引用同一性判据）：双跑第二遍被挡；
 * - fire/consume 经 ref 持最新回调：effect deps 只含 slot，调用方传内联
 *   箭头也不误重触发。
 *
 * 判据说明：引用同一性（claimedRef.current === slot）。reducer 每次填新
 * 槽都是新对象引用 = 新意图 → 会 fire；同一引用二次进入（StrictMode 双跑
 * /消费未落地的重渲染）→ 挡。null 槽不占位不清位（新意图必然新引用）。
 */
import { useEffect, useRef } from "react";

/**
 * @param slot 一次性意图槽（null = 无待消费意图；非空对象引用 = 一份新意图）
 * @param fire 意图兑现副作用（弹 toast 等；恰好一次）
 * @param consume 槽清空指令（dispatch 消费；恰好一次，与 fire 同拍）
 */
export function useOneShot<T>(slot: T | null, fire: (value: T) => void, consume: () => void): void {
  // 占位哨（sentinel：undefined 之外的任何值都可能撞合法槽值，用独立 symbol 语义更稳）
  const claimedRef = useRef<{ readonly claimed: unknown } | null>(null);
  // 回调 ref 化：effect deps 只含 slot（fire/consume 引用漂移不重触发，取最新值）
  const fireRef = useRef(fire);
  fireRef.current = fire;
  const consumeRef = useRef(consume);
  consumeRef.current = consume;

  useEffect(() => {
    if (slot === null || slot === undefined) return;
    if (claimedRef.current?.claimed === slot) return; // 同一引用已被消费过 → 幂等挡下
    claimedRef.current = { claimed: slot }; // 同步占位（不等渲染——双跑第二遍即被挡）
    fireRef.current(slot);
    consumeRef.current();
    // deps 只含 slot：槽引用不变不重入（回调经 ref 取最新）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot]);
}
