# helix-v2

## 安装（macOS arm64 / Apple Silicon）

1. 下载分发物 `helix_<版本>_aarch64.dmg`，打开后将 `helix.app` 拖入「应用程序」。
2. 首次启动：分发物当前为 ad-hoc 未签名（签名/公证留待后续迭代），直接双击会被 Gatekeeper 拦截——在「应用程序」中**右键 `helix.app` → 打开**，再在对话框中确认「打开」即可（仅首次需要）。若仍被拦截，兜底路径：系统设置 → 隐私与安全性 → 安全性一栏点「仍要打开」。
3. 零依赖：应用内已捆绑 daemon 与 ripgrep，**无需安装 Bun、rg 或任何运行时**，开箱即用。

平台限定：当前仅提供 **macOS arm64（Apple Silicon）** 构建，无 Intel / 其他平台分发物。

## 开发

前提：Bun（`packageManager: bun@1.3.14`）；桌面端 dev/打包另需 Rust 工具链（cargo/rustc——Tauri 壳构建前提，非 helix 运行时依赖）。

```bash
bun install        # 同时经 prepare 脚本自动配置 git hooks（core.hooksPath=.githooks）

bun run dev          # daemon 直跑（源码）
bun run dev:shell    # 前端 vite dev
bun run dev:desktop  # 桌面端 dev 一行编排：daemon 源码直跑 + vite dev + tauri dev
```

提交闸门：`pre-commit` 钩跑四包 typecheck（约 6s，`scripts/typecheck-all.sh`）；完整本地验证 = `bun run verify`（typecheck + daemon/protocol/shell 三套单测）。钩未生效时手动执行 `git config core.hooksPath .githooks`。

`bun run dev:desktop` 启动前自检 cargo/rustc；缺失时输出一行安装提示（rustup 命令）并退出，按提示安装即可。

```bash
bun run build:desktop  # 五步管线：compile daemon + 前端构建 + tauri build
```

打包产出：`apps/shell/src-tauri/target/release/bundle/` 下的 `macos/helix.app` 与 `dmg/helix_<版本>_aarch64.dmg`（arm64，ad-hoc 未签名；签名配置位读环境变量证书配置，有 = 签名+公证，无 = ad-hoc）。

## 测试

```bash
bun test apps/daemon   # daemon 全量（unit/integration/arch-guard）
bun run test:shell     # 前端单测（vitest）
bun run test:e2e       # E 层：真 daemon + FakeLLM + 真 WS（playwright）
```
