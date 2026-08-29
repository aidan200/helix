/**
 * P-2 任务页结果查询 tab（T3.1；R-6）：按阶段出产物卡（阶段名 + 状态徽章 +
 * 产出计数 chip + 阶段摘要 + 产出节点清单）；节点条目 = 粗体 name + kind
 * 徽章 + digest 首行 + 「在『项目』页查看 →」链接（AD-4②：nodeId 仅
 * data-id；AD-10：节点详情/修正转 /project 页——本面只读零写动作）；
 * 无产物空态；尾注 confirmed 语义（V-1：无 draft）。
 */
import type { TaskArtifactsDto } from "@helix/protocol";
import { cn } from "@/shared/lib/cn";
import { EmptyPanel, KindBadge, PhaseBadge } from "./P-2-task-atoms";

type T = (key: string, vars?: Record<string, string | number>) => string;

export default function TaskResultPane({
  artifacts,
  t,
  onOpenProject,
}: {
  artifacts: TaskArtifactsDto;
  t: T;
  onOpenProject: () => void;
}) {
  const withArtifact = artifacts.stages.filter((s) => s.artifact !== null);
  if (withArtifact.length === 0) {
    return <EmptyPanel marker="artifacts" title={t("tk.result.emptyTitle")} sub={t("tk.result.emptySub")} />;
  }
  return (
    <>
      {withArtifact.map((stage) => {
        const art = stage.artifact!;
        return (
          <div className="tk-art" key={stage.seq} data-tk-art data-stage-seq={stage.seq}>
            <div className="tk-art-head">
              <span className="tk-art-name">{stage.name}</span>
              <PhaseBadge kind="stage" status={stage.status} label={t(`tk.stage.${stage.status}`)} />
              <span className="hud-chip" data-tk-art-count>
                {t("tk.result.artCount", { n: art.nodes.length })}
              </span>
            </div>
            <div className="tk-art-sum">{art.summary}</div>
            <div className="tk-nlist" data-tk-nodes>
              {art.nodes.map((node) => (
                <div key={node.nodeId} className="tk-nrow" data-tk-node data-id={node.nodeId}>
                  <span className={cn("tk-n-name", node.status === "superseded" && "dim")}>{node.name}</span>
                  <KindBadge kind={node.kind} />
                  <button
                    type="button"
                    className="tk-n-link"
                    data-tk-node-link
                    onClick={onOpenProject}
                  >
                    {t("tk.result.nodeLink")}
                  </button>
                  <span className="tk-n-digest">{node.digestFirstLine}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {/* 尾注（confirmed 即正式知识；查看与修正转「项目」页 AD-10） */}
      <div className="tk-foot-note" data-tk-art-footnote>
        {t("tk.result.footnote")}
      </div>
    </>
  );
}
