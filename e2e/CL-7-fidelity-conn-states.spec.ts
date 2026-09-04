/**
 * TC2.5 —— R-09~R-14 连接四态表象与重连序列（CL-7 F 层还原度）。
 *
 * 断言源：review.md 必须还原 R-09（dot+label 四态联动）、R-10（断线/重连
 * 横幅）、R-11（connecting 覆盖层：投影不清空）、R-12（恢复 toast N 条重建、
 * 自动消失）、R-13（失败卡 + 重试 → connecting → connected）、R-14（输入
 * 禁用三 placeholder + 草稿保留）+ SM-1（四态互斥、切换清旧表象）/ SM-2
 * （转换序列）。剧本 S5。
 *
 * 边界：不断言演示毫秒常量（真实退避 baseMs=800/maxAttempts=5 为实现值），
 * 只断言状态机转换序列与表象；退避等待按真实时间（error 路径 ~12s）。
 */
import { test, expect } from "./harness/fixtures";
import { computed } from "./harness/style-utils";
import { shotEvidence, writeEvidence } from "./harness/evidence";
import { messageCompleted, msgEntry } from "./harness/protocol";
import { S5_ENTRIES } from "./harness/scenarios";

/** 安装 data-conn 变化序列记录器（SM-2 转换序列断言）。 */
async function recordConnSeq(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const seq: string[] = [];
    const app = document.querySelector(".app");
    if (app) {
      seq.push(app.getAttribute("data-conn") ?? "");
      new MutationObserver(() => seq.push(app.getAttribute("data-conn") ?? "")).observe(app, {
        attributes: true,
        attributeFilter: ["data-conn"],
      });
    }
    (window as unknown as { __connSeq: string[] }).__connSeq = seq;
  });
}

async function connSeq(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __connSeq?: string[] }).__connSeq ?? []);
}

test.describe("TC2.5 R-09~R-14/SM-1/SM-2 连接四态（S5）", () => {
  test("R-09 状态条 dot+label：connecting 黄脉冲 / connected 绿常亮 / disconnected 红脉冲", async ({ mock, page }) => {
    // W6o 首启 boot 门禁：未建连恒 boot 屏（首启 connecting 表象 = boot 活状态行），
    // 应用壳 conn-status 的 connecting 态经重连腿覆盖（首启后 phase 不回退）
    await expect(page.locator('[data-wsgate-boot="connecting"]')).toBeVisible();
    const dot = page.locator(".conn-status .hud-dot");

    // connected：绿常亮（无 pulse）
    await mock.connect();
    await expect(page.locator(".conn-status")).toContainText("已连接");
    await expect(dot).toHaveClass(/hud-dot-ok/);
    await expect(dot).not.toHaveClass(/hud-dot-pulse/);
    expect(await computed(page, ".conn-status .hud-dot", "background-color")).toBe("rgb(52, 211, 153)");

    // disconnected：红脉冲 + 已断开
    await mock.netClose();
    await mock.waitForConn("disconnected");
    await expect(page.locator(".conn-status")).toContainText("已断开");
    await expect(dot).toHaveClass(/hud-dot-error/);
    await expect(dot).toHaveClass(/hud-dot-pulse/);
    expect(await computed(page, ".conn-status .hud-dot", "background-color")).toBe("rgb(248, 113, 113)");

    // connecting（自动重连腿）：黄脉冲 + 连接中
    await mock.waitForConn("connecting", 8_000);
    await expect(page.locator(".conn-status")).toContainText("连接中");
    await expect(dot).toHaveClass(/hud-dot-warn/);
    await expect(dot).toHaveClass(/hud-dot-pulse/);
    expect(await computed(page, ".conn-status .hud-dot", "background-color")).toBe("rgb(251, 191, 36)");
  });

  test("SM-2/R-10/R-11/R-12 断线重连序列：横幅→覆盖层→恢复 toast；投影不清空；互斥清除", async ({ mock, page }) => {
    // 建连（快照 2 条）→ 消息投影可见（W6o：.app 首连后才渲染——
    // data-conn 序列记录器在首个 connected 后安装，序列从 connected 起记）
    await mock.open();
    await mock.waitForCommand("hello");
    const { snapshot, welcome } = await import("./harness/protocol");
    await mock.emitAll([welcome(), snapshot(S5_ENTRIES)]);
    await mock.waitForConn("connected");
    await recordConnSeq(page);
    await expect(page.locator(".msg")).toHaveCount(2);
    await expect(page.locator(".conn-banner")).toBeHidden(); // connected 无横幅（R-10）
    await expect(page.locator(".conn-overlay")).toBeHidden();

    // 意外断开 → disconnected：error 色横幅 + 尝试计数；投影不清空（SM-2 规则 4）
    await mock.netClose();
    await mock.waitForConn("disconnected");
    await expect(page.locator(".conn-banner")).toBeVisible();
    await expect(page.locator(".conn-banner")).toContainText("连接中断 · 自动重连中");
    await expect(page.locator(".conn-banner .retry-n")).toContainText("第");
    await expect(page.locator(".conn-banner .retry-n")).toContainText("次尝试");
    expect(await computed(page, ".conn-banner", "color")).toBe("rgb(248, 113, 113)"); // error 语义色
    // SM-1：disconnected 时覆盖层/失败卡不出现
    await expect(page.locator(".conn-overlay")).toBeHidden();
    await expect(page.locator(".session-error")).toBeHidden();
    await expect(page.locator(".msg")).toHaveCount(2); // 投影保留

    // 自动重连 → connecting：warning 横幅 + 覆盖层（spinner + 地址），投影仍在 DOM
    await mock.waitForConn("connecting", 8_000);
    await expect(page.locator(".conn-banner")).toContainText("正在重新连接 daemon");
    await expect(page.locator(".conn-banner .retry-n")).toContainText("ws://127.0.0.1:7333");
    expect(await computed(page, ".conn-banner", "color")).toBe("rgb(251, 191, 36)"); // warning 语义色
    await expect(page.locator(".conn-overlay")).toBeVisible();
    await expect(page.locator(".conn-spinner")).toBeVisible();
    await expect(page.locator(".conn-overlay .t1")).toContainText("正在连接 daemon");
    await expect(page.locator(".conn-overlay .t2")).toContainText("ws://127.0.0.1:7333");
    // 覆盖层 = 半透明覆盖（void/0.72 + blur），投影未被清空（R-11）
    expect(await computed(page, ".conn-overlay", "backdrop-filter")).toContain("blur");
    await expect(page.locator(".session-active .msg")).toHaveCount(2);
    await shotEvidence(page, "fidelity-conn-reconnecting");

    // 重连成功 → connected：恢复 toast（N 条重建）+ 旧表象清除（SM-1）
    await mock.waitForCommand("hello");
    await mock.emitAll([welcome(), snapshot(S5_ENTRIES)]);
    await mock.waitForConn("connected");
    const toast = page.locator(".toast.ok");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("会话已恢复");
    await expect(toast.locator(".t-sub")).toContainText("daemon 快照 + 增量事件重放 · 消息 2 条 · 实例/通道/账目投影已重建");
    await expect(page.locator(".conn-banner")).toBeHidden();
    await expect(page.locator(".conn-overlay")).toBeHidden();
    await expect(page.locator(".msg")).toHaveCount(2);

    // toast 自动消失（约 4s；断言消失行为，不严格断言时长精度）
    await expect(toast).toBeHidden({ timeout: 8_000 });
    await shotEvidence(page, "fidelity-conn-restored");

    // SM-2 转换序列：connected → disconnected → connecting → connected（无跳态）
    const seq = await connSeq(page);
    const iConn1 = seq.indexOf("connected");
    const iDisc = seq.indexOf("disconnected");
    const iReconn = seq.indexOf("connecting", iDisc + 1); // 跳过初始 connecting 态
    const iConn2 = seq.lastIndexOf("connected");
    expect(iConn1).toBeGreaterThan(-1);
    expect(iDisc).toBeGreaterThan(iConn1);
    expect(iReconn).toBeGreaterThan(iDisc);
    expect(iConn2).toBeGreaterThan(iReconn);

    writeEvidence("fidelity-conn-sequence", "txt", `data-conn sequence: ${seq.join(" → ")}`);
  });

  test("R-14 输入禁用与三 placeholder：跨态草稿保留", async ({ mock, page }) => {
    const input = page.locator("#msg-input");
    // W6o 首启门禁：未建连恒 boot 屏（输入区未渲染）；首连 connecting 的
    // 输入禁用语义经重连 connecting 腿覆盖（下方）
    await expect(page.locator('[data-wsgate-boot="connecting"]')).toBeVisible();
    await expect(input).toHaveCount(0);

    // connected：enabled + 正常 placeholder；输入草稿
    await mock.connect();
    await expect(input).toBeEnabled();
    await expect(input).toHaveAttribute("placeholder", "输入消息，Alt+Enter 发送");
    await input.fill("跨状态保留的草稿");

    // disconnected：disabled + placeholderWaiting + 草稿保留（SM 规则 5）
    await mock.netClose();
    await mock.waitForConn("disconnected");
    await expect(input).toBeDisabled();
    await expect(input).toHaveAttribute("placeholder", "等待连接恢复…");
    await expect(input).toHaveValue("跨状态保留的草稿");

    // 重连 connecting：disabled + placeholderConnecting + 草稿仍在
    await mock.waitForConn("connecting", 8_000);
    await expect(input).toBeDisabled();
    await expect(input).toHaveAttribute("placeholder", "正在建立连接…");
    await expect(input).toHaveValue("跨状态保留的草稿");

    // 发送按钮同步禁用（仅 connected 可发）
    await expect(page.locator("#btn-send")).toBeDisabled();

    // 恢复 connected：草稿仍在、可继续编辑发送
    await mock.waitForCommand("hello");
    const { snapshot, welcome } = await import("./harness/protocol");
    await mock.emitAll([welcome(), snapshot(S5_ENTRIES)]);
    await mock.waitForConn("connected");
    await expect(input).toHaveValue("跨状态保留的草稿");
    await expect(input).toBeEnabled();
  });

  test("R-13 失败卡与手动重试：重试耗尽 → error 卡 → 重试 → connecting → connected（重建投影）", async ({ mock, page }) => {
    test.setTimeout(60_000);

    // 首连持续失败：dev-token 端点 500（后注册 route 优先）
    const failToken = async (route: import("@playwright/test").Route) => {
      await route.fulfill({ status: 500, contentType: "text/plain", body: "boom" });
    };
    // 时序关键：必须等首连 token fetch（200）完成、fake transport 创建并注册
    // 控制面后再挂 500 route——否则首个 transport 永不创建（token 500 →
    // 退避重试循环），__helixMock 永不注册（动态 import 由首个 transport 触发）
    await expect(page.locator("[data-wsgate-boot]")).toBeVisible({ timeout: 20_000 });
    await mock.awaitReady();
    await page.route("**://127.0.0.1:7333/helix-dev-token", failToken);
    // 首连 transport 的 token 已取得（200）——手动天折它，
    // 使后续重试序列的 token fetch 全部吃 500（避免 transport 挂起等 open）
    await mock.failHandshake();

    // 退避耗尽（真实退避 ~12s，不做毫秒断言）→ error 态
    // W6o 首启门禁：首连 error 卡 = boot 屏 error 形态（data-wsgate-boot="error"，
    // ErrorCard 视觉语言 + useSession().retry 同一 SM-2 手动重试路径）；
    // 应用壳未渲染（phase 未达 main）
    await expect(page.locator('[data-wsgate-boot="error"]')).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('[data-wsgate-boot="error"] .err-icon')).toBeVisible();
    await expect(page.locator('[data-wsgate-boot="error"] .wsgate-title')).toHaveText("无法连接 daemon");
    const retryBtn = page.locator('[data-wsgate-boot="error"] button', { hasText: "重试连接" });
    await expect(retryBtn).toBeVisible();
    // error 态独占：应用壳表象（横幅/覆盖层/empty/输入区）均不渲染（SM-1）
    await expect(page.locator(".conn-banner")).toHaveCount(0);
    await expect(page.locator(".conn-overlay")).toHaveCount(0);
    await expect(page.locator(".session-empty")).toHaveCount(0);
    await expect(page.locator("#msg-input")).toHaveCount(0);
    await shotEvidence(page, "fidelity-conn-error-card");

    // 恢复端点 → 手动重试 → connecting（boot 序列复播）→ connected（壳渲染 + 重建投影）
    await page.unroute("**://127.0.0.1:7333/helix-dev-token", failToken);
    await retryBtn.click();
    await expect(page.locator('[data-wsgate-boot="connecting"]')).toBeVisible();
    // 重试 = 新 token fetch（200）→ 新 transport 创建（动态 import 已缓存）→
    // 控制面 fireOpen 后客户端发 hello
    await mock.open();
    await mock.waitForCommand("hello");
    const { snapshot, welcome } = await import("./harness/protocol");
    await mock.emitAll([welcome(), snapshot([...S5_ENTRIES, msgEntry("s5-m3", "user", "重试后的新投影")])]);
    await mock.waitForConn("connected");
    // 重建投影（含快照内容）
    await expect(page.locator(".msg")).toHaveCount(3);
    await expect(page.locator(".msg", { hasText: "重试后的新投影" })).toBeVisible();
    // 手动重试成功的 toast 文案（chat.error.retryOk）——首启路径 ChatPage 在
    // toast 落账后才挂载，dev StrictMode 挂载双调会推两条同文 toast（生产单条），
    // 断言取首条不钉条数
    const toast = page.locator(".toast.ok").first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("连接已建立");
    await expect(toast.locator(".t-sub")).toContainText("会话投影从 daemon 快照重建");

    writeEvidence("fidelity-conn-retry-sequence", "txt", "boot error card → manual retry → connecting → connected");
    void messageCompleted; // 保留 import 语义（本用例走快照重建路径）
  });
});
