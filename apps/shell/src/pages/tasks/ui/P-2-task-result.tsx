/**
 * P-2 任务页结果 tab（T3.1；R-6；result-tab-text-only）：按阶段出产物卡，
 * 纯文字报告——阶段名 + 状态徽章 + 阶段摘要（summary）+ 可选产物全文
 * （body，D2 additive：markdown 原文按段留白渲染，不解析语法元素）；产出
 * 与 kg 彻底零耦合（无计数 chip / 节点清单 / 指路链接 / 尾注）；无产物空态。
 */
import type { TaskArtifactsDto } from "@helix/protocol";
import { EmptyPanel, PhaseBadge } from "./P-2-task-atoms";

type T = (key: string, vars?: Record<string, string | number>) => string;

export default function TaskResultPane({
  artifacts,
  t,
}: {
  artifacts: TaskArtifactsDto;
  t: T;
}) {
  const withArtifact = artifacts.stages.filter((s) => s.artifact !== null);
  if (withArtifact.length === 0) {
    return <EmptyPanel marker="artifacts" title={t("tk.result.emptyTitle")} sub={t("tk.result.emptySub")} />;
  }
  return (
    <>
      {withArtifact.map((stage) => (
        <div className="tk-art" key={stage.seq} data-tk-art data-stage-seq={stage.seq}>
          <div className="tk-art-head">
            <span className="tk-art-name">{stage.name}</span>
            <PhaseBadge kind="stage" status={stage.status} label={t(`tk.stage.${stage.status}`)} />
          </div>
          <div className="tk-art-sum">{stage.artifact!.summary}</div>
          {stage.artifact!.body !== undefined && (
            <div className="tk-art-body" data-tk-art-body>
              {stage.artifact!.body}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
