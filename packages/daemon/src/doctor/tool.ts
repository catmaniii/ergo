// 秘书的只读体检工具（409）：用户说"二狗你自己体检一下""你哪里不对劲"时，秘书调 check_health 现查一遍（和设置 · 体检那一页
// 同一份 DoctorView，平时体检那一档：不联网、不调模型），交回不正常的项——哪一块、哪一项、查出来的事实、怎么修
// （句子是体检按当前语言拼好的，和页面上一个字不差）；全正常就说全正常。坏了的在前，然后是要注意的、这次没查出来的；
// "不适用"的不说。只读：不改任何东西，落在"看"那一类（nature: look）。修要用户自己去做（页面上有按钮），工具不修。
// @i18n-ignore-file model：工具的说明和结果的框架给秘书（模型）看；每项的句子是体检按当前语言拼好的；工具的名字走 t()
import { type DoctorGroupView, type DoctorItemView, type DoctorLevel, type DoctorView, t, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { DoctorService } from "./doctor.ts";

/** 工具名（秘书的工具清单、测试里引用） */
export const CHECK_HEALTH_TOOL = "check_health";

/** 给模型看的几种结果的叫法 */
const LEVEL_WORD: Readonly<Record<"error" | "warn" | "unknown", string>> = { error: "坏了", warn: "要注意", unknown: "这次没查出来" };

/** 不正常的先后：坏了、要注意、没查出来 */
const REPORTED: readonly DoctorLevel[] = ["error", "warn", "unknown"];

/** 一项写成一行：[几级] 哪一块 · 哪一项：事实。怎么修：……（从什么时候起） */
function itemLine(group: DoctorGroupView, item: DoctorItemView): string {
  const level = LEVEL_WORD[item.level as keyof typeof LEVEL_WORD];
  const since = item.since === undefined ? "" : `（从 ${item.since} 起）`;
  const fix = item.text.fix === undefined ? "" : ` 怎么修：${item.text.fix}`;
  return `- [${level}] ${group.title} · ${item.text.title}：${item.text.fact}${since}${fix}`;
}

/** 体检结果写成给秘书的一段话：全正常说全正常；不然列出不正常的项（坏了的在前），末尾说停用的插件没查 */
export function healthReport(view: DoctorView): string {
  const total = view.groups.reduce((n, group) => n + group.items.length, 0);
  const off = view.off.length === 0 ? "" : `\n停用的插件没查：${view.off.map((p) => p.title).join("、")}。`;
  const { error, warn, unknown } = view.counts;
  if (error + warn + unknown === 0) return `体检全正常：查了 ${total} 项（${view.at}），没有坏的、要注意的。${off}`;
  const lines = REPORTED.flatMap((level) => view.groups.flatMap((group) => group.items.filter((item) => item.level === level).map((item) => itemLine(group, item))));
  return [
    `体检结果（${view.at}）：查了 ${total} 项，${error} 项坏了、${warn} 项要注意、${unknown} 项这次没查出来。不正常的是这些：`,
    ...lines,
    `照"怎么修"告诉用户，坏了的先说；这些要用户自己去做（设置 · 体检那一页有按钮），你没有修它们，别说已经修好了。${off}`,
  ].join("\n");
}

/** 秘书的"体检一下"：现查一遍，交回 healthReport 的那段话 */
export function checkHealthTool(doctor: Pick<DoctorService, "view">): HostTool {
  return defineHostTool({
    name: CHECK_HEALTH_TOOL,
    title: t("doctor.tool.title"),
    description:
      "给二狗自己做一次体检（和设置 · 体检那一页同一份：二狗本身和每个插件各查一遍，只读本机，不联网、不调模型、不改东西，几秒内回来）。" +
      "用户让你体检一下、问二狗哪里不对劲、为什么慢或者用不了时用。交回不正常的项：哪一块、哪一项、查出来的事实、怎么修；全正常就说全正常。只读。",
    parameters: Type.Object({}, { additionalProperties: false }),
    readOnlyOrIdempotent: true,
    nature: "look",
    run: async () => ({ text: healthReport(await doctor.view()) }),
  });
}
