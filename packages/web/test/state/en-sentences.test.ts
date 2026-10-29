// 170 号票：英文下工具调用说成人话的一句（call-sentence、shell-sentence、sentence-parts）、浏览的 ⋮ 菜单（browse-tools）、
// 工具调用的完整内容（tool-call-storage）都是英文，没有中文；换回中文又和原来一样（常量表取值时现查，不用重建）。
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  activeLocaleFrom,
  BROWSE_DISABLED,
  browseMenu,
  callSentence,
  DEFAULT_LANGUAGE,
  findCountLabel,
  historyGroups,
  setActiveLocale,
  summarizePageText,
  TOOL_LABELS,
  toolCallCleanupText,
  toolCallStorageText,
  toolLabel,
} from "../../src/state/index.ts";
import { pathsText } from "../../src/state/sentence-parts.ts";
import { bashSentence } from "../../src/state/shell-sentence.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

/** 中文（汉字、中文标点、全角符号） */
const CJK = /[　-〿㐀-䶿一-鿿豈-﫿！-｠]/;
const MB = 1024 ** 2;
const GB = 1024 ** 3;
const say = (tool: string, argsSummary: string) => callSentence({ tool, argsSummary }).text;

beforeAll(() => setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en")));
afterAll(() => setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE)));

describe("英文下工具调用说成人话", () => {
  test("各工具的模板：动词加对象", () => {
    expect(say("read", "src/app.ts")).toBe("Read src/app.ts");
    expect(say("read", ".pi/skills/deploy/SKILL.md")).toBe('Read the instructions for skill "deploy"');
    expect(say("grep", "TODO · src")).toBe('Search src for "TODO"');
    expect(say("git_push", "remote=origin branch=main force=true")).toBe("Force-push main to origin");
    expect(say("git_commit", "message=fix login timeout")).toBe("Commit changes: fix login timeout");
    expect(say("create_reminder", "text=Buy milk inDays=1 time=09:00")).toBe('Create reminder "Buy milk": tomorrow 09:00');
    expect(say("create_reminder", "text=Call mom inMinutes=1")).toBe('Create reminder "Call mom": in 1 minute');
    expect(say("create_reminder", "text=Stand up weekday=5 time=18:00")).toBe('Create reminder "Stand up": Fri 18:00');
    expect(say("install_deps", 'packages=["lodash","react"] dev=true')).toBe("Install lodash, react (dev)");
    expect(say("show_card", 'cardIds=["c-1","c-2"]')).toBe("Put cards c-1, c-2 in chat");
    expect(say("propose_quick_action", 'type=pause_task params={"task":"t-3"}')).toBe("Pause task t-3");
    expect(say("ask_questions", 'questions=[{"question":"Which day?"},{"question":"Who?"}]')).toBe("Ask you: Which day? (2 questions)");
  });

  test("没有模板的退回：英文的工具名 · 参数值", () => {
    expect(say("submit_plan", "x=1")).toBe("Submit plan · 1");
    expect(toolLabel("read")).toBe("Read file");
    // 给秘书发消息的名字是协议包的常量（172 号票迁），别的都是英文
    const chinese = Object.entries(TOOL_LABELS).filter(([tool, label]) => tool !== "tell_secretary" && CJK.test(label));
    expect(chinese).toEqual([]);
  });

  test("通用 bash：几句用逗号接，超过三句说还有几步", () => {
    expect(bashSentence("npm test && git add . && git commit -m 'fix login'")).toBe("Run tests, Stage all changes, Commit changes: fix login");
    expect(bashSentence("git push")).toBe("Push current branch to the remote");
    expect(bashSentence("git push -f origin main")).toBe("Force-push main to origin");
    expect(bashSentence("find src -name '*.ts'")).toBe("Find *.ts in src");
    expect(bashSentence("cp a.txt b.txt c.txt dist/")).toBe("Copy a.txt, b.txt, … (3 in all) to dist/");
    expect(bashSentence("mkdir a && touch a/b && rm c && ls && pwd")).toBe("Create folder a, Create file a/b, Delete c, plus 2 more steps");
    expect(pathsText(["a", "b", "c", "d"])).toBe("a, b, … (4 in all)");
  });
});

describe("英文下的浏览菜单、工具调用的完整内容", () => {
  test("⋮ 菜单、浏览记录的分组、查找栏的计数、替用户发的那一句", () => {
    const groups = browseMenu({ url: "", title: "", side: false, text: true, tools: true, sites: {}, ownOrigin: "" });
    const items = groups.flatMap((g) => g.items);
    expect(items.map((i) => i.label)).toEqual([
      "Ask Ergo to summarize this page",
      "Save to Ergo's materials",
      "Find in page",
      "Text size",
      "Desktop site",
      "Share",
      "Open in system browser",
      "History",
      "Downloads",
      "Clear browsing data",
    ]);
    expect(items.find((i) => i.id === "find")?.disabled).toBe("No page open yet");
    expect(BROWSE_DISABLED.needsNewApp).toBe("Needs the latest App");
    const now = new Date(2026, 9, 19, 12).getTime();
    expect(historyGroups([{ url: "https://a.example", title: "A", time: now - 1000 }], now).map((g) => g.label)).toEqual(["Today"]);
    expect(findCountLabel("x", { active: 0, total: 3, done: false })).toBe("1 of 3…");
    expect(findCountLabel("x", { active: 0, total: 0, done: true })).toBe("No matches");
    expect(summarizePageText()).toBe("Summarize this page");
  });

  test("占了多大、规则、能清多少、确认框、清完：英文，单复数对", () => {
    const text = toolCallStorageText({ bytes: 312 * MB, calls: 1, cleared: 2, retentionDays: 30, maxBytes: 2 * GB, due: { calls: 3, bytes: 4 * MB, inUse: 1 } });
    expect(text.usage).toBe("312.0 MB used; full content kept for 1 call; 2 already cleared, summaries only");
    expect(text.due).toBe("3 calls can be cleared now (about 4.0 MB); 1 more has expired but is still in use, so it stays for now");
    expect(text.rule.startsWith("Kept for 30 days, up to 2 GB in total")).toBe(true);
    for (const s of [text.usage, text.rule, text.due, text.confirm ?? ""]) expect(s).not.toMatch(CJK);
    expect(toolCallCleanupText({ trigger: "manual", at: "2026-10-09T21:00:00.000+08:00", expired: 1, overLimit: 0, freedBytes: 4 * MB, keptInUse: 0, bytes: 0, calls: 0 })).toBe(
      "Cleared the full content of 1 call, freeing 4.0 MB",
    );
  });

  test("换回中文：常量表、句子跟着换", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE));
    try {
      expect(toolLabel("read")).toBe("读文件");
      expect(say("git_push", "remote=origin branch=main")).toBe("推送 main 到 origin");
      expect(bashSentence("git push")).toBe("推送当前分支到远端");
    } finally {
      setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    }
  });
});
