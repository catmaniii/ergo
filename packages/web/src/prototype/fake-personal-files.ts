// 原型里的个人档案（281 号票）：只在内存里，刷新回到初始的假数据。人和号码全是编的（号码一看就是假的）。
// 规矩照守护进程那份的大意（personal-files/）：新值把旧值记成历史、撤销回到上一个值、删一个人连整份；不做校验以外的东西。
// 283 号票：生日、纪念日的每年提醒（只记开没开、提前几天，下次提醒的日子按这台设备的日历算）；"二狗了解到的"是编的几条。
// 302 号票：内置字段"纪念日"（本人有一个编的结婚纪念日，开着每年提醒；妈妈那份空着）；字段的先后照协议包的 personalFieldOrder。
// 285 号票：分组——妈妈、女儿没选分组（按关系猜成家人），同事小张建时选了"重要的人"，装修的王师傅没写关系（猜成其他人）；能改分组。
import {
  type AddPersonBody,
  guessPersonGroup,
  isPersonGroup,
  type PersonGroup,
  type PersonalAnnualView,
  type PersonalFileLearnedView,
  isAnnualField,
  monthDayOf,
  checkPersonalNote,
  checkPersonalValue,
  checkPersonName,
  customLabelOf,
  isNumberField,
  type PersonalFieldValue,
  type PersonalFileChangeBody,
  type PersonalFileDeleteBody,
  type PersonalFileDeleteResult,
  type PersonalFileKind,
  type PersonalFileSource,
  type PersonalFilesView,
  type PersonalFileView,
  personalFieldLabel,
  personalFieldOf,
  personalFieldOrder,
} from "../state/index.ts";
import { at } from "./fake-conversations.ts";

interface FakeValue {
  value: string;
  since: string;
  until?: string;
  source: PersonalFileSource;
}

interface FakePerson {
  id: string;
  kind: PersonalFileKind;
  /** 每个字段的值，旧的在前、现在的在最后 */
  values: Map<string, FakeValue[]>;
  /** 285：选过的分组（没选过的按关系猜） */
  group?: PersonGroup;
  notes: { id: string; text: string; date: string; source: PersonalFileSource }[];
}

const page = (when: string): PersonalFileSource => ({ via: "page", at: when });
const chat = (when: string, quote: string, basis: "explicit" | "confirmed"): PersonalFileSource => ({ via: "secretary", basis, at: when, messageId: "msg-pf-demo-1", quote });

const view = (v: FakeValue): PersonalFieldValue => ({ value: v.value, since: v.since, ...(v.until === undefined ? {} : { until: v.until }), source: v.source });

function person(id: string, kind: PersonalFileKind, values: Record<string, FakeValue[]>, notes: FakePerson["notes"] = []): FakePerson {
  return { id, kind, values: new Map(Object.entries(values)), notes };
}

/** 下次提醒的那天（09:00，按这台设备的日历）：生日往前数几天，今年过了算明年 */
function nextReminder(month: number, day: number, daysBefore: number): string {
  const now = new Date();
  let at = new Date(now.getFullYear(), month - 1, day - daysBefore, 9);
  if (at.getTime() <= now.getTime()) at = new Date(now.getFullYear() + 1, month - 1, day - daysBefore, 9);
  return `${at.toLocaleDateString("en-CA")}T09:00:00+08:00`;
}

/** 编的"二狗了解到的"：按档案编号 */
const FAKE_LEARNED: Readonly<Record<string, Omit<PersonalFileLearnedView, "ready">>> = {
  me: {
    entities: [],
    claims: [{ id: "cl-fake-me-1", statement: "周末更愿意待在家里，不太想安排活动", tier: "preference", status: "active", confidence: "medium", epistemic: "inferred" }],
    facts: [{ id: "f-fake-me-1", statement: "用户最近在准备换工作", observedAt: at("10-14", "21:10") }],
    quotes: [{ id: "ev-fake-me-1", text: "这周末哪也不想去，就想在家躺着", at: at("10-18", "22:05") }],
  },
  "p-fake-mom": {
    entities: ["老妈"],
    claims: [
      { id: "cl-fake-mom-1", statement: "很在意妈妈的身体，常提醒她别爬楼", tier: "need", status: "active", confidence: "medium", epistemic: "inferred" },
      { id: "cl-fake-mom-2", statement: "每周日晚上会给妈妈打电话", tier: "state", status: "active", confidence: "high", epistemic: "explicit" },
    ],
    facts: [
      { id: "f-fake-mom-1", statement: "妈妈腿脚不好，爬楼吃力", observedAt: at("10-20", "19:30") },
      { id: "f-fake-mom-2", statement: "妈妈住在示例县老家", observedAt: at("10-09", "20:12") },
    ],
    quotes: [
      { id: "ev-fake-mom-1", text: "我老妈最近腿脚不好，爬楼吃力", at: at("10-20", "19:30") },
      { id: "ev-fake-mom-2", text: "周日晚上记得给老妈打个电话", at: at("10-19", "18:02") },
    ],
  },
};

export class FakePersonalFiles {
  private seq = 0;
  private readonly people: FakePerson[];
  /** 开着的每年提醒：档案编号 · 字段 → 提前几天 */
  private readonly reminders = new Map<string, number>([
    ["p-fake-daughter:birthday", 3],
    ["me:anniversary:结婚纪念日", 3],
  ]);
  private readonly userName: () => string | undefined;
  private readonly setUserName: (name: string | null) => void;

  /** userName：原型里的"我的名字"（本人的姓名就是它） */
  constructor(userName: () => string | undefined, setUserName: (name: string | null) => void) {
    this.userName = userName;
    this.setUserName = setUserName;
    this.people = [
      person("me", "self", {
        id_card: [{ value: "123456789012345678", since: at("10-21", "21:40"), source: chat(at("10-21", "21:40"), "记住我身份证号是 123456789012345678", "confirmed") }],
        birthday: [{ value: "1990-01-01", since: at("10-12", "09:00"), source: page(at("10-12", "09:00")) }],
        "anniversary:结婚纪念日": [{ value: "2018年10月1日", since: at("10-25", "20:30"), source: chat(at("10-25", "20:30"), "我们的结婚纪念日是2018年10月1日", "explicit") }],
        phone: [{ value: "13800000000", since: at("10-12", "09:00"), source: page(at("10-12", "09:00")) }],
        address: [
          { value: "示例市旧城区示例街 3 号", since: at("10-12", "09:00"), until: at("10-24", "20:15"), source: page(at("10-12", "09:00")) },
          { value: "示例市示例区示例路 18 号", since: at("10-24", "20:15"), source: chat(at("10-24", "20:15"), "我搬家了，新地址是示例市示例区示例路 18 号", "explicit") },
        ],
        work: [{ value: "示例科技 · 产品经理", since: at("10-12", "09:00"), source: page(at("10-12", "09:00")) }],
        health: [{ value: "青霉素过敏", since: at("10-12", "09:00"), source: page(at("10-12", "09:00")) }],
      }),
      person(
        "p-fake-mom",
        "person",
        {
          name: [{ value: "妈妈", since: at("10-12", "09:05"), source: page(at("10-12", "09:05")) }],
          aliases: [{ value: "老妈", since: at("10-12", "09:05"), source: page(at("10-12", "09:05")) }],
          relation: [{ value: "母亲", since: at("10-12", "09:05"), source: page(at("10-12", "09:05")) }],
          birthday: [{ value: "农历八月十五", since: at("10-12", "09:05"), source: page(at("10-12", "09:05")) }],
          phone: [{ value: "13900000000", since: at("10-12", "09:05"), source: page(at("10-12", "09:05")) }],
          health: [{ value: "无", since: at("10-12", "09:05"), source: page(at("10-12", "09:05")) }],
        },
        [{ id: "n-fake-1", text: "腿脚不好，爬楼吃力", date: "2026-10-20", source: page(at("10-20", "19:30")) }],
      ),
      person("p-fake-daughter", "person", {
        name: [{ value: "女儿", since: at("10-12", "09:08"), source: page(at("10-12", "09:08")) }],
        relation: [{ value: "女儿", since: at("10-12", "09:08"), source: page(at("10-12", "09:08")) }],
        birthday: [{ value: "2020-03-02", since: at("10-12", "09:08"), source: page(at("10-12", "09:08")) }],
        work: [{ value: "示例小学一年级", since: at("10-12", "09:08"), source: page(at("10-12", "09:08")) }],
      }),
      {
        ...person("p-fake-zhang", "person", {
          name: [{ value: "小张", since: at("10-14", "10:00"), source: page(at("10-14", "10:00")) }],
          relation: [{ value: "同事", since: at("10-14", "10:00"), source: page(at("10-14", "10:00")) }],
          phone: [{ value: "13700000000", since: at("10-14", "10:00"), source: page(at("10-14", "10:00")) }],
          birthday: [{ value: "1992-06-18", since: at("10-14", "10:00"), source: page(at("10-14", "10:00")) }],
        }),
        group: "important",
      },
      person("p-fake-wang", "person", {
        name: [{ value: "王师傅", since: at("10-22", "18:00"), source: page(at("10-22", "18:00")) }],
        phone: [{ value: "13600000000", since: at("10-22", "18:00"), source: page(at("10-22", "18:00")) }],
        work: [{ value: "示例装修队", since: at("10-22", "18:00"), source: page(at("10-22", "18:00")) }],
      }),
    ];
  }

  private find(id: string): FakePerson {
    const found = this.people.find((p) => p.id === id);
    if (!found) throw new Error(`没有这份档案：${id}`);
    return found;
  }

  private nameOf(p: FakePerson): string | undefined {
    return p.kind === "self" ? this.userName() : p.values.get("name")?.at(-1)?.value;
  }

  private current(p: FakePerson, field: string): FakeValue | undefined {
    const last = p.values.get(field)?.at(-1);
    return last && last.until === undefined ? last : undefined;
  }

  /** 285：分组（本人那份没有；没选过的按关系猜） */
  private groupOf(p: FakePerson): Pick<PersonalFileView, "group" | "groupGuessed"> {
    if (p.kind === "self") return {};
    return p.group !== undefined ? { group: p.group } : { group: guessPersonGroup(this.current(p, "relation")?.value), groupGuessed: true };
  }

  list(): PersonalFilesView {
    return {
      files: this.people.map((p) => {
        const name = this.nameOf(p);
        const relation = p.kind === "person" ? this.current(p, "relation")?.value : undefined;
        const filled = [...p.values.keys()].filter((f) => this.current(p, f)).length + (p.kind === "self" && name !== undefined ? 1 : 0);
        return { id: p.id, kind: p.kind, ...(name === undefined ? {} : { name }), ...(relation === undefined ? {} : { relation }), ...this.groupOf(p), filled, notes: p.notes.length };
      }),
    };
  }

  file(id: string): PersonalFileView {
    const p = this.find(id);
    const name = this.nameOf(p);
    return {
      id: p.id,
      kind: p.kind,
      ...(name === undefined ? {} : { name }),
      ...this.groupOf(p),
      fields: personalFieldOrder(p.kind, p.values.keys()).map((field) => {
        const base = { field, label: personalFieldLabel(p.kind, field), custom: customLabelOf(field) !== undefined };
        if (p.kind === "self" && field === "name") return { ...base, number: false, linked: "user_name" as const, ...(name === undefined ? {} : { current: { value: name } }), history: [] };
        const rows = p.values.get(field) ?? [];
        const current = this.current(p, field);
        const annual = this.annual(p.id, field, current?.value);
        return {
          ...base,
          number: isNumberField(field, current?.value ?? ""),
          ...(current ? { current: view(current) } : {}),
          ...(annual === undefined ? {} : { annual }),
          history: rows
            .filter((r) => r.until !== undefined)
            .toReversed()
            .map(view),
        };
      }),
      notes: p.notes.toSorted((a, b) => b.date.localeCompare(a.date)),
    };
  }

  private annual(personId: string, field: string, value: string | undefined): PersonalAnnualView | undefined {
    if (!isAnnualField(field)) return undefined;
    const date = value === undefined ? undefined : monthDayOf(value);
    const days = this.reminders.get(`${personId}:${field}`);
    if (value !== undefined && date === undefined) return { ...(days === undefined ? {} : { daysBefore: days }), blocked: "not_gregorian" };
    return { ...(date === undefined ? {} : { monthDay: date }), ...(days === undefined ? {} : { daysBefore: days, ...(date === undefined ? {} : { nextAt: nextReminder(date.month, date.day, days) }) }) };
  }

  /** 二狗了解到的（编的；没编的人是空的） */
  learned(id: string): PersonalFileLearnedView {
    this.find(id);
    return { ready: true, ...(FAKE_LEARNED[id] ?? { entities: [], claims: [], facts: [], quotes: [] }) };
  }

  addPerson(body: AddPersonBody): PersonalFileView {
    const name = checkPersonName(body.name);
    if (!name.ok) throw new Error(name.error);
    const now = new Date().toISOString();
    const id = `p-fake-${++this.seq}`;
    const values: Record<string, FakeValue[]> = { name: [{ value: name.value, since: now, source: page(now) }] };
    if (body.relation !== undefined && body.relation.trim() !== "") values.relation = [{ value: body.relation.trim(), since: now, source: page(now) }];
    this.people.push({ ...person(id, "person", values), ...(body.group === undefined ? {} : { group: body.group }) });
    return this.file(id);
  }

  change(id: string, body: PersonalFileChangeBody): PersonalFileView {
    const p = this.find(id);
    const now = new Date().toISOString();
    if (body.kind === "add_note") {
      const text = checkPersonalNote(body.text);
      if (!text.ok) throw new Error(text.error);
      p.notes.push({ id: `n-fake-${++this.seq}`, text: text.value, date: body.date ?? now.slice(0, 10), source: page(now) });
      return this.file(id);
    }
    if (body.kind === "set_group") {
      if (p.kind === "self") throw new Error("你本人的档案不分组");
      if (!isPersonGroup(body.group)) throw new Error("不认得这个分组");
      p.group = body.group;
      return this.file(id);
    }
    const field = personalFieldOf(p.kind, body.field);
    if (field === undefined) throw new Error(`认不出字段「${body.field}」`);
    if (body.kind === "set_reminder") {
      if (body.daysBefore === null) this.reminders.delete(`${id}:${field}`);
      else this.reminders.set(`${id}:${field}`, body.daysBefore);
      return this.file(id);
    }
    if (body.kind === "undo_field") {
      const rows = p.values.get(field) ?? [];
      rows.pop();
      const last = rows.at(-1);
      if (last) delete last.until;
      return this.file(id);
    }
    if (p.kind === "self" && field === "name") {
      this.setUserName(body.value);
      return this.file(id);
    }
    const value = checkPersonalValue(field, body.value);
    if (!value.ok) throw new Error(value.error);
    const rows = p.values.get(field) ?? [];
    const last = rows.at(-1);
    if (last && last.until === undefined) last.until = now;
    rows.push({ value: value.value, since: now, source: page(now) });
    p.values.set(field, rows);
    return this.file(id);
  }

  remove(id: string, body: PersonalFileDeleteBody): PersonalFileDeleteResult {
    const p = this.find(id);
    const { target } = body;
    if (target.kind === "person") {
      if (p.kind === "self") throw new Error("你本人的档案删不掉，可以删里面的字段");
      this.people.splice(this.people.indexOf(p), 1);
      return { sources: 0 };
    }
    if (target.kind === "note") p.notes = p.notes.filter((n) => n.id !== target.noteId);
    else if (p.kind === "self" && target.field === "name") this.setUserName(null);
    else {
      p.values.delete(target.field);
      this.reminders.delete(`${id}:${target.field}`);
    }
    return { file: this.file(id), sources: body.withSources === true ? 1 : 0 };
  }
}
