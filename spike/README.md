# helix-spike：pi-agent-core 0.84.2 成熟度 spike（CL-3 / T1.3）

一次性验证代码（**不进 daemon src 四层依赖图，不进 CI，不做回归**——test-design §6 显式豁免）。
四项语义实测 + F-7 三红线运行时确认，结论报告见：
`/Users/siyong/AI_Project/docs/iterations/iter-20260815-6tss/development/spike-report.md`。

## 前置说明

- **运行时**：Bun（`bun run <script>`）。
- **依赖**：仅 `@earendil-works/pi-agent-core@0.84.2` + `@earendil-works/pi-ai@0.84.2`（模型接入纪律 F(3).1 标准 4）。
- **key**：从 `<home>/config.json` 的 `apiKeys` 字段读取后显式传入（不走 env 解析，脚本零硬编码 key）。本目录自带 fixture：`.home/config.json`（`--home .home`）；换自己的 key 时照抄该结构。
- **网络/费用**：01/02/03 发真实 LLM 补全请求（产生真实费用，运行者自负）；04/05 离线零费用。03 必须真实长会话（compaction 无法 dry-run），单次全程约 10–15 分钟、十几次 ~1k-token 级请求。
- **provider 子路径**（F-7 红线）：`pi-ai/providers/all`；**Node 执行环境**（F-7 红线）：`pi-agent-core/node` 子入口。

## 五脚本复跑命令

在 `spike/` 目录下：

| # | 脚本 | 命令 | 网络 | 费用 |
|---|------|------|------|------|
| 01 | beforeToolCall 审批挂起 | `bun run 01-beforetoolcall-approval.ts --home .home`（干跑加 `--dry-run`） | 真实 | 3 次 LLM 请求 ×3 场景 |
| 02 | steer 与工具并发 | `bun run 02-steer-tool-concurrency.ts --home .home` | 真实 | 4 次 LLM 请求 |
| 03 | compaction 长会话 | `bun run 03-compaction-long-session.ts --home .home` | 真实 | ~15 次 LLM 请求（含 1 次摘要） |
| 04 | session 积木 | `bun run 04-session-building-blocks.ts` | 无 | 0 |
| 05 | AgentHarness 红线 | `bun run 05-harness-confirm.ts` | 无 | 0 |

（也可 `bun run 01`…`bun run 05`，见 package.json scripts。）

输出重定向示例：`bun run 04-session-building-blocks.ts > out-04.txt 2>&1`——仓库已留本次实测的 `out-0*.txt` 原始输出（证据），`out-03-attempt1-truncated.txt` 是一次被中途杀掉的截断运行留档。

## 文件

- `lib.ts`：共享设施——key 读取（显式传入 getApiKey 钩子）、结构化时序 logger（`[+ms | ISO] 前缀/通道 事件 {参数}`）、Agent 纯组装（`assembleAgent`：Agent + streamSimple + subscribe，无 harness）。
- `01–05*.ts`：五项实测脚本（头部注释即各自记录点）。
- `.home/config.json`：fixture key 目录（.gitignore 已排除）。
