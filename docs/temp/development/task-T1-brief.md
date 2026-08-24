# T1 Brief — daemon thinking 默认关 + "off" 升格 + 换模重广播

## 项目定位

- 仓库：`/Users/siyong/AI_Project/helix`（bun workspace：apps/daemon、apps/shell、packages/protocol）
- 背景：iter-20260823-6ps5 已落地 thinking 批（协议 v0.11）。本任务变更默认语义：**默认关思考**（用户决策 D 方案），并将 `"off"` 升格为合法 override 值（显式关）。
- 测试命令：`cd /Users/siyong/AI_Project/helix && bun test apps/daemon`；类型检查 `bash scripts/typecheck-all.sh`（改动面大时可只跑 `bunx tsc -p apps/daemon --noEmit` 视项目脚本而定，以仓库脚本为准）。

## 需求（traceability）

1. 用户决策（原话）：「"off" 升格为合法 override 值」——off 是显式关，不是"未配置回落"。
2. 用户决策（原话）：「思考默认都不开启，只有手动的时候去开启」——D 方案：删除 medium 兜底，未配置 = 不传 reasoning。
3. 附带修复（本迭代发现）：model.set 换模后 UI 显示 stale 档位——需重广播 thinking.changed。

## pi-ai 物理事实（已核实，brief 内结论可直接引用）

- pi-ai `streamSimple`：不传 `options.reasoning` → anthropic 适配器 `thinkingEnabled: false`（显式关）；openai-responses 适配器 `reasoningEffort: undefined` 且 `thinkingLevelMap.off !== null` 时发 `effort: off映射`。即 **undefined = 尽力显式关**。
- `clampThinkingLevel(model, "off")`：off 不在支持档时**向上找最近支持档**——对 `thinkingLevelMap: {off: null, ...}` 的模型（约 19%），clamp("off") 会升到最低支持档（如 high），**语义反转（想关反而开）**。因此 off 短路必须发生在 clamp 之前。
- pi-ai 版本：@earendil-works/pi-ai@0.84.2（dist 可读源佐证）。

## 改动点（最小实现）

### 1. `apps/daemon/src/adapters/driven/pi-engine/thinking-resolve.ts`

- `resolveEffectiveThinking`：链遍历中 `value === "off"` → **立即 return undefined**（显式关短路，不进 `clampThinkingLevel`）。注意：短路应发生在 clamp 调用前；`value === undefined || value === ""` 仍按未配置跳过。
- 函数头注释更新：链语义从「兜底 medium」改为「全链未配置 → undefined = 默认关（pi-ai 显式关思考）」；"off" 语义从「helix 无 off 语义：未知档回落值」改为「显式关，短路整链」。

### 2. `apps/daemon/src/infrastructure/assembly/buildSessionStack.ts`

- `engineFor` 内 `resolveThinking` 闭包：链 `[adapter?.thinkingOverride(), resourceService.thinkingSlot("main-session"), "medium"]` → 删第三位 `"medium"`。
- `scheduler` 构造的 `subagentSnapshotFor.thinkingLevel`：`SubAgentProfile.thinkingLevel ?? resourceService.thinkingSlot("subagent-worker") ?? "medium"` → 删 `?? "medium"`（无配置 → undefined）。
- 全文 grep `"medium"` 排查 SubagentLauncher / 其他残留兜底（spawn env 定格链 `resolveThinkingFor` 同族逻辑若在 launcher 文件内，一并删兜底）。

### 3. `apps/daemon/src/application/services/ModelService.ts`

- `setModel` 成功路径：在 `onModelChanged` 广播后，补发一次 `this.deps.onThinkingChanged({ sessionId, ...currentThinking现值 })`（从 `runtime.chatService.currentThinking` 取；引擎未实现观测面（undefined）时不广播——additive 缺省形态行为不变）。
- 注释说明：换模只改 effective 不改 override（AD-3），重广播消除 shell 侧 stale 档位。

### 4. `PROTOCOL.md`（§17.11 thinking 族）

- `thinking.set` payload.level 语义补登：合法值含 `"off"`（显式关：effective=null、后续请求不带 reasoning）；未配置（无覆盖无槽位）= 默认关（不传 reasoning，pi-ai 显式关思考）。
- 命令面零变更 → **不升协议版本**，纯文档语义补登（若仓库纪律要求版本注记，在 §17.11 内 additive 补登，不改 v0.11 版本号）。

## TDD 要求（先改测试看红，再实现）

测试文件：
- `apps/daemon/test/integration/thinking-set-chain.test.ts`（既有钉桩必须跟随）：
  - turn1 无覆盖断言 `reasoning: "medium"` → 改为 `reasoning: undefined`。
  - 新增：`thinking.set("off")` 用例——tri 模型（低中高三档）：outcome `{override:"off", effective:null}`，后续 turn `reasoning === undefined`；切 no-reasoning 模型再切回，override 保留仍 off。
  - 新增：off:null 模型（`thinkingLevelMap: {off: null, high: "h"}` reasoning=true）`setThinking("off")` → effective **null**（不是 high），turn `reasoning === undefined`——这是本任务最重要的反例钉桩。
  - 新增：`setModel` 后订阅连接收到 `thinking.changed`（override 不变、effective 按新模型重算）。
- `apps/daemon/test/unit/thinking-resolve.test.ts`：链尾空 → undefined；`"off"` 短路（含 off:null map 反例）；既有 medium 兜底用例改/删。
- 其他引用 `"medium"` 兜底语义的测试（grep `medium` apps/daemon/test 排查）跟随修改。

## 项目纪律约束

- 六边形分层：pi-ai 类型不出 `adapters/driven/pi-engine` 域（防腐墙既有注释）。
- TR-AD-2：level 字符串透传，daemon 不维护档位枚举、不做档位校验。
- AG-14：service 层纯函数纪律（无 Date.now/IO 之外的规则按仓库注释为准）。
- 最小实现：不顺手重构、不加抽象、不改无关注释时态之外的代码。

## 验收标准（闭环时逐条应答）

1. 无覆盖 + 无槽位会话：stream options.reasoning === undefined（测试钉）。
2. `thinking.set("off")`：outcome effective=null，后续 turn reasoning undefined（测试钉）。
3. off:null 模型 setThinking("off") 不被钳成支持档——effective=null 非 high（测试钉）。
4. `setModel` 成功后该会话收到 thinking.changed 重广播（fake 引擎 currentThinking undefined 时不广播）（测试钉）。
5. SubAgent 快照/launcher 链无 "medium" 兜底残留（grep 证据）。
6. PROTOCOL.md §17.11 补登完成。
7. `bun test apps/daemon` 全绿；typecheck 通过。

## 报告要求

- submit_result 携带 taskId=T1；acceptance[] 逐条应答；findings[] 必填（无发现传 []）。
