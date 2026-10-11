// 工具调用说成人话的一句（67 号票，state/call-sentence.ts、shell-sentence.ts）：照 AgentSense 每个场景的 describe。
// 表格测试：每个模板至少一条，含参数缺失（退回"中文名 · 参数值"）、路径很长时只留末尾几级；通用 bash 按拆出来的命令说；
// 要点层的前缀（⛔ ↩ ⏸ ✕）和 🔒；最后回放现有录像：有模板的工具调用都说成了人话，没有模板的退回原样。
import fs from "node:fs";
import path from "node:path";
import { MessageEventPayload as MessageEventPayloadSchema, schemaChecker } from "@ergou/protocol";
import { describe, expect, test } from "vitest";
import {
  callKeyLine,
  callSentence,
  chatItems,
  detailContent,
  type EventFrame,
  fallbackLine,
  hasCallTemplate,
  type MessageEnvelope,
  type MessagePart,
  replay,
  shortPath,
  shortUrl,
  summaryArgs,
  TOOL_LABELS,
  toolLabel,
  type UiInput,
  zoomBlocks,
} from "../../src/state/index.ts";
import { bashSentence } from "../../src/state/shell-sentence.ts";
import { frame } from "./events.ts";

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const say = (tool: string, argsSummary: string) => callSentence({ tool, argsSummary }).text;

const LONG_WIN = "D:\\code\\claudecode\\my_personal_agent_ergou\\packages\\web\\src\\state\\chat-items.ts";
const LONG_POSIX = "/home/me/projects/ergou/packages/daemon/src/guard-runtime/tool-call-record.ts";
const HASH = "3f9a1c2b4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8";

describe("每个模板（照 AgentSense describe：动词加对象，不带“了”）", () => {
  test.each([
    // 文件工具：摘要就是路径（搜索是"模式 · 路径"）
    ["read", "src/app.ts", "读 src/app.ts"],
    ["read", LONG_WIN, "读 …\\packages\\web\\src\\state\\chat-items.ts"],
    ["read", "C:/Users/me/.ergou/skills/mp-tdd/SKILL.md", "读 skill「mp-tdd」的说明"],
    ["write", "notes.md", "写 notes.md"],
    ["write", LONG_POSIX, "写 …/src/guard-runtime/tool-call-record.ts"],
    ["edit", "<临时目录>\\ergou-data-6VUPP7\\projects\\p-1\\progress.md", "改 …\\projects\\p-1\\progress.md"],
    ["ls", "src", "列出 src"],
    ["ls", "", "列出当前目录"],
    ["ls", "limit=5", "列出当前目录"],
    ["grep", "TODO · src", "在 src 里搜「TODO」"],
    ["grep", "TODO", "搜「TODO」"],
    ["find", "*.ts · packages", "在 packages 里找 *.ts"],
    ["find", "*.md", "在当前目录里找 *.md"],
    // 通用 bash（按拆出来的命令，下面另有一组）
    ["bash", "npm test", "跑测试"],
    // 带类型的特殊 bash 工具（28 号票）：摘要是"参数名=值"
    ["git_status_diff", "", "看 git 状态和改动"],
    ["git_status_diff", 'paths=["src/a.ts"]', "看 src/a.ts 的 git 状态和改动"],
    ["git_commit", "message=修复登录超时", "把改动提交：修复登录超时"],
    ["git_commit", 'repoPath=. message=只提交文档 paths=["README.md","docs/dev.md","CONTEXT.md"]', "把 README.md、docs/dev.md 等 3 个 提交：只提交文档"],
    ["git_merge", "branch=feature", "合并分支 feature"],
    ["git_push", "remote=origin", "推送当前分支到 origin"],
    ["git_push", "remote=origin branch=main", "推送 main 到 origin"],
    ["git_push", "remote=origin force=true", "强推当前分支到 origin"],
    ["git_push", "remote=origin branch=old delete=true", "删除 origin 上的分支 old"],
    ["create_remote_repo", "name=demo description=演示仓库", "建远端仓库 demo：演示仓库"],
    ["create_remote_repo", "name=me/site visibility=public", "建远端仓库 me/site（公开）"],
    ["run_tests", "", "跑测试"],
    ["run_tests", 'args=["--fail"]', "跑测试（--fail）"],
    ["install_deps", 'packages=["left-pad@^1.3.0"]', "装依赖 left-pad@^1.3.0"],
    ["install_deps", 'packages=["vitest"] dev=true', "装依赖 vitest（开发依赖）"],
    ["install_deps", "", "装依赖"],
    ["start_build", "", "构建"],
    // 联网（70 号票）：摘要是查询词、网址
    ["web_search", "ergou 二狗 发布", "联网搜「ergou 二狗 发布」"],
    ["web_fetch", "https://example.com/blog/post-12", "读网页 example.com/blog/post-12"],
    ["web_fetch", "https://news.example.com/2026/10/10/a-long-article-about-agents?ref=rss", "读网页 news.example.com/…/a-long-article-about…"],
    // 提醒
    ["create_reminder", "text=交报告 inDays=1 time=09:00", "建提醒「交报告」：明天 09:00"],
    ["create_reminder", 'text=打卡 time=09:00 repeat={"kind":"workdays"}', "建提醒「打卡」：按我的工作日 09:00"],
    ["create_reminder", 'text=交周报 time=17:00 repeat={"kind":"weekly","weekdays":[5]}', "建提醒「交周报」：每周五 17:00"],
    ["create_reminder", "text=开会 at=2026-10-12 15:00", "建提醒「开会」：2026-10-12 15:00"],
    ["create_reminder", "text=喝水 inMinutes=30", "建提醒「喝水」：30 分钟后"],
    ["create_reminder", "text=下班 weekday=5 time=18:00", "建提醒「下班」：周五 18:00"],
    ["update_reminder", "reminderId=r-3 time=10:00", "改提醒 r-3：时间改到 10:00"],
    ["update_reminder", "reminderId=r-3 text=交周报", "改提醒 r-3：内容改成「交周报」"],
    ["cancel_reminder", "reminderId=r-3", "取消提醒 r-3"],
    // 看板、待办（界面上不说"待我处理"，43 号票）
    ["view_board", "", "查看板"],
    ["list_inbox", "", "看待办"],
    ["show_card", 'cardIds=["c-1","c-2"]', "把卡片 c-1、c-2 放进聊天"],
    // 项目档案
    ["read_project_records", "project=记账本", "读项目档案「记账本」"],
    ["read_project_records", 'project=p-1 docs=["charter","progress"]', "读项目档案「p-1」：立项书、进展"],
    ["suggest_project", "name=记账本 goal=把家里的账管起来", "建议立项「记账本」：把家里的账管起来"],
    // 附件和素材
    ["read_attachment", `ref=${HASH}`, "读附件 3f9a1c2b"],
    ["send_attachment", "path=out/report.pdf", "把 out/report.pdf 作为附件发出"],
    ["send_attachment", "path=out/r.pdf name=九月报销单.pdf", "把 九月报销单.pdf 作为附件发出"],
    ["search_materials", "query=房东 卖房", "检索素材「房东 卖房」"],
    // 86 号票：发语音写口语稿的前 20 个字
    ["send_voice", "text=明早九点开会。", "发语音：明早九点开会。"],
    ["send_voice", "text=好的，我把这周的周报整理好了，下面分几块说清楚。", "发语音：好的，我把这周的周报整理好了，下面分几…"],
    // 快速动作（记忆命令、任务控制、日历：改工作日历）
    ["propose_quick_action", 'type=remember params={"content":"我对花生过敏"} explicit=true', "记住：我对花生过敏"],
    ["propose_quick_action", 'type=purge params={"materialIds":["mat-1"]}', "彻底删除 1 条素材"],
    ["propose_quick_action", 'type=pause_task params={"task":"t-3"}', "暂停任务 t-3"],
    ["propose_quick_action", 'type=workday_calendar params={"change":"mark_rest","date":"2026-10-12"}', "改工作日历：把 2026 年 10 月 12 日（周一）标为休息"],
    ["propose_quick_action", 'type=workday_calendar params={"change":"add_rule","rule":{"kind":"last_weekday","weekday":6}}', "改工作日历：加一条额外上班规则：每月最后一个周六"],
    ["propose_quick_action", "type=something_new params={}", "提议快速动作：something_new"],
    // 82 号票：/流程、/任务 调出来的发起
    ["start_workflow", "title=周报 summary=每周五把周报写好", "发起流程「周报」"],
    ["create_task", "title=X 的调研 summary=帮我整理一份 X 的调研", "发起长程任务「X 的调研」"],
    ["delegate_task", "title=整理九月发票 instructions=把草稿区里的发票按月汇总", "交给后台做「整理九月发票」"],
    ["suggest_task", "title=整理发票 why=你提了三次发票", "建议发起任务「整理发票」"],
    ["ask_questions", 'taskId=t-1 questions=[{"question":"调研给谁看？","options":["自己","团队"],"recommended":"自己"}]', "向你提问：调研给谁看？"],
    ["write_task_brief", 'taskId=t-1 goal=整理一份 X 的调研 acceptanceCriteria=["覆盖三种主流方案"]', "写任务书 t-1：整理一份 X 的调研"],
  ])("%s「%s」→ %s", (tool, summary, expected) => {
    expect(callSentence({ tool, argsSummary: summary })).toEqual({ text: expected, said: true });
  });

  test("参数缺失、写法不对、彻底删除过的：退回“中文名 · 参数值”", () => {
    expect(callSentence({ tool: "read", argsSummary: "" })).toEqual({ text: "读文件", said: false });
    expect(say("read", "offset=10 limit=5")).toBe("读文件 · 10 · 5");
    expect(say("grep", "")).toBe("搜索文件内容");
    expect(say("git_commit", "repoPath=.")).toBe("git 提交 · .");
    expect(say("git_push", "branch=main")).toBe("git 推送 · main");
    expect(say("create_reminder", "time=09:00")).toBe("建简单提醒 · 09:00");
    expect(say("cancel_reminder", "")).toBe("取消简单提醒");
    expect(say("send_voice", "")).toBe("发语音");
    expect(say("web_fetch", "not a url")).toBe("读网页 · not a url");
    expect(say("web_search", "n=5 engine=bing")).toBe("联网搜索 · 5 · bing");
    expect(say("search_materials", "（这条内容已彻底删除）")).toBe("检索素材 · （这条内容已彻底删除）");
    expect(say("read", "（这条内容已彻底删除）")).toBe("读文件 · （这条内容已彻底删除）");
    // 旧写法（不是"参数名=值"）的摘要不硬拆
    expect(say("git_commit", "rules: 外卖单独成类")).toBe("git 提交 · rules: 外卖单独成类");
  });
});

describe("通用 bash：按拆出来的命令说", () => {
  test.each([
    ["ls", "列出当前目录"],
    ['mkdir -p "<临时目录>/ergou-out-udvTAq/s1"', "建目录 <临时目录>/ergou-out-udvTAq/s1"],
    ["git push --force-with-lease origin main", "强推 main 到 origin"],
    ["git status && git diff", "看 git 状态，看改动"],
    ['npm run build && git add . && git commit -m "修复登录超时"', "构建，暂存全部改动，把改动提交：修复登录超时"],
    ["git commit --amend -m '改个说明'", "改上一次提交：改个说明"],
    ["git checkout -b feat/x", "新建分支 feat/x"],
    ["git pull", "从远端拉取"],
    ["cd app && npm test", "跑测试"],
    ["cd src", "进入 src"],
    ["sleep 3", "等 3 秒"],
    ["python calc_reimburse.py invoice-0927.json --rate 0.85", "运行 calc_reimburse.py"],
    ["python -m pytest -q", "跑测试"],
    ['node -e "console.log(1)"', "运行内联脚本"],
    ["./scripts/deploy.sh prod", "运行 ./scripts/deploy.sh"],
    ["node scripts/migrate-posts.mjs --from hexo --to astro", "运行 scripts/migrate-posts.mjs"],
    ["ls /示例/网盘/手机备份 | wc -l", "列出 /示例/网盘/手机备份"],
    ["cat a.txt | grep x | head -5", "读 a.txt"],
    ["head -n 20 README.md", "读 README.md"],
    ["rm -rf build dist", "删除 build、dist"],
    [`rm ${LONG_POSIX}`, "删除 …/src/guard-runtime/tool-call-record.ts"],
    ["cp -r a b c/", "把 a、b 复制到 c/"],
    ["mv old.txt new.txt", "把 old.txt 移到 new.txt"],
    ["rsync -av --delete /示例/相册/ 示例备份机:/相册/", "把 /示例/相册/ 同步到 示例备份机:/相册/"],
    ['grep -rn "TODO" src', "在 src 里搜「TODO」"],
    ["find . -name '*.log'", "在 . 里找 *.log"],
    ["curl -X POST https://api.example.com/v1/items -d @a.json", "发 POST 请求到 api.example.com/v1/items"],
    ["curl -s https://example.com", "请求 example.com"],
    ["wget https://example.com/a.zip", "下载 example.com/a.zip"],
    ['echo "hi" > out.txt', "写 out.txt"],
    ["python gen.py >> log.txt 2>&1", "运行 gen.py，追加到 log.txt"],
    ["npx vitest run --project web", "跑测试"],
    ["pnpm lint", "检查代码（lint）"],
    ["pip install requests", "装依赖 requests"],
    ["FOO=1 sudo npm ci", "装依赖"],
    ["tar -xzf site.tar.gz", "解包 site.tar.gz"],
    ["foo --bar && npm test", "运行 foo，跑测试"],
    ["git status; git log; git diff; npm test; npm run build", "看 git 状态，看提交记录，看改动，还有 2 步"],
  ])("%s → %s", (command, expected) => {
    expect(bashSentence(command)).toBe(expected);
    expect(callSentence({ tool: "bash", argsSummary: command })).toEqual({ text: expected, said: true });
  });

  test("整条都认不出、只有不值得说的：退回“通用 bash · 命令”", () => {
    expect(bashSentence("foo --bar")).toBeUndefined();
    expect(say("bash", "foo --bar")).toBe("通用 bash · foo --bar");
    expect(say("bash", "echo hi")).toBe("通用 bash · echo hi");
    expect(say("bash", "cd app && foo")).toBe("通用 bash · cd app && foo");
    expect(say("bash", "")).toBe("通用 bash");
    // 命令原文本来就是值，开头的环境变量赋值不当成"参数名="拆
    expect(say("bash", "X=1 foo --bar")).toBe("通用 bash · X=1 foo --bar");
    expect(say("grep", "a=b · src")).toBe("在 src 里搜「a=b」");
  });
});

describe("没有模板的：中文名 · 参数值，截到 60 字（用户 2026-10-10 定，三处统一）", () => {
  test("参数摘要里的“参数名=”去掉，几个值用 · 隔开；MCP 工具写原名", () => {
    expect(callSentence({ tool: "submit_receipt", argsSummary: "outcome=done summary=加好了 export.md" })).toEqual({ text: "交回执 · done · 加好了 export.md", said: false });
    expect(say("mcp__github__create_issue", "title=登录超时 repo=me/app")).toBe("mcp__github__create_issue · 登录超时 · me/app");
    expect(say("mcp__demo__ping", "")).toBe("mcp__demo__ping");
    expect(say("dispatch_work_order", "→ 相册库 W-21：扫描重复照片")).toBe("派工单 · → 相册库 W-21：扫描重复照片");
  });

  test("截到 60 字（截掉的用“…”顶最后一个字）", () => {
    const line = fallbackLine("mcp__notes__append", `text=${"很长的一段笔记".repeat(12)}`);
    expect(line).toHaveLength(60);
    expect(line.startsWith("mcp__notes__append · 很长的一段笔记")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
  });

  test("中文名照守护进程登记的 title；没登记的写原名", () => {
    expect([toolLabel("read"), toolLabel("git_push"), toolLabel("web_fetch"), toolLabel("create_reminder"), toolLabel("mcp__x__y")]).toEqual(["读文件", "git 推送", "读网页", "建简单提醒", "mcp__x__y"]);
    // 有模板的工具都有中文名（退回时要用）
    for (const tool of ["read", "write", "edit", "ls", "grep", "find", "bash", "git_commit", "web_search", "view_board", "search_materials", "start_workflow", "create_task"]) {
      expect(Object.hasOwn(TOOL_LABELS, tool)).toBe(true);
    }
  });
});

describe("小零件", () => {
  test("长路径只留末尾几级，前面写“…/”（反斜杠的路径写“…\\”）；最后一级自己就太长的留它的末尾", () => {
    expect(shortPath("src/app.ts")).toBe("src/app.ts");
    expect(shortPath(LONG_POSIX)).toBe("…/src/guard-runtime/tool-call-record.ts");
    expect(shortPath(LONG_POSIX).length).toBeLessThanOrEqual(40);
    expect(shortPath(LONG_WIN)).toBe("…\\packages\\web\\src\\state\\chat-items.ts");
    const name = `${"x".repeat(50)}.md`;
    expect(shortPath(`/tmp/${name}`)).toBe(`…${name.slice(name.length - 39)}`);
    expect(shortPath(`/tmp/${name}`)).toHaveLength(40);
  });

  test("网址去掉 http(s)://，太长时留主机名和最后一级", () => {
    expect(shortUrl("https://example.com/")).toBe("example.com");
    expect(shortUrl("https://example.com/a/b/c/d/e/f/g/h/i/j/k/l/m/post-12?x=1#top")).toBe("example.com/…/post-12");
  });

  test("参数摘要按参数名拆：只在给的名字处断开，第一个必须从开头起", () => {
    expect(summaryArgs("text=周五 开会 to=张三", ["text", "to"])).toEqual({ text: "周五 开会", to: "张三" });
    // 值里有空格加别的名字=，不在名单里就不断开
    expect(summaryArgs("text=a b=c d", ["text"])).toEqual({ text: "a b=c d" });
    expect(summaryArgs("src/app.ts", ["path"])).toEqual({});
    expect(summaryArgs("x y=1", ["y"])).toEqual({});
  });
});

// ───────────────────────── 要点层的前缀和 🔒 ─────────────────────────

const part = (o: Partial<ToolCallPart> = {}): ToolCallPart => ({
  type: "tool_call",
  callId: "c",
  tool: "write",
  argsSummary: "notes.md",
  categoryTitles: [],
  disposition: "do",
  withinGrant: false,
  genericBash: false,
  outcome: "done",
  ...o,
});

describe("要点层那一行：前缀照 AgentSense keyLine 的四种，读了密钥文件的加 🔒（用户 2026-10-10 定）", () => {
  test.each([
    ["顺利执行", part(), "写 notes.md"],
    ["被拦下（硬拒绝）", part({ outcome: "blocked", blockedBy: "hard_refusal" }), "⛔ 写 notes.md"],
    ["被拦下（判定出错）", part({ outcome: "blocked", blockedBy: "judge_error" }), "⛔ 写 notes.md"],
    ["被拦下（计划检查拦下）", part({ outcome: "blocked", blockedBy: "plan_check" }), "⛔ 写 notes.md"],
    ["被拦下（交给我做没执行）", part({ outcome: "blocked", disposition: "hand_to_me" }), "⛔ 写 notes.md"],
    ["按规则退回是拉回", part({ outcome: "blocked", blockedBy: "pull_back" }), "↩ 写 notes.md"],
    ["等你批准", part({ outcome: "blocked", disposition: "ask_first", categoryTitles: ["越出项目目录"] }), "⏸ 写 notes.md"],
    ["你拒绝了", part({ outcome: "denied", disposition: "ask_first" }), "✕ 写 notes.md"],
    ["按计划引回不加", part({ outcome: "blocked", blockedBy: "plan_redirect" }), "写 notes.md"],
    ["问过你不加", part({ disposition: "ask_first", categoryTitles: ["越出项目目录"] }), "写 notes.md"],
    ["出错不加", part({ outcome: "error" }), "写 notes.md"],
    ["读了密钥文件", part({ tool: "read", argsSummary: ".env", readsSecretFile: true }), "🔒 读 .env"],
    ["没有模板的同样加前缀", part({ tool: "mcp__x__send", argsSummary: "to=张三", outcome: "denied", disposition: "ask_first" }), "✕ mcp__x__send · 张三"],
  ])("%s", (_name, p, expected) => {
    expect(callKeyLine(p)).toBe(expected);
  });
});

// ───────────────────────── 回放现有录像 ─────────────────────────

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

/** 录像里出现过的每次工具调用 */
function recordedCalls(): { recording: string; part: ToolCallPart }[] {
  const out: { recording: string; part: ToolCallPart }[] = [];
  const walk = (recording: string, v: unknown) => {
    if (Array.isArray(v)) for (const x of v) walk(recording, x);
    else if (typeof v === "object" && v !== null) {
      const o = v as Record<string, unknown>;
      if (o.type === "tool_call" && typeof o.tool === "string") out.push({ recording, part: o as unknown as ToolCallPart });
      else for (const x of Object.values(o)) walk(recording, x);
    }
  };
  const dir = path.join(import.meta.dirname, "recordings");
  for (const name of fs.readdirSync(dir)) walk(name, JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
  return out;
}

describe("回放现有录像：工具调用的那一行都换成了人话，没有模板的退回原样", () => {
  test("有模板的都说成了人话（彻底删除过的除外）；没有模板的退回“中文名 · 参数值”", () => {
    const calls = recordedCalls();
    expect(calls.length).toBeGreaterThan(100);
    const wrong = calls.flatMap(({ recording, part: p }) => {
      const s = callSentence(p);
      if (p.argsSummary === "（这条内容已彻底删除）") return s.said ? [`${recording} ${p.tool}：彻底删除过的不该说成人话`] : [];
      if (hasCallTemplate(p.tool)) return s.said ? [] : [`${recording} ${p.tool}「${p.argsSummary}」没说成人话：${s.text}`];
      return !s.said && s.text === fallbackLine(p.tool, p.argsSummary) && s.text.startsWith(toolLabel(p.tool)) ? [] : [`${recording} ${p.tool}：退回的不对（${s.text}）`];
    });
    expect(wrong).toEqual([]);
    // 录像里有的工具：有模板的说成了人话，没有模板的（内部工具、工单的工具……）退回
    const tools = new Set(calls.map((c) => c.part.tool));
    expect([...tools].filter((t) => !hasCallTemplate(t)).toSorted()).toEqual([
      "complete_stage", "dispatch_work_order", "mark_infeasible", "propose_parallel", "propose_plan", "propose_plan_change", "report_progress",
      "report_step", "request_toolkit_change", "revise_plan", "spoken_summary", "submit_charter", "submit_plan", "submit_receipt",
      "summarize_receipts", "write_progress", "write_segment_summary",
    ]);
  });

  test("timeline-zoom：缩小后每一块的要点层那一行", () => {
    const items = chatItems(replay(load("timeline-zoom")), "maintainer:tm-1");
    const lines = items.flatMap(zoomBlocks).map((b) => b.keyLine);
    expect(lines.map((l) => l.replace(/ergou-home-\w+/, "ergou-home-*"))).toEqual([
      "写 notes.md",
      "列出当前目录",
      "建目录 <临时目录>/ergou-home-*/notes",
      "把改动提交：整理笔记",
      "读 <临时目录>\\ergou-home-*\\readme.txt",
      "写 report.md",
      "⛔ 写 <临时目录>\\ergou-home-*\\outside.md",
    ]);
  });

  test("typed-shell-tools：组的头上写中文名，组的详情里每一步、单次调用的详情是那一句", () => {
    const state = replay(load("typed-shell-tools"));
    const items = chatItems(state, "maintainer:tm-1");
    const groups = items.filter((it) => it.kind === "tool_group");
    const d = detailContent(state, items, { type: "item", id: groups[1]!.id });
    if (d.kind !== "tool_group") throw new Error("应当是组");
    expect(d.title).toBe("调用了 5 个工具：建远端仓库、git 推送 ×2、跑测试 ×2（2 次被拦下、1 次出错、1 次问过你）");
    const calls = d.steps.flatMap((s) => (s.kind === "call" ? [s.call] : []));
    expect(calls.map((c) => [c.sentence, c.said, c.label])).toEqual([
      ["建远端仓库 demo：演示仓库", true, "建远端仓库"],
      ["推送当前分支到 origin", true, "git 推送"],
      ["跑测试（--fail）", true, "跑测试"],
      ["推送当前分支到 origin", true, "git 推送"],
      ["跑测试", true, "跑测试"],
    ]);
    // 被时序规则退回的推送在要点层是拉回 ↩
    const blocks = groups.flatMap(zoomBlocks);
    expect(blocks.filter((b) => b.kind === "call" && b.call.part.blockedBy === "pull_back").map((b) => b.keyLine)).toEqual(["↩ 推送当前分支到 origin", "↩ 推送当前分支到 origin"]);
    const single = detailContent(state, items, { type: "item", id: calls[0]!.id });
    expect(single.kind === "tool_call" && [single.call.sentence, single.call.label]).toEqual(["建远端仓库 demo：演示仓库", "建远端仓库"]);
  });
});

// ───────────────────────── 构造的：读了密钥文件、按规则退回经状态层画到要点层 ─────────────────────────

const S = "secretary";
const checkMessage = schemaChecker(MessageEventPayloadSchema);
function messageFrame(seq: number, id: string, speaker: MessageEnvelope["speaker"], parts: MessagePart[]): EventFrame {
  const payload = { message: { id, conversation: S, speaker, time: `2026-10-10T10:00:${String(seq).padStart(2, "0")}.000+08:00`, parts } };
  const problem = checkMessage.firstError(payload);
  if (problem) throw new Error(`构造的事件不合 schema：${problem}`);
  return frame(S, seq, "message", payload);
}

test("读了密钥文件的（守护进程带 readsSecretFile）在要点层加 🔒；schema 收这个字段", () => {
  const items = chatItems(
    replay([
      messageFrame(1, "m1", "agent", [part({ callId: "c1", tool: "read", argsSummary: ".env", readsSecretFile: true, resultSummary: "（密钥文件的内容不记录）" })]),
      messageFrame(2, "m2", "agent", [part({ callId: "c2", tool: "bash", argsSummary: "grep API_KEY .env", genericBash: true, readsSecretFile: true })]),
      messageFrame(3, "m3", "agent", [part({ callId: "c3", tool: "read", argsSummary: "README.md" })]),
    ]),
    S,
  );
  expect(items.flatMap(zoomBlocks).map((b) => b.keyLine)).toEqual(["🔒 读 .env", "🔒 在 .env 里搜「API_KEY」", "读 README.md"]);
});
