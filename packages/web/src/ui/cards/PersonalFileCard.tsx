// 个人档案的核对卡（281 号票，卡片类型 personal_file）：秘书提议写进档案、要你核对的——写给谁（新建一份的写明）、哪些字段
// （号码一位一位列在小格子里，按组隔开：身份证号 6 · 8 · 4、手机号 3 · 4 · 4；原来有值的写"原来"）、记下哪件事。
// "确认写入"由运行时写进档案，"取消"关掉；处理完以后有"去档案里看"。原话里明说了的非号码类不出这张卡（直接写，留快速动作的"已执行"卡）。
// 283 号票：生日、纪念日下面一个"每年提前几天提醒"的勾（默认勾着、提前 3 天），确认时一起建。
import { useState } from "react";
import { toHash } from "../../app/route.ts";
import { numberGroups, type PersonalFileCardPayload, type PersonalFileExecuteInput, PURGED_TEXT, t } from "../../state/index.ts";
import { AnnualRemindPick } from "./AnnualRemindPick.tsx";
import { Btn } from "./cards.tsx";
import { type CardProps, CardShell } from "./CardShell.tsx";

/** 号码一位一位列出：每位一个小格子，组和组之间隔开；读屏读整串 */
export function Digits({ value }: { value: string }) {
  return (
    <span className="pf-digits" role="text" aria-label={value}>
      {numberGroups(value).map((group, i) => (
        <span key={i} className="pf-digit-group" aria-hidden="true">
          {group.map((d, j) => (
            <span key={j} className="pf-digit">
              {d}
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

export function PersonalFileCard({ state, payload: p, act }: CardProps<PersonalFileCardPayload>) {
  const handled = state.card.status === "handled";
  const pending = state.card.status === "pending";
  const hasNumber = p.fields.some((f) => f.number);
  // 每年提醒的勾：字段 → 勾没勾、提前几天（默认照卡上的）
  const [remind, setRemind] = useState<Record<string, { on: boolean; days: number }>>(() => Object.fromEntries((p.remind ?? []).map((r) => [r.field, { on: true, days: r.daysBefore }])));
  const execute = () => {
    const input: PersonalFileExecuteInput = {
      remind: (p.remind ?? []).flatMap((r) => {
        const pick = remind[r.field];
        return pick?.on === false ? [] : [{ field: r.field, daysBefore: pick?.days ?? r.daysBefore }];
      }),
    };
    act("execute", undefined, p.remind === undefined ? undefined : input);
  };
  return (
    <CardShell
      state={state}
      title={p.title}
      doneLabel={handled && p.result ? p.result : undefined}
      doneActions={
        handled && p.result !== PURGED_TEXT ? (
          <a className="link" href={toHash({ tab: "more", page: "files", ...(p.person.id === undefined ? {} : { item: p.person.id }) })}>
            {t("ui.cards.personalFile.open")}
          </a>
        ) : undefined
      }
      actions={
        <>
          <Btn onClick={() => act("cancel")}>{t("ui.cards.personalFile.cancel")}</Btn>
          <Btn kind="primary" onClick={execute}>
            {t("ui.cards.personalFile.confirm")}
          </Btn>
        </>
      }
    >
      {p.person.isNew && (
        <div className="pf-card-new">
          {p.person.relation === undefined ? t("ui.cards.personalFile.newPerson", { name: p.person.name }) : t("ui.cards.personalFile.newPersonRelation", { name: p.person.name, relation: p.person.relation })}
        </div>
      )}
      {p.fields.map((f) => (
        <div key={f.field} className="pf-card-field">
          <span className="muted">{t("ui.cards.personalFile.fieldLabel", { label: f.label })}</span>
          {f.number && f.value !== PURGED_TEXT ? <Digits value={f.value} /> : <span className="pf-card-value">{f.value}</span>}
          {f.previous !== undefined && <div className="muted pf-card-previous">{t("ui.cards.personalFile.previous", { value: f.previous })}</div>}
          {p.remind
            ?.filter((r) => r.field === f.field && pending)
            .map((r) => (
              <AnnualRemindPick key={r.field} label={r.label} on={remind[r.field]?.on ?? true} days={remind[r.field]?.days ?? r.daysBefore} onChange={(next) => setRemind((cur) => ({ ...cur, [r.field]: next }))} />
            ))}
        </div>
      ))}
      {p.note && (
        <div className="pf-card-field">
          <span className="muted">{t("ui.cards.personalFile.note", { date: p.note.date })}</span>
          <span className="pf-card-value">{p.note.text}</span>
        </div>
      )}
      {pending && <div className="muted">{hasNumber ? t("ui.cards.personalFile.checkDigits") : t("ui.cards.personalFile.check")}</div>}
    </CardShell>
  );
}
