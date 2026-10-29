// 通用 bash 说成人话（67 号票）：把参数摘要里的命令（守护进程截到 160 字的一行，guard-runtime/describe.ts 的 summarizeArgs）
// 简单拆开，常见的命令各说一句，用"，"接起来："跑测试，把改动提交：修复登录超时"。
// 用户 2026-10-10 定：前端自己简单拆，不用守护进程守卫那边的拆解结果（guard/shell/split.ts）——那份是给守卫判定用的，
// 要宁可多报；这里只是给人看的一句，认不出的命令不硬说。
// 拆法：引号里的不拆；顶层的 &&、||、;、&、换行分成先后几段，| 后面那段是管道下游（head、grep、wc 这类过滤只看不说）；
// 开头的环境变量赋值和 sudo、env、time 这类包装跳过；> / >> 写进文件的另说一句"写 …"，2>&1、> /dev/null 不算。
// 认不出的命令：整条都认不出时交回 undefined（退回"通用 bash · 命令"），夹在认得的中间的说"运行 某命令"。
// 说法：动词加对象，不带"了"（用户 2026-10-10 定）。纯函数。
// 170 号票起按当前语言（state.shellSentence.*）；几句之间的"，"英文是", "。
import { t } from "./protocol.ts";
import { joinList, pathsText, shortPath, shortUrl } from "./sentence-parts.ts";

/** 拆出来的一段简单命令 */
interface Segment {
  /** 命令和参数（引号去掉了） */
  readonly words: readonly string[];
  /** 管道下游（前面是 |） */
  readonly piped: boolean;
  /** 标准输出写进的文件：path 和是不是追加（>>） */
  readonly writes: readonly { readonly path: string; readonly append: boolean }[];
}

/** 一段命令说成什么：一句话；只是过滤、进目录这类不值得说的是 null；认不出的是 undefined */
type Phrase = string | null | undefined;

/** 一条命令说成人话；一句都说不出（整条都认不出）时是 undefined */
export function bashSentence(command: string): string | undefined {
  const segments = splitCommand(command);
  const said: { prog: string; phrase: Phrase; weak: boolean }[] = [];
  for (const seg of segments) {
    const words = skipPrefix(seg.words);
    if (words.length === 0) continue;
    const prog = programOf(words[0]!);
    const weak = prog === "cd" || prog === "pushd";
    const phrase = weak ? (words[1] ? t("state.shellSentence.cd", { path: shortPath(words[1]) }) : null) : phraseOf(prog, words[0]!, words.slice(1), seg);
    said.push({ prog, phrase, weak });
    for (const w of seg.writes) said.push({ prog, phrase: t(w.append ? "state.shellSentence.append" : "state.shellSentence.writeTo", { path: shortPath(w.path) }), weak: false });
  }
  const known = said.filter((s) => typeof s.phrase === "string");
  if (!known.some((s) => !s.weak)) {
    // 只有进目录的说进目录；有认不出的、或者什么都没说出来的退回原样
    return said.length > 0 && said.every((s) => s.phrase !== undefined) && known.length > 0 ? known.map((s) => s.phrase).join(t("state.shellSentence.sep")) : undefined;
  }
  const phrases: string[] = [];
  for (const s of said) {
    if (s.weak) continue;
    const p = s.phrase === undefined ? t("state.shellSentence.run", { name: s.prog }) : s.phrase;
    if (p !== null && phrases[phrases.length - 1] !== p) phrases.push(p);
  }
  const sep = t("state.shellSentence.sep");
  return phrases.length > 3 ? t("state.shellSentence.moreSteps", { phrases: phrases.slice(0, 3).join(sep), count: phrases.length - 3, n: phrases.length - 3 }) : phrases.join(sep);
}

// ───────────────────────── 拆 ─────────────────────────

/** 按引号、顶层的 && || ; & | 换行和重定向拆成几段（$( )、反引号里的整个当作一个词的一部分） */
function splitCommand(command: string): Segment[] {
  const out: Segment[] = [];
  let words: string[] = [];
  let writes: { path: string; append: boolean }[] = [];
  let piped = false;
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;
  let depth = 0;
  /** 下一个词是重定向的目标：写进文件（stdout）、丢掉（stderr、/dev/null、&1）、读进来（<） */
  let target: { kind: "write"; append: boolean } | { kind: "skip" } | undefined;
  const endWord = () => {
    if (!inWord) return;
    if (target?.kind === "write" && !/^(\/dev\/null|nul|&\d?)$/i.test(word)) writes.push({ path: word, append: target.append });
    else if (target === undefined) words.push(word);
    target = undefined;
    word = "";
    inWord = false;
  };
  const endSegment = (nextPiped: boolean) => {
    endWord();
    if (words.length > 0 || writes.length > 0) out.push({ words, piped, writes });
    words = [];
    writes = [];
    piped = nextPiped;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const next = command[i + 1];
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && next !== undefined && '"\\$`'.includes(next)) word += command[++i];
      else word += c;
      continue;
    }
    if (depth > 0) {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === "$" && next === "(") {
      depth = 1;
      word += "$(";
      inWord = true;
      i++;
      continue;
    }
    if (c === "\\" && next !== undefined && " '\"\\$&|;<>()".includes(next)) {
      word += next;
      inWord = true;
      i++;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    if (c === "\n" || c === ";") {
      endSegment(false);
      continue;
    }
    if (c === "&" && next === "&") {
      endSegment(false);
      i++;
      continue;
    }
    if (c === "|") {
      if (next === "|") {
        endSegment(false);
        i++;
      } else endSegment(true);
      continue;
    }
    if (c === "&" && next === ">") {
      // &> 文件：标准输出和错误一起写进去
      endWord();
      const append = command[i + 2] === ">";
      target = { kind: "write", append };
      i += append ? 2 : 1;
      continue;
    }
    if (c === "&") {
      endSegment(false);
      continue;
    }
    if (c === ">" || c === "<") {
      // 前面紧挨着的数字是文件描述符：2> 是错误输出，不算写文件
      const fd = inWord && /^\d$/.test(word) ? word : undefined;
      if (fd !== undefined) {
        word = "";
        inWord = false;
      } else endWord();
      const append = c === ">" && next === ">";
      if (append) i++;
      if (command[i + 1] === "&") {
        // >&2、2>&1：只是改道，没有文件
        i++;
        while (i + 1 < command.length && /\d/.test(command[i + 1]!)) i++;
        continue;
      }
      target = c === "<" || (fd !== undefined && fd !== "1") ? { kind: "skip" } : { kind: "write", append };
      continue;
    }
    if (c === "(" || c === ")") {
      // 子 shell 的括号：只当分隔
      endWord();
      continue;
    }
    word += c;
    inWord = true;
  }
  endSegment(false);
  return out;
}

/** 跳过开头的环境变量赋值和 sudo、env、time 这类只是包一层的命令 */
function skipPrefix(words: readonly string[]): readonly string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
    else if (WRAPPERS.has(w)) {
      i++;
      // timeout 10 cmd、nice -n 5 cmd
      while (i < words.length && (words[i]!.startsWith("-") || /^\d+[smhd]?$/.test(words[i]!))) i++;
    } else break;
  }
  return words.slice(i);
}

const WRAPPERS: ReadonlySet<string> = new Set(["sudo", "env", "time", "nohup", "exec", "command", "nice", "timeout", "cross-env", "winpty"]);

/** 命令名：去掉目录、.exe 这类后缀，转小写 */
function programOf(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
}

/** 参数里不是选项的词（-x、--xx 去掉；选项的值没法分清，个别命令自己处理） */
function plainOf(args: readonly string[]): string[] {
  return args.filter((a) => !a.startsWith("-") || a === "-");
}

/** 选项的值：-m 值、-m值、--message 值、--message=值 */
function optionValue(args: readonly string[], short: readonly string[], long: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const l of long) {
      if (a === l) return args[i + 1];
      if (a.startsWith(`${l}=`)) return a.slice(l.length + 1);
    }
    for (const s of short) {
      if (a === s) return args[i + 1];
      if (a.startsWith(s) && !a.startsWith("--") && a.length > s.length) return a.slice(s.length);
    }
  }
  return undefined;
}

/** 参数里去掉选项和选项的值（valued：带值的选项） */
function operandsOf(args: readonly string[], valued: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (valued.includes(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-") && a !== "-") continue;
    out.push(a);
  }
  return out;
}

// ───────────────────────── 每种命令怎么说 ─────────────────────────

/** 管道下游只是筛一筛、数一数的命令：不另说 */
const FILTERS: ReadonlySet<string> = new Set([
  "head", "tail", "grep", "egrep", "fgrep", "rg", "findstr", "sort", "uniq", "wc", "less", "more", "cut", "awk", "sed", "tr", "jq",
  "xargs", "tee", "cat", "column", "nl", "fold", "rev", "tac", "select-string", "select-object", "out-null", "measure-object",
]);

/** 只是设变量、开关选项、判断的：不说 */
const SILENT: ReadonlySet<string> = new Set(["export", "set", "unset", "source", ".", "alias", "true", "false", ":", "exit", "echo", "printf", "test", "[", "popd", "clear", "cls"]);

/** 跑解释器：node x.js、python x.py */
const INTERPRETERS: ReadonlySet<string> = new Set(["node", "python", "python3", "py", "deno", "ruby", "perl", "bash", "sh", "zsh", "pwsh", "powershell", "tsx", "ts-node"]);

/** 测试工具 */
const TEST_TOOLS: ReadonlySet<string> = new Set(["vitest", "jest", "mocha", "ava", "pytest"]);

/** 查代码的工具 */
const LINT_TOOLS: ReadonlySet<string> = new Set(["eslint", "oxlint", "biome", "ruff", "flake8"]);

function phraseOf(prog: string, raw: string, args: readonly string[], seg: Segment): Phrase {
  if (seg.piped && FILTERS.has(prog)) return null;
  if (SILENT.has(prog)) return null;
  // ./build.sh、scripts/deploy.py 这种直接跑的脚本
  if (/^\.{1,2}[\\/]/.test(raw) || /\.(sh|py|js|mjs|cjs|ts|ps1|rb|pl)$/i.test(raw)) return t("state.shellSentence.run", { name: shortPath(raw) });
  const plain = plainOf(args);
  switch (prog) {
    case "git":
      return gitPhrase(args);
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return packagePhrase(prog, args);
    case "npx":
    case "pnpx":
    case "bunx":
      return toolPhrase(plain[0], plain.slice(1));
    case "pip":
    case "pip3":
    case "uv":
      return pipPhrase(plain);
    case "ls":
    case "ll":
    case "la":
    case "dir":
    case "tree":
      return plain.length > 0 ? t("state.shellSentence.list", { paths: pathsText(plain) }) : t("state.shellSentence.listHere");
    case "cat":
    case "type":
    case "bat":
    case "less":
    case "more":
    case "head":
    case "tail":
    case "nl": {
      const files = operandsOf(args, ["-n", "-c"]).filter((w) => !/^\+?\d+$/.test(w));
      return files.length > 0 ? t("state.shellSentence.read", { paths: pathsText(files) }) : null;
    }
    case "rm":
    case "del":
    case "erase":
    case "rmdir":
    case "rd":
    case "unlink":
    case "trash":
      return plain.length > 0 ? t("state.shellSentence.delete", { paths: pathsText(plain) }) : undefined;
    case "mkdir":
    case "md":
      return plain.length > 0 ? t("state.shellSentence.mkdir", { paths: pathsText(plain) }) : undefined;
    case "touch":
      return plain.length > 0 ? t("state.shellSentence.touch", { paths: pathsText(plain) }) : undefined;
    case "cp":
    case "copy":
    case "xcopy":
      return twoEnds("state.shellSentence.copy", operandsOf(args, ["-t"]));
    case "scp":
      return twoEnds("state.shellSentence.copy", operandsOf(args, ["-i", "-P", "-F", "-o"]));
    case "mv":
    case "move":
    case "ren":
    case "rename":
      return twoEnds("state.shellSentence.move", plain);
    case "rsync":
      return twoEnds("state.shellSentence.sync", operandsOf(args, ["-e", "--exclude", "--include"]));
    case "chmod":
    case "chown":
      return plain.length > 1 ? t("state.shellSentence.chmod", { paths: pathsText(plain.slice(1)) }) : undefined;
    case "grep":
    case "egrep":
    case "fgrep":
    case "rg":
    case "findstr": {
      const ops = operandsOf(args, ["-e", "-f", "-m", "-A", "-B", "-C", "-g", "--glob", "-t", "--type"]);
      const pattern = optionValue(args, ["-e"], ["--regexp"]) ?? ops.shift();
      if (pattern === undefined) return undefined;
      return ops.length > 0 ? t("state.shellSentence.grepIn", { paths: pathsText(ops), pattern }) : t("state.shellSentence.grep", { pattern });
    }
    case "find":
    case "fd": {
      const name = optionValue(args, [], ["-name", "-iname", "-path"]);
      const where = prog === "find" ? args.find((a) => !a.startsWith("-") && a !== name) : plain[1];
      const what = prog === "find" ? name : plain[0];
      if (where) return what ? t("state.shellSentence.findIn", { where: shortPath(where), what }) : t("state.shellSentence.findFilesIn", { where: shortPath(where) });
      return what ? t("state.shellSentence.findHere", { what }) : t("state.shellSentence.findFilesHere");
    }
    case "sed":
      return args.some((a) => a === "-i" || a.startsWith("-i")) && plain.length > 1 ? t("state.shellSentence.edit", { paths: pathsText(plain.slice(1)) }) : undefined;
    case "curl":
    case "wget":
    case "http":
    case "https":
    case "invoke-webrequest":
    case "iwr":
      return requestPhrase(prog, args);
    case "sleep":
      return plain[0] ? t("state.shellSentence.sleep", { seconds: plain[0] }) : undefined;
    case "pwd":
      return t("state.shellSentence.pwd");
    case "which":
    case "where":
    case "whereis":
      return plain[0] ? t("state.shellSentence.which", { name: plain[0] }) : undefined;
    case "wc":
      return plain.length > 0 ? t("state.shellSentence.wc", { paths: pathsText(plain) }) : undefined;
    case "diff":
    case "cmp":
    case "fc":
      return plain.length >= 2 ? t("state.shellSentence.diff", { a: shortPath(plain[0]!), b: shortPath(plain[1]!) }) : undefined;
    case "tar": {
      // 第一个参数是模式（-xzf、czf……），不带横杠的也是
      const mode = args[0] ?? "";
      const file = optionValue(args, ["-f"], ["--file"]) ?? plain[mode !== "" && !mode.startsWith("-") ? 1 : 0];
      const extract = !mode.startsWith("--") && /^-?[a-z]*x/i.test(mode);
      return file ? t(extract ? "state.shellSentence.extract" : "state.shellSentence.pack", { file: shortPath(file) }) : undefined;
    }
    case "unzip":
      return plain[0] ? t("state.shellSentence.unzip", { file: shortPath(plain[0]) }) : undefined;
    case "zip":
      return plain[0] ? t("state.shellSentence.pack", { file: shortPath(plain[0]) }) : undefined;
    case "ps":
    case "tasklist":
      return t("state.shellSentence.ps");
    case "kill":
    case "pkill":
    case "taskkill":
      return plain[0] ? t("state.shellSentence.killOne", { target: plain[0] }) : t("state.shellSentence.kill");
    case "ssh":
      return plain[0] ? t("state.shellSentence.ssh", { host: plain[0] }) : undefined;
    case "gh":
      return plain[0] ? t("state.shellSentence.gh", { args: plain.slice(0, 2).join(" ") }) : undefined;
    case "docker":
      return plain[0] ? t("state.shellSentence.run", { name: `docker ${plain[0]}` }) : undefined;
    case "make":
      return t("state.shellSentence.run", { name: plain[0] ? `make ${plain[0]}` : "make" });
    case "tsc":
      return t("state.shellSentence.typecheck");
    case "cargo":
    case "go":
      return plain[0] === "test" ? t("state.shellSentence.test") : plain[0] === "build" ? t("state.shellSentence.build") : undefined;
    default:
      if (INTERPRETERS.has(prog)) return interpreterPhrase(args);
      if (TEST_TOOLS.has(prog)) return t("state.shellSentence.test");
      if (LINT_TOOLS.has(prog)) return t("state.shellSentence.lint");
      return undefined;
  }
}

/** 复制、移动、同步：最后一个是目标，前面的是源 */
function twoEnds(key: "state.shellSentence.copy" | "state.shellSentence.move" | "state.shellSentence.sync", operands: readonly string[]): Phrase {
  if (operands.length < 2) return undefined;
  const to = operands[operands.length - 1]!;
  return t(key, { from: pathsText(operands.slice(0, -1)), to: shortPath(to) });
}

/** git 的子命令 */
function gitPhrase(all: readonly string[]): Phrase {
  // 跳过子命令前面的全局选项：-C 目录、-c 键=值、--no-pager……
  let i = 0;
  while (i < all.length && all[i]!.startsWith("-")) i += all[i] === "-C" || all[i] === "-c" ? 2 : 1;
  const sub = all[i];
  const args = all.slice(i + 1);
  const ops = operandsOf(args, ["-m", "--message", "-b", "-B", "-c", "-C", "-n", "--format", "--pretty", "-u", "--set-upstream-to"]);
  const has = (...flags: string[]) => args.some((a) => flags.includes(a));
  switch (sub) {
    case undefined:
      return undefined;
    case "status":
      return t("state.shellSentence.git.status");
    case "diff":
      return ops.length > 0 ? t("state.shellSentence.git.diffOf", { paths: pathsText(ops) }) : t("state.shellSentence.git.diff");
    case "log":
      return t("state.shellSentence.git.log");
    case "show":
      return ops[0] ? t("state.shellSentence.git.show", { commit: ops[0] }) : t("state.shellSentence.git.showLatest");
    case "add":
      return ops.length === 0 || ops.includes(".") || has("-A", "--all") ? t("state.shellSentence.git.addAll") : t("state.shellSentence.git.add", { paths: pathsText(ops) });
    case "commit": {
      const message = optionValue(args, ["-m"], ["--message"]);
      const amend = has("--amend");
      if (amend) return message ? t("state.shellSentence.git.amendMsg", { message }) : t("state.shellSentence.git.amend");
      return message ? t("state.shellSentence.git.commitMsg", { message }) : t("state.shellSentence.git.commit");
    }
    case "push": {
      const [remote, branch] = ops;
      if (has("--delete", "-d")) return branch ? (remote ? t("state.shellSentence.git.deleteRemoteBranch", { remote, branch }) : t("state.shellSentence.git.deleteBranchOnRemote", { branch })) : undefined;
      const force = args.some((a) => a === "-f" || a === "--force" || a.startsWith("--force-with-lease"));
      return t("state.shellSentence.git.push", {
        verb: force ? t("state.shellSentence.git.forcePushVerb") : t("state.shellSentence.git.pushVerb"),
        branch: branch ? t("state.shellSentence.git.pushBranch", { branch }) : t("state.shellSentence.git.currentBranch"),
        remote: remote ? t("state.shellSentence.git.pushRemote", { remote }) : t("state.shellSentence.git.theRemote"),
      });
    }
    case "pull":
      return ops[0] ? t("state.shellSentence.git.pullFrom", { remote: ops[0] }) : t("state.shellSentence.git.pull");
    case "fetch":
      return ops[0] ? t("state.shellSentence.git.fetchFrom", { remote: ops[0] }) : t("state.shellSentence.git.fetch");
    case "clone":
      return ops[0] ? t("state.shellSentence.git.clone", { url: shortUrl(ops[0]) }) : undefined;
    case "checkout":
    case "switch": {
      const created = optionValue(args, ["-b", "-B", "-c", "-C"], ["--create"]);
      if (created) return t("state.shellSentence.git.newBranch", { branch: created });
      const dashes = args.indexOf("--");
      if (dashes >= 0) return t("state.shellSentence.git.discardIn", { paths: pathsText(args.slice(dashes + 1)) });
      return ops[0] ? t("state.shellSentence.git.switch", { target: ops[0] }) : undefined;
    }
    case "branch":
      if (has("-d", "-D", "--delete")) return ops[0] ? t("state.shellSentence.git.deleteBranch", { count: ops.length, branches: joinList(ops) }) : undefined;
      return ops[0] ? t("state.shellSentence.git.newBranch", { branch: ops[0] }) : t("state.shellSentence.git.branches");
    case "merge":
      return ops[0] ? t("state.shellSentence.git.merge", { branch: ops[0] }) : undefined;
    case "rebase":
      return ops[0] ? t("state.shellSentence.git.rebaseOnto", { target: ops[0] }) : t("state.shellSentence.git.rebase");
    case "reset":
      if (has("--hard")) return ops[0] ? t("state.shellSentence.git.hardResetTo", { target: ops[0] }) : t("state.shellSentence.git.hardReset");
      return ops[0] ? t("state.shellSentence.git.resetTo", { target: ops[0] }) : t("state.shellSentence.git.unstage");
    case "restore":
      return ops.length > 0 ? (has("--staged", "-S") ? t("state.shellSentence.git.unstageOf", { paths: pathsText(ops) }) : t("state.shellSentence.git.discardIn", { paths: pathsText(ops) })) : undefined;
    case "stash":
      return ops[0] === "pop" || ops[0] === "apply" ? t("state.shellSentence.git.stashPop") : ops[0] === "list" ? t("state.shellSentence.git.stashList") : t("state.shellSentence.git.stash");
    case "rm":
      return ops.length > 0 ? t("state.shellSentence.git.rm", { paths: pathsText(ops) }) : undefined;
    case "mv":
      return twoEnds("state.shellSentence.move", ops);
    case "tag":
      if (has("-d", "--delete")) return ops[0] ? t("state.shellSentence.git.deleteTag", { tag: ops[0] }) : undefined;
      return ops[0] ? t("state.shellSentence.git.tag", { tag: ops[0] }) : t("state.shellSentence.git.tags");
    case "init":
      return t("state.shellSentence.git.init");
    case "remote":
      return ops[0] === "add" && ops[1] ? t("state.shellSentence.git.addRemote", { remote: ops[1] }) : t("state.shellSentence.git.remotes");
    case "cherry-pick":
      return ops[0] ? t("state.shellSentence.git.cherryPick", { commit: ops[0] }) : undefined;
    case "revert":
      return ops[0] ? t("state.shellSentence.git.revert", { commit: ops[0] }) : undefined;
    case "worktree":
      return ops[0] === "add" && ops[1] ? t("state.shellSentence.git.worktreeAdd", { path: shortPath(ops[1]) }) : t("state.shellSentence.git.worktrees");
    default:
      return t("state.shellSentence.run", { name: `git ${sub}` });
  }
}

/** npm、pnpm、yarn、bun */
function packagePhrase(pm: string, args: readonly string[]): Phrase {
  const plain = plainOf(args);
  const [sub, ...rest] = plain;
  switch (sub) {
    case undefined:
      return pm === "yarn" ? t("state.shellSentence.install") : undefined;
    case "test":
    case "t":
    case "tst":
      return t("state.shellSentence.test");
    case "install":
    case "i":
    case "ci":
    case "add":
      return rest.length > 0 ? t("state.shellSentence.installOf", { packages: joinList(rest) }) : t("state.shellSentence.install");
    case "uninstall":
    case "remove":
    case "rm":
    case "un":
      return rest.length > 0 ? t("state.shellSentence.uninstall", { packages: joinList(rest) }) : undefined;
    case "run":
    case "run-script":
      return rest[0] ? scriptPhrase(rest[0]) : undefined;
    case "exec":
    case "dlx":
    case "x":
      return toolPhrase(rest[0], rest.slice(1));
    default:
      // yarn build、pnpm lint 这种直接写脚本名的
      return pm === "npm" ? t("state.shellSentence.run", { name: `npm ${sub}` }) : scriptPhrase(sub);
  }
}

/** npm 脚本：test 开头是跑测试，build 开头是构建，lint、typecheck、check 是检查代码，别的写脚本名 */
function scriptPhrase(script: string): string {
  if (script.startsWith("test")) return script === "test" ? t("state.shellSentence.test") : t("state.shellSentence.testScript", { script });
  if (script.startsWith("build")) return script === "build" ? t("state.shellSentence.build") : t("state.shellSentence.buildScript", { script });
  if (/^(lint|typecheck|check)/.test(script)) return t("state.shellSentence.lintScript", { script });
  return t("state.shellSentence.npmScript", { script });
}

/** npx 起的工具 */
function toolPhrase(tool: string | undefined, rest: readonly string[]): Phrase {
  if (tool === undefined) return undefined;
  const name = programOf(tool).replace(/@.*$/, "");
  if (TEST_TOOLS.has(name) || (name === "playwright" && rest[0] === "test")) return t("state.shellSentence.test");
  if (name === "tsc") return t("state.shellSentence.typecheck");
  if (LINT_TOOLS.has(name)) return t("state.shellSentence.lint");
  if (name === "prettier") return t("state.shellSentence.format");
  return t("state.shellSentence.run", { name });
}

/** pip install、uv add */
function pipPhrase(plain: readonly string[]): Phrase {
  const words = plain[0] === "pip" ? plain.slice(1) : plain;
  const [sub, ...rest] = words;
  if (sub === "install" || sub === "add" || sub === "sync") return rest.length > 0 ? t("state.shellSentence.installOf", { packages: joinList(rest) }) : t("state.shellSentence.install");
  if (sub === "run" && rest[0]) return programOf(rest[0]) === "pytest" ? t("state.shellSentence.test") : t("state.shellSentence.run", { name: rest[0] });
  return undefined;
}

/** node x.js、python -m pytest、python -c "…" */
function interpreterPhrase(args: readonly string[]): Phrase {
  if (args.some((a) => ["-e", "--eval", "-p", "--print", "-command", "-Command", "-encodedcommand"].includes(a) || /^-[a-zA-Z]*c$/.test(a))) return t("state.shellSentence.inline");
  const module = optionValue(args, ["-m"], []);
  if (module) return TEST_TOOLS.has(module) ? t("state.shellSentence.test") : module === "pip" ? pipPhrase(plainOf(args).slice(1)) : t("state.shellSentence.run", { name: module });
  const script = args.find((a) => !a.startsWith("-"));
  return script ? t("state.shellSentence.run", { name: shortPath(script) }) : undefined;
}

/** curl、wget：请求哪个网址，带数据的是发出去 */
function requestPhrase(prog: string, args: readonly string[]): Phrase {
  const url = args.find((a) => /^https?:\/\//i.test(a)) ?? operandsOf(args, ["-X", "--request", "-H", "--header", "-d", "--data", "-o", "--output", "-u", "-F", "-A", "-e", "-b", "-c"]).find((a) => /\.[a-z]{2,}/i.test(a));
  if (url === undefined) return undefined;
  if (prog === "wget") return t("state.shellSentence.download", { url: shortUrl(url) });
  const explicit = optionValue(args, ["-X"], ["--request", "-Method"]);
  const sends = args.some((a) => /^(-d|-F|--data.*|--json|--form|-T|--upload-file|-Body|-InFile)$/.test(a) || a.startsWith("--data"));
  const method = (explicit ?? (sends ? "POST" : "GET")).toUpperCase();
  return method === "GET" ? t("state.shellSentence.request", { url: shortUrl(url) }) : t("state.shellSentence.send", { method, url: shortUrl(url) });
}
