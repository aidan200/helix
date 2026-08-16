/**
 * 工具调用卡（F(7).2 三态；tokens.md 14 节形态契约）：
 * running = accent 边 + spinner，无 body 不可展开；
 * done = 绿边可展开「参数/结果」双 pre；error = 红边展开错误结果（exit code）。
 * 数据源：tool.call.started / tool.call.result 事件投影的 ToolCallEntryDto。
 */
import { memo, useState } from "react";
import type { ToolCallEntryDto } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { extractExitCode, formatDuration, prettyJsonArgs } from "@/shared/lib/format";
import { cn } from "@/shared/lib/cn";

const ToolCard = memo(function ToolCard({ entry }: { entry: ToolCallEntryDto }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const isRunning = entry.state === "running";
  const isError = entry.state === "error";
  const expandable = !isRunning;

  const stateLabel = isRunning
    ? t("chat.tool.running")
    : isError
      ? t("chat.tool.error")
      : t("chat.tool.done");

  const resultLabel = isError
    ? t("chat.tool.resultFailed", { code: extractExitCode(entry.result ?? "") })
    : t("chat.tool.result");

  const onToggle = () => {
    if (!expandable) return; // running 态无 body，点击头不可展开
    setExpanded((v) => !v);
  };

  return (
    <div className={cn("tool-card", entry.state, expanded && "open")}>
      <div
        className="t-head"
        role="button"
        tabIndex={expandable ? 0 : -1}
        aria-expanded={expandable ? expanded : undefined}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (expandable && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <div className="t-icon">{entry.name.charAt(0).toUpperCase() || "?"}</div>
        <span className="t-name">{entry.name}</span>
        <span className="t-args">{entry.args}</span>
        <span className="t-state">
          {isRunning && <span className="t-spinner" />}
          <span className="lab">{stateLabel}</span>
          {entry.durationMs !== undefined && (
            <span className="t-dur">{formatDuration(entry.durationMs)}</span>
          )}
        </span>
        {expandable && <span className="t-chev" />}
      </div>
      {expandable && (
        <div className="t-body">
          <div className="t-section">
            <div className="t-sec-label">{t("chat.tool.args")}</div>
            <pre className="t-pre">{prettyJsonArgs(entry.args)}</pre>
          </div>
          <div className="t-section">
            <div className="t-sec-label">{resultLabel}</div>
            <pre className="t-pre">{entry.result ?? ""}</pre>
          </div>
        </div>
      )}
    </div>
  );
});

export default ToolCard;
