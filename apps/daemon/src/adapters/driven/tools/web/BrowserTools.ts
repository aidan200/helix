import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import { readFile } from "node:fs/promises";
import type { BrowserPort, ScrollDirection } from "../../../../application/ports/outbound/BrowserPort";
import { MAX_IMAGE_BYTES } from "../../../../application/services/images";

/**
 * 动态族浏览器工具（web-access 返工）：**单 browser 工具 + action 参数**
 *（用户裁决：11 个 browser_* 独立工具折叠为一个，LLM 显式选 action，
 * 无自然语言路由；形态参照统一 web_access）。
 *
 * action 分发：open / navigate / back / eval / click / click_at / set_files /
 * scroll / screenshot / close / status —— switch 转投 BrowserPort 对应方法。
 *
 * **纯薄转投，零 CDP 知识**——业务语义全部收敛在 BrowserPort（CDP 协议细节
 * 在 CdpConnectionManager），本文件只做 action 分发 + 必填参数校验 +
 * 返回值 JSON 序列化；port 引用由组合根注入（CoreToolExecutor 条件注册，
 * options.browser 有才注册——同 orchestration 先例）。ChildMain（SubAgent
 * 子进程）经 RemoteBrowserPort 注入（H-3 转发通道：P0-1「子进程不直连
 * CDP」决策不变，连接单例仍归 daemon）。
 *
 * 必填参数按 action 校验（JSON Schema 只约束 action 枚举与形状，按 action
 * 的条件必填在执行前校验，缺失抛中文错误——经 CoreToolExecutor 转 isError）：
 * - url：open/navigate 必填；
 * - tabId：除 open/status 外必填；
 * - code：eval 必填；selector：click/click_at/set_files 必填；
 * - files：set_files 必填；file：screenshot 必填；
 * - y/direction：scroll 可选。
 *
 * description 承载策略层知识（web-access 的灵魂落点，单工具多行承载全部）：
 * - 就绪契约（open/navigate）：返回只代表文档基础加载完成，不代表目标内容
 *   已就绪——导航后必须用 action=eval 验证目标内容出现，加载态/验证页/
 *   登录跳转时在 15 秒窗口内持续观察 URL/标题/DOM 后再判断；
 * - eval 序列化契约：返回值必须可序列化（大量数据 JSON.stringify 包裹；
 *   DOM 节点不能直接返回需提取属性）；递归遍历可穿透 Shadow DOM 与 iframe；
 * - 截图读图：file 必填落盘，之后用 read 工具读取图片（read 支持图片）；
 * - status：连接状态 + 受管 tab 清单（owner/闲置时长）+ 惰性连接语义
 * （idle ≠ 不可用，操作 action 自动建连；status idle 结果附带 hint 引导）。
 */

/** 合法 action 枚举（schema 与分发共用单一来源）。 */
const ACTIONS = [
  "open",
  "navigate",
  "back",
  "eval",
  "click",
  "click_at",
  "set_files",
  "scroll",
  "screenshot",
  "close",
  "status",
] as const;
type BrowserAction = (typeof ACTIONS)[number];

/** 单工具参数 schema（手写 JSON Schema，与 GrepTool 同构；按 action 的条件必填在执行前校验）。 */
const browserParameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [...ACTIONS],
      description: "要执行的浏览器操作",
    },
    url: { type: "string", description: "目标 URL（open/navigate 必填）" },
    tabId: { type: "string", description: "目标 tab id（open 返回；除 open/status 外必填）" },
    code: { type: "string", description: "要执行的 JS 表达式，支持 await（eval 必填）" },
    selector: { type: "string", description: "CSS 选择器（click/click_at/set_files 必填）" },
    files: {
      type: "array",
      items: { type: "string" },
      description: "本地文件绝对路径清单（set_files 必填）",
    },
    y: { type: "number", description: "滚动像素数（scroll 可选，缺省 3000）" },
    direction: {
      type: "string",
      enum: ["down", "up", "top", "bottom"],
      description: "滚动方向（scroll 可选，缺省 down；top/bottom 直达两端）",
    },
    file: { type: "string", description: "截图落盘路径（screenshot 必填）" },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

const DESCRIPTION = `操控用户日常浏览器（Chrome/Edge，天然携带登录态）。用 action 参数选择操作：
- open：打开后台 tab 并导航到 URL，返回 {tabId}（url 必填）；
- navigate：把既有 tab 导航到新 URL（tabId/url 必填）；
- back：在既有 tab 内后退一页；
- eval：在 tab 内执行 JS 表达式（支持 await）提取页面数据（code 必填）；
- click：对选择器元素做 JS 层点击（简单快速）；
- click_at：对选择器元素发真实鼠标点击（算用户手势，可触发文件对话框、绕过反自动化检测）；
- set_files：给 file input 直接设置本地文件，绕过文件对话框（selector/files 必填）；
- scroll：滚动页面触发懒加载（y/direction 可选）；
- screenshot：对 tab 截图（file 必填）；
- close：关闭既有 tab；
- status：查看浏览器连接状态与受管 tab 清单（各 tab 的 owner/URL/标题/闲置时长）。

惰性连接语义（重要）：status 返回 idle 不代表浏览器不可用——open 等操作 action 会**自动建立连接**（惰性连接，无需显式启动）；status 仅用于观测当前连接与 tab 状态，看到 idle 后照常直接调用 open 即可。

就绪契约：open/navigate 返回只代表文档基础加载完成，不代表目标内容已就绪——导航后必须用 action=eval 检查目标内容是否出现；若页面仍是加载态/验证页/登录跳转，在 15 秒窗口内持续观察 URL/标题/DOM 后再判断。
eval 契约：返回值必须可序列化——提取大量数据时用 JSON.stringify 包裹；DOM 节点不能直接返回，需提取属性。eval 递归遍历可穿透 Shadow DOM 与 iframe（选择器不可跨越的边界）。
截图契约：action=screenshot 的 file 必填，截图保存到该路径后用 read 工具读取图片（read 支持图片）。`;

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function jsonResult(value: unknown): AgentToolResult<undefined> {
  return textResult(value === undefined ? "undefined" : JSON.stringify(value));
}

/** 读盘形态：ok（合法小图）/ oversize（超 2MB）/ missing（读失败/空文件）。 */
type ShotRead =
  | { status: "ok"; data: string; mimeType: string }
  | { status: "oversize" | "missing" };

/** 读截图落盘文件 → base64（按请求 format 定 mimeType，CDP port 同契约）。 */
async function readShot(file: string, mimeType: string): Promise<ShotRead> {
  try {
    const bytes = await readFile(file);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      return bytes.byteLength > MAX_IMAGE_BYTES ? { status: "oversize" } : { status: "missing" };
    }
    return { status: "ok", data: Buffer.from(bytes).toString("base64"), mimeType };
  } catch {
    return { status: "missing" };
  }
}

/**
 * 图片下行：screenshot 落盘后读文件 → image 内容块（模型可直接看图 +
 * 聊天窗工具卡缩略图数据源）。首读超 2MB → jpeg format 重截降质（同路径
  * 覆写）；重截仍超限或读失败 → undefined（images 缺省只有文本，不炸）。
 */
async function screenshotImageBlock(
  browser: BrowserPort,
  tabId: string,
  file: string,
): Promise<{ type: "image"; data: string; mimeType: string } | undefined> {
  const first = await readShot(file, "image/png");
  if (first.status === "ok") return { type: "image", data: first.data, mimeType: first.mimeType };
  if (first.status === "missing") return undefined;
  const { saved: retryPath } = await browser.screenshotTab(tabId, file, "jpeg");
  const second = await readShot(retryPath, "image/jpeg");
  return second.status === "ok" ? { type: "image", data: second.data, mimeType: second.mimeType } : undefined;
}

interface BrowserParams {
  readonly action: BrowserAction;
  readonly url?: string;
  readonly tabId?: string;
  readonly code?: string;
  readonly selector?: string;
  readonly files?: string[];
  readonly y?: number;
  readonly direction?: ScrollDirection;
  readonly file?: string;
}

/** 按 action 校验必填参数（缺失抛中文错误——经 CoreToolExecutor 转 isError）。 */
function requireParam<K extends keyof BrowserParams>(params: BrowserParams, key: K): NonNullable<BrowserParams[K]> {
  const value = params[key];
  if (value === undefined) throw new Error(`action=${params.action} 需要 ${String(key)} 参数`);
  return value as NonNullable<BrowserParams[K]>;
}

/**
 * 单工具工厂（整族条件注册——CoreToolExecutor 在 options.browser 存在时
 * 注册本工具单名 "browser"）。ownerId 为 open 的 tab 归属（回收/观测维度，
 * 缺省 "main"——组合根按调用侧注入）。
 */
export function createBrowserTool(
  browser: BrowserPort,
  ownerId = "main",
): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "browser",
    label: "browser",
    description: DESCRIPTION,
    parameters: browserParameters as any,
    async execute(toolCallId, rawParams): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const params = rawParams as BrowserParams;
      switch (params.action) {
        case "open":
          return jsonResult(await browser.openTab(requireParam(params, "url"), ownerId));
        case "navigate": {
          const tabId = requireParam(params, "tabId");
          const url = requireParam(params, "url");
          await browser.navigateTab(tabId, url);
          return textResult(`已导航到 ${url}（tab ${tabId}）`);
        }
        case "back": {
          const tabId = requireParam(params, "tabId");
          await browser.backTab(tabId);
          return textResult(`已后退（tab ${tabId}）`);
        }
        case "eval":
          return jsonResult(await browser.evalInTab(requireParam(params, "tabId"), requireParam(params, "code")));
        case "click":
          return jsonResult(await browser.clickInTab(requireParam(params, "tabId"), requireParam(params, "selector")));
        case "click_at":
          return jsonResult(await browser.clickAtInTab(requireParam(params, "tabId"), requireParam(params, "selector")));
        case "set_files":
          return jsonResult(
            await browser.setFilesInTab(
              requireParam(params, "tabId"),
              requireParam(params, "selector"),
              requireParam(params, "files"),
            ),
          );
        case "scroll":
          return jsonResult(await browser.scrollTab(requireParam(params, "tabId"), params.y, params.direction));
        case "screenshot": {
          const tabId = requireParam(params, "tabId");
          const file = requireParam(params, "file");
          const { saved } = await browser.screenshotTab(tabId, file);
          // 图片下行：落盘后读文件回填 image 内容块（超限 jpeg 重截；失败缺省不炸）
          const image = await screenshotImageBlock(browser, tabId, file);
          const text = JSON.stringify({ saved });
          if (image === undefined) return textResult(text);
          return {
            content: [{ type: "text", text }, image],
            details: undefined,
          };
        }
        case "close": {
          const tabId = requireParam(params, "tabId");
          await browser.closeTab(tabId);
          return textResult(`已关闭 tab ${tabId}`);
        }
        case "status": {
          const status = await browser.getStatus();
          const tabs = await browser.listTabs();
          const now = Date.now();
          return jsonResult({
            status,
            // 惰性语义引导（LLM 侧误判防护）：idle 不代表不可用——
            // 任何操作 action 都会自动建连；connected/error 态不带（可选字段）。
            ...(status.state === "idle"
              ? { hint: "连接为惰性建立：直接调用 action=open 等操作即可自动连接浏览器" }
              : {}),
            tabs: tabs.map((tab) => ({
              ...tab,
              idleMs: Math.max(0, now - tab.lastAccessed),
            })),
          });
        }
        default:
          throw new Error(`未知 action "${String(params.action)}"（合法：${ACTIONS.join(" / ")}）`);
      }
    },
  };
}
