import { createDaemon } from "./infrastructure/container";
import { runChildMainEntry } from "./adapters/driven/subagent/child/ChildMain";

/**
 * daemon 入口（architecture.md §3.6）：解析 argv → 组合根启动（配置/锁/装配）
 * → 运行形态分发。
 *
 * argv（contracts/sidecar-lifecycle.md §1，TR-AD-35：argv 显式分发，两形态
 * 同一代码路径，禁 compile 产物自检分支）：
 * - `--home <dir>`：既有参数，原样透传；
 * - `--sidecar`：sidecar 形态——headless 运行（不起 CLI REPL），WS 就绪后
 *   stdout 输出单行 ready JSON（`{"type":"ready","port":N,"token":"..."}`），
 *   此后 stdout 不再承担协议；缺省 = CLI 形态（runCli 主循环）。
 * - `--child-main`：SubAgent 子进程形态——分发进 ChildMain 逻辑
 *   （SubagentLauncher 两形态统一 spawn `[process.execPath, <本文件>,
 *   "--child-main", ...]`：dev = bun 直跑本文件；compile 产物重入内嵌
 *   本文件，入口实参惰性忽略——同一代码路径，无形态分叉）。
 *
 * 启动期 fail-fast（中文报错 + 退出码 1）：
 * - 同 --home 已有实例运行（单例锁，AG-17）；
 * - config.json 缺 model 等（首次运行会先生成 0600 模板再引导填写）。
 */
function parseHomeArg(argv: readonly string[]): string | undefined {
  const i = argv.indexOf("--home");
  if (i !== -1 && i + 1 < argv.length) {
    return argv[i + 1]!;
  }
  return undefined;
}

async function main(): Promise<void> {
  const explicitHome = parseHomeArg(process.argv);
  const sidecar = process.argv.includes("--sidecar");

  let daemon;
  try {
    daemon = await createDaemon({ home: explicitHome });
  } catch (err) {
    console.error(`[helix-daemon] 启动失败：${(err as Error).message}`);
    process.exit(1);
  }

  // SIGTERM：优雅退出（停输入 → 释放锁）；CLI 形态下 SIGINT 由 CLI 适配器
  // 接管（生成中 → abort；空闲 → 退出）
  process.on("SIGTERM", () => {
    void daemon!.shutdown().then(() => process.exit(0));
  });

  if (sidecar) {
    // sidecar 形态（headless）：组合根返回即 WS 已监听（Bun.serve 同步绑定），
    // 上报 ready 行后常驻——事件循环由 WS 服务保持，关停走 SIGTERM 信号
    // （壳侧 SIGTERM→5s→SIGKILL，与 CLI 形态同一优雅退出路径）。
    process.stdout.write(
      JSON.stringify({ type: "ready", port: daemon!.ws.port, token: daemon!.devToken }) + "\n",
    );
    return;
  }

  try {
    await daemon.runCli();
  } finally {
    await daemon.shutdown();
  }
  process.exit(0);
}

// argv 分发（TR-AD-35）：--child-main 进子进程入口，否则 daemon 主流程。
if (process.argv.includes("--child-main")) {
  runChildMainEntry();
} else {
  void main();
}
