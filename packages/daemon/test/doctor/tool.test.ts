// 秘书的只读体检工具（409，src/doctor/tool.ts）：假的体检结果 → 工具交回的那段话——
// - 全正常：说全正常、查了几项；停用的插件说没查；
// - 有不正常的：数一数，坏了的在前、然后要注意的、没查出来的，每行写哪一块 · 哪一项：事实（从什么时候起）怎么修；不适用的不说；
// - 句子是体检拼好的（当前语言），工具原样转；工具是只读的、落在"看"那一类，调一次现查一遍。
import { DOCTOR_CORE_GROUP, type DoctorGroupView, type DoctorItemView, type DoctorLevel, type DoctorView } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { CHECK_HEALTH_TOOL, checkHealthTool, healthReport } from "../../src/doctor/tool.ts";

/** 一项：拼好的名字、事实，可选的怎么修、从什么时候起 */
function item(id: string, level: DoctorLevel, title: string, fact: string, extra: { fix?: string; since?: string } = {}): DoctorItemView {
  return { id, level, title: { key: "k" }, fact: { key: "k" }, ...(extra.since === undefined ? {} : { since: extra.since }), text: { title, fact, ...(extra.fix === undefined ? {} : { fix: extra.fix }) } };
}

function group(id: string, title: string, items: DoctorItemView[]): DoctorGroupView {
  return { id, kind: id === DOCTOR_CORE_GROUP ? "core" : "plugin", title, level: "ok", items };
}

const AT = "2026-11-07T07:30:00.000Z";

function view(groups: DoctorGroupView[], off: DoctorView["off"] = []): DoctorView {
  const counts = { error: 0, warn: 0, unknown: 0 };
  for (const g of groups) for (const i of g.items) if (i.level === "error" || i.level === "warn" || i.level === "unknown") counts[i.level] += 1;
  return { checks: [], groups, off, level: "ok", counts, at: AT };
}

describe("体检结果写成给秘书的一段话", () => {
  it("全正常：说全正常、查了几项、什么时候查的；停用的插件说没查", () => {
    const text = healthReport(view([group(DOCTOR_CORE_GROUP, "二狗本身", [item("ports", "ok", "端口", "在听")]), group("memory", "记忆", [item("plugin", "ok", "插件本身", "在跑"), item("brief", "na", "记忆简报", "关着")])], [{ plugin: "calendar", title: "日历", state: "disabled" }]));
    expect(text).toBe(`体检全正常：查了 3 项（${AT}），没有坏的、要注意的。\n停用的插件没查：日历。`);
  });

  it("有不正常的：先数，坏了的在前、然后要注意的、没查出来的；每行是哪一块 · 哪一项：事实（从什么时候起）怎么修；不适用的不说", () => {
    const text = healthReport(
      view([
        group(DOCTOR_CORE_GROUP, "二狗本身", [item("ports", "ok", "端口", "在听"), item("model", "error", "模型的 Key", "还没配 Key", { fix: "去设置 · 模型填一个" })]),
        group("looki", "Looki", [item("source:looki", "warn", "数据源：Looki", "85 小时没同步成功了", { since: "2026-11-04T02:30:00+08:00", fix: "点立即同步" })]),
        group("voice", "语音", [item("speech", "unknown", "语音合成", "这次没查出来：1.5 秒内没查完"), item("reply", "na", "语音回复", "关着")]),
      ]),
    );
    expect(text.split("\n")).toEqual([
      `体检结果（${AT}）：查了 5 项，1 项坏了、1 项要注意、1 项这次没查出来。不正常的是这些：`,
      "- [坏了] 二狗本身 · 模型的 Key：还没配 Key 怎么修：去设置 · 模型填一个",
      "- [要注意] Looki · 数据源：Looki：85 小时没同步成功了（从 2026-11-04T02:30:00+08:00 起） 怎么修：点立即同步",
      "- [这次没查出来] 语音 · 语音合成：这次没查出来：1.5 秒内没查完",
      `照"怎么修"告诉用户，坏了的先说；这些要用户自己去做（设置 · 体检那一页有按钮），你没有修它们，别说已经修好了。`,
    ]);
    expect(text).not.toContain("语音回复");
  });

  it("工具：名字是 check_health，只读、落在\"看\"那一类；调一次现查一遍，交回那段话", async () => {
    let calls = 0;
    const tool = checkHealthTool({
      view: async () => {
        calls += 1;
        return view([group(DOCTOR_CORE_GROUP, "二狗本身", [item("disk", "error", "磁盘空间", "只剩 0.5 GB")])]);
      },
    });
    expect(tool.spec.name).toBe(CHECK_HEALTH_TOOL);
    expect(tool.descriptor).toMatchObject({ name: "check_health", readOnlyOrIdempotent: true, nature: "look" });
    const out = await tool.run({}, { toolCallId: "t-1" } as never);
    expect(calls).toBe(1);
    expect(out.text).toContain("- [坏了] 二狗本身 · 磁盘空间：只剩 0.5 GB");
    expect(out.isError).toBeUndefined();
  });
});
