// 用哪个浏览器（70 号票）：联网搜索、读网页（playwright-core 驱动，不下载浏览器）和 agent 的 bash 里的 agent-browser
// （环境变量 AGENT_BROWSER_EXECUTABLE_PATH）用同一个，选择和探测只在这里有一份。
//
// 照搬 drama_maker 的 server/pi/chrome-path.js 的 chromeExecutablePath()（评审后定原样做）：候选的顺序（外部显式指定的
// AGENT_BROWSER_EXECUTABLE_PATH → agent-browser 自带 → 系统 Chrome）、读 PE 签名表的探测、"先跳过没签名的，一个不剩才按存在兜底"、
// 结果一个进程只探一次（没找到也记住，不设环境变量）。只多一处：用户在二狗的配置里显式写了 web.browserPath 时它排最前面。
//
// 背景（drama_maker issue #110）：本机 360 主动防御会杀掉没有签名的浏览器的沙箱子进程——进程秒退、退出码 3、一行日志都没有。
// Chrome for Testing（`agent-browser install` 下的那份）不带代码签名，在本机永远跑不起来；同一个目录里放一份签名的 Chrome
// （系统 Chrome 的拷贝）就一切正常。签没签名是能探测的实事：这里读 PE 文件头里的签名表，探测结果说了算。
import fs from "node:fs";
import path from "node:path";

/** 一个候选：路径和它为什么在这里（日志里说清楚选了谁、跳过了谁） */
export interface BrowserCandidate {
  path: string;
  why: string;
}

/** 环境变量按名字取（Windows 上变量名不分大小写；测试里传的是普通对象） */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  const value = key === undefined ? undefined : env[key];
  return value === undefined || value.trim() === "" ? undefined : value;
}

/** agent-browser 自带的浏览器所在的目录：用户主目录下的 .agent-browser/browsers */
export function agentBrowserDir(homeDir: string): string {
  return path.join(homeDir, ".agent-browser", "browsers");
}

/**
 * agent-browser 自带的那份：`~/.agent-browser/browsers/chrome-<版本>/chrome.exe` 里存在的，版本高的在前（目录名带版本号，
 * 照 drama 按字典序倒排）。不判签名——交给 pickBrowser，好让"跳过了没签名的那个"在日志里说清楚
 */
export function agentBrowserCandidates(homeDir: string): string[] {
  const dir = agentBrowserDir(homeDir);
  try {
    return fs
      .readdirSync(dir)
      .filter((d) => d.startsWith("chrome-"))
      .toSorted()
      .toReversed()
      .map((d) => path.join(dir, d, "chrome.exe"))
      .filter(exists);
  } catch {
    return [];
  }
}

/**
 * 系统装的 Chrome（照 drama 的 SYSTEM_CHROME：Program Files、Program Files (x86)、LocalAppData 三处）：用户日常用的那个，
 * 会自动升级、被 360 和浏览器助手盯得最紧，所以只作兜底
 */
export function systemChromePaths(env: Readonly<Record<string, string | undefined>>): BrowserCandidate[] {
  const chrome = "Google/Chrome/Application/chrome.exe";
  return [envValue(env, "ProgramFiles"), envValue(env, "ProgramFiles(x86)"), envValue(env, "LOCALAPPDATA")].flatMap((root) =>
    root ? [{ path: path.join(root, chrome), why: "系统 Chrome 兜底" }] : [],
  );
}

/**
 * 全部候选，按优先级排（照 drama 的 chromeCandidates）：① 外部显式指定的——用户在二狗的配置里写了 web.browserPath 的排最前，
 * 然后是守护进程环境里的 AGENT_BROWSER_EXECUTABLE_PATH（用户想换 Chrome / Edge 时不覆盖）→ ② agent-browser 自带（版本固定）
 * → ③ 系统 Chrome 兜底
 */
export function browserCandidates(input: { configured?: string | undefined; homeDir: string; env: Readonly<Record<string, string | undefined>> }): BrowserCandidate[] {
  const fromEnv = envValue(input.env, AGENT_BROWSER_ENV);
  return [
    ...(input.configured ? [{ path: input.configured, why: "外部显式指定（二狗的配置 web.browserPath）" }] : []),
    ...(fromEnv ? [{ path: fromEnv, why: `外部显式指定（${AGENT_BROWSER_ENV}）` }] : []),
    ...agentBrowserCandidates(input.homeDir).map((p) => ({ path: p, why: "agent-browser 自带（版本固定）" })),
    ...systemChromePaths(input.env),
  ];
}

/** agent-browser 认的环境变量：浏览器的可执行文件（二狗拉起 agent 时注入 bash 的环境） */
export const AGENT_BROWSER_ENV = "AGENT_BROWSER_EXECUTABLE_PATH";

export type SignatureProbe = "signed" | "unsigned" | "unknown";

/**
 * PE 文件有没有内嵌的 Authenticode 签名（照搬 drama 的 probeEmbeddedSignature）。
 * 判据：PE 可选头里第 4 项 data directory（IMAGE_DIRECTORY_ENTRY_SECURITY）不为零——它指向文件尾部的 WIN_CERTIFICATE 表，
 * 不为零就是文件里真嵌了一段签名（drama 实测和 Windows 报的 Valid / NotSigned 逐份一致）。只读文件头 4 KB，不起子进程。
 * 读不到、不是 PE 的是 unknown：调用方不能据此否决候选。
 * 已知边界：unsigned 严格说是"没有内嵌签名"，只有目录签名（catalog-signed）的文件也报成 unsigned；Chrome、Edge 都带内嵌签名，
 * 方向上也是安全的（少用一份、回落到下一份，原因写进日志）
 */
export function probeEmbeddedSignature(exePath: string): SignatureProbe {
  let fd: number | undefined;
  try {
    fd = fs.openSync(exePath, "r");
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    // 不是 MZ
    if (n < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return "unknown";
    const peOff = buf.readUInt32LE(0x3c);
    // 不是 PE
    if (peOff + 4 > n || buf.readUInt32LE(peOff) !== 0x00004550) return "unknown";
    const optOff = peOff + 24;
    if (optOff + 2 > n) return "unknown";
    const magic = buf.readUInt16LE(optOff);
    // 既不是 PE32+ 也不是 PE32
    if (magic !== 0x20b && magic !== 0x10b) return "unknown";
    // DataDirectory[0] 的起点；第 4 项（SECURITY）
    const dirsOff = optOff + (magic === 0x20b ? 112 : 96);
    const secOff = dirsOff + 4 * 8;
    if (secOff + 8 > n) return "unknown";
    const va = buf.readUInt32LE(secOff);
    const size = buf.readUInt32LE(secOff + 4);
    return va > 0 && size > 0 ? "signed" : "unsigned";
  } catch {
    return "unknown";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关不掉就算了
      }
    }
  }
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 选的结果：路径（一个都没有是 null）、为什么选它、跳过了哪些（各带原因） */
export interface BrowserPick {
  path: string | null;
  why: string;
  rejected: string[];
}

/**
 * 选一个浏览器（照搬 drama 的 pickChrome）：第一轮只认"存在、而且没被判成没签名"的；一个都没有时退回"第一个存在的"
 * （并告警：多半会秒退），绝不比不验签更差
 */
export function pickBrowser(candidates: readonly BrowserCandidate[], probe: (p: string) => SignatureProbe = probeEmbeddedSignature): BrowserPick {
  const rejected: string[] = [];
  for (const c of candidates) {
    if (!exists(c.path)) {
      rejected.push(`${c.path} —— 文件不存在`);
      continue;
    }
    const sig = probe(c.path);
    if (sig === "unsigned") {
      rejected.push(`${c.path} —— 没有 Authenticode 签名（本机的 360 会杀它的沙箱子进程：秒退、退出码 3、没有日志）`);
      continue;
    }
    return { path: c.path, why: c.why + (sig === "unknown" ? "（签名探测不出结论，按能用处理）" : "，已验签"), rejected };
  }
  const first = candidates.find((c) => exists(c.path));
  if (first) return { path: first.path, why: "全部候选都没有内嵌签名，只能按存在兜底（浏览器多半会秒退）", rejected };
  return { path: null, why: "", rejected };
}

/**
 * 守护进程里的浏览器探测（照 drama 的 chromeExecutablePath）：第一次要用时探一次，结果记住，一个进程只探一次——
 * 没找到也记住（不设环境变量，让 agent-browser 走它自己的默认逻辑）；改了配置、装了浏览器要重启二狗才认
 */
export interface BrowserLocator {
  /** 浏览器的可执行文件；没找到是 undefined */
  path(): string | undefined;
  /** 没找到时给模型、给人看的说法 */
  missingReason(): string;
}

export function createBrowserLocator(input: {
  configured?: string | undefined;
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
  log: (line: string) => void;
  /** 测试用：换掉签名探测 */
  probe?: (p: string) => SignatureProbe;
}): BrowserLocator {
  let picked: BrowserPick | undefined;
  const pick = (): BrowserPick => {
    if (picked !== undefined) return picked;
    picked = pickBrowser(browserCandidates(input), input.probe);
    input.log(picked.path ? `浏览器用 ${picked.path}：${picked.why}` : "没找到能用的浏览器：联网搜索、读网页要浏览器的那几步和 agent-browser 都用不了（不设环境变量）");
    // 被跳过的候选要留痕：这是"浏览器为什么突然不好用了"的唯一线索（drama issue #110 查了一轮才查到）
    if (picked.rejected.length > 0) input.log(`跳过的浏览器候选：${picked.rejected.join(" | ")}`);
    return picked;
  };
  return {
    path: () => pick().path ?? undefined,
    missingReason: () => {
      const tried = pick().rejected;
      return (
        "找不到浏览器。在数据目录的配置里写 web.browserPath（Chrome 或 Edge 的可执行文件的绝对路径），或者装上 Chrome，然后重启二狗" +
        (tried.length > 0 ? `。找过：${tried.join("；")}` : "")
      );
    },
  };
}
