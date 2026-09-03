/**
 * ToolPromptSnippets —— 工具提示 snippet 注册表（设计定稿 §三）。
 *
 * 落位 adapters/driven/tools/（与工具实现同目录，pi 工具符号封装边界不扩）：
 * SystemPromptAssembler 的工具段（- name: snippet 扁平清单）数据源。
 * main 19 工具 + subagent 13 工具共享单一注册表（subagent 全集 = main 去编排
 * 六件套（agent_spawn/send/status/inspect/park/resume）与 kg 双工具、
 * codegraph、task_create、task_report、动态族单 browser 工具之外叠加 plan 三工具，是否
 * 进清单由 ResourceService.getEffectiveTools(kind)
 * 生效集决定，本表只管「名 → 中文一句话」映射）。
 *
 * snippet 约束：中文一句话、单行（进 system prompt 的清单行——多行破坏
 * 扁平清单格式）；组装器不做任何状态联动（读 关不删技能引导句，裁决见
 * SystemPromptAssembler）。
 */
export const TOOL_PROMPT_SNIPPETS: Readonly<Record<string, string>> = {
  bash: "在沙箱工作目录执行 shell 命令并返回输出",
  read: "读取文件内容（文本或图片）",
  write: "创建新文件或整体写入文件",
  edit: "按精确文本匹配做字符串替换编辑",
  grep: "跨文件子串检索并列出匹配行（非正则）", // H11：实现是 --fixed-strings 子串语义，原文案误导为正则
  web_search: "联网搜索（DuckDuckGo 主/Bing 兜底），返回标题/链接/摘要列表",
  web_fetch: "抓取网页并转为 Markdown 返回（直连主通道，Jina 备选）",
  agent_spawn: "指派 SubAgent 实例独立执行任务（并行委派，立即返回不等完成）",
  agent_send: "向运行中的 SubAgent 实例追加补充指示",
  agent_status: "查询 SubAgent 实例状态（含挂起中）；用户询问进度或要恢复挂起实例时先用",
  agent_inspect: "核实 SubAgent 实例真实执行轨迹（进展零增量时判断是否死循环）",
  agent_park: "挂起运行中的 SubAgent 实例（完成当前工具调用后暂停，上下文保留零消耗；用户要求暂停某工作时用）",
  agent_resume: "恢复挂起的 SubAgent 实例（同会话从断点继续）",
  browser: "操控浏览器（action 分发：开 tab/eval/点击/滚动/截图等，携带登录态）",
  kg: "查询项目知识图谱（只读：search 关键词检索 → get 节点全量 / affected 锚反查——改代码前用文件或符号反查管辖节点，id 取自返回行）",
  "kg-update":
    "知识图谱即时落账（supersede 推翻节点 / createNode 沉淀新知识——scene 适用场景必填 / updateNode 补全节点元数据（仅限 scene 等，内容改动走候选人审）；iterationId 缺省服务端机械解析，显式传参仅作覆盖；proposeCandidate/decideCandidate 候选台账操作）",
  codegraph: "查询代码索引（只读：status/search 定位符号/node 读源码/callers/callees/impact 查影响面——改代码前先 impact）",
  task_create: "创建任务并启动执行（与用户确认干什么之后再调用——对话即确认，调用即创建；返回任务回执）",
  task_report: "查询任务结果与报告（只读：list 最近任务清单 / get 指定任务阶段产物、批次收口摘要与报告路径——全文用 read 按路径读）",
  task_insert_batch: "在指定阶段插入批次行（划批次落库，返回批次号；暂停/终态会被拒）",
  task_dispatch_batch: "批次派发落章（批次号 + 实例 id；仅 pending/failed 可派发）",
  task_advance_stage: "推进阶段行到 running（上一阶段产物落库后推进下一阶段）",
  task_stage_artifact: "聚合阶段产物并收口阶段（你给人类可读摘要，产出节点 id 集由系统按批次反查）",
  task_complete_job: "申报任务完成（系统机械复核全部阶段行 done 后收口）",
  task_fail_job: "申报任务失败（附失败理由；job → failed 终态）",
  plan_create: "创建本会话工作台账（一次给出全部计划条目，开工前调用；全部办结后可重建重开）",
  plan_update: "更新工作台账条目状态（in_progress/done/abandoned——放弃必须带理由 note；可记产物指针）",
  plan_read: "读工作台账条目（收口/交代前自查全部办结或带理由放弃；台账对用户可见）",
};
