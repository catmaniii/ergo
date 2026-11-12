// 守卫切面：每个 agent 一份目录授权表（ADR-0049）。
// - 登记了的那种操作（读、写、删分开）在登记目录里不落入"越出项目目录"，文件工具写也不再硬拒绝；没登记的那种操作照旧；
// - 说明里说清为什么没放开：没登记（在哪登记）、登记了只读没登记写、已过期、这种调用不按目录授权算；
// - 登记目录里名字像密钥的读写都硬拒绝（"密钥类文件"）；受保护区域、密钥区、整个数据目录照旧；
// - 按真实路径比：`..`、符号链接、目录联接、短路径逃不出去；取不到真实路径的不算；
// - 没有表的 agent（子 agent、评审）判出来和以前一模一样；跑脚本、git、看不出读写的程序照旧。
import { describe, expect, it } from "vitest";
import { type EnvironmentFacts, type GuardFolderGrant, type GuardInput, type GuardJudgement, judgementExecutes, judgeToolCall, type ToolCall } from "../../src/guard/index.ts";
import { bash, call, DAY, inChat, inTask, maintainer, NOW, P, secretary, subAgent } from "./helpers/guard-input.ts";

const NOTES = "F:\\notes";
const A = `${NOTES}\\a.txt`;
const DOCS = `${P.home}\\Documents`;

/** 这些路径在、真实路径就是写的路径（目录写 dir: true） */
const here = (...paths: string[]): EnvironmentFacts => ({ files: Object.fromEntries(paths.map((p) => [p, { exists: true, realPath: p }])) });
/** 写的路径的真实路径在别处（符号链接、目录联接、短路径） */
const linked = (path: string, realPath: string): EnvironmentFacts => ({ files: { [path]: { exists: true, realPath } } });

const grant = (modes: GuardFolderGrant["modes"], extra: Partial<GuardFolderGrant> = {}): GuardFolderGrant => ({ grantId: "fg-1", dir: NOTES, modes, ...extra });
const grants = (...list: GuardFolderGrant[]): Partial<GuardInput> => ({ folderGrants: list });

const read = (path: string) => call("read", { path });
const write = (path: string) => call("write", { path, content: "x" });

/** 项目的负责人：任务里（计划没有授权项）；对话里（对话审批开着） */
const inTaskBy = (c: ToolCall, extra: Partial<GuardInput> = {}) => judgeToolCall(inTask(maintainer(), c, extra));
const inChatBy = (c: ToolCall, extra: Partial<GuardInput> = {}) => judgeToolCall(inChat(maintainer(), c, extra));

const hitsOutside = (j: GuardJudgement) => j.categories.includes("outside_project");
/** 判定里决定结局的那几样（不看说明） */
const verdict = (j: GuardJudgement) => ({ hardRefusal: j.hardRefusal, disposition: j.disposition, categories: j.categories, executes: judgementExecutes(j) });

describe("没登记：照旧，说明里说没登记、在哪登记", () => {
  it("任务里读 Documents 没登记：照旧要授权项，说明写没登记", () => {
    const j = inTaskBy(read(`${DOCS}\\x.txt`), { ...grants(), facts: here(`${DOCS}\\x.txt`) });
    expect(j.disposition).toBe("ask_first");
    expect(j.categories).toEqual(["outside_project"]);
    expect(j.explanation).toContain("没登记");
    expect(j.explanation).toContain("设置 · 目录授权");
    // 464：有表的 agent 也可以自己申请。这句也写在给用户看的审批卡、调用记录上：说人话，不带工具名
    expect(j.explanation).toContain("也可以让它自己申请");
    expect(j.explanation).not.toContain("request_folder_grant");
  });

  it("对话里写项目之外没登记：文件工具照旧硬拒绝（围栏），说明写没登记", () => {
    const j = inChatBy(write(A), { ...grants(), facts: here(A) });
    expect(j.hardRefusal).toEqual(["fence"]);
    expect(j.explanation).toContain("没登记");
  });

  it("没有表的 agent（子 agent、评审）：说明和以前一模一样，不提目录授权", () => {
    for (const agent of [subAgent(), subAgent({ agentId: "review-1" })]) {
      const j = judgeToolCall(inTask(agent, read(A), { facts: here(A) }));
      expect(j.categories).toEqual(["outside_project"]);
      expect(j.explanation).not.toContain("目录授权");
      expect(j.explanation).not.toContain("没登记");
      expect(j.explanation).not.toContain("自己申请");
    }
  });

  it("有表、登记了别的目录：判定和没有表时一样，只是说明多一句", () => {
    const without = judgeToolCall(inTask(maintainer(), read(`${DOCS}\\x.txt`), { facts: here(`${DOCS}\\x.txt`) }));
    const withTable = inTaskBy(read(`${DOCS}\\x.txt`), { ...grants(grant(["read", "write", "delete"])), facts: here(`${DOCS}\\x.txt`) });
    // 登记了就会放开的候选另算（对话里审批卡上用），判定本身一样
    const { folderGrantCandidates: _, ...judged } = withTable;
    expect({ ...judged, explanation: "", findings: withTable.findings.map((f) => ({ ...f, message: "" })) }).toEqual({
      ...without,
      explanation: "",
      findings: without.findings.map((f) => ({ ...f, message: "" })),
    });
  });
});

describe("登记了只读：读放开，写照旧", () => {
  const facts = here(NOTES, A, `${NOTES}\\sub`);
  const READS: ToolCall[] = [
    read(A),
    call("ls", { path: NOTES }),
    call("grep", { pattern: "x", path: NOTES }),
    call("find", { pattern: "*.txt", path: NOTES }),
    bash("cat /f/notes/a.txt"),
    bash("head -n 5 F:/notes/a.txt"),
    bash("ls /f/notes"),
    bash("grep -r hello /f/notes"),
    bash("cat /f/notes/a.txt | head -5"),
  ];
  for (const c of READS) {
    it(`任务里、对话里都放开：${JSON.stringify(c.args)}`, () => {
      for (const j of [inTaskBy(c, { ...grants(grant(["read"])), facts }), inChatBy(c, { ...grants(grant(["read"])), facts })]) {
        expect(hitsOutside(j)).toBe(false);
        expect(judgementExecutes(j)).toBe(true);
        expect(j.folderGrantUses?.[0]).toMatchObject({ grantId: "fg-1", dir: NOTES, mode: "read" });
      }
    });
  }

  it("写同一个目录：文件工具照旧硬拒绝，说明写登记了只读、没登记写", () => {
    const j = inTaskBy(write(A), { ...grants(grant(["read"])), facts });
    expect(j.hardRefusal).toEqual(["fence"]);
    expect(j.explanation).toContain(`${NOTES} 登记了只读，没登记写`);
    expect(j.folderGrantUses).toBeUndefined();
  });

  it("bash 写同一个目录：照旧越出项目目录，说明写登记了只读、没登记写", () => {
    const j = inChatBy(bash("echo x > /f/notes/a.txt"), { ...grants(grant(["read"])), facts });
    expect(j.categories).toEqual(["outside_project"]);
    expect(j.disposition).toBe("ask_first");
    expect(j.explanation).toContain("登记了只读，没登记写");
  });
});

describe("登记了写：写放开；删除要另勾删除", () => {
  const facts = here(NOTES, A, `${NOTES}\\b.txt`);
  const WRITES: ToolCall[] = [write(A), call("edit", { path: A, edits: [] }), bash("echo x > /f/notes/a.txt"), bash("echo x >> /f/notes/a.txt"), bash("mkdir /f/notes/new"), bash("cp E:/work/notes/x.txt /f/notes/b.txt")];
  for (const c of WRITES) {
    it(`放开：${JSON.stringify(c.args)}`, () => {
      const j = inTaskBy(c, { ...grants(grant(["read", "write"])), facts: { files: { ...here(NOTES, A, `${NOTES}\\b.txt`, `${NOTES}\\new`).files, [`${P.workDir}\\x.txt`]: { exists: true, realPath: `${P.workDir}\\x.txt` } } } });
      expect(j.hardRefusal).toBeNull();
      expect(hitsOutside(j)).toBe(false);
      expect(judgementExecutes(j)).toBe(true);
      expect(j.folderGrantUses?.some((u) => u.mode === "write")).toBe(true);
    });
  }

  it("删除：登记了读写没登记删除照旧要问，说明写没登记删除", () => {
    const j = inChatBy(bash("rm /f/notes/a.txt"), { ...grants(grant(["read", "write"])), facts });
    expect(j.categories).toEqual(["outside_project"]);
    expect(j.disposition).toBe("ask_first");
    expect(j.explanation).toContain("没登记删除");
  });

  it("勾了删除就能删；勾删除不带写", () => {
    const j = inChatBy(bash("rm /f/notes/a.txt"), { ...grants(grant(["delete"])), facts });
    expect(judgementExecutes(j)).toBe(true);
    expect(j.folderGrantUses).toEqual([{ grantId: "fg-1", dir: NOTES, path: A, mode: "delete", call: 0 }]);
    const w = inTaskBy(write(A), { ...grants(grant(["delete"])), facts });
    expect(w.hardRefusal).toEqual(["fence"]);
    expect(w.explanation).toContain("登记了删除，没登记写");
  });

  it("移动要删（来源）和写（目标）都登记了", () => {
    const mv = bash("mv /f/notes/a.txt /f/notes/b.txt");
    expect(judgementExecutes(inChatBy(mv, { ...grants(grant(["write"])), facts }))).toBe(false);
    expect(judgementExecutes(inChatBy(mv, { ...grants(grant(["write", "delete"])), facts }))).toBe(true);
  });

  it("项目外的 rm -rf 照旧永不（v1 模板），登记了删除也一样", () => {
    const j = inChatBy(bash("rm -rf /f/notes/old"), { ...grants(grant(["read", "write", "delete"])), facts: here(NOTES, `${NOTES}\\old`) });
    expect(j.disposition).toBe("never");
  });

  it("秘书：对话审批关着时写登记目录不再要用户授权", () => {
    const before = judgeToolCall(inChat(secretary(), write(A), { conversationApprovals: "off", facts }));
    expect(before.disposition).toBe("ask_first");
    const j = judgeToolCall(inChat(secretary(), write(A), { conversationApprovals: "off", ...grants(grant(["write"])), facts }));
    expect(judgementExecutes(j)).toBe(true);
    expect(j.categories).toEqual([]);
  });
});

describe("登记目录里名字像密钥的：读写都拒，理由是密钥类文件", () => {
  const SECRETS = [".env", ".env.local", "server.key", "cert.pem", "secrets.txt", "secret.json", "id_rsa", "id_rsa.pub", "credentials.csv", "credentials", ".env."];
  for (const name of SECRETS) {
    it(`文件名 ${name}`, () => {
      const path = `${NOTES}\\${name}`;
      for (const c of [read(path), write(path), bash(`cat '/f/notes/${name}'`)]) {
        const j = inChatBy(c, { ...grants(grant(["read", "write", "delete"])), facts: here(path) });
        expect(j.hardRefusal).toEqual(["secret_file"]);
        expect(j.explanation).toContain("密钥类文件");
        expect(judgementExecutes(j)).toBe(false);
      }
    });
  }

  it("登记目录下面叫 secrets 的目录里的也算；.env.example 不算；登记目录上级的名字不算", () => {
    expect(inChatBy(read(`${NOTES}\\secrets\\db.txt`), { ...grants(grant(["read"])), facts: here(`${NOTES}\\secrets\\db.txt`) }).hardRefusal).toEqual(["secret_file"]);
    expect(judgementExecutes(inChatBy(read(`${NOTES}\\.env.example`), { ...grants(grant(["read"])), facts: here(`${NOTES}\\.env.example`) }))).toBe(true);
    const dir = "F:\\secret-project";
    const j = inChatBy(read(`${dir}\\a.txt`), { ...grants(grant(["read"], { dir })), facts: here(`${dir}\\a.txt`) });
    expect(judgementExecutes(j)).toBe(true);
  });

  it("真实路径是密钥文件的（链接指过去）也拒", () => {
    const j = inChatBy(read(`${NOTES}\\notes.txt`), { ...grants(grant(["read"])), facts: linked(`${NOTES}\\notes.txt`, `${NOTES}\\.env`) });
    expect(j.hardRefusal).toEqual(["secret_file"]);
  });

  it("没登记、过期了的目录里：不是新加的拒绝，照旧", () => {
    expect(inChatBy(read(`${NOTES}\\.env`), { ...grants(), facts: here(`${NOTES}\\.env`) }).hardRefusal).toBeNull();
    expect(inChatBy(read(`${NOTES}\\.env`), { ...grants(grant(["read"], { expiresAt: NOW - 1 })), facts: here(`${NOTES}\\.env`) }).hardRefusal).toBeNull();
  });
});

describe("过期", () => {
  it("到期时间早于现在（或就是现在）的不算，说已过期", () => {
    for (const expiresAt of [NOW - DAY, NOW]) {
      const j = inChatBy(read(A), { ...grants(grant(["read"], { expiresAt })), facts: here(A) });
      expect(j.categories).toEqual(["outside_project"]);
      expect(j.explanation).toContain(`${NOTES} 的目录授权已过期`);
    }
  });

  it("没到期的、长期有效的照常放开", () => {
    expect(judgementExecutes(inChatBy(read(A), { ...grants(grant(["read"], { expiresAt: NOW + 1 })), facts: here(A) }))).toBe(true);
    expect(judgementExecutes(inChatBy(read(A), { ...grants(grant(["read"])), facts: here(A) }))).toBe(true);
  });

  it("同一个目录一条过期一条有效：按有效的", () => {
    const j = inChatBy(read(A), { ...grants(grant(["read"], { grantId: "old", expiresAt: NOW - DAY }), grant(["read"], { grantId: "new" })), facts: here(A) });
    expect(j.folderGrantUses?.[0]?.grantId).toBe("new");
  });
});

describe("逃不出去：按真实路径比", () => {
  it("文件工具写着 `..`：按解析出的路径比", () => {
    const path = `${NOTES}\\..\\other\\x.txt`;
    const j = inChatBy(read(path), { ...grants(grant(["read"])), facts: here("F:\\other\\x.txt") });
    expect(j.categories).toEqual(["outside_project"]);
    expect(j.explanation).toContain("没登记");
  });

  it("bash 里写着 `..`：落在登记目录里也不算（Git Bash 先走链接再走 ..）", () => {
    const j = inChatBy(bash("cat /f/notes/sub/../a.txt"), { ...grants(grant(["read"])), facts: here(A, `${NOTES}\\sub`) });
    expect(j.categories).toEqual(["outside_project"]);
    expect(j.explanation).toContain("这种调用不按目录授权算");
  });

  it("符号链接、目录联接指到别处：不算", () => {
    const j = inChatBy(read(`${NOTES}\\link\\x.txt`), { ...grants(grant(["read", "write", "delete"])), facts: linked(`${NOTES}\\link\\x.txt`, "C:\\Windows\\x.txt") });
    expect(j.categories).toEqual(["outside_project"]);
    expect(judgementExecutes(j)).toBe(false);
  });

  it("别处指进来的链接：读写按真实路径放开，删除不放（删的是别处那个链接）", () => {
    const facts = linked("E:\\elsewhere\\link", A);
    expect(judgementExecutes(inChatBy(read("E:\\elsewhere\\link"), { ...grants(grant(["read"])), facts }))).toBe(true);
    const j = inChatBy(bash("rm /e/elsewhere/link"), { ...grants(grant(["delete"])), facts });
    expect(j.categories).toEqual(["outside_project"]);
    expect(judgementExecutes(j)).toBe(false);
  });

  it("短路径：真实路径在登记目录里的放开，在旁边目录里的不放", () => {
    const pub = `${NOTES}\\public`;
    const g = grants(grant(["read"], { dir: pub }));
    expect(judgementExecutes(inChatBy(read("F:\\NOTES~1\\PUBLIC~1\\x.txt"), { ...g, facts: linked("F:\\NOTES~1\\PUBLIC~1\\x.txt", `${pub}\\x.txt`) }))).toBe(true);
    const j = inChatBy(read("F:\\NOTES~1\\PRIVAT~1\\x.txt"), { ...g, facts: linked("F:\\NOTES~1\\PRIVAT~1\\x.txt", `${NOTES}\\private\\x.txt`) });
    expect(j.categories).toEqual(["outside_project"]);
    expect(judgementExecutes(j)).toBe(false);
  });

  it("登记目录本身被换成链接（真实路径不再在里面）：不算", () => {
    const j = inChatBy(read(A), { ...grants(grant(["read"])), facts: linked(A, "C:\\Windows\\a.txt") });
    expect(judgementExecutes(j)).toBe(false);
  });

  it("取不到真实路径：不算", () => {
    const j = inChatBy(read(A), { ...grants(grant(["read"])), facts: { files: { [A]: { exists: true } } } });
    expect(judgementExecutes(j)).toBe(false);
    expect(j.explanation).toContain("这种调用不按目录授权算");
  });
});

describe("受保护区域、密钥区、数据目录：登记了上级目录也照旧", () => {
  const DRIVE = "D:\\";
  const all = grants(grant(["read", "write", "delete"], { dir: DRIVE }));
  it("写配置区：永不", () => {
    const path = `${P.config}\\x.json`;
    const j = inChatBy(write(path), { ...all, facts: here(path) });
    expect(j.disposition).toBe("never");
    expect(judgementExecutes(j)).toBe(false);
  });
  it("读密钥区：硬拒绝", () => {
    const path = `${P.secrets}\\k`;
    expect(inChatBy(read(path), { ...all, facts: here(path) }).hardRefusal).toContain("secrets_area");
  });
  it("读数据目录里别的地方（别的项目档案）：不算，照旧越出项目目录", () => {
    const path = `${P.projects}\\other\\x.md`;
    const j = inTaskBy(read(path), { ...all, facts: here(path) });
    expect(j.categories).toEqual(["outside_project"]);
  });
  it("写程序目录：永不", () => {
    const path = `${P.programDir}\\x.js`;
    expect(inChatBy(write(path), { ...all, facts: here(path) }).disposition).toBe("never");
  });
});

describe("不按目录授权算的调用：和没登记时判得一样", () => {
  const facts: EnvironmentFacts = { ...here(NOTES, A, `${NOTES}\\run.py`), scripts: { [`${NOTES}\\run.py`]: { networkUsage: [] } } };
  const CALLS: ToolCall[] = [
    bash("python /f/notes/run.py"),
    bash("cd /f/notes && cat a.txt"),
    bash("git -C /f/notes status"),
    bash("echo x | tee /f/notes/a.txt"),
    bash("find /f/notes -name '*.tmp' | xargs rm"),
    call("git_status_diff", { repoPath: NOTES }),
  ];
  for (const c of CALLS) {
    it(`调用：${JSON.stringify(c.args)}`, () => {
      const without = verdict(inChatBy(c, { facts }));
      const withGrant = inChatBy(c, { ...grants(grant(["read", "write", "delete"])), facts });
      expect(verdict(withGrant)).toEqual(without);
    });
  }

  it("写 git 的配置和钩子：登记了写也不算", () => {
    const path = `${NOTES}\\.git\\hooks\\pre-commit`;
    const j = inChatBy(write(path), { ...grants(grant(["read", "write"])), facts: here(path) });
    expect(j.hardRefusal).toEqual(["fence"]);
  });
});

describe("对话里审批卡的候选：登记了就会放开的", () => {
  it("没登记的读、写给出候选（真实路径、是不是目录、要的操作）", () => {
    const j = inChatBy(read(A), { ...grants(), facts: here(A) });
    expect(j.folderGrantCandidates).toEqual([{ path: A, realPath: A, isDirectory: false, mode: "read" }].map((c) => ({ ...c, call: 0 })));
    const dir = inChatBy(call("ls", { path: NOTES }), { ...grants(), facts: { files: { [NOTES]: { exists: true, isDirectory: true, realPath: NOTES } } } });
    expect(dir.folderGrantCandidates?.[0]).toMatchObject({ path: NOTES, isDirectory: true, mode: "read" });
  });

  it("登记了只读、要写：候选是写", () => {
    const j = inChatBy(bash("echo x > /f/notes/a.txt"), { ...grants(grant(["read"])), facts: here(A) });
    expect(j.folderGrantCandidates?.map((c) => c.mode)).toEqual(["write"]);
  });

  it("没有候选：没有表的、密钥类文件、数据目录、跑脚本、取不到真实路径的", () => {
    expect(judgeToolCall(inChat(subAgent(), read(A), { facts: here(A) })).folderGrantCandidates).toBeUndefined();
    expect(inChatBy(read(`${NOTES}\\.env`), { ...grants(), facts: here(`${NOTES}\\.env`) }).folderGrantCandidates).toBeUndefined();
    expect(inChatBy(read(`${P.projects}\\other\\x`), { ...grants(), facts: here(`${P.projects}\\other\\x`) }).folderGrantCandidates).toBeUndefined();
    expect(inChatBy(bash("python /f/notes/run.py"), { ...grants(), facts: { ...here(`${NOTES}\\run.py`), scripts: { [`${NOTES}\\run.py`]: { networkUsage: [] } } } }).folderGrantCandidates).toBeUndefined();
    expect(inChatBy(read(A), grants()).folderGrantCandidates).toBeUndefined();
  });
});
