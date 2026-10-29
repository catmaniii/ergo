// 候选核对卡（283 号票，卡片类型 personal_file_suggest）：每晚整理把白天听到的人物信息攒成候选，第二天一张卡逐条核对——
// 按人分块（新的人先有一条"建一份档案"，不勾它这个人的别的条目也写不进去），每条一个勾（默认都勾着），生日、纪念日下面带
// "每年提前几天提醒"；直接写进档案的生日跟着回执出的那种只有一条"每年提醒"。卡上不放原话，只写哪几天听到的。
// "写进勾了的"把勾了的写进档案（留痕：经记忆管理员、你在卡上确认），"都不用"关掉；没勾的以后不再提。
// 299 号票：从手机通讯录挑的人（origin contacts）也上这张卡——建档那一条写"从手机通讯录挑的"，电话照 281 的核对卡一位一位列在小格子里，
// 底下多一句"号码请一位一位对一遍"。
// 301 号票：导入的通讯录 vCard（origin vcard，Google 联系人导出的）也上这张卡——建档那一条写"从导入的通讯录来的"，底下的话写明没勾的以后不再提。
import { useState } from "react";
import { toHash } from "../../app/route.ts";
import { numberGroups, type PersonalFileSuggestCardPayload, type PersonalFileSuggestInput, type PersonalFileSuggestItem, PURGED_TEXT, suggestGroups, suggestHeard, t } from "../../state/index.ts";
import { AnnualRemindPick } from "./AnnualRemindPick.tsx";
import { Digits } from "./PersonalFileCard.tsx";
import { Btn } from "./cards.tsx";
import { type CardProps, CardShell } from "./CardShell.tsx";

interface Pick {
  on: boolean;
  days: number;
}

/** 号码类的值（299 号票：通讯录挑来的电话）一位一位列出，别的照原样 */
function Value({ item }: { item: PersonalFileSuggestItem }) {
  if (item.number === true && item.value !== undefined && item.value !== PURGED_TEXT) return <Digits value={item.value} />;
  return <>{valueText(item)}</>;
}

function valueText(item: PersonalFileSuggestItem): string {
  if (item.value === undefined) return "";
  return item.number === true && item.value !== PURGED_TEXT ? numberGroups(item.value).map((g) => g.join("")).join(" ") : item.value;
}

export function PersonalFileSuggestCard({ state, payload: p, act }: CardProps<PersonalFileSuggestCardPayload>) {
  const pending = state.card.status === "pending";
  const handled = state.card.status === "handled";
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(p.items.map((i) => [i.id, true])));
  const [remind, setRemind] = useState<Record<string, Pick>>(() => Object.fromEntries(p.items.flatMap((i) => (i.remind === undefined ? [] : [[i.id, { on: true, days: i.remind.daysBefore }]]))));
  const groups = suggestGroups(p.items);
  const isOn = (item: PersonalFileSuggestItem) => (pending ? checked[item.id] !== false : item.decision === "accepted");

  const confirm = () => {
    const accept: string[] = [];
    const days: NonNullable<PersonalFileSuggestInput["remind"]> = [];
    for (const group of groups) {
      if (group.create && checked[group.create.id] === false) continue;
      if (group.create) accept.push(group.create.id);
      for (const item of group.items) {
        if (checked[item.id] === false) continue;
        const pick = remind[item.id];
        // 每年提醒那一条：勾就是写，天数跟着
        if (item.kind === "reminder") {
          accept.push(item.id);
          days.push({ item: item.id, daysBefore: pick?.days ?? item.remind?.daysBefore ?? 3 });
          continue;
        }
        accept.push(item.id);
        if (item.remind !== undefined && pick?.on !== false) days.push({ item: item.id, daysBefore: pick?.days ?? item.remind.daysBefore });
      }
    }
    act("confirm", undefined, { accept, remind: days } satisfies PersonalFileSuggestInput);
  };

  const firstPerson = groups.find((g) => g.person.id !== undefined)?.person.id;
  return (
    <CardShell
      state={state}
      title={p.title}
      doneLabel={handled && p.result ? p.result : undefined}
      doneActions={
        handled && p.result !== PURGED_TEXT && p.items.some((i) => i.decision === "accepted") ? (
          <a className="link" href={toHash({ tab: "more", page: "files", ...(firstPerson === undefined ? {} : { item: firstPerson }) })}>
            {t("ui.cards.personalFile.open")}
          </a>
        ) : undefined
      }
      actions={
        <>
          <Btn onClick={() => act("reject")}>{t("ui.cards.personalFileSuggest.reject")}</Btn>
          <Btn kind="primary" onClick={confirm}>
            {t("ui.cards.personalFileSuggest.confirm")}
          </Btn>
        </>
      }
    >
      {groups.map((group) => {
        const blocked = group.create !== undefined && !isOn(group.create);
        return (
          <div key={group.key} className="pf-suggest-person">
            <div className="pf-suggest-name">
              {group.person.relation === undefined ? group.person.name : t("ui.cards.personalFileSuggest.nameRelation", { name: group.person.name, relation: group.person.relation })}
              {group.person.isNew && <span className="pf-suggest-new">{t("ui.cards.personalFileSuggest.new")}</span>}
            </div>
            {group.create && (
              <label className={`pf-suggest-item${pending ? "" : " done"}${isOn(group.create) ? "" : " off"}`}>
                <input type="checkbox" checked={isOn(group.create)} disabled={!pending} onChange={(e) => setChecked((c) => ({ ...c, [group.create!.id]: e.currentTarget.checked }))} />
                <span>
                  {group.create.origin === "contacts"
                    ? t("ui.cards.personalFileSuggest.createPicked")
                    : group.create.origin === "vcard"
                      ? t("ui.cards.personalFileSuggest.createImported")
                      : t("ui.cards.personalFileSuggest.create", { count: group.create.mentions ?? 0 })}
                  {suggestHeard(group.create) !== undefined && <span className="muted pf-suggest-heard">{suggestHeard(group.create)}</span>}
                </span>
              </label>
            )}
            {group.items.map((item) =>
              item.kind === "reminder" ? (
                <div key={item.id} className="pf-suggest-item pf-suggest-reminder">
                  <div>{t("ui.cards.personalFileSuggest.fieldLine", { label: item.label ?? "", value: valueText(item) })}</div>
                  <AnnualRemindPick
                    label={item.label ?? ""}
                    on={isOn(item)}
                    days={remind[item.id]?.days ?? item.remind?.daysBefore ?? 3}
                    disabled={!pending}
                    onChange={(next) => {
                      setChecked((c) => ({ ...c, [item.id]: next.on }));
                      setRemind((r) => ({ ...r, [item.id]: next }));
                    }}
                  />
                </div>
              ) : (
                <div key={item.id} className={`pf-suggest-item${pending ? "" : " done"}${isOn(item) && !blocked ? "" : " off"}`}>
                  <label className="pf-suggest-check">
                    <input type="checkbox" checked={isOn(item) && !blocked} disabled={!pending || blocked} onChange={(e) => setChecked((c) => ({ ...c, [item.id]: e.currentTarget.checked }))} />
                    <span>
                      {item.number === true ? (
                        <>
                          {t("ui.cards.personalFileSuggest.fieldLabel", { label: item.label ?? "" })}
                          <Value item={item} />
                        </>
                      ) : (
                        t("ui.cards.personalFileSuggest.fieldLine", { label: item.label ?? "", value: valueText(item) })
                      )}
                      {item.previous !== undefined && <span className="muted pf-suggest-previous">{t("ui.cards.personalFile.previous", { value: item.previous })}</span>}
                      {suggestHeard(item) !== undefined && <span className="muted pf-suggest-heard">{suggestHeard(item)}</span>}
                    </span>
                  </label>
                  {item.remind !== undefined && pending && (
                    <AnnualRemindPick
                      label={item.label ?? ""}
                      on={remind[item.id]?.on ?? true}
                      days={remind[item.id]?.days ?? item.remind.daysBefore}
                      disabled={!isOn(item) || blocked}
                      onChange={(next) => setRemind((r) => ({ ...r, [item.id]: next }))}
                    />
                  )}
                </div>
              ),
            )}
          </div>
        );
      })}
      {pending && p.items.some((i) => i.origin !== "contacts" && i.origin !== "vcard") && <div className="muted">{t("ui.cards.personalFileSuggest.hint")}</div>}
      {pending && p.items.some((i) => i.origin === "contacts") && <div className="muted">{t(p.items.some((i) => i.origin === "contacts" && i.number === true) ? "ui.cards.personalFileSuggest.hintPickedNumber" : "ui.cards.personalFileSuggest.hintPicked")}</div>}
      {pending && p.items.some((i) => i.origin === "vcard") && <div className="muted">{t(p.items.some((i) => i.origin === "vcard" && i.number === true) ? "ui.cards.personalFileSuggest.hintImportedNumber" : "ui.cards.personalFileSuggest.hintImported")}</div>}
    </CardShell>
  );
}
