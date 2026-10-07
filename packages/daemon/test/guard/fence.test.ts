// 守卫切面：路径围栏、受保护区域、密钥区，以及"删除或覆盖"按路径和文件元数据算。
import { describe, expect, it } from "vitest";
import { judgementExecutes, judgeToolCall, type GuardAgent, type GuardInput, type ToolCall } from "../../src/guard/index.ts";
import { bash, call, dispositionFinding, inChat, inTask, maintainer, P, secretary, subAgent, task, v1Satisfied, DAY, NOW } from "./helpers/guard-input.ts";

const write = (path: string) => call("write", { path, content: "x" });
const edit = (path: string) => call("edit", { path, edits: [{ oldText: "a", newText: "b" }] });
const read = (path: string) => call("read", { path });

describe("维护者和子 agent 的文件工具", () => {
  it("写项目档案和工作目录以外：一律拒绝，不问用户", () => {
    for (const agent of [maintainer(), subAgent()]) {
      for (const scene of [inChat, inTask]) {
        for (const c of [write(`${P.outside}\\x.txt`), edit("C:\\Windows\\win.ini"), write("../../escape.txt")]) {
          const j = judgeToolCall(scene(agent, c));
          expect(j.hardRefusal).toEqual(["fence"]);
          expect(j.findings.some((f) => f.kind === "hard_refusal" && f.id === "fence")).toBe(true);
          expect(j.explanation).toMatch(/^拒绝：.*只能写项目档案和工作目录/);
          expect(j.withinGrant).toBe(false);
        }
      }
    }
  });

  it("越界写入即使有覆盖它的授权项、最松的设置，也照样硬拒绝", () => {
    const grants = [{ grantId: "g", tool: "write", scope: { path: P.outside }, stageId: "s1", grantedAt: NOW - DAY }];
    const settings = { custom: [{ id: "loose", title: "随便", match: { tools: ["write"] }, chat: "log_only" as const, task: "log_only" as const }] };
    const j = judgeToolCall(inTask(maintainer(), write(`${P.outside}\\x.txt`), { task: task({ plan: { grants } }), settings }));
    expect(j.hardRefusal).toEqual(["fence"]);
    expect(j.withinGrant).toBe(false);
  });

  it("写工作目录和项目档案里的新文件：直接做只记录", () => {
    const facts = { files: { [`${P.workDir}\\new.ts`]: { exists: false }, [`${P.records}\\progress.md`]: { exists: false } } };
    for (const c of [write(`${P.workDir}\\new.ts`), write("new.ts"), write(`${P.records}\\progress.md`), edit(`${P.workDir}\\a.ts`)]) {
      const j = judgeToolCall(inTask(maintainer(), c, { facts }));
      expect({ call: c, disposition: j.disposition }).toEqual({ call: c, disposition: "log_only" });
      expect(j.categories).toEqual([]);
    }
  });

  it("读项目档案和工作目录以外：落入'越出项目目录'，按处置走", () => {
    expect(judgeToolCall(inChat(maintainer(), read(`${P.outside}\\a.txt`))).disposition).toBe("ask_first");
    const j = judgeToolCall(inTask(maintainer(), read(`${P.outside}\\a.txt`)));
    expect(j.categories).toEqual(["outside_project"]);
    expect(j.disposition).toBe("ask_first");
    expect(dispositionFinding(j, "outside_project")!.categoryDisposition).toBe("plan_listed");
    // ls、grep、find 不写 path 时是工作目录
    expect(judgeToolCall(inChat(maintainer(), call("ls", {}))).disposition).toBe("log_only");
    expect(judgeToolCall(inChat(maintainer(), call("grep", { pattern: "x", path: "/e/elsewhere" }))).categories).toEqual(["outside_project"]);
  });

  it("子 agent 写项目档案一律硬拒绝（文件工具和 bash 都一样），写工作目录照常判定", () => {
    for (const c of [
      write(`${P.records}\\spec.md`),
      edit(`${P.records}\\progress.md`),
      bash(`echo x >> '${P.records}\\progress.md'`),
      bash(`rm -f ${P.records.replaceAll("\\", "/")}/old.md`),
      bash(`cd ${P.records.replaceAll("\\", "/")} && sed -i 's/a/b/' spec.md`),
      call("git_commit", { repoPath: P.records, message: "x" }),
    ]) {
      const j = judgeToolCall(inTask(subAgent(), c));
      expect({ call: c, hardRefusal: j.hardRefusal }).toEqual({ call: c, hardRefusal: ["sub_agent_records"] });
      expect(j.explanation).toMatch(/子 agent 不能写项目档案/);
    }
    // 读项目档案照常
    expect(judgeToolCall(inTask(subAgent(), bash(`cat '${P.records}\\spec.md'`))).hardRefusal).toBeNull();
    expect(judgeToolCall(inTask(subAgent(), read(`${P.records}\\spec.md`))).disposition).toBe("log_only");
    // 写工作目录照常判定（工作目录在项目档案里面也一样）
    const work = judgeToolCall(inTask(subAgent(), write(`${P.workDir}\\x.ts`), { facts: { files: { [`${P.workDir}\\x.ts`]: { exists: false } } } }));
    expect(work.hardRefusal).toBeNull();
    expect(work.disposition).toBe("log_only");
    const nested = subAgent({ workingDirs: [`${P.records}\\work`], cwd: `${P.records}\\work` });
    expect(judgeToolCall(inTask(nested, bash("echo x > out.txt"))).hardRefusal).toBeNull();
    expect(judgeToolCall(inTask(nested, bash("echo x > ../spec.md"))).hardRefusal).toEqual(["sub_agent_records"]);
    // 维护者写项目档案照常
    expect(judgeToolCall(inTask(maintainer(), bash(`echo x >> '${P.records}\\progress.md'`))).hardRefusal).toBeNull();
  });
});

describe("删除或覆盖：只算项目档案和工作目录里的", () => {
  it("写一个已存在的文件算覆盖；不知道在不在时也按覆盖算", () => {
    const target = `${P.workDir}\\README.md`;
    const exists = judgeToolCall(inChat(maintainer(), write(target), { facts: { files: { [target]: { exists: true } } } }));
    expect(exists.categories).toEqual(["delete_or_overwrite"]);
    expect(exists.disposition).toBe("ask_first");
    // 工作目录是干净的 git 仓库：v1 模板"删除或覆盖之前必须已提交"满足，这里看的是类别
    const unknown =judgeToolCall(inTask(maintainer(), write(target), { facts: v1Satisfied().facts }));
    expect(unknown.categories).toEqual(["delete_or_overwrite"]);
    expect(unknown.disposition).toBe("notify_after");
    // 文件元数据的键不分大小写、不分分隔符
    const otherCase = judgeToolCall(inChat(maintainer(), write(target), { facts: { files: { "e:/WORK/notes/readme.md": { exists: false } } } }));
    expect(otherCase.categories).toEqual([]);
  });

  it("bash 删除、移动、丢弃改动", () => {
    for (const command of ["rm -rf build", "mv a.ts b.ts", "git reset --hard", "git clean -fd", "git checkout -- ."]) {
      const categories = judgeToolCall(inTask(maintainer(), bash(command))).categories;
      expect({ command, categories }).toEqual({ command, categories: expect.arrayContaining(["delete_or_overwrite"]) });
    }
  });

  it("删除项目外的东西落入'越出项目目录'，不算'删除或覆盖'", () => {
    const j = judgeToolCall(inTask(maintainer(), bash("rm -rf /e/elsewhere/old")));
    expect(j.categories).toEqual(["outside_project"]);
  });
});

describe("秘书的围栏是草稿区", () => {
  it("文件工具写草稿区：直接做只记录，覆盖也不落入任何类别", () => {
    for (const c of [write(`${P.scratch}\\calc.py`), write("calc.py"), edit(`${P.scratch}\\calc.py`)]) {
      const j = judgeToolCall(inChat(secretary(), c, { facts: { files: { [`${P.scratch}\\calc.py`]: { exists: true } } } }));
      expect(j.disposition).toBe("log_only");
      expect(j.categories).toEqual([]);
    }
  });

  it("草稿区里删、改用 bash 也不落入任何类别", () => {
    for (const command of ["rm -rf out", "mv a.csv b.csv", "echo 1 > result.txt", "python calc.py > result.txt"]) {
      const j = judgeToolCall(inChat(secretary(), bash(command)));
      expect({ command, categories: j.categories }).toEqual({ command, categories: [] });
      expect(j.disposition).toBe("log_only");
      expect(j.genericShell).toBe(true);
    }
  });

  it("文件工具写草稿区以外（包括项目档案）：直接拒绝", () => {
    for (const c of [write(`${P.records}\\spec.md`), write(`${P.outside}\\x.txt`), edit(`${P.workDir}\\a.ts`)]) {
      const j = judgeToolCall(inChat(secretary(), c));
      expect(j.hardRefusal).toEqual(["fence"]);
      expect(j.explanation).toMatch(/秘书的文件工具只能写草稿区/);
    }
  });

  it("文件工具读项目档案：只读放行；读草稿区和项目档案以外：越出项目目录，对话里先问", () => {
    expect(judgeToolCall(inChat(secretary(), read(`${P.projects}\\other\\charter.md`))).disposition).toBe("log_only");
    const j = judgeToolCall(inChat(secretary(), read("C:\\Users\\tester\\Documents\\bill.pdf")));
    expect(j.categories).toEqual(["outside_project"]);
    expect(j.disposition).toBe("ask_first");
  });

  it("bash 跑草稿区外的现成脚本：越出项目目录，先问", () => {
    const j = judgeToolCall(inChat(secretary(), bash("python 'C:\\Users\\tester\\tools\\report.py'")));
    expect(j.categories).toEqual(["outside_project"]);
    expect(j.disposition).toBe("ask_first");
  });
});

describe("受保护区域：写入一律'永不'，密钥区连读都拒绝", () => {
  const PROTECTED = [
    ["配置区", `${P.config}\\watch-categories.json`],
    ["密钥区", `${P.secrets}\\deepseek.key`],
    ["数据库区", `${P.db}\\ergou.db`],
    ["二狗程序目录", `${P.programDir}\\packages\\daemon\\src\\guard\\judge.ts`],
  ] as const;
  const agents: [string, GuardAgent][] = [
    ["秘书", secretary()],
    ["维护者", maintainer()],
    ["子 agent", subAgent()],
    // 就算维护者的工作目录正好盖住了受保护区域
    ["工作目录盖住数据目录的维护者", maintainer({ workingDirs: [P.dataDir, P.programDir] })],
  ];

  for (const [area, target] of PROTECTED) {
    for (const [who, agent] of agents) {
      it(`${who}写${area}：文件工具和 bash 都是永不`, () => {
        const unixTarget = target.replaceAll("\\", "/");
        const attempts: ToolCall[] = [
          write(target),
          edit(target),
          bash(`echo x > '${target}'`),
          bash(`rm -f ${unixTarget}`),
          bash(`cp evil.json ${unixTarget}`),
          bash(`node tool.js --out=${unixTarget}`),
        ];
        for (const c of attempts) {
          for (const scene of [inChat, inTask]) {
            const input: GuardInput = scene(agent, c, { settings: { custom: [{ id: "loose", title: "随便", match: { tools: ["write", "edit"] }, chat: "log_only", task: "log_only" }] } });
            const j = judgeToolCall(input);
            expect({ call: c, disposition: j.disposition }).toEqual({ call: c, disposition: "never" });
            expect(j.findings.some((f) => f.kind === "protected_area")).toBe(true);
            expect(j.explanation).toMatch(/受保护区域/);
            expect(judgementExecutes(j)).toBe(false);
          }
        }
      });
    }
  }

  it("密钥区连读都拒绝（文件工具和 bash）", () => {
    for (const agent of [secretary(), maintainer(), maintainer({ workingDirs: [P.dataDir] })]) {
      for (const c of [read(`${P.secrets}\\deepseek.key`), bash(`cat ${P.secrets.replaceAll("\\", "/")}/deepseek.key`), call("ls", { path: P.secrets })]) {
        const j = judgeToolCall(inChat(agent, c));
        expect({ call: c, hardRefusal: j.hardRefusal }).toEqual({ call: c, hardRefusal: ["secrets_area"] });
        expect(j.explanation).toMatch(/密钥区连读都拒绝/);
      }
    }
  });

  it("读配置区不算写：维护者读它落入'越出项目目录'", () => {
    const j = judgeToolCall(inChat(maintainer(), read(`${P.config}\\ergou.json`)));
    expect(j.disposition).toBe("ask_first");
    expect(j.categories).toEqual(["outside_project"]);
  });

  it("调用方给出的真实路径（符号链接、目录联接、8.3 短名）一并检查", () => {
    const link = `${P.workDir}\\link-to-config\\x.json`;
    const j = judgeToolCall(inChat(maintainer(), write(link), { facts: { files: { [link]: { exists: true, realPath: `${P.config}\\x.json` } } } }));
    expect(j.disposition).toBe("never");
  });

  it("用 Git Bash 写法、相对路径上跳、大小写不同也认得出", () => {
    for (const command of [
      "echo x > /d/ergou-data/config/a.json",
      "cd /d/ergou-data/projects/notes && echo x > ../../CONFIG/a.json",
      "cd /d/ergou-data && rm -rf db",
    ]) {
      expect({ command, disposition: judgeToolCall(inTask(maintainer(), bash(command))).disposition }).toEqual({ command, disposition: "never" });
    }
    expect(judgeToolCall(inChat(maintainer(), write("d:/ERGOU-DATA/config/a.json"))).disposition).toBe("never");
  });
});
