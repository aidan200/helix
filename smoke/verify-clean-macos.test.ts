/**
 * verify-clean-macos 纯函数面测试（评审 F5 #10/#12）。
 *
 * 该脚本跑「干净机等效」真机冒烟（env -i 起 .app、真 grep 检索、看护重启），
 * 端到端不挂常态测试集；两处修复的判定面抽可测纯函数钉住：
 *
 * - #10 端口定值：旧实现写 `<home>/config.json {port}` 定端口——但本脚本起的是
 *   打包 .app（壳固定以 `--sidecar` 拉 daemon，argv 不可达），config.json 的 port
 *   字段已随 config 瘦身批退役（迁移收口后静默回落 7333 → 握手 45s 超时误报）。
 *   定案：不再预绑端口，改为**从 daemon 日志的「WS 服务监听」行发现实际端口**
 *   （daemon 解析链 argv > KV daemon_port > 7333 的定格产物）。
 * - #12 报告落点：默认报告落点曾硬编码项目仓 `docs/iterations/iter-.../evidence/`
 *   （过程文档写进项目仓 docs/，违反工程纪律③a）且写死旧迭代/任务号。
 *   定案：默认落 `<workspace>/.helix/tmp/`，不记迭代号。
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_REPORT, parseListenPort } from "./verify-clean-macos";

describe("#10 daemon 端口发现（读 daemon 日志的监听行）", () => {
  test("标准 INFO 行 → 端口", () => {
    const log =
      "[2026-10-19T14:32:19.454Z] [INFO] WS 服务监听 ws://127.0.0.1:43157；dev token 已写入 /tmp/x/.helix/dev-token\n";
    expect(parseListenPort(log)).toBe(43157);
  });

  test("多行日志取末次监听（重启后新端口优先）", () => {
    const log = [
      "[t] [INFO] WS 服务监听 ws://127.0.0.1:40001；dev token 已写入 /tmp/x/.helix/dev-token",
      "[t] [INFO] 其他噪声 http://127.0.0.1:9999/helix-dev-token",
      "[t] [INFO] WS 服务监听 ws://127.0.0.1:40002；dev token 已写入 /tmp/x/.helix/dev-token",
    ].join("\n");
    expect(parseListenPort(log)).toBe(40002);
  });

  test("日志尚无监听行 / 空串 → undefined（调用方继续轮询）", () => {
    expect(parseListenPort("")).toBeUndefined();
    expect(parseListenPort("[t] [INFO] 启动中…\n")).toBeUndefined();
    // dev token 端点的 GET URL 不是监听行，不得误取
    expect(parseListenPort("GET http://127.0.0.1:7333/helix-dev-token")).toBeUndefined();
  });
});

describe("#12 默认报告落点（过程文档不落项目仓 docs/）", () => {
  test("落 <workspace>/.helix/tmp/，不带迭代/任务号", () => {
    expect(DEFAULT_REPORT).toContain(`${"/"}.helix/tmp/`);
    expect(DEFAULT_REPORT).not.toContain("docs/iterations");
    expect(DEFAULT_REPORT).not.toMatch(/iter-\d/);
  });
});
