# P1 会话模式框架 — T5 验证证据

日期：2026-08-24 · 验证人：MainAgent · 范围：commits 2390c1a / 460b048 / 4da73d4 / f04b9d9

## 测试矩阵（全绿）

| 包 | 命令 | 结果 |
|---|---|---|
| packages/protocol | `cd packages/protocol && bun test` | 93 pass / 0 fail（17 files, 433 expect） |
| apps/daemon | `cd apps/daemon && bun test` | 895 pass / 0 fail（127 files, 7893 expect） |
| apps/shell | `cd apps/shell && bun run test`（vitest run） | 515 pass / 0 fail（51 files） |

## 类型检查

`bash scripts/typecheck-all.sh` → common/protocol/daemon/shell 四包 OK。

## 守护测试

- `arch-guard.test.ts` + `protocol-import.test.ts`：2 pass（含于 daemon 895）。
- AG-06（WriteQueue 单写）：runtime_config 写语句在 WriteQueue 内（RuntimeConfigStore 复用通道）。

## 残留 grep

- `chat.header.session` 词条：非测试代码零残留（T4 退役断言在测试内）。
- `FROM/INTO default_model` SQL：仅 WriteQueue 迁移代码一处（WriteQueue.ts:553，允许）。

## e2e 判定（非回归）

`bun run test:e2e`：28 failed / 3 passed。**基线对照**：P1 前的 e4f3990 worktree 同命令结果完全一致（同 3 passed、同批失败 spec——CL-5 trace/CL-7 真daemon 系）。结论：28 失败为本机环境既有问题（真 daemon spec），非 P1 回归。

## 前端 pre-flight（T4 UI 改动）

- 既有 hud-chip/hud-badge 设计语言延续，无新造视觉体系；
- i18n 新词条（modeTitle / chat.mode.default）双语同步、无 em-dash、无 AI tells；
- 图标沿用既有 lucide 族（ChevronDown/Check），未引入手写 SVG；
- 草稿/已建两态互斥、菜单开合受控——交互态完整（P-1-top-bar.test.tsx 281-347 钉死）。

## 结构性验收（设计核心）

- 锁定语义 = 结构不可能：`ui/set-draft-mode` 仅草稿生效（真实会话原引用返回）；daemon 侧 mode 唯一消费点 = startDraftSession；无 mode.set 命令（chat-send-mode.test.ts ⑥ 钉死非草稿链零调用）。
- 热草稿复用条件含 profileKind 一致性（session-registry-draft.test.ts ③）。
- session_state.mode 列：守护式补列 + 恢复侧归一（旧行 → default），冷恢复/SIGTERM 重启快照等价测试通过。
