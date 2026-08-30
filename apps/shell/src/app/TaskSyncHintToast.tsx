/**
 * W2-D kg sync 提示全局 toast（R13，设计 kg-driven-dev-loop-design D4）：
 * job 终态且 pending_sync 台账有未提示行时，daemon 经既有 task.changed
 * 广播通路随行 `syncHint` 人读文案（机器只记录只提醒，sync 本体永远人
 * 确认）——本组件常驻 AppRoutes（页面无关）订阅并直渲 toast（kg DTO
 * summary 人读文案直渲同规，前端零二次叙述）。
 *
 * 通配 task.subscribe 幂等：TasksPage 挂载同发，服务端连接级订阅表是
 * Set/布尔语义，重复订阅不双份投递；连接就绪门控与 TasksPage 同构
 * （重连后连接级订阅表已清，需补订）。
 */
import { useEffect, useRef } from "react";
import type { EventEnvelope, TaskChangedPayload } from "@helix/protocol";
import { useSession } from "@/entities/session/SessionContext";
import { useToast } from "@/shared/ui/Toast";

export default function TaskSyncHintToast() {
  const { state, sendTaskSubscribe, subscribeTaskFrames } = useSession();
  const toast = useToast();
  const conn = state.conn;

  // 连接就绪（首挂/重连）：通配订阅（重连后服务端订阅表已清——补订）
  //（防御：部分测试 mock 的 session 面不含 task 族——跳过不炸，App.gate-hold 先例）
  const prevConnRef = useRef<string | null>(null);
  useEffect(() => {
    if (typeof sendTaskSubscribe !== "function") return;
    const prev = prevConnRef.current;
    prevConnRef.current = conn;
    if (conn === "connected" && prev !== "connected") sendTaskSubscribe();
  }, [conn, sendTaskSubscribe]);

  // task.changed 随行 syncHint → toast（非提示帧不消费）
  useEffect(() => {
    if (typeof subscribeTaskFrames !== "function") return;
    return subscribeTaskFrames((e: EventEnvelope) => {
      if (e.type !== "task.changed") return;
      const hint = (e.payload as TaskChangedPayload).syncHint;
      if (typeof hint === "string" && hint !== "") toast.push("warn", hint);
    });
  }, [subscribeTaskFrames, toast]);

  return null;
}
