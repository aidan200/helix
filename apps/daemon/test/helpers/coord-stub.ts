/**
 * 测试共享：coord 三工具注入 stub（U4）。
 *
 * 为什么存在：MainSessionProfile 声明了 coord_* 三名（声明面=注册面铁律），
 * 自建 CoreToolExecutor 的测试要装「main 全集」就必须注入 coord deps——
 * 本 helper 提供最小真服务（零依赖闭包），行为测试归 coord-tools.test.ts。
 */

import { CoordinationService } from "../../src/application/services/CoordinationService";
import type { CoordToolDeps } from "../../src/adapters/driven/tools/coord/CoordTools";

export function stubCoordDeps(sessionId = "test-session"): CoordToolDeps {
  const service = new CoordinationService({
    publish: () => undefined,
    planReaderFor: () => undefined,
    workspaceRoot: () => undefined,
    writeFacts: { sessionLastWriteAt: () => 0 } as never,
    now: () => 0,
  });
  return { service, sessionId, instanceId: "main" };
}
