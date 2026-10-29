// 归档清单卡（19 号票）：每周一次，结束超过 N 天、还没归档的任务汇总成一张清单放进待我处理。
// 每一项单独选：归档（任务变为已归档）、继续改（已完成的走返工、失败的走重试，回到执行中）、先留着（不变）；
// 已取消的（以及转为项目结束的）只能归档或先留着。每一项都选了，清单算处理完。
import { toHash } from "../../app/route.ts";
import {
  ARCHIVE_CHOICE_LABEL,
  ARCHIVE_CHOICES,
  type ArchiveChoice,
  type ArchiveListCardPayload,
  type ArchiveListDecideInput,
  TASK_END_KIND_LABEL,
  TASK_STATE_LABEL,
  t,
} from "../../state/index.ts";
import { timeLabel } from "../../util/time.ts";
import { type CardProps, CardShell } from "./CardShell.tsx";

/** 处理完之后的一句话："归档 2 个，继续改 1 个，先留着 1 个" */
function decidedSummary(p: ArchiveListCardPayload): string {
  return ARCHIVE_CHOICES.map((c) => [c, p.items.filter((i) => i.decision === c).length] as const)
    .filter(([, n]) => n > 0)
    .map(([c, n]) => t("ui.archiveListCard.choiceCount", { choice: ARCHIVE_CHOICE_LABEL[c], count: n }))
    .join(t("ui.archiveListCard.summarySep"));
}

export function ArchiveListCard({ state, payload: p, done, act }: CardProps<ArchiveListCardPayload>) {
  const sending = state.pending?.status === "sending";
  const left = p.items.filter((i) => i.decision === undefined).length;
  const decide = (taskId: string, choice: ArchiveChoice) => act("decide", undefined, { taskId, choice } satisfies ArchiveListDecideInput);
  return (
    <CardShell state={state} title={t("ui.archiveListCard.title", { count: p.items.length, days: p.afterDays })} doneLabel={done ? t("ui.archiveListCard.handled", { summary: decidedSummary(p) }) : undefined}>
      <div className="archive-list">
        {p.items.map((item) => (
          <div key={item.taskId} className="sjob-row">
            <div>
              <a className="link" href={toHash({ tab: "tasks", taskId: item.taskId })}>
                {t("ui.archiveListCard.taskRef", { id: item.taskId, title: item.title })}
              </a>
              <div className="muted">
                {TASK_STATE_LABEL[item.state]}
                {item.endKind ? ` · ${TASK_END_KIND_LABEL[item.endKind]}` : ""}
                {t("ui.archiveListCard.endedAt", { time: timeLabel(item.endedAt) })}
              </div>
            </div>
            {item.decision ? (
              <span className="chip">{ARCHIVE_CHOICE_LABEL[item.decision]}</span>
            ) : (
              item.choices.map((c) => (
                <button key={c} type="button" className={`btn small ${c === "archive" ? "primary" : "ghost"}`} disabled={done || sending} onClick={() => decide(item.taskId, c)}>
                  {ARCHIVE_CHOICE_LABEL[c]}
                </button>
              ))
            )}
          </div>
        ))}
        {!done && left < p.items.length && <div className="muted">{t("ui.archiveListCard.left", { count: left })}</div>}
      </div>
    </CardShell>
  );
}
