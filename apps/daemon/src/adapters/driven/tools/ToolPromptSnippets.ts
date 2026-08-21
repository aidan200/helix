/**
 * ToolPromptSnippets —— 工具提示 snippet 注册表（M6 T2，设计定稿 §三）。
 *
 * 落位 adapters/driven/tools/（与工具实现同目录，pi 工具符号封装边界不扩）：
 * SystemPromptAssembler 的工具段（- name: snippet 扁平清单）数据源。
 * main 21 工具 + subagent 7 工具共享单一注册表（subagent 全集 = main 去编排
 * 三件套与动态族十一件套，是否进清单由 ResourceService.getEffectiveTools(kind)
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
  agent_status: "查询 SubAgent 实例的当前执行状态",
  browser_open: "打开后台浏览器 tab 并导航到 URL（返回后须用 browser_eval 验证内容就绪）",
  browser_navigate: "把既有 tab 导航到新 URL（返回后须用 browser_eval 验证内容就绪）",
  browser_back: "在既有 tab 内后退一页",
  browser_eval: "在 tab 内执行 JS（支持 await）提取页面数据，可穿透 Shadow DOM/iframe",
  browser_click: "对选择器元素做 JS 层点击（简单快速）",
  browser_click_at: "对选择器元素发真实鼠标点击（算用户手势，可触发文件对话框）",
  browser_set_files: "给 file input 直接设置本地文件（绕过文件对话框）",
  browser_scroll: "滚动 tab 页面（触发懒加载）",
  browser_screenshot: "对 tab 截图落盘，之后用 read 工具读图",
  browser_close: "关闭既有 tab",
  browser_status: "查看浏览器连接状态与受管 tab 清单",
};
