// 看板上的"记忆整理 · 每天 03:00"那张卡（242 号票，记忆插件的看板条目）。
// 它不是一个任务、不是定时作业：是记忆管理员每天的整理。点它跳到记忆管理员的整页对话（#/more/memory/curator，卡上的 route），
// 在那里能看到每一夜的整理日记、接着跟它说话。记忆插件没在运行时这张卡不长出来（state/board.ts 按插件的状况决定）。
// 卡片的样子和别的看板卡一样（.bcard 那一套），只多一个 .bcard-curator 用来区分。
import { useRoute } from "../../app/route.ts";
import { t } from "../../state/index.ts";
import type { BoardEntryProps } from "../api.ts";

export function CuratorBoardCard({ entry }: BoardEntryProps) {
  const [, navigate] = useRoute();
  if (entry.kind !== "memory_curator") return null;
  const open = () => navigate(entry.route);
  return (
    <div
      className="bcard bcard-static bcard-curator"
      role="button"
      tabIndex={0}
      aria-label={`${entry.title} · ${entry.schedule}`}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
    >
      <div className="bcard-row">
        <span className="bcard-title">{entry.title}</span>
        <span className="muted">›</span>
      </div>
      <div className="bcard-meta">
        <span className="bcard-num">{entry.schedule}</span>
        {entry.note && <span className="bcard-num">{entry.note}</span>}
        <span className="muted">{t("pages.tasks.memoryCurator.open")}</span>
      </div>
    </div>
  );
}
