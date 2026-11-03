// skill 变更卡（ui/cards/SkillChangeCard.tsx）：负责人提的把一个 skill 加进 skill 库、改、删。用 React 在 Node 里渲染出来查：
// - 有脚本的醒目写明"里面有 N 个脚本，用它的 agent 可能会运行"，没脚本的写没有；文件清单和大小；SKILL.md 全文能展开（纯文本，不渲染）；
// - 不带的东西、依赖目录列出来；清单放不下的写还有多少；
// - 改、删的列出在用的工具包，个人助理写用户起的名字（界面上不出现字面的"秘书"）；
// - 处理完了写自检结果、配没配进工具包；批准了但没改成的写原因；没有输入框。
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { Connection } from "../../src/app/connection.ts";
import type { DaemonHttp } from "../../src/app/daemon-http.ts";
import { StoreProvider } from "../../src/app/store.tsx";
import { type Card, type CardState, type SkillChangeCardPayload } from "../../src/state/index.ts";
import { SkillChangeCard } from "../../src/ui/cards/SkillChangeCard.tsx";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const offline = { connection: {} as Connection, http: {} as DaemonHttp } as ComponentProps<typeof StoreProvider>;

const SUBMITTER = { kind: "project", projectId: "p-1", projectName: "记账本", maintainerId: "pm-1" } as const;

function adding(extra: Partial<NonNullable<SkillChangeCardPayload["source"]>> = {}, more: Partial<SkillChangeCardPayload> = {}): SkillChangeCardPayload {
  return {
    action: "add",
    name: "notes-style",
    description: "写笔记的规矩",
    why: "别的项目也用得上",
    submitter: SUBMITTER,
    source: {
      path: "D:\\work\\notes-style",
      dirName: "notes-style",
      skillMd: "---\nname: notes-style\ndescription: 写笔记的规矩\n---\n\n<b>不渲染</b>\n",
      files: [{ path: "SKILL.md", bytes: 2048 }, { path: "guide.md", bytes: 12 }],
      fileCount: 2,
      totalBytes: 2060,
      scriptCount: 0,
      excluded: [],
      linked: [],
      fingerprint: "f".repeat(64),
      ...extra,
    },
    ...more,
  };
}

function state(p: SkillChangeCardPayload, status: Card["status"], outcome?: Card["outcome"]): CardState {
  return { card: { id: "c-1", type: "skill_change", typeVersion: 1, version: status === "pending" ? 1 : 2, status, payload: p, text: "skill 变更", createdAt: "2026-11-01T10:00:00+08:00", ...(outcome ? { outcome } : {}) } } as CardState;
}

const render = (p: SkillChangeCardPayload, status: Card["status"] = "pending", outcome?: Card["outcome"]) =>
  renderToStaticMarkup(createElement(StoreProvider, offline, createElement(SkillChangeCard, { state: state(p, status, outcome), payload: p, done: status !== "pending", act: () => {} })));

describe("skill 变更卡", () => {
  test("没脚本的：名字、说明、谁提的、文件清单和大小；SKILL.md 全文能展开，当纯文本；有确认和拒绝", () => {
    const html = render(adding());
    expect(html).toContain("项目「记账本」的负责人提交的");
    expect(html).toContain("加进 skill 库");
    expect(html).toContain("<code>notes-style</code>");
    expect(html).toContain("写笔记的规矩");
    expect(html).toContain("别的项目也用得上");
    expect(html).toContain("没有脚本");
    expect(html).not.toContain("用它的 agent 可能会运行");
    expect(html).toContain("2 个文件，共 2.0 KB");
    expect(html).toContain("<code>guide.md</code>");
    expect(html).toContain("2.0 KB");
    expect(html).toContain("SKILL.md 全文");
    expect(html).toContain("&lt;b&gt;不渲染&lt;/b&gt;");
    expect(html).toContain(">确认</button>");
    expect(html).toContain(">拒绝</button>");
    expect(html).toContain("附一句话给负责人");
    expect(html).not.toContain("秘书");
  });

  test("有脚本的醒目写明，脚本标在清单里；清单放不下写还有多少；不带的东西、依赖目录列出来", () => {
    const html = render(adding({ scriptCount: 3, fileCount: 205, totalBytes: 2048 * 1024, files: [{ path: "bin/run.py", bytes: 10, script: true }], excluded: [".env", "deploy.pem"], linked: ["node_modules"] }));
    expect(html).toMatch(/class="sys-note sev-alert skill-change-scripts"[^>]*>⚠ 里面有 3 个脚本，用它的 agent 可能会运行/);
    expect(html).toContain("<code>bin/run.py</code>");
    expect(html).toContain("· 脚本");
    expect(html).toContain("还有 204 个没列出来");
    expect(html).toContain("205 个文件，共 2.0 MB");
    expect(html).toContain("没带进来");
    expect(html).toContain(".env、deploy.pem");
    expect(html).toContain("node_modules");
  });

  test("改：列出在用的、写明留旧版；删：列出在用的、写明名字留着；个人助理写用户起的名字，不写秘书", () => {
    const update = render(adding({}, { action: "update", usedBy: [{ kind: "project", title: "相册库" }, { kind: "task", title: "整理发票" }] }));
    expect(update).toContain("改库里的");
    expect(update).toContain("项目「相册库」、任务「整理发票」");
    expect(update).toContain("留一份旧版");

    const { source: _source, ...rest } = adding();
    const remove = render({ ...rest, action: "remove", usedBy: [{ kind: "project", title: "相册库" }, { kind: "assistant" }] });
    expect(remove).toContain("从库里删");
    expect(remove).toContain("项目「相册库」");
    expect(remove).toContain("名字留着");
    expect(remove).not.toContain("SKILL.md 全文");
    expect(remove).not.toContain("秘书");

    const unused = render({ ...rest, action: "remove", usedBy: [] });
    expect(unused).toContain("现在没有工具包在用它");
  });

  test("处理完了：写自检结果和配进工具包；批准了但没改成的写原因；没有输入框和按钮", () => {
    const applied = render(adding({}, { applied: true, addedToToolkit: true, check: { ok: true, time: "2026-11-01T10:01:00+08:00" } }), "handled", { action: "approve", note: "skill notes-style 进库了", at: "2026-11-01T10:01:00+08:00" } as never);
    expect(applied).toContain("自检通过");
    expect(applied).toContain("已配进提交人的工具包");
    expect(applied).not.toContain("<input");
    expect(applied).not.toContain(">确认</button>");

    const changed = render(adding({}, { applied: false, problem: "来源变了，要重新提交一张卡" }), "handled");
    expect(changed).toContain("没改成：来源变了，要重新提交一张卡");

    const refused = render(adding({}, { applied: true, addedToToolkit: false, toolkitProblem: "项目已归档", check: { ok: true, time: "t" } }), "handled");
    expect(refused).toContain("没配进提交人的工具包：项目已归档");
  });

  test("个人助理提交的：标题写它的名字（不写秘书）；它会改变什么行为、SKILL.md 全文摊开、同名检查；不列文件和来源；确认、拒绝", () => {
    const md = "---\nname: notes-style\ndescription: >-\n  写笔记的规矩\n---\n\n照着做。\n";
    const html = render(adding({ skillMd: md, files: [{ path: "SKILL.md", bytes: 60 }], fileCount: 1, totalBytes: 60 }, { submitter: { kind: "secretary" }, why: "用户让记成 skill" }));
    expect(html).toContain("二狗</span>提交的");
    expect(html).not.toContain("秘书");
    expect(html).toContain("它会改变什么行为");
    expect(html).toContain("写笔记的规矩");
    expect(html).toMatch(/<details class="skill-change-more" open=""><summary>SKILL.md 全文<\/summary><pre class="skill-change-md">---\nname: notes-style/);
    expect(html).toContain("同名检查：库里没有同名的 skill");
    expect(html).not.toContain("来源：");
    expect(html).not.toContain("没有脚本");
    expect(html).toContain(">确认</button>");
    expect(html).toContain(">拒绝</button>");
    expect(html).not.toContain(">覆盖</button>");
    expect(html).toContain("附一句话给");
  });

  test("和库里同名：写明撞上的是谁；能覆盖的有覆盖、改名、放弃，不能覆盖的写原因、没有覆盖；没有确认", () => {
    const secretary = { submitter: { kind: "secretary" } } as const;
    const taken = render(adding({}, { ...secretary, sameName: { owner: "你导入的 notes-style", overwritable: true }, usedBy: [{ kind: "project", title: "相册库" }, { kind: "assistant" }] }));
    expect(taken).toContain("同名检查：库里已经有你导入的 notes-style");
    expect(taken).toContain("旧版留一份");
    expect(taken).toContain("现在在用它的：项目「相册库」、<span class=\"assistant-name\">二狗</span>");
    expect(taken).toContain(">覆盖</button>");
    expect(taken).toContain(">改名…</button>");
    expect(taken).toContain(">放弃</button>");
    expect(taken).not.toContain(">确认</button>");
    const fixed = render(adding({}, { ...secretary, sameName: { owner: "框架自带的 notes-style", overwritable: false, problem: "notes-style 是框架自带的 skill，不能改、不能删" } }));
    expect(fixed).toContain("不能覆盖：notes-style 是框架自带的 skill，不能改、不能删");
    expect(fixed).not.toContain(">覆盖</button>");
    expect(fixed).toContain(">改名…</button>");
    expect(fixed).not.toContain("秘书");
  });

  test("个人助理提交的处理完了：覆盖了、改名进库了；配进它用的 skill；同名时放弃的写已放弃", () => {
    const secretary = { submitter: { kind: "secretary" } } as const;
    const renamed = render(adding({}, { ...secretary, sameName: { owner: "你导入的 notes-style", overwritable: true }, applied: true, resolution: "rename", renamedTo: "notes-mine", addedToToolkit: true, check: { ok: true, time: "t" } }), "handled", { action: "rename", note: "skill notes-mine 进库了", at: "t" } as never);
    expect(renamed).toContain("改名为 notes-mine 进库");
    expect(renamed).toContain("已配进<span class=\"assistant-name\">二狗</span>用的 skill，下一轮起能用");
    expect(renamed).not.toContain("提交人的工具包");
    expect(renamed).not.toContain("<input");
    const overwritten = render(adding({}, { ...secretary, applied: true, resolution: "overwrite", addedToToolkit: false, toolkitProblem: "设置文件不对", check: { ok: true, time: "t" } }), "handled");
    expect(overwritten).toContain("覆盖了库里同名的，旧版留着");
    expect(overwritten).toContain("用的 skill：设置文件不对");
    const dropped = render(adding({}, { ...secretary, sameName: { owner: "你导入的 notes-style", overwritable: true } }), "handled", { action: "deny", at: "t" } as never);
    expect(dropped).toContain("已放弃");
    expect(dropped).not.toContain("秘书");
  });

  test("任务的负责人：标题写任务；项目内部的任务带上项目", () => {
    const task = render(adding({}, { submitter: { kind: "task", taskId: "t-1", taskTitle: "整理发票", maintainerId: "tm-1" } }));
    expect(task).toContain("任务「整理发票」的负责人提交的");
    const inProject = render(adding({}, { submitter: { kind: "task", taskId: "t-1", taskTitle: "整理发票", maintainerId: "pm-1", projectId: "p-1", projectName: "记账本" } }));
    expect(inProject).toContain("项目「记账本」里任务「整理发票」的负责人提交的");
  });
});
