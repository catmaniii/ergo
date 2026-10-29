// 秘书读个人档案的工具（281 号票）：按人、按字段读，拿到用户确认过的原值（以后安全阶段再改成默认打码、取全值留痕，只记录不实现）。
// 填网页表单时秘书先读档案、再用现有的网页工具填；问"我以前住哪"答得出（以前的值连同到哪天为止）。只读，不落入任何类别。
// 不给 person 是列出有哪些人、各填了哪些字段（不带值）。
// @i18n-ignore-file model：工具的说明、参数说明、交回秘书的结果给模型看；工具的名字走 t()
import { builtinFields, forModel, isAnniversaryField, type PersonalFileKind, type PersonalFileSource, personalFieldLabel, personalFieldOf, t, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { PersonalFileTrail } from "./events.ts";
import type { PersonalFilesService } from "./personal-files.ts";
import { READ_PERSONAL_FILE } from "./tool-names.ts";

const Params = Type.Object(
  {
    person: Type.Optional(Type.String({ description: "谁的档案：用户本人写\"我\"，别人写称呼或别名（\"妈妈\"）。不给是列出档案里有哪些人、各填了哪些字段" })),
    fields: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: "只读这几个字段（字段名，如\"身份证号\"\"住址\"）；不给是整份（字段、记下的事）" })),
  },
  { additionalProperties: false },
);

const dateOf = (iso: string | undefined) => (iso ?? "").slice(0, 10);

/** 留痕给模型看的说法 */
function sourceText(source: PersonalFileSource | PersonalFileTrail | undefined): string {
  if (source === undefined) return "设置里的「我的名字」";
  if (source.via === "page") return "用户在档案页里填的";
  if (source.via === "curator") return "记忆管理员提议、用户确认的";
  return source.basis === "explicit" ? "用户在聊天里明说的" : "用户在核对卡上确认过";
}

export function readPersonalFileTool(files: PersonalFilesService): HostTool {
  return defineHostTool({
    name: READ_PERSONAL_FILE,
    title: t("personalFiles.tool.read"),
    description: [
      "读个人档案：用户本人和用户身边重要的人各一份，里面是用户确认过的固定信息（证件号、生日、电话、住址、单位、过敏用药……，一字不差、以最新为准，旧值留作历史）和用户特意要记的事。",
      "要用到这些信息时先读它，不要凭记忆或检索素材去猜：替用户填网页表单（读出来再用网页工具填）、回答\"我的身份证号是多少\"\"我妈生日哪天\"\"我以前住哪\"。",
      "档案里没有的就照实说没有；要记进档案用 propose_quick_action 的 personal_file。",
    ].join("\n"),
    parameters: Params,
    readOnlyOrIdempotent: true,
    run: ({ person, fields }) => ({ text: forModel(() => (person === undefined ? listText(files) : fileText(files, person, fields))) }),
  });
}

/** 有哪些人、各填了哪些字段（不带值） */
function listText(files: PersonalFilesService): string {
  const lines = ["个人档案里有："];
  for (const summary of files.list().files) {
    const view = files.file(summary.id)!;
    const filled = view.fields.filter((f) => f.current !== undefined).map((f) => f.label);
    const who = summary.kind === "self" ? `我（本人${summary.name === undefined ? "" : `，姓名 ${summary.name}`}）` : `${summary.name ?? summary.id}${summary.relation === undefined ? "" : `（和用户的关系：${summary.relation}）`}`;
    lines.push(`- ${who}：${filled.length === 0 ? "还没填字段" : `填了 ${filled.join("、")}`}；记下 ${summary.notes} 件事`);
  }
  lines.push("要看值用 person（和 fields）再读一次。");
  return lines.join("\n");
}

/** 一份档案（或其中几个字段）的值：现在的、以前的（到哪天为止）、怎么写进来的；整份的另列记下的事 */
function fileText(files: PersonalFilesService, person: string, fields: readonly string[] | undefined): string {
  const ref = files.find(person);
  if (!ref) {
    const names = files.list().files.map((f) => (f.kind === "self" ? "我" : (f.name ?? f.id)));
    return `档案里没有「${person}」。现有：${names.join("、")}。要新建就用 propose_quick_action 的 personal_file 提议（用户确认后建）。`;
  }
  const view = files.file(ref.id)!;
  const kind: PersonalFileKind = view.kind;
  const relation = view.fields.find((f) => f.field === "relation")?.current?.value;
  const title = kind === "self" ? "「我」的档案（本人）" : `「${view.name ?? person}」的档案${relation === undefined ? "" : `（和用户的关系：${relation}）`}`;
  const lines = [`${title}，固定信息是用户确认过的原值：`];
  let wanted = view.fields;
  const unknown: string[] = [];
  if (fields !== undefined && fields.length > 0) {
    const present = view.fields.map((f) => f.field);
    const ids = fields.flatMap((name) => {
      const id = personalFieldOf(kind, name, present);
      if (id !== undefined && present.includes(id)) return [id];
      // 302：问"纪念日"（或者一个没有的纪念日）没对上具体哪一个，列出全部纪念日（一个都没有列那个空的）
      const anniversaries = id !== undefined && isAnniversaryField(id) ? present.filter(isAnniversaryField) : [];
      if (anniversaries.length > 0) return anniversaries;
      unknown.push(name);
      return [];
    });
    wanted = view.fields.filter((f) => ids.includes(f.field));
  }
  for (const field of wanted) {
    const label = personalFieldLabel(kind, field.field);
    if (!field.current) {
      lines.push(`- ${label}：没填`);
      continue;
    }
    const since = field.current.since === undefined ? "" : `${dateOf(field.current.since)} 起，`;
    lines.push(`- ${label}：${field.current.value}（${since}${sourceText(field.current.source)}）`);
    for (const old of field.history) lines.push(`  以前：${old.value}（${dateOf(old.since)} 到 ${dateOf(old.until)}）`);
  }
  if (unknown.length > 0) lines.push(`没有这些字段：${unknown.join("、")}（默认字段有 ${builtinFields(kind).map((f) => personalFieldLabel(kind, f)).join("、")}）`);
  if (fields === undefined || fields.length === 0) {
    lines.push(view.notes.length === 0 ? "记下的事：没有" : "记下的事：");
    for (const note of view.notes) lines.push(`- ${note.date}：${note.text}`);
  }
  return lines.join("\n");
}
