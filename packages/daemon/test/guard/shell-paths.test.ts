// 守卫切面（177 号票）：通用 bash 的路径看得准一点——
// - 同一条命令里定义的变量代进去：只认前面定义、后面使用；条件里、子 shell 里、管道里、后台的、函数里赋的值，循环回头再用的，
//   读进来的（read、mapfile、printf -v……）、命令替换的、source 过的，照旧看不准；
// - 哪些参数是路径：echo、printf 的参数和格式串、grep 的模式、sed 的脚本、tr 的字符集、basename / dirname 的字不是路径；
//   命令替换里面的命令照样单独检查；整个 "$(...)" 本身不当路径看（和 "$X" 一样），拼在路径里的照旧是没法确定的路径；
// - Git Bash 的 /tmp：守卫知道它挂到哪（agent 的 bashTmp）就按那个目录判；不知道照旧看不准。$TMPDIR 这些按 agent 的环境变量展开。
// 每一种"看得准"都配了反例：真看不准的照旧问，碰受保护区域、密钥的照旧拦。
// wo-10（2026-10-19 AI 简报站日报那一轮）弹出审批卡的 5 条命令原样放在最后：改之前问，改之后不问。
import { describe, expect, it } from "vitest";
import { judgeToolCall, type ExecutingAgent, type GuardJudgement } from "../../src/guard/index.ts";
import { resolveAgentPath, type ShellEnv } from "../../src/guard/paths.ts";
import { splitShellCommand } from "../../src/guard/shell/split.ts";
import { bash, dispositionFinding, inChat, inTask, maintainer, P, secretary, v1Satisfied } from "./helpers/guard-input.ts";

const ENV: ShellEnv = { cwd: P.workDir, homeDir: P.home };
const W = (rel: string) => `${P.workDir}\\${rel}`;

/** 拆出来的调用里碰到的路径（path、paths、from、to、repoPath），没法确定的写成 <unresolved:…> */
function touched(command: string, env: ShellEnv = ENV): string[] {
  const out: string[] = [];
  for (const c of splitShellCommand(command, env)) {
    for (const key of ["path", "paths", "from", "to", "repoPath"]) {
      const v = c.args[key];
      for (const p of Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]) out.push(String(p));
    }
  }
  return out;
}
const unresolved = (command: string, env?: ShellEnv) => touched(command, env).filter((p) => p.startsWith("<unresolved:"));

/** 任务里的维护者（v1 模板的前提满足），对话审批开着（不传按 on）：看的是判定本身，不靠"超出授权先不管" */
const judge = (command: string, agent: ExecutingAgent = maintainer() as ExecutingAgent): GuardJudgement =>
  judgeToolCall(inTask(agent, bash(command), v1Satisfied()));
const asks = (j: GuardJudgement) => j.disposition === "ask_first" || j.disposition === "never" || j.hardRefusal !== null;

describe("同一条命令里定义的变量代进去", () => {
  it("&&、;、export、换行之后用：代进去", () => {
    expect(touched("A=out && cat $A/x.txt")).toEqual([W("out\\x.txt")]);
    expect(touched("A=out; cat $A/x.txt")).toEqual([W("out\\x.txt")]);
    expect(touched("export A=out; cat $A/x.txt")).toEqual([W("out\\x.txt")]);
    expect(touched("A=out\ncat $A/x.txt")).toEqual([W("out\\x.txt")]);
    // 由已知的变量拼成
    expect(touched('DATE=2026-10-19 && LOG=logs/$DATE.log && echo hi >> "$LOG"')).toEqual([W("logs\\2026-10-19.log")]);
    // 一条命令里连着几个赋值：从左到右，后面的看得到前面的
    expect(touched("A=out B=$A/y; cat $B")).toEqual([W("out\\y")]);
    // && 链上一个个往后传（cd 失败时后面都不跑）
    expect(touched("cd sub && A=out && cat $A/x")).toEqual([W("sub"), W("sub\\out\\x")]);
    // if 的两个分支都赋了值：两个值都算
    expect(touched("if [ -f a ]; then A=x; else A=y; fi; cat $A")).toEqual(expect.arrayContaining([W("x"), W("y")]));
  });

  it("反例：先用后赋、值来自命令替换、只在命令前面临时设的，照旧看不准", () => {
    expect(unresolved('rm -rf "$A"; A=build')).toEqual(['<unresolved:"$A">']);
    expect(unresolved('A=$(pwd); rm -rf "$A/x"')).toEqual(['<unresolved:"$A/x">']);
    // `A=… cmd`：$A 在赋值之前就展开了
    expect(unresolved('A=build rm -rf "$A/x"')).toEqual(['<unresolved:"$A/x">']);
    // 不认得的 ${A:-…} 这类展开照旧看不准
    expect(unresolved('A=build; rm -rf "${A:-/}x"')).toHaveLength(1);
  });

  it("反例：赋值可能没发生（条件里、|| 后面、&& 链之后），后面用到时看不准", () => {
    expect(unresolved('[ -f y ] && A=build; rm -rf "$A/"')).toEqual(['<unresolved:"$A/">']);
    expect(unresolved('cd sub && A=build; rm -rf "$A/"')).toEqual(['<unresolved:"$A/">']);
    expect(unresolved('false || A=build; rm -rf "$A/"')).toEqual(['<unresolved:"$A/">']);
    expect(unresolved('if [ -f y ]; then A=build; fi; rm -rf "$A/"')).toEqual(['<unresolved:"$A/">']);
    expect(unresolved('case "$1" in a) A=build;; esac; rm -rf "$A/"')).toEqual(['<unresolved:"$A/">']);
    expect(unresolved('for f in a b; do A=build; done; rm -rf "$A/"')).toEqual(['<unresolved:"$A/">']);
    // 之前有确定的值、条件里又赋了一个：两个都算
    expect(touched('A=a; [ -f y ] && A=b; cat "$A"')).toEqual([W("a"), W("b")]);
  });

  it("反例：子 shell、管道、后台里赋的值不往外传", () => {
    expect(unresolved('(A=build); rm -rf "$A/x"')).toEqual(['<unresolved:"$A/x">']);
    expect(unresolved('A=build | true; rm -rf "$A/x"')).toEqual(['<unresolved:"$A/x">']);
    expect(unresolved('A=build & rm -rf "$A/x"')).toEqual(['<unresolved:"$A/x">']);
    expect(unresolved('echo "$(A=build)"; rm -rf "$A/x"')).toEqual(['<unresolved:"$A/x">']);
    // 之前有值的，子 shell 里改了也还是原来的
    expect(touched('A=out; (A=../..); cat "$A/x"')).toEqual([W("out\\x")]);
  });

  it("反例：循环回头再用时，看得到后面赋的值和 cd", () => {
    expect(judge('A=build; for i in 1 2; do rm -rf "$A"; A=../..; done').categories).toContain("outside_project");
    expect(judge('A=build; while true; do rm -rf "$A"; A="../$A"; done').categories).toContain("outside_project");
    expect(judge("while true; do rm -rf x; cd ..; done").categories).toContain("outside_project");
    // 子 shell 里 cd：不往外传，每一轮都从原来的目录开始
    expect(touched("for d in a b; do (cd $d && rm -rf x); done").toSorted()).toEqual([W("a"), W("a\\x"), W("b"), W("b\\x")]);
    // continue 时的样子也回到循环开头
    expect(judge('A=x; while true; do [ -f y ] && { A=../..; continue; }; rm -rf "$A"; done').categories).toContain("outside_project");
    // 循环变量是静态的词：照常代进去
    expect(touched('for f in a.txt b.txt; do cat "$f"; done')).toEqual([W("a.txt"), W("b.txt")]);
  });

  it("反例：读进来的（read、mapfile、printf -v、getopts、let）、unset 的、${A:=…} 赋的，看不准", () => {
    expect(unresolved('while read -r f; do rm "$f"; done < list.txt')).toEqual(['<unresolved:"$f">']);
    expect(unresolved('A=build; read -r A < f.txt; rm -rf "$A"')).toEqual(['<unresolved:"$A">']);
    expect(unresolved('A=build; IFS=, read -r x A < f.txt; rm -rf "$A"')).toEqual(['<unresolved:"$A">']);
    expect(unresolved('A=build; mapfile -t A < f.txt; rm -rf "$A"')).toEqual(['<unresolved:"$A">']);
    expect(unresolved("A=build; printf -v A '%s' ../..; rm -rf \"$A\"")).toEqual(['<unresolved:"$A">']);
    expect(unresolved('A=build; getopts ab A; rm -rf "$A"')).toEqual(['<unresolved:"$A">']);
    expect(unresolved('A=build; let A=1; rm -rf "$A"')).toEqual(['<unresolved:"$A">']);
    expect(unresolved('A=build; (( A = 1 )); rm -rf "$A"')).toEqual(['<unresolved:"$A">']);
    expect(unresolved('A=build; unset A; rm -rf "$A/"')).toEqual(['<unresolved:"$A/">']);
    expect(unresolved(': ${A:=../..}; rm -rf "$A/x"')).toEqual(['<unresolved:"$A/x">']);
  });

  it("反例：declare / local 带选项的（-n 引用别的变量、-i 算术……）看不准；export、local 不带选项的照常", () => {
    expect(unresolved('declare -n R=X; rm -rf "$R"')).toEqual(['<unresolved:"$R">']);
    expect(unresolved('declare -i A=1+1; rm -rf "$A"')).toEqual(['<unresolved:"$A">']);
    expect(touched("local A=out; cat $A")).toEqual([W("out")]);
    expect(touched("readonly A=out; cat $A")).toEqual([W("out")]);
  });

  it("函数在调用的地方按那时的样子走；递归的按什么都没法确定；source 过的脚本之后看不准", () => {
    // 调用时函数体改了变量、用的是调用时的值
    expect(judge('f() { A=../..; }; A=build; f; rm -rf "$A/x"').categories).toContain("outside_project");
    expect(judge('A=build; f() { rm -rf "$A/x"; }; A=../..; f').categories).toContain("outside_project");
    expect(judge('A=build; f() { rm -rf "$A/x"; }; f').categories).toEqual(["delete_or_overwrite"]);
    // 函数里的相对路径按调用时的目录
    expect(judge("f() { rm -rf x; }; cd .. && f").categories).toContain("outside_project");
    // 调用时命令前面的赋值在函数里看得到
    expect(judge('f() { rm -rf "$A"; }; A=build; A=../.. f').categories).toContain("outside_project");
    // 函数里的局部变量调用完恢复；只写了名字的 local 是空的
    expect(judge('A=../..; f() { local A=build; }; f; rm -rf "$A"').categories).toContain("outside_project");
    expect(unresolved('A=build; f() { local A; rm -rf "$A/"; }; f')).toEqual(['<unresolved:"$A/">']);
    // 定义了没调用：不跑
    expect(touched("f() { cat /e/elsewhere/x; }")).toEqual([]);
    // 递归：再按什么都没法确定走一遍
    expect(unresolved('f() { rm -rf "$D"; D="../$D"; f; }; D=x; f')).toContain('<unresolved:"$D">');
    expect(unresolved('A=build; . ./env.sh; rm -rf "$A/x"')).toEqual(['<unresolved:"$A/x">']);
    expect(unresolved('A=build; source ./env.sh && rm -rf "$A/x"')).toEqual(['<unresolved:"$A/x">']);
  });

  it("HOME 在命令里改过：$HOME、~ 跟着改；没改过照旧是用户主目录", () => {
    expect(touched("cat ~/a $HOME/b")).toEqual([`${P.home}\\a`, `${P.home}\\b`]);
    expect(touched("HOME=out; cat ~/a $HOME/b")).toEqual([W("out\\a"), W("out\\b")]);
    expect(unresolved('HOME=$(pwd); cat ~/a "$HOME/b"')).toHaveLength(2);
  });

  it("反例：代进去之后落在受保护区域、密钥区：照旧永不、照旧拒绝", () => {
    const config = P.config.replaceAll("\\", "/");
    expect(judge(`D=${config} && F=$D/ergo.json && echo x > "$F"`).disposition).toBe("never");
    const secrets = P.secrets.replaceAll("\\", "/");
    expect(judge(`D=${secrets}; cat "$D/key.txt"`).hardRefusal).toEqual(["secrets_area"]);
  });
});

describe("哪些参数是路径", () => {
  it("echo、printf 的参数和格式串不是路径；命令替换里面的命令照样单独检查", () => {
    expect(touched('echo "S01 items: $(grep -o \'<item\' raw/2026-10-19/S01-1.xml | wc -l)"')).toEqual([W("raw\\2026-10-19\\S01-1.xml")]);
    expect(touched("printf '\\n=== S15-11/S16/S17 ===\\n' x/y")).toEqual([]);
    expect(touched("echo -e 'a/b\\tc' /e/elsewhere ../..")).toEqual([]);
    // 重定向照旧是路径
    expect(touched("echo hi > /e/elsewhere/x.txt")).toEqual(["E:\\elsewhere\\x.txt"]);
    // printf 的结果写进变量（-v）：变量看不准，不是路径
    expect(touched("printf -v A '%s' a/b")).toEqual([]);
  });

  it("反例：echo 里命令替换读密钥区照旧拒绝、写受保护区域照旧永不", () => {
    const secrets = P.secrets.replaceAll("\\", "/");
    expect(judge(`echo "$(cat ${secrets}/key.txt)"`).hardRefusal).toEqual(["secrets_area"]);
    const config = P.config.replaceAll("\\", "/");
    expect(judge(`echo "$(echo x > ${config}/a.json)"`).disposition).toBe("never");
  });

  it("grep、rg 的模式，sed、awk 的脚本，jq 的过滤器：没法静态确定也不是路径；-f 给的文件照旧是路径", () => {
    expect(touched('grep "a/$X" notes.txt')).toEqual([W("notes.txt")]);
    expect(touched("grep -o '<title>[^<]*</title>\\|<link>[^<]*</link>' raw/a.xml")).toEqual([W("raw\\a.xml")]);
    expect(touched('sed "s/a/$X/g" a.txt')).toEqual([W("a.txt")]);
    expect(touched('awk "/x/{print \\$2}" a.txt')).toEqual([W("a.txt")]);
    expect(touched('jq ".a/$X" a.json')).toEqual([W("a.json")]);
    expect(touched("grep -f /e/elsewhere/patterns.txt a.txt")).toEqual([W("a.txt"), "E:\\elsewhere\\patterns.txt"]);
    // rg --files 没有模式：第一个就是目录（原来被当成模式漏看了）
    expect(touched("rg --files /e/elsewhere")).toEqual(["E:\\elsewhere"]);
  });

  it("tr 的字符集、basename / dirname 的字、date 的格式不是路径；date -r 读的文件照旧是", () => {
    expect(touched("tr '/' '_' < a.txt")).toEqual([W("a.txt")]);
    expect(touched("tr -d ' '")).toEqual([]);
    expect(touched("dirname /e/elsewhere/x && basename /e/elsewhere/y")).toEqual([]);
    expect(touched("date +%Y/%m/%d")).toEqual([]);
    expect(touched("date -r /e/elsewhere/f")).toEqual(["E:\\elsewhere\\f"]);
  });

  it("整个 \"$(...)\" 本身不当路径看（和 \"$X\" 一样）；拼在路径里的照旧是没法确定的路径", () => {
    expect(touched('mytool "$(cat a/b.txt)"')).toEqual([W("a\\b.txt")]);
    expect(unresolved('mytool "$(pwd)/out.txt"')).toEqual(['<unresolved:"$(pwd)/out.txt">']);
    // 表里的程序：操作数的位置本来就是路径
    expect(unresolved('cat "$(ls -t | head -1)"')).toEqual(['<unresolved:"$(ls -t | head -1)">']);
    expect(unresolved('rm -rf "$(cat where.txt)"')).toEqual(['<unresolved:"$(cat where.txt)">']);
  });

  it("原来漏判的路径位置：从伪设备拷过去的目标、没法确定的 -o / -O / of= / --git-dir= / tar -C，现在照样判", () => {
    const config = P.config.replaceAll("\\", "/");
    // cp /dev/null 目标：就是把目标清空（原来连目标都没判，受保护区域也漏了）
    expect(judge(`cp /dev/null ${config}/ergo.json`).disposition).toBe("never");
    expect(touched("cp /dev/null notes.md")).toEqual([W("notes.md")]);
    for (const command of ['curl -o "$X" https://example.com', 'curl --output="$X" https://example.com','curl --output-dir "$X" -O https://example.com/a', 'wget -O "$X" https://example.com', 'dd if=a.bin of="$X"', 'git --git-dir="$X" commit -m x', 'tar -xf a.tgz -C "$X"']) {
      expect({ command, blind: unresolved(command) }).toEqual({ command, blind: [expect.stringMatching(/^<unresolved:/)] });
    }
    expect(asks(judgeToolCall(inChat(maintainer(), bash('curl -o "$X" https://example.com'), { conversationApprovals: "off" })))).toBe(true);
    expect(judge(`curl --output-dir ${config} -O https://example.com/a`).disposition).toBe("never");
  });

  it("算术展开的结果按一个不跨目录的通配符算；case 只写了字面模式的一支收窄变量", () => {
    expect(touched("echo hi > out_$((n + 1)).txt")).toEqual([W("out_*.txt")]);
    expect(touched("cat /e/elsewhere/$((n))")).toEqual(["E:\\elsewhere\\*"]);
    expect(touched('case "$m" in a|b) cat "$m";; esac')).toEqual([W("a"), W("b")]);
    // 反例：没对上的那一支（或者没有 *) 时一支都没走）照旧看不准
    expect(unresolved('case "$m" in a|b) ;; *) cat "$m";; esac')).toEqual(['<unresolved:"$m">']);
    expect(unresolved('case "$m" in a|b) ;; esac; cat "$m"')).toEqual(['<unresolved:"$m">']);
    // 上一支 ;& 落下来的不看这一支的模式：落下来的那一支收窄过就是那几个，没收窄的照旧看不准
    expect(touched('case "$m" in a) ;& b) cat "$m";; esac').toSorted()).toEqual([W("a"), W("b")]);
    expect(unresolved('case "$m" in a*) ;& b) cat "$m";; esac')).toEqual(['<unresolved:"$m">']);
    // 反例：模式带通配符、带引号的不收窄
    expect(unresolved('case "$m" in a*) cat "$m";; esac')).toEqual(['<unresolved:"$m">']);
  });

  it("不加引号的变量值里有空白、命令里改过 IFS：会被拆成几个词，看不准", () => {
    expect(unresolved('A="x ../../y"; rm -rf $A')).toEqual(["<unresolved:$A>"]);
    expect(touched('A="x y"; cat "$A"')).toEqual([W("x y")]);
    expect(unresolved("IFS=/; A=a/../../b; rm -rf $A")).toEqual(["<unresolved:$A>"]);
  });

  it("curl -A 这类选项的值不是路径", () => {
    expect(touched('UA="Mozilla/5.0" && curl -sS -A "$UA" -o out.xml https://example.com/feed')).toEqual([W("out.xml")]);
  });
});

describe("Git Bash 的 /tmp 和 $TMPDIR", () => {
  const TEMP = "C:\\Users\\tester\\AppData\\Local\\Temp";
  const WORK_TMP = W(".ergo-tmp");

  it("知道 /tmp 挂到哪：按那个目录解析；不知道照旧看不准；别的挂载点照旧看不准", () => {
    expect(resolveAgentPath("/tmp/a.out", { ...ENV, tmpMount: TEMP })).toEqual({ kind: "absolute", path: `${TEMP}\\a.out` });
    expect(resolveAgentPath("/tmp", { ...ENV, tmpMount: TEMP })).toEqual({ kind: "absolute", path: TEMP });
    expect(resolveAgentPath("/tmp/a.out", ENV).kind).toBe("unknown");
    expect(resolveAgentPath("/tmpx/a", { ...ENV, tmpMount: TEMP }).kind).toBe("unknown");
    expect(resolveAgentPath("/usr/bin/x", { ...ENV, tmpMount: TEMP }).kind).toBe("unknown");
  });

  it("$TMPDIR、$TEMP、$TMP 按 agent 的 bash 环境展开：在项目里", () => {
    const env: ShellEnv = { ...ENV, vars: { TMPDIR: WORK_TMP, TEMP: WORK_TMP, TMP: WORK_TMP }, tmpMount: TEMP };
    expect(touched('node x.js > "$TMPDIR/cand.txt"; wc -l "$TEMP/cand.txt" $TMP/b', env)).toEqual([W("x.js"), `${WORK_TMP}\\cand.txt`, `${WORK_TMP}\\cand.txt`, `${WORK_TMP}\\b`]);
    // 命令里改了 TMPDIR：按改的
    expect(touched('TMPDIR=out; echo x > "$TMPDIR/a"', env)).toEqual([W("out\\a")]);
  });

  it("维护者写 /tmp（挂到系统临时目录）：在项目外、但看得准，不再按\"看不准、可能碰到受保护区域\"问", () => {
    const agent = maintainer({ bashTmp: TEMP }) as ExecutingAgent;
    const j = judge("node x.js > /tmp/cand.txt 2>&1; wc -l /tmp/cand.txt", agent);
    expect(j.categories).toEqual(["outside_project"]);
    expect(dispositionFinding(j, "outside_project")).not.toMatchObject({ keepAsking: true });
    // 对话审批关着：任务的 agent 超出授权先不管
    expect(judgeToolCall(inChat(agent, bash("node x.js > /tmp/cand.txt 2>&1"), { conversationApprovals: "off" })).disposition).toBe("log_only");
    // 反例：不知道 /tmp 挂到哪（没给 bashTmp）照旧看不准，对话审批关着也照旧问
    const blind = judgeToolCall(inChat(maintainer(), bash("node x.js > /tmp/cand.txt 2>&1"), { conversationApprovals: "off" }));
    expect(blind.disposition).toBe("ask_first");
    expect(dispositionFinding(blind, "outside_project")).toMatchObject({ keepAsking: true });
  });

  it("写 $TMPDIR：在项目里，对话审批开着也不问", () => {
    const agent = maintainer({ bashTmp: TEMP, shellVars: { TMPDIR: WORK_TMP, TEMP: WORK_TMP, TMP: WORK_TMP } }) as ExecutingAgent;
    const j = judgeToolCall(inChat(agent, bash('node x.js > "$TMPDIR/cand.txt" 2>&1; tail -5 "$TMPDIR/cand.txt"'), { facts: { files: { [`${WORK_TMP}\\cand.txt`]: { exists: false } } } }));
    expect([j.disposition, j.categories]).toEqual(["log_only", []]);
  });

  it("$TMPDIR（工作目录里的 .ergo-tmp）里的东西一律算临时文件：覆盖、删除不算\"删除或覆盖\"；链接指到外面的、目录里有链接的照旧算", () => {
    const agent = maintainer({ shellVars: { TMPDIR: WORK_TMP } }) as ExecutingAgent;
    const existing = { files: { [`${WORK_TMP}\\cand.txt`]: { exists: true } } };
    expect(judge('echo x > "$TMPDIR/cand.txt"; rm -rf "$TMPDIR"/old', agent).categories).toEqual([]);
    expect(judgeToolCall(inTask(agent, bash('echo x > "$TMPDIR/cand.txt"'), { ...v1Satisfied(), facts: { ...v1Satisfied().facts, ...existing } })).categories).toEqual([]);
    // 反例：工作目录里别处的已有文件照旧
    expect(judge("echo x > notes.md", agent).categories).toEqual(["delete_or_overwrite"]);
    // 反例：临时目录里的链接指到工作目录别处
    const link = { files: { [`${WORK_TMP}\\link.md`]: { exists: true, realPath: W("notes.md") } } };
    expect(judgeToolCall(inTask(agent, bash('echo x > "$TMPDIR/link.md"'), { ...v1Satisfied(), facts: { ...v1Satisfied().facts, ...link } })).categories).toContain("delete_or_overwrite");
    // 反例：要删的目录里有链接（列不全）
    const linked = { files: { [`${WORK_TMP}\\run`]: { exists: true, isDirectory: true, contents: { entries: [], complete: false } } } };
    expect(judgeToolCall(inTask(agent, bash('rm -rf "$TMPDIR/run"'), { ...v1Satisfied(), facts: { ...v1Satisfied().facts, ...linked } })).categories).toContain("delete_or_overwrite");
  });

  it("秘书写 /tmp：照旧算写草稿区之外，对话审批关着也问", () => {
    const j = judgeToolCall(inChat(secretary(), bash("echo x > /tmp/a.txt"), { conversationApprovals: "off" }));
    expect(j.disposition).toBe("ask_first");
  });
});

describe("wo-10 的 5 条命令（原样）：改之后不再问；反例照旧问", () => {
  // 那一轮的环境：项目 p-1 的维护者在定时运行里（不属于任务，按对话判），工作目录在数据目录的项目区里，对话审批关着
  const HOME = "C:\\Users\\someone";
  const DATA = `${HOME}\\.ergo`;
  const RECORDS = `${DATA}\\projects\\p-1`;
  const WORKDIR = `${RECORDS}\\workdir`;
  const TEMP = `${HOME}\\AppData\\Local\\Temp`;
  const places = {
    dataDir: { root: DATA, config: `${DATA}\\config`, secrets: `${DATA}\\secrets`, db: `${DATA}\\db`, projects: `${DATA}\\projects` },
    programDir: "D:\\code\\ergo",
    homeDir: HOME,
    ownPorts: P.ownPorts,
  };
  const pm1 = (extra: Partial<ExecutingAgent> = {}): ExecutingAgent => ({
    kind: "maintainer",
    agentId: "pm-1",
    cwd: WORKDIR,
    toolkit: { bash: true, network: true },
    projectRecords: [RECORDS],
    workingDirs: [WORKDIR],
    ...extra,
  });
  const WORK_TMP = `${WORKDIR}\\.ergo-tmp`;
  /** 177 号票之后的维护者：bash 里 TMPDIR 这些指到工作目录里的临时目录，守卫知道 /tmp 挂到系统临时目录 */
  const after = () => pm1({ bashTmp: TEMP, shellVars: { TMPDIR: WORK_TMP, TEMP: WORK_TMP, TMP: WORK_TMP } });
  const run = (command: string, agent: ExecutingAgent, approvals: "on" | "off" = "off") =>
    judgeToolCall(inChat(agent, bash(command), { places, conversationApprovals: approvals }));

  const C1 =
    "cd C:/Users/someone/.ergo/projects/p-1/workdir && DATE=2026-10-19 && RAW=raw/$DATE && LOG=logs/$DATE.log && RUN=\"$(date '+%Y-%m-%d %H:%M:%S%z')\" && UA=\"Mozilla/5.0\" && printf '\\n=== fetch run %s（补抓：上轮被中断，S15-11/S16/S17/S18/S20 没跑到） ===\\n' \"$RUN\" >> \"$LOG\" && printf '%s\\t%s\\tOK\\t%s\\t%s\\t%sB\\n' \"$RUN\" S15 200 \"llama.cpp release（补抓）\" \"$(wc -c < $RAW/S15-11.xml | tr -d ' ')\" >> \"$LOG\" && printf 'S15\\tatom\\t%s\\n' \"$RAW/S15-11.xml\" >> \"$RAW/.index.tsv\" && while IFS=$'\\t' read -r id url kind note; do\n  case \"$id\" in S16|S17|S18|S20) ;; *) continue ;; esac\n  case \"$kind\" in rss|atom) ext=xml;; *) ext=txt;; esac\n  idx=$(($(wc -l < \"$RAW/.index.tsv\" | tr -d ' ')+1))\n  out=\"$RAW/$id-$idx.$ext\"\n  code=$(curl -sS -L --compressed --retry 1 --retry-delay 1 -o \"$out\" -w \"%{http_code}\" --max-time 60 -A \"$UA\" \"$url\" 2>/dev/null || echo 000)\n  size=$(wc -c < \"$out\" 2>/dev/null | tr -d ' '); size=${size:-0}\n  if [ \"$code\" = 200 ] && [ \"$size\" -gt 200 ]; then\n    printf '%s\\t%s\\tOK\\t%s\\t%s\\t%sB\\n' \"$RUN\" \"$id\" \"$code\" \"$note\" \"$size\" >> \"$LOG\"\n    printf '%s\\t%s\\t%s\\n' \"$id\" \"$kind\" \"$out\" >> \"$RAW/.index.tsv\"\n  else\n    printf '%s\\t%s\\tFAIL\\t%s\\t%s\\tsize=%sB\\t%s\\n' \"$RUN\" \"$id\" \"$code\" \"$note\" \"$size\" \"$url\" >> \"$LOG\"\n  fi\ndone < scripts/fetch-targets.tsv\necho \"--- index ---\"; cat \"$RAW/.index.tsv\"; echo \"--- log tail ---\"; tail -10 \"$LOG\"";
  const C2 =
    "cd C:/Users/someone/.ergo/projects/p-1/workdir && echo \"S01 items: $(grep -o '<item' raw/2026-10-19/S01-1.xml | wc -l)\"; head -c 600 raw/2026-10-19/S01-1.xml; echo; echo \"--- S01 最近 8 条 ---\"; grep -o '<title>[^<]*</title>\\|<pubDate>[^<]*</pubDate>\\|<link>[^<]*</link>' raw/2026-10-19/S01-1.xml | head -30";
  const C3 = 'cd C:/Users/someone/.ergo/projects/p-1/workdir && bash scripts/daily.sh 2026-10-19 > /tmp/daily-1019.out 2>&1; echo "exit=$?"; tail -25 /tmp/daily-1019.out';
  const C4 = "cd C:/Users/someone/.ergo/projects/p-1/workdir && node scripts/lib/list-candidates.js 2026-10-19 > /tmp/cand-1019.txt 2>&1; echo exit=$?; wc -l /tmp/cand-1019.txt; sed -n '1,120p' /tmp/cand-1019.txt";
  const C5 = "cd C:/Users/someone/.ergo/projects/p-1/workdir && node scripts/lib/list-candidates.js 2026-10-19 --all --per-source 6 > /tmp/cand-all.txt 2>&1; echo exit=$?; sed -n '1,80p' /tmp/cand-all.txt";

  it("改之后：5 条都不弹审批卡", () => {
    for (const command of [C1, C2, C3, C4, C5]) {
      const j = run(command, after());
      expect({ command: command.slice(0, 80), disposition: j.disposition, hard: j.hardRefusal }).toEqual({ command: command.slice(0, 80), disposition: "log_only", hard: null });
    }
  });

  it("1、2 条（printf 的格式串、echo 里的命令替换）：每个路径都看得准，对话审批开着也不问", () => {
    for (const command of [C2]) expect(run(command, after(), "on").disposition).toBe("log_only");
    // 第 1 条：LOG、RAW 代进去了，printf 的格式串、"$(wc -c < …)" 不再当路径；还剩循环里从文件读来的 $out 看不准（只读，照常放开）
    // 第 1 条：LOG、RAW 代进去了，printf 的格式串、"$(wc -c < …)" 不再当路径；循环里的 $out 由 case 收窄的 $id、算术算出的 $idx
    // 拼成（raw/2026-10-19/S16-*.xml 这样），也看得准。还没法确定的只有链子后面那两句读：开头的 cd 失败的话 RAW、LOG 根本没赋值
    const j = run(C1, after(), "on");
    const blind = j.findings.filter((f) => "message" in f && f.message.includes("没法确定"));
    expect(blind.map((f) => ("message" in f ? f.message.split("」")[0] : ""))).toEqual(['bash 里的「cat "$RAW/.index.tsv"', 'bash 里的「tail -10 "$LOG"']);
    expect(blind.every((f) => !("keepAsking" in f))).toBe(true);
  });

  it("3–5 条（写 /tmp）：在项目外、看得准；对话审批开着时照旧问（确实在项目外），写 $TMPDIR 就不问", () => {
    for (const command of [C3, C4, C5]) {
      const j = run(command, after(), "on");
      expect([j.disposition, j.categories]).toEqual(["ask_first", ["outside_project"]]);
      expect(dispositionFinding(j, "outside_project")).not.toMatchObject({ keepAsking: true });
    }
    // 写到 $TMPDIR（工作目录里的临时目录，新文件）：对话审批开着也不问
    const viaTmpdir = C4.replaceAll("/tmp/", "$TMPDIR/");
    const fresh = { files: { [`${WORK_TMP}\\cand-1019.txt`]: { exists: false } } };
    expect(judgeToolCall(inChat(after(), bash(viaTmpdir), { places, facts: fresh })).disposition).toBe("log_only");
  });

  it("反例：改之前的样子（守卫不知道 /tmp 挂到哪）3–5 条照旧问；真看不准的写照旧问；碰受保护区域照旧永不", () => {
    for (const command of [C3, C4, C5]) expect(run(command, pm1()).disposition).toBe("ask_first");
    // 写的路径来自从文件读进来的变量：看不准，对话审批关着也问
    const blindWrite = C1.replace('size=$(wc -c < "$out"', 'cp /dev/null "$note"; size=$(wc -c < "$out"');
    expect(run(blindWrite, after()).disposition).toBe("ask_first");
    // case 没收窄的（带通配符的模式）：$id 照旧看不准，curl -o "$out" 写到哪没法确定
    const globCase = C1.replace("S16|S17|S18|S20) ;;", "S1*) ;;");
    expect(run(globCase, after()).disposition).toBe("ask_first");
    // 代进去之后落在配置区：永不
    expect(run('cd C:/Users/someone/.ergo/projects/p-1/workdir && D=../../../config && printf \'%s\\n\' x >> "$D/ergo.json"', after()).disposition).toBe("never");
  });
});

describe("通用 bash 的判定没有因此放松", () => {
  it("rm 一个没法确定的路径照旧问；echo 里拼的路径不算路径，但 echo 的重定向目标没法确定照旧问", () => {
    expect(asks(judgeToolCall(inChat(maintainer(), bash('rm -rf "$X"'), { conversationApprovals: "off" })))).toBe(true);
    expect(asks(judgeToolCall(inChat(maintainer(), bash('echo hi > "$X/a.txt"'), { conversationApprovals: "off" })))).toBe(true);
  });
});
