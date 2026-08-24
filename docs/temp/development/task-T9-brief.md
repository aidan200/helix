# T9 Brief — shell 模型菜单选中即关（B 方案）

## 项目定位

- 仓库：`/Users/siyong/AI_Project/helix`，只动 `apps/shell/src/features/model-switch/`。
- 测试命令：`bunx vitest run apps/shell/src/features/model-switch`。

## 需求（traceability）

用户决策（原话）：「使用B方案」——模型菜单**选中即关**，推翻 commit 2015f0e（P-3 T3.3）定案的「选中即切不关菜单（连续比对）」交互。

## 改动点（最小实现）

1. `apps/shell/src/features/model-switch/ui/P-3-model-switch.tsx`：
   - `pick(model, label)`（:113-117）末尾调 `onClose()`——选中（含 resetToDefault 的 `pick` 调用）后菜单关闭。
   - 文件头/函数注释更新：「不关菜单（连续比对）」→ 现状陈述（选中即关，B 方案）。
2. 检查 `onClose` 来源（TopBar 徽标 toggle 传入）在关闭后状态一致（无悬挂 open 态）。
3. 测试：`P-3-model-switch` 相关测试文件（grep 同目录 *.test.tsx）——「选择后菜单保持打开」类断言反转为「选择后调用 onClose」。

## 验收标准

1. 点选模型项 → setSessionModel 调用 + onClose 调用（测试钉）。
2. resetToDefault 同样选中即关（测试钉）。
3. 「连续比对」语义注释/i18n 无残留（grep 证据；若有相关文案一并更新）。
4. `bunx vitest run apps/shell` 相关文件全绿。

## 报告要求

- submit_result 传 taskId=T9；acceptance[] 逐条应答；findings[] 必填（无发现传 []）。
