// 守卫切面：PowerShell 的文件命令（Codex 在 Windows 上默认跑 PowerShell）。cmdlet 和常用别名按对应的 Unix 命令判，裸文件名算路径。
// 这里用真的拆解和判定函数，不是替身。真的 Codex 上的实测在 test/codex/real-codex.test.ts，补判 workdir 的在 test/codex/guard-workdir.test.ts。
import { describe, expect, it } from "vitest";
import { judgementExecutes, judgeToolCall, toolNature, type ExecutingAgent, type GuardInput, type GuardJudgement } from "../../src/guard/index.ts";
import { splitShellCommand } from "../../src/guard/shell/split.ts";
import { bash, inTask, maintainer, P, v1Satisfied } from "./helpers/guard-input.ts";

const W = (rel: string) => `${P.workDir}\\${rel}`;
const calls = (command: string) => splitShellCommand(command, { cwd: P.workDir, homeDir: P.home }).map((c) => ({ tool: c.tool, ...c.args }));
const tools = (command: string) => calls(command).map((c) => c.tool);
/** 拆出来的调用碰到的路径 */
const touched = (command: string) =>
  calls(command).flatMap((c) => {
    const args = c as Record<string, unknown>;
    return ["path", "from", "to"].flatMap((key) => (args[key] === undefined ? [] : [args[key] as string]));
  });

const input = (command: string, extra: Partial<GuardInput> = {}): GuardInput => inTask(maintainer() as ExecutingAgent, bash(command), { ...v1Satisfied(), ...extra });
const judge = (command: string, extra: Partial<GuardInput> = {}): GuardJudgement => judgeToolCall(input(command, extra));
const ids = (j: GuardJudgement) => j.findings.map((f) => f.id);
const nature = (command: string) => toolNature(input(command), judge(command));

/** 判定结果里要紧的部分（用来比两条命令判得一不一样） */
const verdict = (command: string) => {
  const j = judge(command);
  return { disposition: j.disposition, hardRefusal: j.hardRefusal, categories: j.categories };
};

describe("名字：cmdlet 和常用别名，不分大小写", () => {
  it("删除：Remove-Item、ri、del、erase、rd", () => {
    for (const name of ["Remove-Item", "remove-item", "REMOVE-ITEM", "ri", "del", "DEL", "erase", "rd"]) {
      expect(calls(`${name} keep.txt`)).toEqual([{ tool: "delete", path: W("keep.txt"), recursive: false }]);
    }
    expect(calls("Remove-Item -Recurse -Force build")).toEqual([{ tool: "delete", path: W("build"), recursive: true }]);
  });

  it("写入：Set-Content、sc、Clear-Content、clc、Out-File 整个写；Add-Content、ac、Out-File -Append 追加", () => {
    for (const name of ["Set-Content", "Clear-Content", "clc", "Out-File"]) expect(calls(`${name} a.txt`)).toEqual([{ tool: "write", path: W("a.txt") }]);
    for (const name of ["Add-Content", "ac"]) expect(calls(`${name} a.txt hi`)).toEqual([{ tool: "edit", path: W("a.txt"), append: true }]);
    expect(calls("Out-File a.txt -Append")).toEqual([{ tool: "edit", path: W("a.txt"), append: true }]);
    expect(calls("sc a.txt hi")).toContainEqual({ tool: "write", path: W("a.txt") });
  });

  it("New-Item、ni：默认写文件，-ItemType 决定建目录（mkdir）、建链接（ln，指向哪儿也算路径）；-Name 在 -Path 下面；md 是建目录", () => {
    for (const name of ["New-Item", "ni"]) expect(calls(`${name} a.txt`)).toEqual([{ tool: "write", path: W("a.txt") }]);
    expect(calls("New-Item -ItemType Directory d")).toEqual([{ tool: "make_dir", path: W("d") }]);
    expect(calls("ni -Type d d")).toEqual([{ tool: "make_dir", path: W("d") }]);
    expect(calls("md d")).toEqual([{ tool: "make_dir", path: W("d") }]);
    expect(calls("New-Item -Path sub -Name a.txt -ItemType File")).toEqual([{ tool: "write", path: W("sub\\a.txt") }]);
    expect(calls("New-Item -Name a.txt")).toEqual([{ tool: "write", path: W("a.txt") }]);
    expect(calls("New-Item -Path a.txt -Value hi/there")).toEqual([{ tool: "write", path: W("a.txt") }]);
    expect(touched(`New-Item -ItemType Junction -Path l -Target ${P.config.replaceAll("\\", "/")}`)).toEqual([W("l"), P.config]);
    expect(judge(`New-Item -ItemType SymbolicLink -Path l -Value ${P.config.replaceAll("\\", "/")}`).disposition).toBe("never");
  });

  it("移动、复制：Move-Item、mi、move，Copy-Item、cpi、copy；第二个位置参数或 -Destination 是目标，不写目标是当前目录", () => {
    for (const name of ["Move-Item", "mi", "move"]) expect(calls(`${name} a b`)).toEqual([{ tool: "move", from: W("a"), to: W("b") }]);
    for (const name of ["Copy-Item", "cpi", "copy"]) expect(calls(`${name} a b`)).toEqual([{ tool: "copy", from: W("a"), to: W("b") }]);
    const moved = [{ tool: "move", from: W("a"), to: W("b") }];
    expect(calls("Move-Item -Path a -Destination b")).toEqual(moved);
    expect(calls("Move-Item -Destination b -Path a")).toEqual(moved);
    expect(calls("Move-Item -Destination b a")).toEqual(moved);
    expect(calls("Move-Item a -Destination b -Force")).toEqual(moved);
    expect(calls("Copy-Item a")).toEqual([{ tool: "copy", from: W("a"), to: P.workDir }]);
    expect(calls("Copy-Item a,c b -Recurse")).toEqual([
      { tool: "copy", from: W("a"), to: W("b") },
      { tool: "copy", from: W("c"), to: W("b") },
    ]);
  });

  it("改名：Rename-Item、rni、ren，新名字在原来的目录下面", () => {
    for (const name of ["Rename-Item", "rni", "ren"]) expect(calls(`${name} sub/a.txt b.txt`)).toEqual([{ tool: "move", from: W("sub\\a.txt"), to: W("sub\\b.txt") }]);
    expect(calls("Rename-Item -Path a.txt -NewName b.txt")).toEqual([{ tool: "move", from: W("a.txt"), to: W("b.txt") }]);
    expect(calls("Rename-Item -NewName b.txt -LiteralPath a.txt")).toEqual([{ tool: "move", from: W("a.txt"), to: W("b.txt") }]);
    expect(touched("Rename-Item $x b.txt")).toEqual(["<unresolved:$x>", "<unresolved:$x/b.txt>"]);
  });

  it("读取：Get-Content、gc、type、Get-ChildItem、gci、dir、Test-Path、Select-String、sls", () => {
    for (const name of ["Get-Content", "gc", "type", "Get-ChildItem", "gci", "dir", "Test-Path"]) expect(calls(`${name} a.txt`)).toEqual([{ tool: "read", path: W("a.txt") }]);
    for (const name of ["Select-String", "sls"]) expect(calls(`${name} foo a.txt`)).toEqual([{ tool: "read", path: W("a.txt") }]);
    expect(calls("Select-String -Pattern foo a.txt")).toEqual([{ tool: "read", path: W("a.txt") }]);
    expect(calls("Select-String -Path a.txt foo")).toEqual([{ tool: "read", path: W("a.txt") }]);
    expect(calls("Get-ChildItem")).toEqual([{ tool: "shell_command", program: "get-childitem", paths: [] }]);
    expect(calls("Select-String foo")).toEqual([{ tool: "shell_command", program: "select-string", paths: [] }]);
  });

  it("带模块名的写法同样认", () => {
    expect(calls("Microsoft.PowerShell.Management/Remove-Item keep.txt")).toEqual([{ tool: "delete", path: W("keep.txt"), recursive: false }]);
  });
});

describe("参数：不分大小写、能缩写，开关不算路径，值不是路径", () => {
  it("-Path、-LiteralPath 和它们的缩写、别名、-Path:值 的写法", () => {
    for (const arg of ["-Path a.txt", "-path a.txt", "-PATH a.txt", "-Pa a.txt", "-LiteralPath a.txt", "-Lit a.txt", "-lp a.txt", "-PSPath a.txt", "-Path:a.txt", "-Path: a.txt", '-Path:"a.txt"', "-Lit:a.txt"]) {
      expect(calls(`Remove-Item ${arg}`)).toEqual([{ tool: "delete", path: W("a.txt"), recursive: false }]);
    }
  });

  it("-Destination 的缩写；-FilePath 和它的别名 -Path", () => {
    for (const arg of ["-Destination b", "-Dest b", "-Des b", "-dest b", "-Destination:b"]) expect(calls(`Copy-Item a ${arg}`)).toEqual([{ tool: "copy", from: W("a"), to: W("b") }]);
    for (const arg of ["-FilePath a.txt", "-File a.txt", "-Path a.txt", "-LiteralPath a.txt"]) expect(calls(`Out-File ${arg}`)).toEqual([{ tool: "write", path: W("a.txt") }]);
  });

  it("-Value 不是路径；Set-Content 第一个位置参数是路径、第二个是内容，写了名字的不占位置", () => {
    const written = [{ tool: "write", path: W("a.txt") }];
    expect(calls("Set-Content -Path a.txt -Value b/c.txt")).toEqual(written);
    expect(calls("Set-Content a.txt b/c.txt")).toEqual(written);
    expect(calls("Set-Content -Value b/c.txt a.txt")).toEqual(written);
    expect(calls("Set-Content -Path a.txt b/c.txt")).toEqual(written);
    expect(calls("Set-Content a.txt -Val b/c.txt -Encoding utf8 -NoNewline -Force")).toEqual(written);
    expect(calls("Add-Content -Value b/c.txt a.txt")).toEqual([{ tool: "edit", path: W("a.txt"), append: true }]);
  });

  it("-Recurse、-Force 这类开关不算路径，带值的（-Filter、-Encoding、-TotalCount）值也不算", () => {
    expect(calls("Get-ChildItem sub -Recurse -Force -Filter *.ts -Depth 2 -File")).toEqual([{ tool: "read", path: W("sub") }]);
    expect(calls("Get-ChildItem sub *.ts")).toEqual([{ tool: "read", path: W("sub") }]);
    expect(calls("Get-Content a.txt -TotalCount 5 -Encoding utf8 -Raw")).toEqual([{ tool: "read", path: W("a.txt") }]);
    expect(calls("Remove-Item a.txt -Recurse -Force -ErrorAction SilentlyContinue")).toEqual([{ tool: "delete", path: W("a.txt"), recursive: true }]);
    expect(calls("Remove-Item -r -fo a.txt")).toEqual([{ tool: "delete", path: W("a.txt"), recursive: true }]);
    expect(calls("Remove-Item a.txt -Recurse:$false")[0]).toMatchObject({ tool: "delete", path: W("a.txt") });
  });

  it("逗号是数组：a,b、a, b、\"a\",\"b\"；整个加了引号的是一个文件名", () => {
    const both = [
      { tool: "delete", path: W("a.txt"), recursive: false },
      { tool: "delete", path: W("b.txt"), recursive: false },
    ];
    for (const list of ["a.txt,b.txt", "a.txt, b.txt", "a.txt ,b.txt", '"a.txt","b.txt"', "'a.txt', 'b.txt'", "-Path a.txt,b.txt", "-Path a.txt, b.txt"]) expect(calls(`Remove-Item ${list}`)).toEqual(both);
    expect(touched('Remove-Item "a,b.txt"')).toEqual([W("a,b.txt")]);
    expect(touched("Set-Content a.txt, b.txt hi")).toEqual([W("a.txt"), W("b.txt")]);
  });

  it("认不得的参数当开关，后面的词当路径（宁可多判）；加了引号的不是参数名；-- 之后都是路径", () => {
    expect(touched("Remove-Item -Bogus x.txt")).toEqual([W("x.txt")]);
    expect(touched('Remove-Item "-Path" x.txt')).toEqual([W("-Path"), W("x.txt")]);
    expect(touched("Remove-Item -- -Path")).toEqual([W("-Path")]);
    // 有歧义的缩写（Set-Content 的 -Pa 是 -Path 还是 -PassThru）：PowerShell 自己报错，这里后面的词照样当路径
    expect(touched("Set-Content -Pa a.txt hi")).toEqual([W("a.txt")]);
  });
});

describe("没法确定的路径：不能当成确定的", () => {
  it("$env:、$变量、$( ) 走没法确定的路径", () => {
    expect(touched("Remove-Item $env:TEMP/x.txt")).toEqual(["<unresolved:$env:TEMP/x.txt>"]);
    expect(touched("Remove-Item $x")).toEqual(["<unresolved:$x>"]);
    expect(touched('Set-Content "$env:APPDATA/x.json" hi')).toEqual(['<unresolved:"$env:APPDATA/x.json">']);
    expect(touched("Get-Content -Path:$x")).toEqual(["<unresolved:$x>"]);
    expect(touched("Remove-Item $(Get-Content list.txt)")).toEqual([W("list.txt"), "<unresolved:$(Get-Content list.txt)>"]);
    // 数组里确定的那个照样认出来：密钥区不能因为前面有个变量就只算没法确定
    expect(touched(`Get-Content $a,${P.secrets.replaceAll("\\", "/")}/x.key`)).toEqual(["<unresolved:$a>", `${P.secrets}\\x.key`]);
  });

  it("写、删没法确定的路径：可能碰到硬底线，对话审批关着也要问；和 rm \"$X\" 判得一样", () => {
    for (const command of ["Remove-Item $env:TEMP/x.txt", "Set-Content $x hi", "Remove-Item $(Get-Date)"]) {
      for (const mode of ["on", "off"] as const) {
        const j = judge(command, { conversationApprovals: mode });
        expect([`${command} ${mode}`, j.disposition]).toEqual([`${command} ${mode}`, "ask_first"]);
        expect(ids(j)).toContain("outside_project");
      }
    }
    expect(judge("Remove-Item $x").disposition).toBe(judge('rm "$x"').disposition);
  });

  it("读没法确定的路径和 cat \"$X\" 一样：对话审批开着问，关着放行；原文写着密钥区、数据目录的认得出来（数据目录在主目录下的 .ergo）", () => {
    expect(judge("Get-Content $x").disposition).toBe("ask_first");
    expect(judgementExecutes(judge("Get-Content $x", { conversationApprovals: "off" }))).toBe(true);

    const root = `${P.home}\\.ergo`;
    const places = { dataDir: { root, config: `${root}\\config`, secrets: `${root}\\secrets`, db: `${root}\\db`, projects: `${root}\\projects` }, programDir: P.programDir, homeDir: P.home, ownPorts: P.ownPorts };
    for (const command of ["Get-Content $env:USERPROFILE/.ergo/secrets/x.key", 'gc "$env:USERPROFILE/.ergo/secrets/x.key"', "cat $env:USERPROFILE/.ergo/secrets/x.key", "Get-Content -Path:$env:USERPROFILE/.ergo/secrets/x.key"]) {
      for (const mode of ["on", "off"] as const) expect([`${command} ${mode}`, judge(command, { conversationApprovals: mode, places }).disposition]).toEqual([`${command} ${mode}`, "never"]);
    }
    expect(judge("Remove-Item $env:USERPROFILE/.ergo/config/ergo.json", { conversationApprovals: "off", places }).disposition).toBe("ask_first");
    expect(judge("Remove-Item $env:USERPROFILE/.ergo/config/ergo.json", { conversationApprovals: "off", places }).findings.some((f) => f.message.includes(".ergo"))).toBe(true);
    // cd 到写着变量的目录：之后的裸文件名没法确定，原文写着的认得出来
    for (const line of ["cd $env:USERPROFILE/.ergo/secrets; gc x.key", "Set-Location $env:USERPROFILE/.ergo/secrets; gc x.key"]) {
      expect([line, judge(line, { conversationApprovals: "off", places }).disposition]).toEqual([line, "never"]);
    }
  });

  it("@参数表（splatting）、别的提供程序（HKLM:、Env:）不是确定的文件路径", () => {
    expect(touched("Remove-Item @p")).toEqual(["<unresolved:@p>"]);
    expect(touched("Remove-Item HKLM:/Software/x")).toEqual(["<unresolved:HKLM:/Software/x>"]);
    expect(touched("Get-Content Env:SECRET")).toEqual(["<unresolved:Env:SECRET>"]);
  });

  it("FileSystem:: 和 \\\\?\\ 前缀去掉再判：不能靠前缀绕过受保护区域", () => {
    const config = P.config.replaceAll("\\", "/");
    for (const path of [`FileSystem::${config}/x.json`, `Microsoft.PowerShell.Core/FileSystem::${config}/x.json`, `//?/${config}/x.json`, `//./${config}/x.json`]) {
      expect(touched(`Remove-Item ${path}`)).toEqual([`${P.config}\\x.json`]);
      expect(judge(`Remove-Item ${path}`, { conversationApprovals: "off" }).disposition).toBe("never");
    }
  });

  it("通配符走判定函数现成的那条路，和 rm *.json 判得一样：受保护区、密钥区照拒，项目里读不打扰", () => {
    expect(touched("Remove-Item *.json")).toEqual([W("*.json")]);
    expect(verdict("Remove-Item *.json")).toEqual(verdict("rm *.json"));
    const config = P.config.replaceAll("\\", "/");
    const secrets = P.secrets.replaceAll("\\", "/");
    for (const mode of ["on", "off"] as const) {
      expect(judge(`cd "${config}" && Remove-Item *.json`, { conversationApprovals: mode }).disposition).toBe("never");
      expect(judge(`Set-Content ${config}/*.json hi`, { conversationApprovals: mode }).disposition).toBe("never");
      expect(judge(`Get-Content ${secrets}/*`, { conversationApprovals: mode }).hardRefusal).toContain("secrets_area");
    }
    expect(judge("Get-Content src/*.ts").disposition).toBe("log_only");
  });
});

describe("路径经管道来：拿不准按未知的写操作判", () => {
  it("写、删、移动没写路径：拆不开", () => {
    for (const command of [
      "Get-ChildItem x | Remove-Item",
      "gci x | del -Force",
      "Get-Content list.txt | ri",
      "Get-ChildItem x | Clear-Content",
      "Get-ChildItem x | Set-Content -Value hi",
      "Get-ChildItem x | Add-Content -Value hi",
      "Get-ChildItem x | Rename-Item -NewName y",
      "Get-ChildItem x | Move-Item -Destination y",
      "Get-ChildItem x | Copy-Item -Destination y",
      "Get-ChildItem x | Out-File",
      "Get-ChildItem x | New-Item",
    ]) {
      expect(tools(command)).toContain("opaque_shell");
      expect(ids(judge(command))).toContain("unknown_write");
      expect([command, judge(command).disposition]).toEqual([command, "ask_first"]);
    }
  });

  it("不能放过：写、删从管道来的路径，对话审批关着也要问，和 xargs rm 一样", () => {
    for (const command of ["Get-ChildItem x | Remove-Item", "gci x | del -Force", "Get-ChildItem x | Set-Content -Value hi", "Get-ChildItem x | Add-Content -Value hi", "Get-ChildItem x | Clear-Content", "Get-ChildItem x | Rename-Item -NewName y", "Get-ChildItem x | Move-Item -Destination y", "Get-ChildItem x | New-Item"]) {
      const j = judge(command, { conversationApprovals: "off" });
      expect([command, j.disposition]).toEqual([command, "ask_first"]);
      expect([command, judgementExecutes(j)]).toEqual([command, false]);
    }
    expect(judge("find x | xargs rm", { conversationApprovals: "off" }).disposition).toBe("ask_first");
  });

  it("目标写明了的照样判：不能因为来源在管道里就放过受保护区", () => {
    const j = judge(`Get-ChildItem x | Copy-Item -Destination ${P.config.replaceAll("\\", "/")}`, { conversationApprovals: "off" });
    expect(j.disposition).toBe("never");
  });

  it("管道前面写着受保护区、当前目录在受保护区：拆不开的那一段照样拦", () => {
    const config = P.config.replaceAll("\\", "/");
    const secrets = P.secrets.replaceAll("\\", "/");
    // 前面的 Get-ChildItem 写着配置区，后面的脚本块拆不开：原文算上整条管道
    expect(judge(`Get-ChildItem ${config} | % { del $_ }`, { conversationApprovals: "off" }).disposition).toBe("ask_first");
    expect(judge(`Get-ChildItem ${config} | Remove-Item`, { conversationApprovals: "off" }).disposition).toBe("ask_first");
    expect(judgementExecutes(judge(`Get-ChildItem ${secrets} | % { $_ -replace 'a' }`, { conversationApprovals: "off" }))).toBe(false);
    // 当前目录在配置区
    for (const mode of ["on", "off"] as const) {
      expect(judge(`cd "${config}" && Get-ChildItem | % { del $_ }`, { conversationApprovals: mode }).disposition).toBe("never");
      expect(judge(`cd "${config}" && Get-ChildItem | Remove-Item`, { conversationApprovals: mode }).disposition).toBe("never");
      expect(judge(`cd "${config}" && iex 'del x'`, { conversationApprovals: mode }).disposition).toBe("never");
    }
  });

  it("读取路径从管道来也拆不开；Select-String 筛的是文字，和 grep 一样不打扰", () => {
    expect(tools("Get-ChildItem x | Get-Content")).toContain("opaque_shell");
    expect(tools("Get-Content list.txt | Get-ChildItem")).toContain("opaque_shell");
    expect(judge("Get-Content a.txt | Select-String foo").disposition).toBe("log_only");
    expect(judge("git log | sls foo").disposition).toBe("log_only");
  });

  it("写了路径的不算：内容从管道来，路径是确定的", () => {
    expect(calls("Get-Content a.txt | Set-Content b.txt")).toEqual([
      { tool: "read", path: W("a.txt") },
      { tool: "write", path: W("b.txt") },
    ]);
    expect(tools("Get-Content a.txt | Out-File b.txt")).toEqual(["read", "write"]);
  });

  it("ForEach-Object 的脚本块拆不开；只取属性的不碰文件", () => {
    for (const command of ["gci x | % { Remove-Item $_ }", "gci x | ForEach-Object { del $_.FullName }", "gci x | foreach { rm $_ }", "gci x | % { Set-Content $_ hi }", "gci x | % {del $_}"]) {
      expect(tools(command)).toContain("opaque_shell");
    }
    for (const command of ["gci x | % { $_.FullName }", "gci x | ForEach-Object {$_.Name}", "gci x | % Name"]) {
      expect(tools(command)).not.toContain("opaque_shell");
      expect([command, judge(command).disposition]).toEqual([command, "log_only"]);
      expect([command, nature(command)]).toEqual([command, "look"]);
    }
  });

  it("cmdlet 带脚本块的参数（-NewName { … }）、iex、Invoke-Command、Start-Process、Invoke-Item：拆不开", () => {
    for (const command of ["Rename-Item a -NewName { $_.Name + '.bak' }", "iex 'Remove-Item x'", "Invoke-Expression $x", "icm { Remove-Item x }", "Invoke-Command -ScriptBlock { del x }", "Start-Process cmd", "saps cmd", "Invoke-Item x.exe", "ii x.exe"]) {
      expect(tools(command)).toContain("opaque_shell");
    }
  });

  it("xargs 补上的参数算没法确定的路径", () => {
    expect(touched("cat list.txt | xargs Remove-Item")).toEqual([W("list.txt"), expect.stringContaining("<unresolved:")]);
  });

  it("语法过不去的（圆括号表达式、if）：整句拆不开，原文里写着密钥区照样判永不", () => {
    expect(tools("Remove-Item (Join-Path a b)")).toEqual(["opaque_shell"]);
    expect(tools("if (Test-Path x) { Remove-Item x }")).toEqual(["opaque_shell"]);
    expect(judge(`Get-Content (Join-Path ${P.secrets.replaceAll("\\", "/")} x.key)`).disposition).toBe("never");
  });
});

describe("票 383 第 5 条：改完之后判成什么", () => {
  const config = P.config.replaceAll("\\", "/");
  const secrets = P.secrets.replaceAll("\\", "/");

  it("删项目外的：不带 -Recurse 要问；带了和项目外的 rm -rf 一样判永不", () => {
    const outside = P.outside.replaceAll("\\", "/");
    expect(judge(`Remove-Item ${outside}/a.txt`).disposition).toBe("ask_first");
    expect(verdict(`Remove-Item ${outside}/a.txt`)).toEqual(verdict(`rm ${outside}/a.txt`));
    for (const mode of ["on", "off"] as const) {
      expect(judge(`Remove-Item -Recurse -Force ${outside}/d`, { conversationApprovals: mode }).disposition).toBe("never");
      expect(judge(`rd -r ${outside}/d`, { conversationApprovals: mode }).disposition).toBe("never");
      expect(judge(`rm -rf ${outside}/d`, { conversationApprovals: mode }).disposition).toBe("never");
    }
  });

  it("项目里 Remove-Item keep.txt 判成删除，和 rm 判得一样", () => {
    const j = judge("Remove-Item keep.txt");
    expect(ids(j)).toContain("delete_or_overwrite");
    expect(j.findings.find((f) => f.id === "delete_or_overwrite")?.message).toContain(W("keep.txt"));
    expect(ids(j)).not.toContain("outside_project");
    expect(verdict("Remove-Item keep.txt")).toEqual(verdict("rm keep.txt"));
    expect(nature("Remove-Item keep.txt")).toBe("modify");
  });

  it("cd 到配置区再 Remove-Item x.json、Set-Content x.json：写受保护区，硬拒绝，对话审批关着也一样", () => {
    for (const line of ["Remove-Item x.json", "Set-Content x.json", "Set-Content x.json hi", "ri x.json", "del x.json", "sc x.json hi", "Add-Content x.json hi", "Clear-Content x.json", "Out-File x.json", "New-Item x.json", "Move-Item a x.json", "Copy-Item a x.json", "Rename-Item a x.json"]) {
      for (const mode of ["on", "off"] as const) {
        const j = judge(`cd "${config}" && ${line}`, { conversationApprovals: mode });
        expect([`${line} ${mode}`, j.disposition]).toEqual([`${line} ${mode}`, "never"]);
        expect([line, j.findings.some((f) => f.id === "protected_area" && f.message.includes(`${P.config}\\`))]).toEqual([line, true]);
        expect([`${line} ${mode}`, judgementExecutes(j)]).toEqual([`${line} ${mode}`, false]);
      }
    }
  });

  it("数据库区、程序目录同样；模型自己写 cd x; Remove-Item y（不带 workdir）也一样", () => {
    for (const dir of [P.db, P.programDir]) {
      const d = dir.replaceAll("\\", "/");
      for (const mode of ["on", "off"] as const) {
        expect(judge(`cd "${d}" && Remove-Item x.json`, { conversationApprovals: mode }).disposition).toBe("never");
        expect(judge(`cd ${d}; Set-Content x.json hi`, { conversationApprovals: mode }).disposition).toBe("never");
      }
    }
  });

  it("cd 到密钥区再 Get-Content x.key、gc x.key：硬拒绝，对话审批关着也一样", () => {
    for (const line of ["Get-Content x.key", "gc x.key", "type x.key", "Select-String foo x.key", "Test-Path x.key"]) {
      for (const mode of ["on", "off"] as const) {
        const j = judge(`cd "${secrets}" && ${line}`, { conversationApprovals: mode });
        expect(j.hardRefusal).toContain("secrets_area");
        expect(judgementExecutes(j)).toBe(false);
      }
    }
    expect(judge(`Get-Content ${secrets}/x.key`, { conversationApprovals: "off" }).hardRefusal).toContain("secrets_area");
    expect(judge(`Get-Content -LiteralPath ${secrets}/x.key`, { conversationApprovals: "off" }).hardRefusal).toContain("secrets_area");
  });

  it("Get-ChildItem、Get-Content 读项目内文件不打扰用户：只记录，算只看", () => {
    for (const command of ["Get-ChildItem", "Get-ChildItem src", "Get-ChildItem -Recurse -Filter *.ts", "gci src -Force", "dir", "Get-Content a.txt", "gc a.txt", "type a.txt", "Get-Content src/a.ts -TotalCount 20", "Test-Path a.txt", "Select-String foo a.txt", "Get-Content a.txt 2>$null"]) {
      for (const mode of ["on", "off"] as const) {
        const j = judge(command, { conversationApprovals: mode });
        expect([`${command} ${mode}`, j.disposition]).toEqual([`${command} ${mode}`, "log_only"]);
        expect([command, j.findings]).toEqual([command, []]);
      }
      expect([command, nature(command)]).toEqual([command, "look"]);
    }
  });

  it("读项目外的：和 cat 判得一样，先问", () => {
    const outside = P.outside.replaceAll("\\", "/");
    expect(ids(judge(`Get-Content ${outside}/a.txt`))).toContain("outside_project");
    expect(verdict(`Get-Content ${outside}/a.txt`)).toEqual(verdict(`cat ${outside}/a.txt`));
    expect(verdict(`cd ${outside} && gc a.txt`)).toEqual(verdict(`cd ${outside} && cat a.txt`));
  });
});

describe("和现成的程序名撞上的、PowerShell 里也是别名的", () => {
  const config = P.config.replaceAll("\\", "/");
  const secrets = P.secrets.replaceAll("\\", "/");

  it("sc：管服务的写法只算账户与安全，别的也算写文件（PowerShell 5 里 sc 是 Set-Content）", () => {
    for (const command of ["sc query foo", "sc config svc start= auto", "sc.exe x.json", "SC STOP foo"]) {
      expect([command, tools(command)]).toEqual([command, ["account_command"]]);
      expect([command, judge(command).categories]).toEqual([command, ["account_security"]]);
    }
    expect(tools("sc //server query foo")).not.toContain("write");
    expect(tools("sc x.json hi")).toEqual(["account_command", "write"]);
    expect(judge(`cd "${config}" && sc x.json hi`, { conversationApprovals: "off" }).disposition).toBe("never");
  });

  it("dir、type 也是 Git Bash 里的：GNU 的开关、查命令的写法照常，不多问", () => {
    expect(calls("dir -la sub")).toEqual([{ tool: "read", path: W("sub") }]);
    expect(calls("dir a b")).toEqual([
      { tool: "read", path: W("a") },
      { tool: "read", path: W("b") },
    ]);
    expect(calls("dir")).toEqual([{ tool: "shell_command", program: "dir", paths: [] }]);
    expect(judge("type -a node").disposition).toBe("log_only");
    expect(judge("type node").disposition).toBe("log_only");
    expect(nature("type node")).toBe("look");
  });

  it("rm、mv、cp、cat、ls、cd 写了路径参数的按 cmdlet 拆：-Destination 不会认反，-Path:x 不会漏", () => {
    expect(calls("cp -Destination b a")).toEqual([{ tool: "copy", from: W("a"), to: W("b") }]);
    expect(calls("mv -Dest b -Path a")).toEqual([{ tool: "move", from: W("a"), to: W("b") }]);
    expect(calls("rm -Path:a.txt -Recurse")).toEqual([{ tool: "delete", path: W("a.txt"), recursive: true }]);
    expect(calls("rm -LiteralPath a.txt")).toEqual([{ tool: "delete", path: W("a.txt"), recursive: false }]);
    expect(calls("cat -Path:a.txt")).toEqual([{ tool: "read", path: W("a.txt") }]);
    expect(calls("ls -Path:sub")).toEqual([{ tool: "read", path: W("sub") }]);
    expect(calls("mkdir -Path:d")).toEqual([{ tool: "make_dir", path: W("d") }]);
    expect(judge(`cp -Destination ${config}/x.json a`, { conversationApprovals: "off" }).disposition).toBe("never");
    expect(judge(`cat -Path:${secrets}/x.key`, { conversationApprovals: "off" }).hardRefusal).toContain("secrets_area");
  });

  it("Unix 的写法不变", () => {
    expect(calls("rm -rf build")).toEqual([{ tool: "delete", path: W("build"), recursive: true }]);
    expect(calls("rm -Recurse -Force build")).toEqual([{ tool: "delete", path: W("build"), recursive: true }]);
    expect(calls("cp -r a b")).toEqual([{ tool: "copy", from: W("a"), to: W("b") }]);
    expect(calls("cp -pa a b")).toEqual([{ tool: "copy", from: W("a"), to: W("b") }]);
    expect(calls("cp -t b a")).toEqual([{ tool: "copy", from: W("a"), to: W("b") }]);
    expect(calls("ls -la sub")).toEqual([{ tool: "read", path: W("sub") }]);
    expect(calls("cat -n a.txt")).toEqual([{ tool: "read", path: W("a.txt") }]);
    expect(calls("mkdir -p a/b")).toEqual([{ tool: "make_dir", path: W("a\\b") }]);
  });

  it("Set-Location、sl、chdir、Push-Location 和 cd 一样记下当前目录：后面的裸文件名按那里解析", () => {
    for (const name of ["Set-Location", "sl", "chdir", "Push-Location"]) {
      for (const mode of ["on", "off"] as const) expect([name, judge(`${name} ${config}; Remove-Item x.json`, { conversationApprovals: mode }).disposition]).toEqual([name, "never"]);
      expect(calls(`${name} sub && Remove-Item x.json`).at(-1)).toEqual({ tool: "delete", path: W("sub\\x.json"), recursive: false });
    }
    for (const line of [`Set-Location -Path ${config}`, `Set-Location -LiteralPath:${config}`, `cd -Path:${config}`, `cd -LiteralPath ${config}`]) {
      expect([line, judge(`${line}; Remove-Item x.json`, { conversationApprovals: "off" }).disposition]).toEqual([line, "never"]);
    }
    expect(judge(`Set-Location ${secrets} && gc x.key`, { conversationApprovals: "off" }).hardRefusal).toContain("secrets_area");
  });
});

describe("程序表没列、动词是写东西的 cmdlet：裸词也当路径，看不出读写按写算", () => {
  const config = P.config.replaceAll("\\", "/");
  const writers = ["Export-Csv x.json", "Export-Csv -Path x.json -NoTypeInformation", "Export-Csv -Path:x.json", "Tee-Object x.json", "Tee-Object -FilePath x.json", "Compress-Archive a -DestinationPath x.zip", "Set-Item x.json hi", "Clear-Item x.json", "Save-Thing x.json"];

  it("跑在受保护区里判永不，对话审批关着也一样", () => {
    for (const line of writers) {
      for (const mode of ["on", "off"] as const) expect([`${line} ${mode}`, judge(`cd "${config}" && ${line}`, { conversationApprovals: mode }).disposition]).toEqual([`${line} ${mode}`, "never"]);
    }
  });

  it("项目里不多问", () => {
    for (const line of writers) {
      expect([line, judge(line).disposition]).toEqual([line, "log_only"]);
      expect([line, judge(line).findings]).toEqual([line, []]);
    }
  });

  it("写的是变量：看不出是哪儿，对话审批关着也要问", () => {
    expect(judge("Export-Csv $x", { conversationApprovals: "off" }).disposition).toBe("ask_first");
  });

  it("筛东西的（Select-Object、Sort-Object、Get-Item……）不算：管道里常见，参数不是路径", () => {
    expect(calls("Get-Item a.txt")).toEqual([{ tool: "shell_command", program: "get-item", paths: [] }]);
    expect(calls("Select-Object -First 5")).toEqual([{ tool: "shell_command", program: "select-object", paths: [] }]);
    expect(judge(`cd "${config}" && Get-Content a.txt | Select-Object -First 5`).disposition).toBe("ask_first");
    expect(judgementExecutes(judge(`cd "${config}" && Get-Content a.txt | Select-Object -First 5`, { conversationApprovals: "off" }))).toBe(true);
  });
});

describe("PowerShell 的 2>$null", () => {
  it("丢掉输出，不是写文件：读项目内的不问", () => {
    for (const redirect of ["2>$null", "2> $null", ">$null", "2>$NULL"]) {
      expect(calls(`Get-Content a.txt ${redirect}`)).toEqual([{ tool: "read", path: W("a.txt") }]);
    }
  });

  it("反例：命令里赋过 null、source 过的照旧算路径", () => {
    expect(touched("null=x.txt; echo hi > $null")).toEqual([W("x.txt")]);
    expect(touched("read null; echo hi > $null")).toEqual(["<unresolved:$null>"]);
    expect(touched("source a.sh; echo hi > $null")).toContain("<unresolved:$null>");
  });
});

describe("Git Bash 里写了 PowerShell 的名字（pi、Claude Code 的 Bash 工具）：这些命令在那里跑不起来，判定变严只多问一次", () => {
  it("del、Remove-Item 算删除，Set-Content 算写", () => {
    expect(ids(judge("del x.txt"))).toContain("delete_or_overwrite");
    expect(ids(judge("Remove-Item x.txt"))).toContain("delete_or_overwrite");
    expect(tools("Set-Content x.txt hi")).toEqual(["write"]);
  });
});
