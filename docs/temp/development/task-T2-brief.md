# T2 Brief — shell P-1 推理控件 OFF 刻度 + 默认 OFF 文案

## 项目定位

- 仓库：`/Users/siyong/AI_Project/helix`，本任务只动 `apps/shell`。
- 背景：daemon 侧（T1 并行中）将默认语义改为**默认关**且 `"off"` 成为合法 override 值。本任务让 P-1 chat composer 推理控件表达该语义。
- 测试命令：`cd /Users/siyong/AI_Project/helix && bunx vitest run apps/shell/src/features/thinking-level`（以仓库 test:shell 脚本口径为准）。

## 需求（traceability）

1. 用户决策（原话）：「"off" 升格为合法 override 值」→ P-1 滑块需要能选到 OFF。
2. 用户决策（原话）：「思考默认都不开启，只有手动的时候去开启」→ 无覆盖时 chip 显示 OFF（AUTO 文案退场）。

## 语义设计（已定案）

- 刻度列表：`["off", ...capability.thinkingLevels]`（UI 合成 OFF 为第 0 刻度；CatalogModel.thinkingLevels 不含 off，协议零变更）。
- chip 显示：`reasoningOff ? OFF : (effective ?? "OFF")`——无覆盖（effective=null，默认关）与显式关（override="off"）显示同态 OFF；区别在滑块：无覆盖 = ghost 空心 thumb 停 off 位，显式关 = 实心。
- 选择 OFF 刻度 → `setSessionThinking("off")`（协议透传，daemon 侧 T1 短路处理）。
- PEAK / clamped 判据不变（effective=null 时均不触发，既有纯函数已覆盖）。
- 草稿态 ghostValue：默认关语义 → ghost 落 `"off"`（原来是 "medium"）。

## 改动点（最小实现）

### 1. `apps/shell/src/features/thinking-level/ui/ComposerThinkingPicker.tsx`

- `levels` 组装：`["off", ...capability.thinkingLevels]`。
- `levelText`：`effective ?? t("chat.thinking.auto")` → `effective ?? t("chat.thinking.off")`（AUTO 退场）。
- ghostValue（草稿态分支，若有）：`"medium"` → `"off"`。
- 相关注释跟随现状陈述。

### 2. i18n（`apps/shell/src/shared/i18n/lang/zh-CN.ts` + `en-US.ts`，仅 chat.thinking 段）

- `chat.thinking.auto` 移除（若无其他消费位；grep 确认）；OFF 标签复用既有 `chat.thinking.off`（"OFF"）。
- 如需新增滑块 OFF 刻度 aria/说明文案，chat 段内 additive。

### 3. 删除 scope 文字提示（用户追加决策 2026-08-24）

- `ComposerThinkingPicker.tsx:115` 的 `<span className="tp-scope">{t("chat.thinking.scope")}</span>` 整行删除。
- zh-CN.ts / en-US.ts 中 `chat.thinking.scope` 键删除（grep 确认无其他消费位）。

### 4. 不动的东西

- `ThinkingLevelSlider.tsx` 零改动（刻度列表透传组件）。
- `thinking-capability.ts` 判据函数零改动。
- protocol 零变更。

## TDD 要求

- `ComposerThinkingPicker.test.tsx` 既有「无覆盖且生效 null → 显示 AUTO」断言 → 改 OFF。
- 新增：滑块渲染含 OFF 第 0 刻度；选择 OFF 刻度 → setSessionThinking 收到 `"off"`。
- `state.ts` 初始 thinking 切片 `{null, null}` 不变。

## 验收标准（闭环时逐条应答）

1. 无覆盖会话 chip 显示 OFF（测试钉）。
2. 滑块第 0 刻度为 off，选择后发 level="off"（测试钉）。
3. `chat.thinking.auto` 无残留消费位（grep 证据）。
4. popover 不再渲染 scope 文案，`chat.thinking.scope` 键无残留（grep 证据）。
5. `bunx vitest run apps/shell`（或仓库等价命令）相关文件全绿。

## 报告要求

- submit_result 携带 taskId=T2；acceptance[] 逐条应答；findings[] 必填（无发现传 []）。
