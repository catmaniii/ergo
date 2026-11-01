// 系统提示文件里占位符的写法、检查和填值（71 号票，system-prompts.ts）：守护进程和设置页共用。
// 写错的一律报出第几行、错在哪，不默默填空串；条件独占一行时整行去掉，所以挪进 md 之后拼出来的提示逐字不变。
import { describe, expect, it } from "vitest";
import { normalizePromptSource, parsePromptTemplate, type PromptNode, PromptValueMissing, promptIssuesText, renderPromptTemplate, type PromptTemplateSpec } from "../src/system-prompts.ts";

const SPEC: PromptTemplateSpec = { values: ["名字", "web_search"], flags: ["开着"], partials: ["片段"] };

function nodes(source: string, spec = SPEC): readonly PromptNode[] {
  const parsed = parsePromptTemplate(source, spec);
  if (!parsed.ok) throw new Error(promptIssuesText(parsed.issues));
  return parsed.nodes;
}

const render = (source: string, values: Record<string, string | boolean | undefined>, partials: Record<string, string> = {}) =>
  renderPromptTemplate(nodes(source), values, (id) => nodes(partials[id] ?? ""));

const issues = (source: string) => {
  const parsed = parsePromptTemplate(source, SPEC);
  return parsed.ok ? [] : parsed.issues.map((i) => `${i.line}:${i.message}`);
};

describe("填值", () => {
  it("值、工具名原样填进去；没有占位符的文字一字不动（JSON 例子里的单个花括号、出现在前面的 }} 都是文字）", () => {
    expect(render("用户叫你「{{名字}}」，用 {{ web_search }} 搜索", { 名字: "小美", web_search: "web_search" })).toBe("用户叫你「小美」，用 web_search 搜索");
    const json = '只输出 {"records":[{"kind":"x"}]}；没有就输出 {"records":[]}。a}}b';
    expect(render(json, {})).toBe(json);
  });

  it("条件独占一行时整行连同换行去掉；写在一行里的照样能用；^ 是不成立时才有", () => {
    const source = ["第一行", "{{#开着}}", "开着时的一段", "{{/开着}}", "{{^开着}}", "关着时的一段", "{{/开着}}", "末行：{{#开着}}能{{/开着}}{{^开着}}不能{{/开着}}联网"].join("\n");
    expect(render(source, { 开着: true })).toBe("第一行\n开着时的一段\n末行：能联网");
    expect(render(source, { 开着: false })).toBe("第一行\n关着时的一段\n末行：不能联网");
  });

  it("条件包住最后一段、不成立时不留下末尾的空行", () => {
    expect(render("前面\n{{#开着}}\n后面\n{{/开着}}", { 开着: false })).toBe("前面");
  });

  it("片段插在它那一行，里面的占位符用同一份值", () => {
    expect(render("开头\n{{> 片段}}\n结尾", { 名字: "小美" }, { 片段: "片段一 {{名字}}\n片段二" })).toBe("开头\n片段一 小美\n片段二\n结尾");
  });

  it("用到的占位符没有值、条件没给成立不成立：报错，不默默填空串", () => {
    expect(() => render("叫你{{名字}}", {})).toThrow(PromptValueMissing);
    expect(() => render("叫你{{名字}}", { 名字: undefined })).toThrow("第 1 行的 {{名字}} 没有值");
    expect(() => render("{{#开着}}x{{/开着}}", {})).toThrow("条件“开着”没有给出成立不成立");
    // 出错的是哪一份、第几行、哪个占位符：守护进程据此把那一份退回默认的
    let missing: unknown;
    try {
      renderPromptTemplate(nodes("开头\n{{> 片段}}"), {}, () => nodes("第一行\n叫你{{名字}}"), "角色");
    } catch (err) {
      missing = err;
    }
    expect(missing).toMatchObject({ source: "片段", line: 2, placeholder: "名字", flag: false });
    // 没用到的分支里的占位符可以没有值
    expect(render("{{#开着}}叫你{{名字}}{{/开着}}好", { 开着: false })).toBe("好");
  });
});

describe("检查：写错了报第几行、错在哪", () => {
  it("不认得的占位符，列出这里能填的", () => {
    expect(issues("第一行\n用 {{名子}} 称呼")).toEqual(["2:不认得的占位符 {{名子}}（这里能填的值：名字、web_search）"]);
    // 每份都能用的工具名、标记照样能填，报错时不一个个列
    const withCommon: PromptTemplateSpec = { values: ["名字"], common: ["web_search", "view_board"], flags: [], partials: [] };
    expect(parsePromptTemplate("用 {{view_board}} 查", withCommon).ok).toBe(true);
    const bad = parsePromptTemplate("用 {{veiw_board}} 查", withCommon);
    expect(bad.ok ? "" : promptIssuesText(bad.issues)).toBe("第 1 行：不认得的占位符 {{veiw_board}}（这里能填的值：名字，另有每份都能用的工具名和标记）");
  });

  it("条件当值用、值当条件用、不认得的条件", () => {
    expect(issues("{{开着}}")).toEqual(["1:“开着”是条件，要写成 {{#开着}}……{{/开着}} 或 {{^开着}}……{{/开着}}"]);
    expect(issues("{{#名字}}x{{/名字}}")).toEqual(["1:“名字”不是条件，只能写成 {{名字}}"]);
    expect(issues("{{^关着}}x{{/关着}}")).toEqual(["1:不认得的条件“关着”（这里能用的条件：开着）"]);
  });

  it("条件没配对：没结束、对不上、前面没有开头", () => {
    expect(issues("{{#开着}}\nx")).toEqual(["1:第 1 行的 {{#开着}} 没有结束：后面要有 {{/开着}}"]);
    expect(issues("x{{/开着}}")).toEqual(["1:{{/开着}} 前面没有对应的 {{#开着}} 或 {{^开着}}"]);
    expect(parsePromptTemplate("{{#开着}}{{/名字}}{{/开着}}", { ...SPEC, flags: ["开着", "名字"], values: [] }).ok).toBe(false);
  });

  it("只在某个条件成立时才有值的：写在条件外面、写在 {{^条件}} 里面都拦下，说清在什么情况下会缺", () => {
    const spec: PromptTemplateSpec = { values: ["名字", "项目类型"], flags: ["已确认", "开着"], partials: [], onlyWhen: { 项目类型: "已确认" } };
    const check = (source: string) => {
      const parsed = parsePromptTemplate(source, spec);
      return parsed.ok ? "" : promptIssuesText(parsed.issues);
    };
    const missing = "{{项目类型}} 在条件“已确认”不成立时没有值，要写在 {{#已确认}}……{{/已确认}} 里面";
    expect(check("第一行\n类型：{{项目类型}}")).toBe(`第 2 行：${missing}`);
    expect(check("{{^已确认}}类型：{{项目类型}}{{/已确认}}")).toBe(`第 1 行：${missing}`);
    expect(check("{{#已确认}}{{^已确认}}{{项目类型}}{{/已确认}}{{/已确认}}")).toBe(`第 1 行：${missing}`);
    expect(check("{{#开着}}{{项目类型}}{{/开着}}")).toBe(`第 1 行：${missing}`);
    expect(check("{{#已确认}}\n类型：{{项目类型}}\n{{/已确认}}")).toBe("");
    expect(check("{{#已确认}}{{#开着}}{{项目类型}}{{/开着}}{{/已确认}}")).toBe("");
  });

  it("不认得的片段、没写完的花括号、名字里有空白", () => {
    expect(issues("{{> 别的}}")).toEqual(["1:不认得的片段 {{> 别的}}（这里能插的片段：片段）"]);
    expect(issues("a\n用 {{名字 称呼")).toEqual(["2:“{{”没有配对的“}}”：占位符要在同一行里写完，比如 {{名字}}"]);
    expect(issues("{{名 字}}")[0]).toMatch(/^1:\{\{名 字\}\} 写得不对/);
    expect(issues("{{}}")[0]).toMatch(/^1:\{\{\}\} 写得不对/);
  });

  it("几处错按行号排，写成给人看的一段", () => {
    const parsed = parsePromptTemplate("{{甲}}\n{{乙}}", SPEC);
    expect(promptIssuesText(parsed.ok ? [] : parsed.issues)).toBe("第 1 行：不认得的占位符 {{甲}}（这里能填的值：名字、web_search）\n第 2 行：不认得的占位符 {{乙}}（这里能填的值：名字、web_search）");
  });
});

describe("读进来的文件统一成一个样子", () => {
  it("去掉 BOM、\\r\\n 换成 \\n、去掉末尾的空行（Windows 上检出、编辑器存的）", () => {
    expect(normalizePromptSource("﻿第一行\r\n第二行\r\n\r\n")).toBe("第一行\n第二行");
    expect(normalizePromptSource("一行\n")).toBe("一行");
    expect(normalizePromptSource("")).toBe("");
  });
});
