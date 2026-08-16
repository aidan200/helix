/**
 * T4.4 —— fake transport 标准入口 smoke（决策消解：入口本身是被测基建，
 * 不算还原项——env 与 URL 两形态注入各自一条 smoke，mock mode 下连接成功 +
 * 首帧到达）。
 *
 * - env 形态：URL 不带参数，vite define（VITE_HELIX_FAKE_TRANSPORT=1，
 *   webServer 注入）烘焙值生效 → SessionProvider 装配 fake transport →
 *   生产握手路径（hello 首帧 + welcome/snapshot 投影）真实跑通。
 * - URL 剧本模块形态：`?fakeTransport=<auto-connect 模块 /@fs URL>` →
 *   应用侧动态 import 剧本模块，default export 收到控制面 API 自动完成
 *   「open → welcome → snapshot」——spec 零手动驱动，仅断言产物。
 */
import { test, expect } from "./harness/fixtures";
import { messageCompleted, msgEntry } from "./harness/protocol";

test.describe("T4.4 fake transport 标准入口 smoke（env/URL 双形态）", () => {
  test("env 形态：define 烘焙值装配，握手/快照/增量全链可用", async ({ mockEnv, page }) => {
    // 建连剧本（真实生产路径）：open → hello → welcome + snapshot → connected
    await mockEnv.connect();
    await expect(mockEnv.app()).toHaveAttribute("data-conn", "connected");

    // 首帧到达：hello 已被客户端发出（connect 内 waitForCommand 已验）；
    // 快照投影落地 → 空会话引导页可见（entries=0 投影）
    await expect(page.locator(".session-empty")).toBeVisible();

    // 增量链路可用：emit 一帧 chat.message.completed → 主消息流投影
    // （帧构造经 harness/protocol 直引 @helix/protocol，零字面量 type）
    await mockEnv.emit(messageCompleted(msgEntry("smoke-env-1", "assistant", "env 形态增量可用")));
    await expect(page.locator(".msg.assistant", { hasText: "env 形态增量可用" })).toBeVisible();
  });

  test("URL 剧本模块形态：auto-connect 模块自动驱动建连（spec 零手动驱动）", async ({ mockScript }) => {
    // 剧本模块 default export 自动：open → welcome(sess-url-form) → snapshot([])
    // ——断言产物：connected + 空会话引导页（快照空投影）
    await expect(mockScript.locator(".app")).toHaveAttribute("data-conn", "connected", { timeout: 10_000 });
    await expect(mockScript.locator(".session-empty")).toBeVisible({ timeout: 10_000 });
  });
});
