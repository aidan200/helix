import { loadConfig } from "./infrastructure/config";
import { createPaths } from "./infrastructure/paths";

/**
 * daemon 入口（architecture.md §3.6）：解析 `--home <dir>` 等 argv →
 * 调 paths/config → 启动日志。
 *
 * 本任务（T1.1 / CL-1）为占位启动：打印就绪信息后正常退出（退出码 0）；
 * 真正的常驻进程（WS 服务/组合根装配）自 T1.4+ 落地。
 */

/** 从 argv 中解析 `--home <dir>`；未提供时返回 undefined（走默认 ~/.helix）。 */
function parseHomeArg(argv: readonly string[]): string | undefined {
  const i = argv.indexOf("--home");
  if (i !== -1 && i + 1 < argv.length) {
    return argv[i + 1]!;
  }
  return undefined;
}

function main(): void {
  const explicitHome = parseHomeArg(process.argv);
  const paths = createPaths(explicitHome);
  const config = loadConfig(paths.configPath());

  console.log("[helix-daemon] 就绪（占位模式：常驻进程自 T1.4 起实现）");
  console.log(`[helix-daemon] home:   ${paths.home}`);
  console.log(`[helix-daemon] config: ${paths.configPath()}`);
  console.log(`[helix-daemon] db:     ${paths.dbPath()}`);
  console.log(`[helix-daemon] logs:   ${paths.logsDir()}`);
  console.log(`[helix-daemon] token:  ${paths.devTokenPath()}`);
  console.log(`[helix-daemon] port:   ${config.port}${config.model ? "" : "（config.json 缺失，默认值；model 未配置）"}`);
}

main();
