/**
 * useShellSurface —— shell surface adapter（M0 表面协议地基批；设计稿 §1/D2/D4）。
 *
 * 页面级三动作（App 根单份挂载，接 useAppRoute 的 page）：
 * 1. **注册恒发**（连接就绪 → surface.register SHELL_SURFACE_DESCRIPTOR；
 *    重连随 conn 迁移重发——daemon 不持跨连接表面）。注册不受感知开关门
 *    ——navigate 收编（surface.action 消费）与感知上报正交；
 * 2. **感知开关默认 off**（D1）：off 时页面级事件零上行（activated/
 *    navigated 均不发）；开时——连接就绪报 activated（当前页）、路由切换
 *    报 navigated（携 from；断连窗口的页面变化不积累为导航事件，重连以
 *    activated 交代现页）；
 * 3. 事件 origin 恒 "user"（M0 页面级事件全是用户操作；管家触发的回声
 *    origin="steward" 消费接线留 M1——D7-2）。
 *
 * 帧序保证：注册 effect 先声明先执行——register 帧先于事件帧入队
 * （WS 有序传输，daemon 侧 observe 不见未注册连接）。
 */
import { useEffect, useRef } from "react";
import { useSession } from "@/entities/session/SessionContext";
import { SHELL_SURFACE_DESCRIPTOR, isSurfaceAwarenessOn } from "./shell-surface";

/** 注册帧发送失败后的退避重试延迟（每连接世代一次；仍失败等下次 conn 迁移重放）。 */
const SURFACE_REGISTER_RETRY_MS = 500;

export function useShellSurface(page: string): void {
  const { topology, sendSurfaceRegister, sendSurfaceEvent } = useSession() as {
    topology?: { active?: { conn?: string } };
    sendSurfaceRegister?: (descriptor: typeof SHELL_SURFACE_DESCRIPTOR) => boolean;
    sendSurfaceEvent?: (event: {
      kind: "activated" | "navigated";
      origin: "user";
      page: string;
      detail?: Record<string, unknown>;
    }) => boolean;
  };
  const conn = topology?.active?.conn ?? "connecting";
  // activated 报现页（effect deps 只有 conn——page 经 ref 读，避免页面变化
  // 重发 activated）；refs 提交后同步（command-surface 读点先例）
  const pageRef = useRef(page);
  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  // 1. 注册（恒发——重连重放；断连窗口零帧）
  const regRetriedRef = useRef(false);
  useEffect(() => {
    if (conn !== "connected") {
      regRetriedRef.current = false; // 连接世代复位（下个世代重新给一次重试额度）
      return;
    }
    // send 返回值必消费（TR-84：=== false 严格判 = 帧未发出）——注册帧丢弃=
    // daemon 侧没有该连接的表面（感知面/navigate 收编整体失灵），不是可忽略
    // 的软事件；conn 迁移与 socket 已断的竞态窗口里给一次退避重试，仍失败则
    // 等下次连接迁移重放（不发假成功）。
    if (sendSurfaceRegister?.(SHELL_SURFACE_DESCRIPTOR) === false && !regRetriedRef.current) {
      regRetriedRef.current = true;
      const timer = setTimeout(() => {
        sendSurfaceRegister?.(SHELL_SURFACE_DESCRIPTOR);
      }, SURFACE_REGISTER_RETRY_MS);
      return () => clearTimeout(timer);
    }
  }, [conn, sendSurfaceRegister]);

  // 2. activated（感知开关门内；conn 迁移驱动——重连 = 新表面新 activated）
  useEffect(() => {
    if (conn !== "connected" || !isSurfaceAwarenessOn()) return;
    // 事件帧是软语义（丢弃可容忍，不重试）——返回值消费点保留：false 即未发出，
    // 不做任何本地状态动作（感知面 next 帧自愈）
    if (sendSurfaceEvent?.({ kind: "activated", origin: "user", page: pageRef.current }) === false) return;
    // page 经 ref 读——不随页面变化重发（navigated 语义归下一 effect）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, sendSurfaceEvent]);

  // 3. navigated（页面变化；断连窗口更新基线不积累事件）
  const prevPageRef = useRef(page);
  useEffect(() => {
    if (conn !== "connected" || !isSurfaceAwarenessOn()) {
      prevPageRef.current = page; // 基线跟进（重连以 activated 交代现页）
      return;
    }
    if (prevPageRef.current === page) return;
    const from = prevPageRef.current;
    prevPageRef.current = page;
    // 事件帧软语义同 activated：返回值消费但不重试（断连窗口由基线跟进兜底）
    if (sendSurfaceEvent?.({ kind: "navigated", origin: "user", page, detail: { from } }) === false) return;
  }, [page, conn, sendSurfaceEvent]);
}
