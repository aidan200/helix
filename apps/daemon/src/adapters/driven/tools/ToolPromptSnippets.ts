/**
 * ToolPromptSnippets —— 工具提示 snippet 注册表（设计定稿 §三）。
 *
 * 落位 adapters/driven/tools/（与工具实现同目录，pi 工具符号封装边界不扩）：
 * SystemPromptAssembler 的工具段（- name: snippet 扁平清单）数据源。
 * main 11 工具 + subagent 7 工具共享单一注册表（subagent 全集 = main 去编排
 * 三件套与动态族单 browser 工具，是否进清单由 ResourceService.getEffectiveTools(kind)
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
  grep: "跨文件正则检索并列出匹配行",
  web_search: "联网搜索（DuckDuckGo 主/Bing 兜底），返回标题/链接/摘要列表",
  web_fetch: "抓取网页并转为 Markdown 返回（直连主通道，Jina 备选）",
  agent_spawn: "指派 SubAgent 实例独立执行任务（并行委派，立即返回不等完成）",
  agent_send: "向运行中的 SubAgent 实例追加补充指示",
  agent_status: "查询 SubAgent 实例的当前执行状态（仅用户主动询问进度时用）",
  agent_inspect: "核实 SubAgent 实例真实执行轨迹（进展零增量时判断是否死循环）",
  browser: "操控浏览器（action 分发：开 tab/eval/点击/滚动/截图等，携带登录态）",
  kg: "查询项目知识图谱（只读：search 关键词检索 → get 节点全量 / affected 锚反查——改代码前用文件或符号反查管辖节点，id 取自返回行）",
  "kg-update": "知识图谱即时落账（supersede 推翻节点 / createNode 沉淀新知识——scene 适用场景必填；iterationId 缺省服务端机械解析，显式传参仅作覆盖；proposeCandidate/decideCandidate 候选台账操作）",
  codegraph: "查询代码索引（只读：status/search 定位符号/node 读源码/callers/callees/impact 查影响面——改代码前先 impact）",
  task_create: "创建任务并启动执行（与用户确认干什么之后再调用——对话即确认，调用即创建；返回任务回执）",
  task_insert_batch: "在指定阶段插入批次行（划批次落库，返回批次号；暂停/终态会被拒）",
  task_dispatch_batch: "批次派发落章（批次号 + 实例 id；仅 pending/failed 可派发）",
  task_advance_stage: "推进阶段行到 running（上一阶段产物落库后推进下一阶段）",
  task_stage_artifact: "聚合阶段产物并收口阶段（你给人类可读摘要，产出节点 id 集由系统按批次反查）",
  task_complete_job: "申报任务完成（系统机械复核全部阶段行 done 后收口）",
  task_fail_job: "申报任务失败（附失败理由；job → failed 终态）",
  plan_create: "创建本实例工作台账（一次给出全部计划条目，开工前调用；创建后不可重建）",
  plan_update: "更新工作台账条目状态（in_progress/done/abandoned——放弃必须带理由 note；可记产物指针）",
  plan_read: "读工作台账条目（SubAgent 读本实例收口自查；编排主 agent 按实例 id 读批次台账判进度）",
};
