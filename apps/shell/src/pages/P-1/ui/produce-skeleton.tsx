/**
 * 产出呈现 loading 骨架（T3.2）：分组三级形态同构的占位行（任务头 + 阶段
 * 头 + 节点行），沿用 kg-skel-* 骨架 token。
 */
export function ProduceSkeleton() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div className="kg-skel-row" key={i}>
          <div className="kg-skel-line" style={{ width: `${34 + ((i * 11) % 22)}%`, height: 14 }} />
          <div className="kg-skel-line" style={{ width: `${62 + ((i * 9) % 28)}%` }} />
          <div className="kg-skel-line" style={{ width: `${48 + ((i * 13) % 34)}%`, height: 8 }} />
        </div>
      ))}
    </>
  );
}
