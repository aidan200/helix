import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect } from "./harness/daemon-fixture";
import { replyFromResult, toolCall, type DaemonScript } from "./harness/daemon-script";

/** 真 HTTP 代理桩；目标 .invalid 无法直连，成功必须经过本地代理。 */
async function serveProxy(marker: string) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    if (req.url?.includes("helix-proxy-test.invalid")) requests.push(req.url);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body><h1>${marker}</h1><p>local proxy acceptance fixture</p></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

const script: DaemonScript = { entries: [
  toolCall("web_fetch", { url: "http://helix-proxy-test.invalid/page" }), replyFromResult("PROXY_FIRST_RESULT: {last}"),
  toolCall("web_fetch", { url: "http://helix-proxy-test.invalid/page" }), replyFromResult("PROXY_SECOND_RESULT: {last}"),
] };

test("network proxy: UI → real WS/KV → hot web_fetch routing → reload/restart persistence", async ({ e2e, page }, info) => {
  test.setTimeout(90000);
  const a = await serveProxy("PROXY_ROUTE_ALPHA");
  const b = await serveProxy("PROXY_ROUTE_BRAVO");
  try {
    const daemon = await e2e.startDaemon({ script });
    const writes: Record<string, unknown>[] = [];
    // 只观察真实出站帧，不拦截或伪造任何 WS 回执。
    page.on("websocket", socket => socket.on("framesent", frame => {
      try {
        const command = JSON.parse(String(frame.payload));
        if (command.type === "config.set_proxy") writes.push(command.payload);
      } catch { /* 非 JSON 不参与计数 */ }
    }));
    await e2e.openApp(page);
    await e2e.waitForConnected(page);
    const openSettings = async () => {
      await page.locator('.rail-btn[data-page="settings"]').click();
      await page.locator('[data-settings-nav] [data-section="general"]').click();
      await expect(page.locator('[data-proxy-option="on"]')).toBeEnabled();
    };
    await openSettings();
    const group = page.locator("[data-network-proxy]");
    const input = group.locator("[data-proxy-url]");
    await expect(group.locator('[data-proxy-option="off"]')).toHaveAttribute("aria-pressed", "true");
    await input.fill(a.url);
    // 包含真实的 input blur → button click 顺序，必须只有一次原子写。
    await group.locator('[data-proxy-option="on"]').click();
    await expect(group.locator('[data-proxy-option="on"]')).toHaveAttribute("aria-pressed", "true");
    await expect(group.locator("[data-proxy-saved]")).toBeVisible();
    expect(writes).toEqual([{ enabled: true, url: a.url }]);
    await group.screenshot({ path: info.outputPath("network-proxy-dark.png") });
    await page.locator("#btn-theme-toggle").click();
    await group.screenshot({ path: info.outputPath("network-proxy-light.png") });

    await page.locator('.rail-btn[data-page="chat"]').click();
    await e2e.send(page, "读取代理验证页面，复述真实工具结果");
    await e2e.waitForTurnDone(page, "PROXY_ROUTE_ALPHA");
    expect(a.requests).toHaveLength(1);

    await openSettings();
    await input.fill(b.url);
    await input.press("Enter");
    await expect(group.locator("[data-proxy-saved]")).toBeVisible();
    await expect(input).toBeEnabled();
    await page.locator('.rail-btn[data-page="chat"]').click();
    await e2e.send(page, "再次读取同一页面，验证下一次请求已切换代理");
    await e2e.waitForTurnDone(page, "PROXY_ROUTE_BRAVO");
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);

    await openSettings();
    await input.fill("socks5://127.0.0.1:1080");
    await input.press("Enter");
    await expect(group.locator("[data-proxy-error]")).toContainText("SOCKS5");
    expect(writes).toHaveLength(2); // 非法协议不向 daemon 发送。
    await page.reload();
    await e2e.waitForConnected(page);
    await openSettings();
    await expect(input).toHaveValue(b.url); // 真 KV 持久化
    await group.locator('[data-proxy-option="off"]').click();
    await expect(group.locator('[data-proxy-option="off"]')).toHaveAttribute("aria-pressed", "true");
    await expect(input).toHaveValue(b.url); // 关闭保留地址

    await daemon.stop();
    await expect(page.locator(".app")).not.toHaveAttribute("data-conn", "connected");
    await e2e.startDaemon({ script: { entries: [] }, home: daemon.home, retries: 2 });
    await e2e.waitForConnected(page);
    // 不重新挂载设置组，重连必须主动重拉。
    await expect(input).toHaveValue(b.url);
    await expect(group.locator('[data-proxy-option="off"]')).toHaveAttribute("aria-pressed", "true");
    await expect(group.locator('[data-proxy-option="on"]')).toBeEnabled();
    await expect(group.locator("[data-proxy-saved]")).toHaveCount(0);
  } finally { await a.close(); await b.close(); }
});
