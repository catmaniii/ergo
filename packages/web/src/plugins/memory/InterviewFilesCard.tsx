// 访谈的档案核对卡（284 号票，卡片类型 interview_files，记忆插件登记的画法）：一次了解你访谈收尾时，记忆管理员把这次听到的档案信息
// （生日、电话、单位……）合成一张，按人分组一条一条列出（号码一位一位列在小格子里，和 281 号票的核对卡一样；原来有值的写"原来"），
// 每条"不记""确认"：确认的由运行时写进个人档案（和秘书提议的同一个写入口），不记的不写。都定了以后卡片算处理完，有"去档案里看"。
// 生日、纪念日那条带"每年提前几天提醒"的勾（283 号票，和个人档案的核对卡一样默认勾着、提前 3 天），确认时一起建。
// 记忆插件停用时这张卡显示占位（守护进程那边的"确认"回"记忆插件没启用"）。
import { useState } from "react";
import { toHash } from "../../app/route.ts";
import { type InterviewFileItem, type InterviewFilesCardPayload, PURGED_TEXT, t, tTable } from "../../state/index.ts";
import { AnnualRemindPick } from "../../ui/cards/AnnualRemindPick.tsx";
import { Btn } from "../../ui/cards/cards.tsx";
import { type CardProps, CardShell } from "../../ui/cards/CardShell.tsx";
import { Digits } from "../../ui/cards/PersonalFileCard.tsx";

/** 定了的那一条写什么 */
const STATE_LABEL: Readonly<Record<Exclude<InterviewFileItem["state"], "pending">, string>> = tTable({
  written: "ui.cards.interviewFiles.written",
  skipped: "ui.cards.interviewFiles.skipped",
  unchanged: "ui.cards.interviewFiles.unchanged",
});

/** 按人分组（按第一次出现的先后） */
function byPerson(items: readonly InterviewFileItem[]): { name: string; first: InterviewFileItem; items: InterviewFileItem[] }[] {
  const groups: { name: string; first: InterviewFileItem; items: InterviewFileItem[] }[] = [];
  for (const item of items) {
    const group = groups.find((g) => g.name === item.person.name);
    if (group) group.items.push(item);
    else groups.push({ name: item.person.name, first: item, items: [item] });
  }
  return groups;
}

export function InterviewFilesCard({ state, payload: p, act, done }: CardProps<InterviewFilesCardPayload>) {
  const busy = state.pending?.status === "sending";
  const left = p.items.filter((item) => item.state === "pending").length;
  // 每年提醒的勾：哪一条 → 勾没勾、提前几天（默认照卡上的）
  const [remind, setRemind] = useState<Record<string, { on: boolean; days: number }>>({});
  const confirm = (item: InterviewFileItem) => {
    const pick = remind[item.id];
    const chosen = item.remind === undefined ? undefined : pick?.on === false ? [] : [{ field: item.remind.field, daysBefore: pick?.days ?? item.remind.daysBefore }];
    act("confirm", undefined, { item: item.id, ...(chosen === undefined ? {} : { remind: chosen }) });
  };
  return (
    <CardShell
      state={state}
      title={t("ui.cards.interviewFiles.title", { n: p.items.length })}
      doneLabel={t("ui.cards.interviewFiles.done")}
      doneActions={
        p.items.some((item) => item.state === "written" && item.result !== PURGED_TEXT) ? (
          <a className="link" href={toHash({ tab: "more", page: "files" })}>
            {t("ui.cards.personalFile.open")}
          </a>
        ) : undefined
      }
    >
      {byPerson(p.items).map((group) => (
        <div key={group.name} className="ivf-person">
          <div className="pf-card-new">
            {group.first.person.isNew
              ? group.first.person.relation === undefined
                ? t("ui.cards.personalFile.newPerson", { name: group.name })
                : t("ui.cards.personalFile.newPersonRelation", { name: group.name, relation: group.first.person.relation })
              : group.name}
          </div>
          {group.items.map((item) => (
            <div key={item.id} className={`ivf-item ivf-${item.state}`} data-item={item.id}>
              <div className="pf-card-field">
                {item.field ? (
                  <>
                    <span className="muted">{t("ui.cards.personalFile.fieldLabel", { label: item.field.label })}</span>
                    {item.field.number && item.field.value !== PURGED_TEXT ? <Digits value={item.field.value} /> : <span className="pf-card-value">{item.field.value}</span>}
                    {item.field.previous !== undefined && <div className="muted pf-card-previous">{t("ui.cards.personalFile.previous", { value: item.field.previous })}</div>}
                    {item.remind !== undefined && item.state === "pending" && !done && (
                      <AnnualRemindPick
                        label={item.remind.label}
                        on={remind[item.id]?.on ?? true}
                        days={remind[item.id]?.days ?? item.remind.daysBefore}
                        disabled={busy}
                        onChange={(next) => setRemind((cur) => ({ ...cur, [item.id]: next }))}
                      />
                    )}
                  </>
                ) : (
                  <>
                    <span className="muted">{t("ui.cards.personalFile.note", { date: item.note?.date ?? "" })}</span>
                    <span className="pf-card-value">{item.note?.text}</span>
                  </>
                )}
              </div>
              {item.state === "pending" ? (
                !done && (
                  <div className="ivf-actions">
                    <Btn disabled={busy} onClick={() => act("reject", undefined, { item: item.id })}>
                      {t("ui.cards.interviewFiles.skip")}
                    </Btn>
                    <Btn kind="primary" disabled={busy} onClick={() => confirm(item)}>
                      {t("ui.cards.interviewFiles.confirm")}
                    </Btn>
                  </div>
                )
              ) : (
                <div className={`ivf-state ${item.state === "written" ? "ok" : "muted"}`}>
                  {item.state === "written" ? "✓ " : ""}
                  {STATE_LABEL[item.state]}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
      {!done && left > 0 && <div className="muted">{t("ui.cards.interviewFiles.hint", { n: left })}</div>}
    </CardShell>
  );
}
