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
};
