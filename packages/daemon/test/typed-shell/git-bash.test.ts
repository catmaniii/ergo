// 找 Git Bash（src/typed-shell/git-bash.ts）。238 号票查到的坑：测试里的守护进程拿到的环境是 process.env 摊平出来的
// 普通对象，键只剩大写（PROGRAMFILES）；实现原来写死 env.ProgramFiles，查不到就掉到 PATH 上 WSL 的 bash，报"找不到 Git Bash"。
// 这里造一个假的 Program Files，不依赖这台机器真的装了 Git。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findGitBash } from "../../src/typed-shell/git-bash.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 一个装着 Git\bin\bash.exe 的假 Program Files（空文件就够：实现只查在不在） */
function fakeProgramFiles(): string {
  const dir = makeTempDir("ergo-program-files-");
  fs.mkdirSync(path.join(dir, "Git", "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Git", "bin", "bash.exe"), "");
  return dir;
}

const bashIn = (programFiles: string) => path.join(programFiles, "Git", "bin", "bash.exe");

describe.runIf(process.platform === "win32")("找 Git Bash", () => {
  it("环境是普通对象、键只有大写（PROGRAMFILES）时也找得到", () => {
    const programFiles = fakeProgramFiles();
    expect(findGitBash({ PROGRAMFILES: programFiles, PATH: process.env.PATH ?? "" })).toBe(bashIn(programFiles));
  });

  it("大小写混着写、ProgramFiles、ProgramFiles(x86)、ProgramW6432 任意一个都认", () => {
    const programFiles = fakeProgramFiles();
    expect(findGitBash({ ProgramFiles: programFiles })).toBe(bashIn(programFiles));
    expect(findGitBash({ "PROGRAMFILES(X86)": programFiles })).toBe(bashIn(programFiles));
    expect(findGitBash({ programw6432: programFiles })).toBe(bashIn(programFiles));
  });

  it("PATH 上只有 System32 的 WSL bash：照样靠 Program Files 找到，不靠 where", () => {
    const programFiles = fakeProgramFiles();
    const before = process.env.PATH;
    try {
      // 只留 System32：where 自己找得到，但 where bash 只能查到 System32 里那个 WSL 的（实现会排除它）
      process.env.PATH = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
      expect(findGitBash({ PROGRAMFILES: programFiles, PATH: process.env.PATH })).toBe(bashIn(programFiles));
    } finally {
      if (before === undefined) delete process.env.PATH;
      else process.env.PATH = before;
    }
  });
});
