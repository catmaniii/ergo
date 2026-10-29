// @i18n-ignore-file log：计数工具自己（认中文的正则、标注写错的说明给开发者看）
// 还剩多少处写死的中文（168 号票：多语言迁移的棘轮）。按区域数源码里含中文的字面量，每个区域记一个基线，只许降不许升；
// 每张迁移票把自己区域降下来，175 号票收紧（网页到 0，守护进程只剩登记过的给模型看的和日志）。
//
// 怎么数（不引用 TypeScript 编译器，自己过一遍词法，够用就行）：
// - 扫 .ts / .tsx（鸿蒙 App 是 .ets），注释不算；
// - 一处 = 一个含中文（汉字、中文标点、全角符号）的字符串字面量、模板字符串、正则字面量，或者 JSX 里一段含中文的文字（被 <>{} 隔开的算几段）；
// - 不算的（排除）：
//   - 日志：直接写在 log(...)、console.log/warn/error/info/debug(...)、xxx.log(...) 的括号里的（不用标）；
//   - 标了 @i18n-ignore 的（白名单就是代码里的这些标注，npm run i18n:check -- --ignored 列出全部），原因必须是下面几种之一：
//       model  给模型看的（工具说明、系统提示拼接、给 agent 的错误说明、交给子进程的通知）
//       log    日志、给开发者看的（先拼好再交给 log 的、启动时的编程错误、命令行工具的输出）
//       fixed  故意不翻的（"语言 / Language"这种中英并列的、认旧数据用的旧话 LEGACY_WORDING）
//       data   数据，不是界面文字（内置的样例、节假日名、正则里认中文输入的）
//     写法：`// @i18n-ignore model` 写在那一行末尾只管这一行；`// @i18n-ignore-next model` 管下一行；
//     `// @i18n-ignore-start model` 到 `// @i18n-ignore-end` 管中间几行；`// @i18n-ignore-file model` 管整个文件（写在文件开头的注释里）。
//     标注要是那条注释开头的第一样东西，后面可以接说明（`// @i18n-ignore model：工具说明`）；JSX 里写 `{/* @i18n-ignore fixed */}`。
// - 不扫的：测试、原型的演示数据（packages/web/src/prototype/，和聊天内容一样是"内容"）、多语言自己的代码（protocol/src/i18n/）。
import fs from "node:fs";
import path from "node:path";

/** 标注的原因 */
export const IGNORE_REASONS = ["model", "log", "fixed", "data"] as const;
export type IgnoreReason = (typeof IGNORE_REASONS)[number];

/** 一处含中文的字面量 */
export interface ChineseLiteral {
  line: number;
  text: string;
  kind: "string" | "template" | "regex" | "jsx";
  /** 排除的原因（日志调用里的、标注了的）；算数的是 undefined */
  ignored?: IgnoreReason;
}

export interface SourceScan {
  literals: ChineseLiteral[];
  /** 标注写错了（原因不认得、start 没有 end……）：测试据此报错 */
  markerErrors: string[];
}

const CJK = /[　-〿㐀-䶿一-鿿豈-﫿！-｠￠-￦]/;

/** 在这几个调用里的字面量算日志（xxx.log 也算） */
const LOG_CALLEES = /(^|\.)log$|^console\.(log|warn|error|info|debug)$/;

/** 前一个记号是这些时，/ 开头的是正则（不是除号） */
const REGEX_AFTER_PUNCT = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"]);

const isIdent = (c: string | undefined) => c !== undefined && /[\w$]/.test(c);

// 标注要是注释里的第一样东西（`// @i18n-ignore model：……`，JSX 里是花括号包着的块注释），说明文字里提到它不算
const MARKER = /^\/[/*]\s*@i18n-ignore(-next|-start|-end|-file)?(?:\s+([A-Za-z]+))?/;

/** 扫一个文件的源码 */
export function scanSource(code: string): SourceScan {
  const literals: ChineseLiteral[] = [];
  const markerErrors: string[] = [];
  /** 行号 → 标注的原因 */
  const lineIgnores = new Map<number, IgnoreReason>();
  const ranges: { from: number; to: number; reason: IgnoreReason }[] = [];
  let fileReason: IgnoreReason | undefined;
  let openRange: { from: number; reason: IgnoreReason } | undefined;
  /** 有代码的行（判断标注是不是写在代码行的末尾） */
  const codeLines = new Set<number>();
  /** 写在行末的 @i18n-ignore 在哪几行（单独一行写它管不到东西，要用 -next） */
  const plainMarkers: number[] = [];

  let i = 0;
  let line = 1;
  /** 上一个有意义的记号：标点、词、字面量 */
  let prev: { kind: "punct" | "word" | "literal"; value: string } = { kind: "punct", value: ";" };
  /** 调用栈：每个还没合上的 ( 前面是谁（判断是不是日志调用）；模板里的 ${ 也压一层，记它外面的花括号深度 */
  const parens: (string | undefined)[] = [];
  const templateDepth: number[] = [];
  let braceDepth = 0;

  const inLog = () => parens.some((callee) => callee !== undefined && LOG_CALLEES.test(callee));
  const record = (text: string, kind: ChineseLiteral["kind"], at: number) => {
    if (!CJK.test(text)) return;
    literals.push({ line: at, text, kind, ...(inLog() ? { ignored: "log" as const } : {}) });
  };

  const handleComment = (text: string, at: number) => {
    for (const m of [MARKER.exec(text)].filter((x) => x !== null)) {
      const variant = m[1] ?? "";
      const reason = m[2] as IgnoreReason | undefined;
      if (variant === "-end") {
        if (!openRange) markerErrors.push(`第 ${at} 行：@i18n-ignore-end 前面没有 @i18n-ignore-start`);
        else ranges.push({ from: openRange.from, to: at, reason: openRange.reason });
        openRange = undefined;
        continue;
      }
      if (!reason || !(IGNORE_REASONS as readonly string[]).includes(reason)) {
        markerErrors.push(`第 ${at} 行：@i18n-ignore${variant} 后面要写原因（${IGNORE_REASONS.join(" / ")}），写的是 ${reason ?? "空的"}`);
        continue;
      }
      if (variant === "-file") fileReason = reason;
      else if (variant === "-start") openRange = { from: at, reason };
      else if (variant === "-next") lineIgnores.set(at + 1, reason);
      else {
        lineIgnores.set(at, reason);
        plainMarkers.push(at);
      }
    }
  };

  /** 往前看到的一个词（标识符，带点的成员路径） */
  const calleeBefore = (end: number): string | undefined => {
    let j = end - 1;
    while (j >= 0 && /\s/.test(code[j]!)) j--;
    let k = j;
    while (k >= 0 && /[\w$.]/.test(code[k]!)) k--;
    const word = code.slice(k + 1, j + 1);
    return word === "" ? undefined : word;
  };

  const readQuoted = (quote: string): string => {
    const start = i;
    i++;
    while (i < code.length && code[i] !== quote && code[i] !== "\n") {
      if (code[i] === "\\") i++;
      i++;
    }
    const text = code.slice(start + 1, i);
    i++;
    return text;
  };

  const readRegex = (): string => {
    const start = i;
    i++;
    let inClass = false;
    while (i < code.length && code[i] !== "\n") {
      const c = code[i];
      if (c === "\\") i++;
      else if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) break;
      i++;
    }
    i++;
    while (isIdent(code[i])) i++;
    return code.slice(start, i);
  };

  /** 读模板字符串的一段文字，到 ` 或 ${ 为止 */
  const readTemplateChunk = (): { text: string; open: boolean } => {
    const start = i;
    while (i < code.length) {
      const c = code[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        const text = code.slice(start, i);
        i++;
        return { text, open: false };
      }
      if (c === "$" && code[i + 1] === "{") {
        const text = code.slice(start, i);
        i += 2;
        return { text, open: true };
      }
      if (c === "\n") line++;
      i++;
    }
    return { text: code.slice(start), open: false };
  };

  /** 一段模板文字（含中文就记一处：一个模板字符串的几段文字算一处，按开头那行） */
  let templateStart: { line: number; texts: string[] } | undefined;
  const templateStack: { line: number; texts: string[] }[] = [];
  const continueTemplate = () => {
    const chunk = readTemplateChunk();
    templateStart!.texts.push(chunk.text);
    if (chunk.open) {
      templateStack.push(templateStart!);
      templateDepth.push(braceDepth);
      templateStart = undefined;
      prev = { kind: "punct", value: "{" };
      return;
    }
    record(templateStart!.texts.join(""), "template", templateStart!.line);
    templateStart = undefined;
    prev = { kind: "literal", value: "`" };
  };

  while (i < code.length) {
    const c = code[i]!;
    const next = code[i + 1];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      const end = code.indexOf("\n", i);
      const stop = end < 0 ? code.length : end;
      handleComment(code.slice(i, stop), line);
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end < 0 ? code.length : end + 2;
      const text = code.slice(i, stop);
      handleComment(text, line);
      line += text.split("\n").length - 1;
      i = stop;
      continue;
    }
    codeLines.add(line);
    if (c === '"' || c === "'") {
      const at = line;
      record(readQuoted(c), "string", at);
      prev = { kind: "literal", value: c };
      continue;
    }
    if (c === "`") {
      i++;
      templateStart = { line, texts: [] };
      continueTemplate();
      continue;
    }
    if (c === "/") {
      // </div>：JSX 的结束标签；/>：自闭合标签
      if (prev.kind === "punct" && prev.value === "<") {
        i++;
        prev = { kind: "punct", value: "/" };
        continue;
      }
      const regex = next !== ">" && ((prev.kind === "punct" && REGEX_AFTER_PUNCT.has(prev.value)) || (prev.kind === "word" && REGEX_AFTER_WORD.has(prev.value)));
      if (regex) {
        const at = line;
        record(readRegex(), "regex", at);
        prev = { kind: "literal", value: "/" };
        continue;
      }
      i++;
      prev = { kind: "punct", value: "/" };
      continue;
    }
    if (isIdent(c)) {
      const start = i;
      while (isIdent(code[i])) i++;
      prev = { kind: "word", value: code.slice(start, i) };
      continue;
    }
    if (CJK.test(c)) {
      // 代码里（不在字符串、注释里）的中文：中文的标识符（系统提示的占位符名这类对象的键 `拉回次数: …`）不算；
      // 别的只能是 JSX 的文字，到 < > { } 或换行为止算一段。紧跟在 > 或 } 后面的一定是 JSX 的文字
      const word = /^[\w$㐀-䶿一-鿿]+/.exec(code.slice(i, i + 200))?.[0] ?? "";
      const after = /^[ \t]*(.)/.exec(code.slice(i + word.length, i + word.length + 50))?.[1];
      const jsxContext = prev.kind === "punct" && (prev.value === ">" || prev.value === "}");
      if (word !== "" && !jsxContext && after !== undefined && ":(,)=;.]}?".includes(after)) {
        i += word.length;
        prev = { kind: "word", value: word };
        continue;
      }
      const start = i;
      while (i < code.length && !"<>{}\n".includes(code[i]!)) i++;
      record(code.slice(start, i).trim(), "jsx", line);
      prev = { kind: "literal", value: "jsx" };
      continue;
    }
    if (c === "(") parens.push(calleeBefore(i));
    else if (c === ")") parens.pop();
    else if (c === "{") braceDepth++;
    else if (c === "}") {
      if (templateDepth.length > 0 && templateDepth.at(-1) === braceDepth) {
        templateDepth.pop();
        i++;
        templateStart = templateStack.pop();
        continueTemplate();
        continue;
      }
      braceDepth--;
    }
    prev = { kind: "punct", value: c };
    i++;
  }
  if (openRange) markerErrors.push(`第 ${openRange.from} 行：@i18n-ignore-start 没有对应的 @i18n-ignore-end`);
  for (const at of plainMarkers) if (!codeLines.has(at)) markerErrors.push(`第 ${at} 行：@i18n-ignore 单独占一行管不到东西：写在那一行代码的末尾，或者用 @i18n-ignore-next`);

  for (const literal of literals) {
    if (literal.ignored) continue;
    const reason = fileReason ?? lineIgnores.get(literal.line) ?? ranges.find((r) => r.from <= literal.line && literal.line <= r.to)?.reason;
    if (reason) literal.ignored = reason;
  }
  return { literals, markerErrors };
}

/** 一个区域：哪张票迁、管哪些源码 */
export interface HardcodedRegion {
  readonly region: string;
  readonly ticket: number;
  /** 相对仓库根目录的目录或文件；一个文件按表里第一个包含它的区域算 */
  readonly roots: readonly string[];
}

/**
 * 区域表（和 168–175 号票的分法一致）：顺序就是认领的先后，前面的先认（守护进程 tasks/ 和 173 号票的几个目录排在"其余目录"前面）。
 * 168 号票迁的外壳散在 web-ui、web-state、web-pages 几个区域的文件里，降的是那几个区域
 */
export const HARDCODED_REGIONS: readonly HardcodedRegion[] = [
  {
    region: "web-ui",
    ticket: 169,
    roots: [
      "packages/web/src/ui",
      "packages/web/src/app",
      "packages/web/src/model",
      "packages/web/src/visual-styles",
      "packages/web/src/page-bridge",
      "packages/web/src/util",
      // 193 号票：网页插件（宿主和各插件的界面）
      "packages/web/src/plugins",
      "packages/web/src/App.tsx",
      "packages/web/src/main.tsx",
    ],
  },
  { region: "web-state", ticket: 170, roots: ["packages/web/src/state"] },
  { region: "web-pages", ticket: 171, roots: ["packages/web/src/pages"] },
  { region: "protocol", ticket: 172, roots: ["packages/protocol/src"] },
  { region: "daemon-tasks", ticket: 172, roots: ["packages/daemon/src/tasks"] },
  {
    region: "daemon-a",
    ticket: 173,
    roots: ["guard", "guard-runtime", "projects", "work-orders", "conversation", "voice", "web", "browsing", "secretary"].map((d) => `packages/daemon/src/${d}`),
  },
  { region: "daemon-b", ticket: 174, roots: ["packages/daemon/src"] },
  { region: "harmony", ticket: 175, roots: ["frontend/harmony/entry/src/main/ets"] },
];

/** 不扫的：原型的演示数据、多语言自己的代码 */
export const HARDCODED_EXCLUDED: readonly string[] = ["packages/web/src/prototype", "packages/protocol/src/i18n"];

const SOURCE_EXT = /\.(ts|tsx|ets)$/;

const under = (rel: string, root: string) => rel === root || rel.startsWith(`${root}/`);

/** 这个文件（相对仓库根目录，用 / 分隔）属于哪个区域；不扫的是 undefined */
export function regionOf(rel: string): HardcodedRegion | undefined {
  if (!SOURCE_EXT.test(rel) || rel.endsWith(".d.ts") || HARDCODED_EXCLUDED.some((root) => under(rel, root))) return undefined;
  return HARDCODED_REGIONS.find((r) => r.roots.some((root) => under(rel, root)));
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && SOURCE_EXT.test(entry.name)) out.push(full);
  }
}

/** 一个文件扫出来的（带上相对路径） */
export interface FileScan extends SourceScan {
  file: string;
  region: string;
}

/** 扫整个仓库（repoRoot 是仓库根目录） */
export function scanRepo(repoRoot: string): FileScan[] {
  const roots = [...new Set(HARDCODED_REGIONS.flatMap((r) => r.roots))];
  const files = new Set<string>();
  for (const root of roots) {
    const full = path.join(repoRoot, root);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) files.add(full);
    else {
      const found: string[] = [];
      walk(full, found);
      for (const f of found) files.add(f);
    }
  }
  const out: FileScan[] = [];
  for (const full of [...files].toSorted()) {
    const rel = path.relative(repoRoot, full).split(path.sep).join("/");
    const region = regionOf(rel);
    if (!region) continue;
    out.push({ file: rel, region: region.region, ...scanSource(fs.readFileSync(full, "utf8")) });
  }
  return out;
}

/** 每个区域还剩几处（算数的，不含排除的） */
export function countByRegion(scans: readonly FileScan[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(HARDCODED_REGIONS.map((r) => [r.region, 0]));
  for (const scan of scans) counts[scan.region] = (counts[scan.region] ?? 0) + scan.literals.filter((l) => !l.ignored).length;
  return counts;
}

/** 基线所在的目录：每个区域一个文件 <区域>.json（{ "count": N }），各迁移票只改自己区域的那个，合并时不打架 */
export const HARDCODED_BASELINE_DIR = path.join("packages", "daemon", "test", "i18n", "hardcoded-baseline");

/** 读某个区域的基线 */
export function readBaseline(repoRoot: string, region: string): number | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, HARDCODED_BASELINE_DIR, `${region}.json`), "utf8")) as { count?: unknown };
    return typeof raw.count === "number" ? raw.count : undefined;
  } catch {
    return undefined;
  }
}

/** 写某个区域的基线（只往下降：比原来的大就不写） */
export function lowerBaseline(repoRoot: string, region: string, count: number): boolean {
  const old = readBaseline(repoRoot, region);
  if (old !== undefined && count >= old) return false;
  const ticket = HARDCODED_REGIONS.find((r) => r.region === region)?.ticket;
  fs.mkdirSync(path.join(repoRoot, HARDCODED_BASELINE_DIR), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, HARDCODED_BASELINE_DIR, `${region}.json`), `${JSON.stringify({ ticket, count }, null, 2)}\n`);
  return true;
}
