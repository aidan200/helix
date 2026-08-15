import { createDaemon } from "./infrastructure/container";

/**
 * daemon 入口（architecture.md §3.6）：解析 `--home <dir>` 等 argv →
 * 组合根启动（配置/锁/装配）→ CLI 主循环。
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

  let daemon;
  try {
    daemon = createDaemon({ home: explicitHome });
  } catch (err) {
    console.error(`[helix-daemon] 启动失败：${(err as Error).message}`);
    process.exit(1);
  }

  // SIGTERM：优雅退出（停输入 → 释放锁）；SIGINT 由 CLI 适配器接管
  // （生成中 → abort；空闲 → 退出）
  process.on("SIGTERM", () => {
    void daemon!.shutdown().then(() => process.exit(0));
  });

  try {
    await daemon.runCli();
  } finally {
    await daemon.shutdown();
  }
  process.exit(0);
}

void main();
