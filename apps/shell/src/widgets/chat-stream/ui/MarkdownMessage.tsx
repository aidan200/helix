/**
 * Markdown 渲染（desk MarkdownRenderer 按 P-1 原型重织，F(7).1）：
 * 段落 / 加粗 / 行内 code chip（.bubble code.inline）/ 无序列表（violet
 * marker，CSS ::marker）/ 代码块（hud-code：语言标签行 + 5px 圆角 + pre 换行）。
 */
import { memo, isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** 递归提取 React 子树的纯文本（代码块语言行与 pre 内容用）。 */
function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractText(node.props.children);
  }
  return "";
}

/** fenced 代码块 → hud-code 卡（语言标签行 + pre）。 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const child = Array.isArray(children) ? children[0] : children;
  let lang = "";
  let text = "";
  if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    lang = /language-([\w-]+)/.exec(child.props.className ?? "")?.[1] ?? "";
    text = extractText(child.props.children);
  } else {
    text = extractText(children);
  }
  return (
    <div className="md-code">
      <div className="c-lang">
        <span>{lang || "text"}</span>
        <span />
      </div>
      <pre>{text}</pre>
    </div>
  );
}

/** 组件映射：inline code 加 .inline；块级 pre 整体替换为 hud-code。 */
const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  // 走到这里的 code 都不在 pre 内（块级已被 CodeBlock 接管）→ inline chip
  code: ({ children }) => <code className="inline">{children}</code>,
};

interface MarkdownMessageProps {
  text: string;
}

const MarkdownMessage = memo(function MarkdownMessage({ text }: MarkdownMessageProps) {
  if (!text.trim()) return null;
  return (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

export default MarkdownMessage;
