import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import type { BrowserPort, ScrollDirection } from "../../../../application/ports/outbound/BrowserPort";

/**
 * 动态族浏览器工具十一件套（web-access T3）：browser_open / browser_navigate /
 * browser_back / browser_eval / browser_click / browser_click_at /
 * browser_set_files / browser_scroll / browser_screenshot / browser_close /
 * browser_status。
 *
 * **纯薄转投，零 CDP 知识**——与 AgentOrchestrationTools 同构：业务语义全部
 * 收敛在 BrowserPort（CDP 协议细节在 CdpConnectionManager），本文件只做
 * 参数转投 + 返回值 JSON 序列化；port 引用由组合根注入（CoreToolExecutor
 * 条件注册，options.browser 有才注册——同 orchestration 先例）。ChildMain
 * （SubAgent 子进程）不传 browser（P0-1 决策：子进程无动态族）。
 *
 * description 承载策略层知识（web-access 的灵魂落点）：
 * - 就绪契约（open/navigate）：返回只代表文档基础加载完成，不代表目标内容
 *   已就绪——导航后必须用 browser_eval 验证目标内容出现，加载态/验证页/
 *   登录跳转时在 15 秒窗口内持续观察 URL/标题/DOM 后再判断；
 * - eval 序列化契约：返回值必须可序列化（大量数据 JSON.stringify 包裹；
 *   DOM 节点不能直接返回需提取属性）；递归遍历可穿透 Shadow DOM 与 iframe；
 * - 截图读图：file 必填落盘，之后用 read 工具读取图片（read 支持图片）；
 * - status：连接状态 + 受管 tab 清单（owner/闲置时长）。
 */

/** 三工具族共用的参数 schema 风格（手写 JSON Schema，与 GrepTool 同构）。 */
const openParameters = {
  type: "object",
  properties: {
    url: { type: "string", description: "要打开的 URL" },
  },
  required: ["url"],
  additionalProperties: false,
} as const;

const navigateParameters = {
  type: "object",
  properties: {
    tabId: { type: "string", description: "目标 tab id（browser_open 返回）" },
    url: { type: "string", description: "要导航到的 URL" },
  },
  required: ["tabId", "url"],
  additionalProperties: false,
} as const;

const tabOnlyParameters = {
  type: "object",
  properties: {
    tabId: { type: "string", description: "目标 tab id" },
  },
  required: ["tabId"],
  additionalProperties: false,
} as const;

const evalParameters = {
  type: "object",
  properties: {
    tabId: { type: "string", description: "目标 tab id" },
    code: { type: "string", description: "要执行的 JS 表达式（支持 await）" },
  },
  required: ["tabId", "code"],
  additionalProperties: false,
} as const;

const selectorParameters = {
  type: "object",
  properties: {
    tabId: { type: "string", description: "目标 tab id" },
    selector: { type: "string", description: "CSS 选择器" },
  },
  required: ["tabId", "selector"],
  additionalProperties: false,
} as const;

const setFilesParameters = {
  type: "object",
  properties: {
    tabId: { type: "string", description: "目标 tab id" },
    selector: { type: "string", description: "file input 的 CSS 选择器" },
    files: { type: "array", items: { type: "string" }, description: "本地文件绝对路径清单" },
  },
  required: ["tabId", "selector", "files"],
  additionalProperties: false,
} as const;

const scrollParameters = {
  type: "object",
  properties: {
    tabId: { type: "string", description: "目标 tab id" },
    y: { type: "number", description: "滚动像素数（缺省 3000）" },
    direction: {
      type: "string",
      enum: ["down", "up", "top", "bottom"],
      description: "滚动方向（缺省 down；top/bottom 直达两端）",
    },
  },
  required: ["tabId"],
  additionalProperties: false,
} as const;

const screenshotParameters = {
  type: "object",
  properties: {
    tabId: { type: "string", description: "目标 tab id" },
    file: { type: "string", description: "截图落盘路径（必填）" },
  },
  required: ["tabId", "file"],
  additionalProperties: false,
} as const;

const statusParameters = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

/** 导航就绪契约（open/navigate 共享的策略知识——description 的灵魂落点）。 */
const READINESS_CONTRACT =
  "返回只代表文档基础加载完成，不代表目标内容已就绪——导航后必须用 browser_eval " +
  "检查目标内容是否出现；若页面仍是加载态/验证页/登录跳转，在 15 秒窗口内持续观察 " +
  "URL/标题/DOM 后再判断。";

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function jsonResult(value: unknown): AgentToolResult<undefined> {
  return textResult(value === undefined ? "undefined" : JSON.stringify(value));
}

/**
 * 十一工具族工厂（整族条件注册——CoreToolExecutor 在 options.browser 存在时
 * 一次性 push 本数组）。ownerId 为 browser_open 的 tab 归属（回收/观测维度，
 * 缺省 "main"——组合根按调用侧注入）。
 */
export function createBrowserTools(
  browser: BrowserPort,
  ownerId = "main",
): AgentHarnessTool<ExecutionToolContext, any, undefined>[] {
  return [
    {
      name: "browser_open",
      label: "browser_open",
      description: `打开一个后台浏览器 tab 并导航到指定 URL，返回 {tabId}。${READINESS_CONTRACT}`,
      parameters: openParameters as any,
      async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
        void toolCallId;
        const { url } = params as { url: string };
        return jsonResult(await browser.openTab(url, ownerId));
      },
    },
    {
      name: "browser_navigate",
      label: "browser_navigate",
      description: `把既有 tab 导航到新 URL（自动等待基础加载完成）。${READINESS_CONTRACT}`,
      parameters: navigateParameters as any,
      async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
        void toolCallId;
        const { tabId, url } = params as { tabId: string; url: string };
        await browser.navigateTab(tabId, url);
        return textResult(`已导航到 ${url}（tab ${tabId}）`);
      },
    },
    {
      name: "browser_back",
      label: "browser_back",
      description: "在既有 tab 内后退一页（history.back + 等待基础加载完成）。",
      parameters: tabOnlyParameters as any,
      async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
        void toolCallId;
        const { tabId } = params as { tabId: string };
        await browser.backTab(tabId);
        return textResult(`已后退（tab ${tabId}）`);
      },
    },
    {
      name: "browser_eval",
      label: "browser_eval",
      description:
        "在既有 tab 内执行 JS 表达式（支持 await）并返回其值。返回值必须可序列化——" +
        "提取大量数据时用 JSON.stringify 包裹；DOM 节点不能直接返回，需提取属性。" +
        "eval 递归遍历可穿透 Shadow DOM 与 iframe（选择器不可跨越的边界）。",
      parameters: evalParameters as any,
      async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
        void toolCallId;
        const { tabId, code } = params as { tabId: string; code: string };
        return jsonResult(await browser.evalInTab(tabId, code));
      },
    },
    {
      name: "browser_click",
      label: "browser_click",
      description:
        "在既有 tab 内对 CSS 选择器命中的元素做 JS 层点击（简单快速）；未命中返回 {clicked:false}。",
      parameters: selectorParameters as any,
      async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
        void toolCallId;
        const { tabId, selector } = params as { tabId: string; selector: string };
        return jsonResult(await browser.clickInTab(tabId, selector));
      },
    },
    {
      name: "browser_click_at",
      label: "browser_click_at",
      description:
        "在既有 tab 内对选择器元素发真实鼠标事件点击（算用户手势：可触发文件对话框、绕过反自动化检测），附点击坐标。",
      parameters: selectorParameters as any,
      async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
        void toolCallId;
        const { tabId, selector } = params as { tabId: string; selector: string };
        return jsonResult(await browser.clickAtInTab(tabId, selector));
      },
    },
    {
      name: "browser_set_files",
      label: "browser_set_files",
      description:
        "给既有 tab 内的 file input 直接设置本地文件（绕过文件对话框），返回 {success,count}；元素未命中报错。",
      parameters: setFilesParameters as any,
      async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
        void toolCallId;
        const { tabId, selector, files } = params as { tabId: string; selector: string; files: string[] };
        return jsonResult(await browser.setFilesInTab(tabId, selector, files));
      },
    },
    {
      name: "browser_scroll",
      label: "browser_scroll",
      description:
        "滚动既有 tab 的页面（缺省向下 3000px，滚后留懒加载触发窗口；direction 可取 up/top/bottom），返回滚动结果说明。",
      parameters: scrollParameters as any,
      async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
        void toolCallId;
        const { tabId, y, direction } = params as { tabId: string; y?: number; direction?: ScrollDirection };
        return jsonResult(await browser.scrollTab(tabId, y, direction));
      },
    },
    {
      name: "browser_screenshot",
      label: "browser_screenshot",
      description:
        "对既有 tab 截图——file 必填：截图保存到该路径，之后用 read 工具读取图片（read 支持图片）。返回 {saved}。",
      parameters: screenshotParameters as any,
      async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
        void toolCallId;
        const { tabId, file } = params as { tabId: string; file?: string };
        // file 必填由 port 层裁决（缺省抛错原样透传——CoreToolExecutor 转 isError）
        return jsonResult(await browser.screenshotTab(tabId, file));
      },
    },
    {
      name: "browser_close",
      label: "browser_close",
      description: "关闭既有 tab（释放受管资源）。",
      parameters: tabOnlyParameters as any,
      async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
        void toolCallId;
        const { tabId } = params as { tabId: string };
        await browser.closeTab(tabId);
        return textResult(`已关闭 tab ${tabId}`);
      },
    },
    {
      name: "browser_status",
      label: "browser_status",
      description:
        "查看浏览器连接状态（未连接/已连接浏览器）与受管 tab 清单（各 tab 的 owner/URL/标题/闲置时长）。",
      parameters: statusParameters as any,
      async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
        void toolCallId;
        void params;
        const status = browser.getStatus();
        const tabs = browser.listTabs();
        const now = Date.now();
        return jsonResult({
          status,
          tabs: tabs.map((tab) => ({
            ...tab,
            idleMs: Math.max(0, now - tab.lastAccessed),
          })),
        });
      },
    },
  ];
}
