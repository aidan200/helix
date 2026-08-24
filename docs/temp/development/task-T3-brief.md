# T3 Brief — shell P-2 推理级别字段重构为 on/off 开关形态

## 项目定位

- 仓库：`/Users/siyong/AI_Project/helix`，本任务只动 `apps/shell`（P-2 字段 + i18n agents 段）。
- 背景：thinking 语义变更批（默认关 + off 升格）的 P-2 侧重构。T1（daemon 默认关）与 T2（P-1 滑块 OFF 刻度）并行/先行，本任务依赖其语义但不依赖其代码（共用组件 ThinkingLevelSlider 零改动）。
- 测试命令：`bunx vitest run apps/shell`（以仓库 test:shell 口径为准）。

## 需求（traceability）

1. 用户决策（原话）：「智能体页面的配置逻辑需要改一下，就是think等级是有on/off的开关的，on的时候获取当前模型最新的支持的档位列表，然后再渲染滑块组件，这样逻辑比较顺畅。」
2. 用户决策（原话）：「agent页面的"新会话按此档解析推理级别；composer 会话覆盖优先于此槽位。" 这些文字提示也删除吧」→ P-2 说明行（四条 note 文案）删除。

## 交互设计（已定案）

**开关语义**：
- **off** = thinking 槽位空（`block?.thinkingLevel == null`）= 该 profile 默认不思考（与 daemon 默认关语义对齐）
- **on** = 槽位已设档

**开启行为**：开关从 off → on 时，若槽位为空，**立即写入当前模型档位的中位档**（`defaultLevelFor(levels)`，见下），使槽位变为已配置；随后渲染滑块，用户可再调档。
- "获取当前模型最新的支持的档位列表" = 既有 `thinkingCapability` memo（`resolveThinkingCapability(block?.model ?? defaultModel ?? "", catalog)`）——数据链已存在，消费即可。
- **关闭行为**：on → off 调既有 `onClear`（清槽位）。
- **中位档规则**（用户原话：「所有模型的推理强度默认都取中间档位，如果只有两个档位则取第一档位，最高档位默认都不选」）：`levels[Math.floor((n-1)/2)]`——n=2 取低档、n=3 取中、n=4 取低中位、n=1 唯一档（无选择，属例外）。空数组 → undefined（不写）。

**边界态**（沿用既有判据，不新增逻辑）：
- `reasoning=false`（当前模型不支持推理）：开关 disabled + 既有 `disabledNote` 保留。
- 能力位未判明（catalog 未达）：开关 disabled + 既有 `capabilityLoading` 提示。
- P-2 滑块**无 OFF 刻度**（off 由开关承担，与 P-1 不同）——levels 直接用 `capability.thinkingLevels`。
- clampedHint / PEAK 判据不变（既有纯函数）。

## 改动点（最小实现）

### 1. `apps/shell/src/features/thinking-level/model/thinking-capability.ts`

- 新增纯函数 `defaultLevelFor(levels: readonly string[]): string | undefined`（中位规则，注释写明用户决策语义）。纯函数纪律：无 React / 无 IO。

### 2. `apps/shell/src/pages/skills/ui/P-2-ThinkingField.tsx`

- 重构为开关 + 滑块两段：head 行放 on/off 开关（可参照 AgentPage.tsx 的 `AgentSwitch` 形态——若提取该组件需改 AgentPage，则在本文件内写同形态局部组件，**不强行抽公共件**，取改动最小路径）+ 状态徽章（on → 档位名；off → "OFF" 或空）。
- 开关 on（槽位空时）→ `onSelect(defaultLevelFor(levels))`；off → `onClear()`。
- 滑块仅 on 且 capabilityKnown 且非 reasoningOff 时渲染（levels 不含 off 刻度）。
- **删除说明行**：`noteUnsetMain/noteUnsetSub/noteConfiguredMain/noteConfiguredSub` 四条消费（:131-133 的 `<p className="ag-note tl-note">` 整段重构——reasoningOff 分支保留 disabledNote，其余分支不再渲染 note）。
- `unsetBadge` 徽章若随开关形态失去意义一并移除（grep 确认消费位后删）。
- 文件头注释跟随现状陈述。

### 3. i18n（zh-CN.ts / en-US.ts，仅 `agents.thinking` 段）

- 删：`noteUnsetMain` / `noteUnsetSub` / `noteConfiguredMain` / `noteConfiguredSub`（+ 确认无消费位后的 `unsetBadge`）。
- 留：`disabledNote` / `clampedHint` / `capabilityLoading` / `clearTitle`（clearTitle 若开关形态下清除钮移除则一并删——清除语义已由开关 off 承担，注意 `tl-clear` 钮在新形态下的去留：开关承担 off 后清除钮冗余，建议移除并删 `clearTitle`）。
- 新增（若需）：开关 aria-label 文案（如 `agents.thinking.switchLabel`）。
- 开关状态词复用既有 `agents.switchOn` / `agents.switchOff`。

### 4. 不动的东西

- `ThinkingLevelSlider.tsx` 零改动；`ComposerThinkingPicker.tsx`（T2 域）；protocol 零变更；AgentPage 的数据链（thinkingCapability memo / onToggle 写路径）不动。

## TDD 要求

- `P-2-ThinkingField` 既有测试文件若有（grep `P-2-ThinkingField.test` / `P2ThinkingField` in tests）先读，钉桩跟随。
- 新增测试：① off 态槽位空 → 开关 off、无滑块；② 开 on → onSelect 收到中位档（[low,high,max] → high；[low,high] → low；[minimal,low,medium,high] → low）——`defaultLevelFor` 纯函数测试为主；③ 开关 off → onClear 调用；④ reasoning=false → 开关 disabled + disabledNote；⑤ note 文案不再渲染。
- 若该组件此前无组件级测试，`defaultLevelFor` 纯函数测试必须有（落在 thinking-capability 的测试文件）。

## 验收标准（闭环时逐条应答）

1. P-2 字段呈 on/off 开关形态；off = 槽位空默认关，on = 滑块可选档（测试钉/截图级描述）。
2. 开 on 且槽位空 → 写入中位档（[low,high,max]→high、[low,high]→low 断言过）。
3. 开关 off → 清槽位（onClear 调用断言）。
4. 四条 note 文案 + `note*` i18n 键无残留消费（grep 证据）；disabledNote 保留。
5. `bunx vitest run apps/shell` 相关文件全绿；`chat.thinking` 段未被本任务触碰（T2 域）。

## 报告要求

- submit_result 传 taskId=T3；acceptance[] 逐条应答；findings[] 必填（无发现传 []）。
