// 换目录跑的命令（模型写了 workdir，钩子看不到）补判时，守卫到底判出什么：这里用真的判定函数，不是替身。
// 补判的命令是 cd "<真的目录>" && <模型写的那句>（child/guard.ts 的 cwdCheckOf），靠守卫现成的 shell 分析：
// - cd 本身算一次"不只是读"的读：目录越出项目要问，目录在密钥区硬拒绝；
// - 守卫认得的程序（rm、cat，Remove-Item、Get-Content 这些 cmdlet，见 test/guard/powershell-cmdlets.test.ts）和像路径的词（.\keep.txt）按 cd 之后的目录解析。
// 守卫按 Git Bash 的语法拆，没加引号的反斜杠是转义，所以 Codex 交给守卫的命令一律换成正斜杠（commandForGuard）。
import { describe, expect, it } from "vitest";
import { cwdCheckOf, toGuardCall } from "../../src/codex/child/guard.ts";
import { type ExecutingAgent, type GuardInput, type GuardJudgement, judgementExecutes, judgeToolCall } from "../../src/guard/index.ts";
import { splitShellCommand } from "../../src/guard/shell/split.ts";
import { bash, inTask, maintainer, P, v1Satisfied } from "../guard/helpers/guard-input.ts";

/** 模型写的这句放到 cwd 跑时，补判发给守卫的命令 */
const checkOf = (command: string, cwd: string) => String(cwdCheckOf(toGuardCall("c-1", "Bash", { command }), cwd).args.command);
/** 钩子发给守卫的命令 */
const hooked = (command: string) => String(toGuardCall("c-1", "Bash", { command }).args.command);
const input = (command: string, extra: Partial<GuardInput> = {}): GuardInput => inTask(maintainer() as ExecutingAgent, bash(command), { ...v1Satisfied(), ...extra });
const judge = (command: string, extra: Partial<GuardInput> = {}): GuardJudgement => judgeToolCall(input(command, extra));
/** 拆出来的调用碰到的路径 */
function touched(command: string): string[] {
  return splitShellCommand(command, { cwd: P.workDir, homeDir: P.home }).flatMap((c) => {
    const paths = c.args.paths;
    return Array.isArray(paths) ? paths.map(String) : typeof c.args.path === "string" ? [c.args.path] : [];
  });
}
const findingIds = (j: GuardJudgement) => j.findings.map((f) => f.id);

describe("cd \"<cwd>\" && <命令>：判的是实际跑的目录", () => {
  it("cd 到外面再 Remove-Item keep.txt：判出来的路径是外面那个，越出项目目录要问；不带 cd 时按工作目录判成项目里的删除（这就是要补判的原因）", () => {
    const command = checkOf("Remove-Item keep.txt", P.outside);
    expect(command).toBe('cd "E:/elsewhere" && Remove-Item keep.txt');
    expect(splitShellCommand(command, { cwd: P.workDir, homeDir: P.home })[0]).toMatchObject({ tool: "read", args: { path: P.outside }, notJustRead: true });
    const verdict = judge(command);
    expect(verdict.disposition).toBe("ask_first");
    expect(findingIds(verdict)).toContain("outside_project");
    expect(verdict.findings.find((f) => f.id === "outside_project")?.message).toContain(P.outside);
    expect(touched(command)).toEqual([P.outside, `${P.outside}\\keep.txt`]);

    const unchecked = judge(hooked("Remove-Item keep.txt"));
    expect(findingIds(unchecked)).toContain("delete_or_overwrite");
    expect(findingIds(unchecked)).not.toContain("outside_project");
  });

  it("目录在密钥区：什么命令都硬拒绝（PowerShell 写法也一样），对话审批关着也一样", () => {
    for (const line of ["type x.key", "Get-Content x.key", "Get-Content .\\x.key", "cat x.key", "dir"]) {
      const command = checkOf(line, P.secrets);
      expect(judge(command).hardRefusal).toContain("secrets_area");
      const off = judge(command, { conversationApprovals: "off" });
      expect(off.hardRefusal).toContain("secrets_area");
      expect(judgementExecutes(off)).toBe(false);
    }
  });

  it("目录在密钥区、命令守卫拆不开（PowerShell 的 if）：拆不开的原文里写着密钥区，判永不", () => {
    const command = checkOf("if (Test-Path x.key) { Get-Content x.key }", P.secrets);
    for (const mode of ["on", "off"] as const) {
      const verdict = judge(command, { conversationApprovals: mode });
      expect(verdict.disposition).toBe("never");
      expect(judgementExecutes(verdict)).toBe(false);
    }
  });

  it("目录在受保护区（不是密钥区）：判永不，对话审批关着也一样；cmdlet 只写文件名的（Remove-Item x.json、Set-Content x.json）也算", () => {
    for (const line of ["rm x.json", "Remove-Item .\\x.json", "echo x > x.json", "Remove-Item x.json", "Set-Content x.json", "del x.json"]) {
      for (const mode of ["on", "off"] as const) {
        const verdict = judge(checkOf(line, P.config), { conversationApprovals: mode });
        expect(verdict.disposition).toBe("never");
        expect(judgementExecutes(verdict)).toBe(false);
      }
    }
  });

  it("目录在密钥区，gc 这样的别名也硬拒绝", () => {
    for (const mode of ["on", "off"] as const) expect(judge(checkOf("gc x.key", P.secrets), { conversationApprovals: mode }).hardRefusal).toContain("secrets_area");
  });

  it("守卫认得的程序和像路径的词：相对路径按实际跑的目录解析", () => {
    expect(touched(checkOf("rm keep.txt", P.outside))).toEqual([P.outside, `${P.outside}\\keep.txt`]);
    expect(touched(checkOf("Remove-Item .\\keep.txt", P.outside))).toEqual([P.outside, `${P.outside}\\keep.txt`]);
    expect(touched(checkOf("Get-Content ..\\a\\b.txt", P.outside))).toEqual([P.outside, "E:\\a\\b.txt"]);
    expect(touched(checkOf("echo x > w.txt", P.outside))).toEqual([P.outside, `${P.outside}\\w.txt`]);
  });

  it("目录在工作目录里面：不多问；认得的删除照旧算项目内的删除", () => {
    const sub = `${P.workDir}\\sub`;
    const quiet = judge(checkOf("dir", sub));
    expect(quiet.disposition).toBe("log_only");
    expect(quiet.findings).toEqual([]);
    expect(findingIds(judge(checkOf("rm keep.txt", sub)))).toContain("delete_or_overwrite");
  });

  it("目录写法：末尾的反斜杠不会吃掉引号，空格、中文照常，双引号里有特殊意思的字符转义", () => {
    expect(checkOf("dir", "D:\\")).toBe('cd "D:/" && dir');
    expect(touched(checkOf("dir", "D:\\"))).toEqual(["D:\\"]);
    expect(touched(checkOf("rm a", "E:\\有 空格\\x"))).toEqual(["E:\\有 空格\\x", "E:\\有 空格\\x\\a"]);
    expect(checkOf("dir", "E:\\a$b`c")).toBe('cd "E:/a\\$b\\`c" && dir');
    expect(touched(checkOf("rm a", "E:\\a$b`c"))).toEqual(["E:\\a$b`c", "E:\\a$b`c\\a"]);
  });

  it("补判的原样记着模型写的那句和真的目录", () => {
    const check = cwdCheckOf(toGuardCall("c-1", "Bash", { command: "type .\\x" }), "E:\\other");
    expect(check).toMatchObject({ id: "c-1#cwd", toolName: "bash", args: { command: 'cd "E:/other" && type ./x' }, native: { toolName: "Bash", args: { command: "type .\\x", workdir: "E:\\other" } } });
  });
});

describe("PowerShell 写法的命令交给守卫前换成正斜杠（Codex 在 Windows 上默认跑 PowerShell）", () => {
  it("没加引号的绝对路径：密钥区照样硬拒绝。原样给守卫的话反斜杠被当成转义、拆成 D:ergo-datasecretsx.key，认不出来", () => {
    const raw = `Get-Content ${P.secrets}\\x.key`;
    expect(judge(raw).hardRefusal).toBeNull();
    expect(judge(hooked(raw)).hardRefusal).toContain("secrets_area");
    expect(judge(hooked(raw), { conversationApprovals: "off" }).hardRefusal).toContain("secrets_area");
  });

  it("相对路径往上走：原样给守卫的话 ..\\..\\x 拆成工作目录里的 ....x，看不出越界", () => {
    const raw = "Remove-Item ..\\..\\keep.txt";
    expect(findingIds(judge(raw))).not.toContain("outside_project");
    expect(touched(hooked(raw))).toEqual(["E:\\keep.txt"]);
    expect(findingIds(judge(hooked(raw)))).toContain("outside_project");
  });

  it("模型写的原样放在 native；没有反斜杠的不变", () => {
    expect(toGuardCall("c-1", "Bash", { command: "type a\\b" })).toMatchObject({ args: { command: "type a/b" }, native: { args: { command: "type a\\b" } } });
    expect(hooked("git status")).toBe("git status");
  });
});
