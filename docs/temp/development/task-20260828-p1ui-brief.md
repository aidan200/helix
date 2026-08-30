# Brief — task-20260828-p1ui：P-1 折叠窄轨改版 + 索引面板去原型化/真实化

## 项目位置

- 仓库：/Users/siyong/AI_Project/helix；前端 = apps/shell（React + vite + vitest）。
- 目标页：`apps/shell/src/pages/P-1/`（ProjectPage.tsx / kg-viewer.tsx / ui/kg-index-panel.tsx / ui/kg-progress.tsx / model/project-model.ts）。
- 样式：`apps/shell/src/shared/ui/styles/project.css`（token 纪律：**零新增 token**，色值只用 tokens.css 既有变量；动效仅 transform/opacity 且 honor reduced-motion——参照文件内既有模式）。
- i18n：`apps/shell/src/shared/i18n/lang/zh-CN.ts` 与 `en-US.ts`（**两文件键集合必须保持一致**——zh-CN.test.ts 有 parity 断言）。
- 测试：shell 单测 `bun run test:shell`（vitest）；e2e = `playwright test -c playwright.e2e.config.ts`（可选，环境允许则跑 CL-5 两个 spec）。

## 任务一：折叠窄轨改版（用户要求①②）

现状：选中项目后左栏收成 64px 窄轨（`.pj-rail`），顶部一枚「☰ 展开」按钮（`.pj-rail-btn`），下面竖排项目名（`.pj-rail-name`，`writing-mode: vertical-rl`，颜色 `--text-dim`）。

用户要求：不需要展开按钮，**直接点击竖排项目名就展开**（节省空间）；竖排文字用**高亮色**。

改动：

1. `ProjectPage.tsx` 窄轨分支：删除 ☰ button；让 `.pj-rail-name` 成为展开触发——`role="button"`、`tabIndex={0}`、`onClick={onExpandDomain}`、onKeyDown（Enter/Space）、`title={t("pj.domain.expandTitle")}`。保留 `data-pj-rail="collapsed"` 与 `.pj-rail-name` 类名（e2e 选择器在用）。
2. `project.css`：
   - `.pj-rail-name`：`color: var(--accent); cursor: pointer;` + hover 态（如 `var(--accent-hover)`）；其余竖排样式不动。
   - 删除 `.pj-rail-btn` 规则（元素已移除）；`.pj-rail` 布局按需微调（保持 64px 宽）。
3. i18n：删除 `pj.domain.expand` 键（zh+en 同步删）；`pj.domain.expandTitle` 保留（作 tooltip）。
4. 测试更新：
   - `apps/shell/src/pages/P-1/ProjectPage.test.tsx`：展开动作现在点 `.pj-rail-name`（现有用例 `screen.getByTitle("展开项目域")` 若 title 挂在 rail-name 上可继续用，自行选最稳写法）。
   - e2e 选择器 `.pj-rail-btn` 全部改为 `.pj-rail-name`：
     - `e2e/CL-5-kg-viewer-flow.spec.ts`：5 处（L76/L87/L95/L146/L184 附近）。
     - `e2e/CL-5-fidelity-kg-viewer.spec.ts`：8 处；其中 L141 `await expect(page.locator(".pj-rail-btn")).toHaveText("☰ 展开")` 这条断言随元素删除而失效——改为断言 `.pj-rail-name` 可点击语义（如保留既有 L140 的文本断言即可，删除 L141，或改为断言 `title` 属性）。

## 任务二：索引状态面板去原型化（用户要求③之一）

`ui/kg-index-panel.tsx` 里残留原型演示控件：isDev() 门控的三态 seg（building/synced/degraded 演示切换，dev 可见）。真实数据面早已接通，这是原型脚手架，用户明确指出"还是原型的逻辑"。

1. 移除 `devOverride` state、isDev seg 整块 JSX、`isDev` import；面板状态完全由 `idx` prop 驱动。
2. `kg-viewer.tsx` 有一个**未使用**的 `isDev` import（L25），一并删除。
3. i18n 删除 `pj.kg.idxDemo / idxSegBuilding / idxSegSynced / idxSegDegraded` 四键（zh+en 同步）。
4. 全局确认无其他引用（`grep -rn "idxDemo\|idxSeg\|kg-seg-idx" apps e2e`）。

## 任务三：building 态真实显示（用户要求③之二）

真实 daemon 的 building 回执**不带 progress**（`{state:"building"}` 仅此）；现状 UI 会显示「构建中 · 0%」「0 / 0 符号」——假数据观感。要求：无真实进度时显示不确定态，有 progress 时保持现有 N/M 显示。

1. `ui/kg-progress.tsx` `ProgressFill`：加可选 `indeterminate?: boolean`。indeterminate 时跳过 rAF transform 逻辑，渲染 `<div className="kg-progress-fill indeterminate" />`。
2. `project.css`：`.kg-progress-fill.indeterminate` 关键帧动画（仅 transform/opacity；`@media (prefers-reduced-motion)` 关停——参照文件内 `kg-pulse` 的既有处理）。
3. `kg-index-panel.tsx` building 分支：`idx.progress === undefined || total === 0` → 徽章文案「构建中…」（新键 `pj.kg.idxBuildingWait`）+ `<ProgressFill indeterminate />` + 副行新键 `pj.kg.idxBuildingSubWait`（zh：「codegraph 机械抽取中（仅代码层）…」/ en：「codegraph mechanical extraction (code layer only)…」）；有 progress 时现状不变。
4. `ProjectPage.tsx` 主区 building 面板：`state.buildProgress === null || total === 0` → 徽章 `pj.badge.buildingWait`（新键，zh「构建中…」/ en「Building…」）+ indeterminate 进度条 + 副行新键 `pj.main.buildSubWait`（同 3 的文案）；否则现状。
5. 项目行次行 `projectDataLine` building 分支：progress 为 null 或 total===0 → 新键 `pj.dataLine.buildingWait`（zh「构建中…」/ en「Building…」）。
6. 新键 zh+en 同步添加（parity 测试）。
7. `ProjectPage.test.tsx`：补/改断言——无 progress 的 building 回执 → 面板/主区显示「构建中…」且无「0 / 0」字样；带 progress 的回执仍显示「N / M 符号」（现有断言保留）。

## 验收标准（闭环逐条应答）

1. 窄轨无 ☰ 按钮；点击竖排项目名（含键盘 Enter/Space）展开项目域；主区不受影响。
2. 竖排项目名颜色为 accent 高亮色（`var(--accent)`），有 hover 态；零新增 token。
3. 索引面板无 isDev 演示 seg；`idxDemo/idxSeg*` 四键与 `pj.domain.expand` 键 zh+en 同步移除；全仓零残留引用。
4. building 无 progress 时：面板/主区/行次行均显示不确定态（「构建中…」+ indeterminate 进度条），无「0 / 0」「0%」假数据；有 progress 时显示不变。
5. i18n zh/en 键集合 parity 测试通过；`bun run test:shell` 全绿（既存无关红需说明）；`cd apps/shell && bunx tsc --noEmit` 无新增错误。
6. e2e 两个 CL-5 spec 中 `.pj-rail-btn` 选择器全部替换（列出改动行）；环境允许则跑 `bun run test:e2e -- e2e/CL-5` 验证，跑不了说明原因。

## 报告要求

闭环 submit_result 传 taskId=task-20260828-p1ui；acceptance 逐条 ✓/✗ + 证据；findings 必填（无发现给 []）。
