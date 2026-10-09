// 守卫切面：效果日志的记录（规格第 9 节）和参数名统一。
// 只有执行成功的调用才追加；记录里是规范化之后的参数：带类型的工具和从通用 bash 拆出的伪工具调用规范化成同一种形式，
// 同一条规则对两者都生效。内容类的参数（写入的全文、编辑的新旧片段）只记长度和摘要哈希（68 号票）。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  effectLogArgs,
  effectRecordsFor,
  isDigested,
  judgeToolCall,
  normalizeArgs,
  BUILTIN_TOOL_REGISTRY,
  type GuardInput,
} from "../../src/guard/index.ts";
import { bash, call, inTask, maintainer, NOW, P } from "./helpers/guard-input.ts";

function recordsOf(input: GuardInput, firstSeq = 1) {
  return effectRecordsFor(input, judgeToolCall(input), { firstSeq, at: NOW });
}

describe("效果日志的记录", () => {
  it("字段照规格：序号、任务、阶段、agent、工具或伪工具、规范化参数、效果摘要、时间", () => {
    const [record, ...rest] = recordsOf(inTask(maintainer(), call("git_commit", { message: "保存进展" })), 7);
    expect(rest).toEqual([]);
    expect(record).toEqual({
      seq: 7,
      taskId: "task-1",
      stageId: "s1",
      agentId: "maintainer-notes",
      tool: "git_commit",
      args: { repoPath: P.workDir, message: "保存进展" },
      summary: "git 提交",
      at: NOW,
    });
  });

  it("通用 bash 拆出的每条伪工具调用各记一条，序号接着排，效果摘要是那段命令", () => {
    const records = recordsOf(inTask(maintainer(), bash("npm test && git commit -m wip")), 3);
    expect(records.map((r) => [r.seq, r.tool, r.summary])).toEqual([
      [3, "run_tests", "npm test"],
      [4, "git_commit", "git commit -m wip"],
    ]);
  });

  it("调用方可以写自己的效果摘要（比如提交号）", () => {
    const input = inTask(maintainer(), call("git_commit", { message: "x" }));
    const [record] = effectRecordsFor(input, judgeToolCall(input), { firstSeq: 1, at: NOW, summary: () => "提交了 3f2a1c0" });
    expect(record!.summary).toBe("提交了 3f2a1c0");
  });

  it("对话里的记录任务和阶段为空", () => {
    const input = { ...inTask(maintainer(), call("read", { path: "README.md" })), task: null };
    expect(recordsOf(input)[0]).toEqual(expect.objectContaining({ taskId: null, stageId: null, args: { path: `${P.workDir}\\README.md` } }));
  });
});

describe("参数名统一", () => {
  it("带类型的 git 推送和 bash 里的 git push 规范化成同一种形式，补上当时 HEAD 的提交号", () => {
    const facts = { git: { [P.workDir]: { uncommittedPaths: [], head: "3f2a1c0" } } };
    const typed = recordsOf(inTask(maintainer(), call("git_push", { remote: "origin", branch: "main", force: false }), { facts }));
    const shell = recordsOf(inTask(maintainer(), bash("git push origin main"), { facts }));
    const expected = { repoPath: P.workDir, remote: "origin", branch: "main", force: false, headCommit: "3f2a1c0" };
    expect(typed.map((r) => [r.tool, r.args])).toEqual([["git_push", expected]]);
    expect(shell.map((r) => [r.tool, r.args])).toEqual([["git_push", expected]]);
  });

  it("记录带上会话段", () => {
    const [record] = recordsOf({ ...inTask(maintainer(), call("read", { path: "a.md" })), task: null, segmentId: "seg-7" });
    expect(record!.segmentId).toBe("seg-7");
  });

  it("带类型的跑测试和 bash 里的 npm test、npx vitest 都是 run_tests，仓库路径取工作目录", () => {
    for (const input of [call("run_tests", {}), bash("npm test"), bash("npx vitest run")]) {
      const [record] = recordsOf(inTask(maintainer(), input));
      expect([record!.tool, record!.args.repoPath]).toEqual(["run_tests", P.workDir]);
    }
  });

  it("路径参数解析成绝对路径（Git Bash 写法、相对路径、~ 都一样）", () => {
    const env = { cwd: P.workDir, homeDir: P.home };
    expect(normalizeArgs("read", { path: "docs/a.md" }, BUILTIN_TOOL_REGISTRY, env)).toEqual({ path: `${P.workDir}\\docs\\a.md` });
    expect(normalizeArgs("read", { path: "/e/work/notes/docs/a.md" }, BUILTIN_TOOL_REGISTRY, env)).toEqual({ path: `${P.workDir}\\docs\\a.md` });
    expect(normalizeArgs("read", { path: "~/x.txt" }, BUILTIN_TOOL_REGISTRY, env)).toEqual({ path: `${P.home}\\x.txt` });
  });

  it("没法确定的值记成'未知'（能存成 JSON），空值去掉", () => {
    const [record] = recordsOf(inTask(maintainer(), bash("rm -f $TARGET")));
    expect(record!.args).toEqual({ path: { $unknown: "$TARGET" }, recursive: false });
    const [push] = recordsOf(inTask(maintainer(), bash("git push -f")));
    expect(push!.args).toEqual({ repoPath: P.workDir, force: true, headCommit: { $unknown: "推送的提交" } });
  });

  it("规范化是幂等的：记录里的参数再规范化一遍不变", () => {
    const env = { cwd: "C:\\somewhere\\else", homeDir: P.home };
    for (const record of recordsOf(inTask(maintainer(), bash("git push origin main && cp a.md /e/backup/a.md")))) {
      expect(normalizeArgs(record.tool, record.args, BUILTIN_TOOL_REGISTRY, env)).toEqual(record.args);
    }
  });
});

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const digest = (text: string) => ({ $digest: { length: text.length, sha256: sha(text) } });
/** 效果日志里存的参数：规范化之后再缩 */
const stored = (input: GuardInput) => recordsOf(input).map((r) => [r.tool, effectLogArgs(r.tool, r.args, BUILTIN_TOOL_REGISTRY)]);

describe("内容类的参数只记长度和摘要哈希（68 号票）", () => {
  const NOTES = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行：周三下午三点确认水电方案`).join("\n");

  it("写文件的全文换成字符数和 SHA-256，路径照原样", () => {
    expect(stored(inTask(maintainer(), call("write", { path: "notes.md", content: NOTES })))).toEqual([
      ["write", { path: `${P.workDir}\\notes.md`, content: digest(NOTES) }],
    ]);
  });

  it("改文件的新旧片段每一段各换一个（哈希的原文是它的 JSON，和授权项对象范围的写法一样）", () => {
    const edits = [
      { oldText: "周三", newText: "周四" },
      { oldText: "三点", newText: "四点" },
    ];
    expect(stored(inTask(maintainer(), call("edit", { path: "notes.md", edits })))).toEqual([
      ["edit", { path: `${P.workDir}\\notes.md`, edits: edits.map((e) => digest(JSON.stringify(e))) }],
    ]);
  });

  it("别的参数照原样：提交说明、命令、远端和分支、对外发送的内容（\"不重复发\"比的就是它）", () => {
    const facts = { git: { [P.workDir]: { uncommittedPaths: [], head: "3f2a1c0" } } };
    expect(stored(inTask(maintainer(), call("git_commit", { message: "保存进展" })))).toEqual([["git_commit", { repoPath: P.workDir, message: "保存进展" }]]);
    expect(stored(inTask(maintainer(), bash("git push origin main && git checkout -- notes.md"), { facts }))).toEqual([
      ["git_push", { repoPath: P.workDir, remote: "origin", branch: "main", force: false, headCommit: "3f2a1c0" }],
      ["git_discard", { repoPath: P.workDir, command: "git checkout -- notes.md" }],
    ]);
    const body = NOTES.slice(0, 50);
    const [[, post]] = stored(inTask(maintainer(), bash(`curl -X POST -d '${body}' https://example.com/notes`))) as [[string, Record<string, unknown>]];
    expect(post).toMatchObject({ method: "POST", url: "https://example.com/notes", data: [body] });
  });

  it("幂等：缩过的再缩一遍不变；不改动传入的参数；bash 拆出来只带路径的写文件不用缩", () => {
    const raw = { path: `${P.workDir}\\notes.md`, content: NOTES };
    const once = effectLogArgs("write", raw, BUILTIN_TOOL_REGISTRY);
    expect(effectLogArgs("write", once, BUILTIN_TOOL_REGISTRY)).toEqual(once);
    expect(raw.content).toBe(NOTES);
    expect(isDigested(once.content)).toBe(true);
    const edits = effectLogArgs("edit", { path: raw.path, edits: [{ oldText: "a", newText: "b" }] }, BUILTIN_TOOL_REGISTRY);
    expect(effectLogArgs("edit", edits, BUILTIN_TOOL_REGISTRY)).toEqual(edits);
    expect(stored(inTask(maintainer(), bash("echo hi > out.txt"))).filter(([tool]) => tool === "write")).toEqual([["write", { path: `${P.workDir}\\out.txt` }]]);
  });
});
