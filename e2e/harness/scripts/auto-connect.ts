/**
 * URL 形态自动剧本模块（T4.4 入口 smoke 消费）。
 *
 * 装配路径：`?fakeTransport=<本模块经 vite /@fs 的 URL>` → SessionProvider
 * 动态 import 本模块 → default export 收到应用侧控制面 API（fake-transport
 * 的 HelixMockApi），自动完成「open → welcome → snapshot」标准建连剧本
 * ——无需 spec 手动驱动（证明剧本模块 URL 形态可自动驱动帧回放）。
 *
 * 帧构造直引 harness/protocol.ts（其运行时零依赖，仅 type import
 * @helix/protocol —— TR-TEST-3 纪律②：类型即守护）。
 */
import { snapshot, welcome } from "../protocol";
import type { HelixMockApi } from "../../../../apps/shell/src/shared/api/fake-transport";

export default async function autoConnect(api: HelixMockApi): Promise<void> {
  await api.open();
  await api.emit(welcome({ sessionId: "sess-url-form" }));
  await api.emit(snapshot([]));
}
