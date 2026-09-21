/**
 * 记忆管理子组件（B2 UI 骨架——mock 数据先行）。
 *
 * 展示记忆条目列表（text/kind/created_at），支持：
 * - 手动新增（文本输入 + 保存）
 * - 行级编辑（点击编辑 → 文本框 + 保存/取消）
 * - 行级删除
 * - 清空全部
 *
 * 编辑保存 = 重新向量化（异步，UI 显示「向量化中…」占位态）。
 * 真实数据面待 B2 后端接 steward.memory.list/upsert/delete 命令后填充。
 */
import { useState } from "react";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";

/** Mock 记忆条目（B2 后端就绪前展示用——文本走 ASCII 占位，AG-16 零硬编码 CJK 纪律）。 */
const MOCK_ENTRIES = [
  { id: 1, text: "[mock] prefers concise, direct replies without redundant explanation", kind: "preference", createdAt: "2026-09-21T10:30:00Z" },
  { id: 2, text: "[mock] primary stack: TypeScript + React", kind: "fact", createdAt: "2026-09-21T11:15:00Z" },
  { id: 3, text: "[mock] code review: performance issues first", kind: "preference", createdAt: "2026-09-21T14:22:00Z" },
];

const MemoryManageSection = function MemoryManageSection() {
  const { t } = useI18n();
  const [entries, setEntries] = useState(MOCK_ENTRIES);
  const [newText, setNewText] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [embeddingId, setEmbeddingId] = useState<number | null>(null);

  const handleAdd = () => {
    if (newText.trim() === "") return;
    const mockId = Math.max(...entries.map((e) => e.id), 0) + 1;
    setEmbeddingId(mockId);
    setTimeout(() => {
      setEntries([...entries, { id: mockId, text: newText, kind: "manual", createdAt: new Date().toISOString() }]);
      setNewText("");
      setEmbeddingId(null);
    }, 800);
  };

  const handleEdit = (id: number) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    setEditingId(id);
    setEditText(entry.text);
  };

  const handleSaveEdit = () => {
    if (editingId === null || editText.trim() === "") return;
    setEmbeddingId(editingId);
    setTimeout(() => {
      setEntries(entries.map((e) => (e.id === editingId ? { ...e, text: editText } : e)));
      setEditingId(null);
      setEditText("");
      setEmbeddingId(null);
    }, 800);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditText("");
  };

  const handleDelete = (id: number) => {
    setEntries(entries.filter((e) => e.id !== id));
  };

  const handleClearAll = () => {
    setEntries([]);
  };

  return (
    <div data-memory-manage>
      <div className="memory-add">
        <input
          className="hud-input"
          value={newText}
          placeholder={t("chat.settings.general.memoryAddPlaceholder")}
          data-memory-add-input
          onChange={(e) => setNewText(e.target.value)}
        />
        <button
          type="button"
          className="hud-btn hud-btn-cyan"
          data-memory-add-btn
          disabled={newText.trim() === ""}
          onClick={handleAdd}
        >
          {t("chat.settings.general.memoryAdd")}
        </button>
      </div>

      {entries.length > 0 && (
        <>
          <div className="memory-list" data-memory-list>
            {entries.map((entry) => (
              <div key={entry.id} className="memory-item" data-memory-item={entry.id}>
                {embeddingId === entry.id ? (
                  <span className="ag-note">{t("chat.settings.general.memoryEmbedding")}</span>
                ) : editingId === entry.id ? (
                  <div className="memory-edit">
                    <input
                      className="hud-input"
                      value={editText}
                      data-memory-edit-input
                      onChange={(e) => setEditText(e.target.value)}
                    />
                    <button
                      type="button"
                      className="hud-btn hud-btn-cyan"
                      data-memory-edit-save
                      disabled={editText.trim() === ""}
                      onClick={handleSaveEdit}
                    >
                      {t("chat.settings.general.memorySave")}
                    </button>
                    <button
                      type="button"
                      className="hud-btn hud-btn-ghost"
                      data-memory-edit-cancel
                      onClick={handleCancelEdit}
                    >
                      {t("chat.settings.general.memoryCancel")}
                    </button>
                  </div>
                ) : (
                  <>
                    <span className="memory-text">{entry.text}</span>
                    <span className="memory-meta">
                      {t(`chat.settings.general.memoryKind.${entry.kind}`)} · {new Date(entry.createdAt).toLocaleDateString()}
                    </span>
                    <div className="memory-actions">
                      <button
                        type="button"
                        className="hud-btn hud-btn-ghost sm"
                        data-memory-edit-btn={entry.id}
                        onClick={() => handleEdit(entry.id)}
                      >
                        {t("chat.settings.general.memoryEdit")}
                      </button>
                      <button
                        type="button"
                        className="hud-btn hud-btn-ghost sm"
                        data-memory-delete-btn={entry.id}
                        onClick={() => handleDelete(entry.id)}
                      >
                        {t("chat.settings.general.memoryDelete")}
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            className="hud-btn hud-btn-ghost"
            data-memory-clear-all
            onClick={handleClearAll}
          >
            {t("chat.settings.general.memoryClearAll")}
          </button>
        </>
      )}

      {entries.length === 0 && (
        <span className="ag-note">{t("chat.settings.general.memoryEmpty")}</span>
      )}
    </div>
  );
};

export default MemoryManageSection;
