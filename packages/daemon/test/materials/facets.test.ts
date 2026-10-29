// 记忆 · 素材按种类筛（167 号票）：给用户看的几种（说过的话、做过的、附件、语音、存的网页、数据源（303 号票）、记忆命令）怎么从素材认出来。
// 一条可以同时算几种；每条素材至少算一种（不然筛哪种都看不到它）。
import { MATERIAL_FACETS, SAVED_WEB_PAGE_CONTEXT } from "@ergo/protocol";
import { describe, expect, test } from "vitest";
import { materialFacets, matchesFacets } from "../../src/materials/facets.ts";
import { MATERIAL_KINDS, MATERIAL_MODE, type Material, type MaterialSegment } from "../../src/materials/types.ts";

const seg = (form: MaterialSegment["form"], source: MaterialSegment["source"] = "self"): MaterialSegment => ({ form, source, notes: [], locator: {} });

function material(kind: Material["kind"], segments: MaterialSegment[], context: string[] = []): Pick<Material, "kind" | "mode" | "context" | "segments"> {
  return { kind, mode: MATERIAL_MODE[kind], context, segments };
}

describe("种类", () => {
  test.each([
    ["打的字", material("user_utterance", [seg("typed")]), ["said"]],
    ["打的字加引用块", material("user_utterance", [seg("quote", "external_untrusted"), seg("typed")]), ["said"]],
    ["只发了附件", material("user_utterance", [seg("attachment", "external_untrusted")], ["secretary", "with_attachment"]), ["attachment"]],
    ["说了话还发了附件", material("user_utterance", [seg("attachment", "external_untrusted"), seg("typed")]), ["said", "attachment"]],
    ["语音转写", material("user_utterance", [seg("voice")], ["secretary", "voice_transcript"]), ["voice"]],
    ["回答提问卡", material("clarification_answer", [seg("choice"), seg("typed")]), ["said"]],
    ["作为材料投喂的文件", material("fed_material", [seg("attachment", "external_untrusted")]), ["attachment"]],
    ["作为材料投喂的一段话", material("fed_material", [seg("typed")]), ["said"]],
    ["存的网页", material("fed_material", [seg("web_page", "external_untrusted")], [SAVED_WEB_PAGE_CONTEXT]), ["web_page"]],
    ["审批决定", material("approval_decision", [seg("choice"), seg("typed")]), ["did"]],
    ["对产出的反应", material("output_reaction", [seg("choice")]), ["did"]],
    ["关掉一张卡", material("avoidance_signal", [seg("agent_output", "agent")]), ["did"]],
    ["卡一直没处理", material("avoidance_signal", [seg("agent_output", "agent")], ["stale"]), ["did"]],
    ["任务结局", material("task_outcome", [seg("choice")]), ["did"]],
    ["记住", material("memory_command", [seg("typed")]), ["memory_command"]],
    ["忘掉几条", material("memory_command", [seg("choice")]), ["memory_command"]],
    // 303 号票：数据源导入的三种都算"数据源"；观察到的本人行为也算做过的、本人写的也算说过的话，别人写给你的不算你说的
    ["数据源：观察到的本人行为", material("observed_behavior", [seg("text")]), ["did", "data_source"]],
    ["数据源：别人写给你的", material("received_writing", [seg("quote", "external_untrusted")]), ["data_source"]],
    ["数据源：本人写的", material("own_writing", [seg("typed")]), ["said", "data_source"]],
  ])("%s", (_name, m, facets) => {
    expect(materialFacets(m)).toEqual(facets);
  });

  test("每种素材都至少算一种（连一段都没有的也算），算的都是认得的种类", () => {
    const none: string[] = [];
    const unknown: string[] = [];
    for (const kind of MATERIAL_KINDS) {
      for (const segments of [[], ...(["typed", "attachment", "voice", "agent_output", "choice", "quote", "text"] as const).map((form) => [seg(form)])]) {
        const facets = materialFacets(material(kind, segments));
        const label = `${kind} ${segments[0]?.form ?? "（没有段）"}`;
        if (facets.length === 0) none.push(label);
        if (!facets.every((f) => (MATERIAL_FACETS as readonly string[]).includes(f))) unknown.push(label);
      }
    }
    expect(none).toEqual([]);
    expect(unknown).toEqual([]);
  });
});

describe("按种类筛", () => {
  const both = material("user_utterance", [seg("attachment", "external_untrusted"), seg("typed")]);
  test("算其中任一种就行；不筛（没给、空的）都留下", () => {
    expect(matchesFacets(both, ["attachment"])).toBe(true);
    expect(matchesFacets(both, ["said"])).toBe(true);
    expect(matchesFacets(both, ["voice", "web_page"])).toBe(false);
    expect(matchesFacets(both, ["voice", "said"])).toBe(true);
    expect(matchesFacets(both, [])).toBe(true);
    expect(matchesFacets(both, undefined)).toBe(true);
  });
});
