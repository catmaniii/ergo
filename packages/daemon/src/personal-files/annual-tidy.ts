// 460：生日、纪念日以前随手写的旧值，一次性统一成存的样子。449 起写进来的都经 checkPersonalValue 规范化了，以前存的没改写
// （"3月2号""1990/3/2" 这类认得出，显示、提醒都正常，只是存的写法不统一）。守护进程起来时整理一遍（personal-files.ts 的 start，
// 对每年提醒之前），一个字段只整理一次，第二次起来一条也不写：
// - 看每个人（本人和档案里的别人）生日、纪念日这几类字段（isAnnualField）现在的值；以前的值、忘掉了的、彻底删除改写过的不看；
// - 已经是存的样子、认不出的（"大学开学那天"，档案页照旧提示点"改"重新选）：不动；
// - 认得出、和现值不一样：追加一条照常的 field_set，值是规范化后的，留痕 { via: "tidy" }（不带原话、不带旧值，旧值在前一条事件里）；
// - 规范化后是农历、而这个字段开着每年提醒（有设置）：不动，留给用户在页面上改，计数；
// - 整理过的字段不再整理：用户在档案页上撤销了这一条（回到原来的写法），是他要原来那样，下次起来不再改回去。
// 识别规则照 449 不改（中文月日不带"日""号"的"八月十五""正月初一"算农历）。公历的迁过去月日不变（monthDayOf 先按同一个
// parseAnnualDate 认），每年提醒的日子、内容都不变，对一遍时不改、不删、不重建。
// 这里只算要追加的事件和计数；追加、记日志、对提醒由调用方做。
import { formatAnnualDate, isAnnualField, parseAnnualDate, PURGED_TEXT, SELF_PERSON_ID } from "@ergo/protocol";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { PERSONAL_FILE_EVENT, PERSONAL_FILES_CHANNEL, type PersonalFileChange, personalFileEvent } from "./events.ts";
import { listPeople, remindersOf, valuesOf } from "./view.ts";

/** 整理一遍的结果：要追加的事件，和日志里记的几个数（只记数，不记值） */
export interface AnnualTidy {
  events: NewEvent[];
  /** 改写成存的样子的 */
  changed: number;
  /** 认不出、没动的 */
  unreadable: number;
  /** 会变成农历、开着每年提醒，没动的 */
  keptForReminder: number;
}

const keyOf = (personId: string, field: string) => JSON.stringify([personId, field]);

/** 算一遍要改写哪些（不追加） */
export function annualTidy(store: Pick<EventStore, "reader" | "read">): AnnualTidy {
  const { reader } = store;
  const out: AnnualTidy = { events: [], changed: 0, unreadable: 0, keptForReminder: 0 };
  // 整理过的字段（连被撤销了的那条也算：视图里没有了，事件里还在）
  const done = new Set<string>();
  for (const event of store.read(PERSONAL_FILES_CHANNEL, 0, PERSONAL_FILE_EVENT)) {
    const change = event.payload as PersonalFileChange;
    if (change.change === "field_set" && change.trail.via === "tidy") done.add(keyOf(change.personId, change.field));
  }
  for (const personId of [SELF_PERSON_ID, ...listPeople(reader)]) {
    const reminded = new Set(remindersOf(reader, personId).map((r) => r.field));
    for (const { field, value, until } of valuesOf(reader, personId)) {
      if (until !== undefined || !isAnnualField(field) || value === PURGED_TEXT || done.has(keyOf(personId, field))) continue;
      const date = parseAnnualDate(value);
      if (date === undefined) {
        out.unreadable++;
        continue;
      }
      const stored = formatAnnualDate(date);
      if (stored === value) continue;
      if (date.calendar === "lunar" && reminded.has(field)) {
        out.keptForReminder++;
        continue;
      }
      out.events.push(personalFileEvent({ change: "field_set", personId, field, value: stored, trail: { via: "tidy" } }));
      out.changed++;
    }
  }
  return out;
}
