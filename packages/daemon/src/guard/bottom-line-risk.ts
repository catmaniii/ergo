// 硬底线的兜底（101 号票评审后定）：对话审批关着时"先问我"大多放开了，但原来有一些"先问"兜着的是守卫看不准、可能碰到硬底线
// （写二狗自己的受保护区域、读密钥区、读过密钥之后往外送）的写法——这些不随放开走，两边（秘书、任务的 agent）都照旧问或拒。
// 这里是判定函数用的纯函数（不读文件）：
// - 带通配符的路径：通配符之前那段目录（展开靠调用方的环境事实 EnvironmentFacts.wildcards）；
// - 一段看不透的文字（内联脚本、拆不开的命令、看不出读写的程序的命令）里写着的数据目录、受保护区域的路径：写死的盘符路径、
//   Git Bash 写法、`~`、`$HOME`、`%USERPROFILE%`、`$env:USERPROFILE` 拼出来的，数据目录的目录名（`.ergo` 这样写在变量后面的）
//   和它的 8.3 短名；
// - 一段文字是不是要往外送（秘书的特别敏感：往外 POST、发信……；目标都是本机的不算）；网址是不是本机；
// - 网址是不是二狗自己（139 号票：本机的、端口是守护进程实际监听的本机端口或外网端口；"发往本机不算对外"的例外不包括它）。
import { oldNameOf, t } from "@ergo/protocol";
import { win32 } from "node:path";
import { absolutePathsIn, comparable, isWithin, isWithinAny } from "./paths.ts";

/** 一个受保护区域（judge.ts 的 ProtectedArea 同形） */
export interface RiskArea {
  dir: string;
  title: string;
  secrets: boolean;
}

/** bash 的通配符：* ? [...] */
const WILDCARD = /[*?[]/;

/** 路径里带通配符时，通配符之前的那段目录（第一个带通配符的那一段之前）；不带通配符的是 undefined */
export function wildcardPrefix(p: string): string | undefined {
  const { root } = win32.parse(p);
  const segments = p.slice(root.length).split(/[\\/]+/).filter((s) => s !== "");
  const first = segments.findIndex((s) => WILDCARD.test(s));
  if (first < 0) return undefined;
  return win32.join(root, ...segments.slice(0, first));
}

/**
 * 带通配符的路径能不能匹配到 dir 或它里面（逐段比：`**` 匹配任意几段；通配符写的段数不够、到不了 dir 那一层的不算）。
 * 用在展不开的时候：`D:\ergo-data\secret*\keys.env` 能匹配到密钥区 `D:\ergo-data\secrets` 里，`D:\ergo-data\*.log` 到不了
 */
export function globCanReach(glob: string, dir: string): boolean {
  const g = segmentsOf(glob);
  const d = segmentsOf(dir);
  if (g.root !== d.root) return false;
  for (let i = 0; i < d.segments.length; i++) {
    const s = g.segments[i];
    if (s === undefined) return false;
    if (s === "**") return true;
    if (!globSegment(s).test(d.segments[i]!)) return false;
  }
  return true;
}

function segmentsOf(p: string): { root: string; segments: string[] } {
  const c = comparable(p);
  const { root } = win32.parse(c);
  return { root, segments: c.slice(root.length).split("\\").filter((s) => s !== "") };
}

/** 一段带通配符的名字换成正则：* 任意几个字符，? 一个字符，[...] 其中一个；不分大小写 */
function globSegment(segment: string): RegExp {
  let source = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    const close = c === "[" ? segment.indexOf("]", i + 2) : -1;
    if (c === "*") source += ".*";
    else if (c === "?") source += ".";
    else if (close > 0) {
      const body = segment.slice(i + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      source += `[${negated ? "^" : ""}${(negated ? body.slice(1) : body).replaceAll("\\", "\\\\")}]`;
      i = close;
    } else source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

/** 两个目录有没有包含关系（任一方向） */
export function related(a: string, b: string): boolean {
  return isWithin(a, b) || isWithin(b, a);
}

export interface MentionContext {
  /** 数据目录的根 */
  dataDir: string;
  /** 受保护区域（含密钥区） */
  areas: readonly RiskArea[];
  /** 用户主目录：`~`、`$HOME` 这些按它展开 */
  homeDir: string;
  /** 这个 agent 自己的地方（秘书的草稿区，维护者的项目档案和工作目录）：写着它们的不算 */
  ownDirs: readonly string[];
}

/** 一段文字里写着的数据目录、受保护区域：碰到的受保护区域，和有没有写着数据目录里（自己的地方以外）或者数据目录的上级 */
export interface Mentions {
  areas: RiskArea[];
  dataDir: boolean;
  /** 写着的全部绝对路径（展开过 `~`、`$HOME` 这些） */
  paths: string[];
}

/**
 * 一段看不透的文字里写着的数据目录、受保护区域（尽力而为）。先把 `~`、`$HOME`、`%USERPROFILE%`、`$env:USERPROFILE` 换成主目录，
 * 再找绝对路径：落在受保护区域里的记区域；落在数据目录里（自己的地方以外）、是数据目录的上级、或者有一段是数据目录的目录名或它的
 * 8.3 短名的（主目录写成短名、拼在变量后面看不全）记数据目录。没写成绝对路径、只写了数据目录目录名的（`"$X/.ergo/config"`）也记
 */
export function dataDirMentions(text: string, ctx: MentionContext): Mentions {
  const expanded = expandHome(text, ctx.homeDir);
  const paths = absolutePathsIn(expanded);
  const areas: RiskArea[] = [];
  let dataDir = false;
  const names = dataDirNames(ctx.dataDir);
  // 312 号票：旧名字的数据目录（~/.ergou）迁移后是指到数据目录的目录联接，写在它下面的路径照数据目录里的同一处判
  // （自己的地方照样算自己的：接着的 Claude Code 会话的工作目录可能还是旧写法）
  const oldRoot = win32.join(win32.dirname(ctx.dataDir), oldNameOf(win32.basename(ctx.dataDir)));
  const viaOld = (p: string) => (comparable(oldRoot) !== comparable(ctx.dataDir) && isWithin(p, oldRoot) ? win32.join(ctx.dataDir, win32.relative(oldRoot, p)) : p);
  for (const written of paths) {
    const p = viaOld(written);
    const area = ctx.areas.find((a) => isWithin(p, a.dir));
    if (area) {
      if (!areas.includes(area)) areas.push(area);
      continue;
    }
    if (isWithin(p, ctx.dataDir)) {
      if (!isWithinAny(p, ctx.ownDirs.map(viaOld))) dataDir = true;
      continue;
    }
    if (isWithin(ctx.dataDir, p) || hasSegment(p, names)) dataDir = true;
  }
  // 没写成绝对路径的：去掉认出来的绝对路径之后，还有一段是数据目录的目录名或短名
  if (!dataDir && names.some((n) => n.test(stripAbsolutePaths(expanded)))) dataDir = true;
  return { areas, dataDir, paths };
}

/** 路径里的一段（前后是分隔符、引号、空白，或者开头结尾） */
const segment = (body: string) => new RegExp(String.raw`(?:^|[\\/'"\s=:])${body}(?=$|[\\/'"\s;,)])`, "i");

/**
 * 数据目录的目录名（`.ergo`）和它的 8.3 短名（`ERGO~1`），作为路径里的一段来认。312 号票：旧名字（`.ergou`，迁移后是指到
 * 数据目录的目录联接）和它的短名同样认
 */
function dataDirNames(dataDir: string): RegExp[] {
  const base = win32.basename(comparable(dataDir));
  if (base.length < 3) return [];
  return [...new Set([base, oldNameOf(base)])].flatMap((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const short = name.replace(/[^a-z0-9_\-$!#%&@'`^~{}]/gi, "").slice(0, 6).replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
    return [segment(escaped), ...(short.length > 0 ? [segment(`${short}~\\d+`)] : [])];
  });
}

function hasSegment(p: string, names: readonly RegExp[]): boolean {
  return names.some((n) => n.test(p));
}

/** 把文字里写死的盘符路径、Git Bash 写法去掉（剩下的再看有没有只写了目录名的） */
function stripAbsolutePaths(text: string): string {
  return text.replace(/(?<![\w])[a-z]:[\\/][^\s'"\x60<>|,;()[\]{}]*/gi, " ").replace(/(?<![\w.:\\/~-])\/(?:mnt\/|cygdrive\/)?[a-z]\/[^\s'"\x60<>|,;()[\]{}]*/gi, " ");
}

/** `~`、`$HOME`、`${HOME}`、`%USERPROFILE%`、`$env:USERPROFILE`、`%HOMEDRIVE%%HOMEPATH%` 换成主目录 */
function expandHome(text: string, homeDir: string): string {
  const home = homeDir.replaceAll("\\", "/");
  return text
    .replace(/%HOMEDRIVE%%HOMEPATH%/gi, home)
    .replace(/%USERPROFILE%/gi, home)
    .replace(/\$\{?env:USERPROFILE\}?/gi, home)
    .replace(/\$\{HOME\}|\$HOME\b/g, home)
    .replace(/(^|[\s'"=:(])~(?=[\\/])/g, `$1${home}`);
}

/** 网址是不是本机（127.0.0.1 这一段、localhost、::1） */
export function isLocalUrl(url: string): boolean {
  const parsed = parseUrl(url);
  return parsed !== undefined && isLocalHost(parsed.hostname);
}

/** 写明了协议的端口默认值（网址里写的端口等于默认值时 URL.port 是空的） */
const DEFAULT_PORTS: Readonly<Record<string, number>> = { "http:": 80, "https:": 443, "ws:": 80, "wss:": 443 };

/**
 * 网址是不是二狗自己（139 号票；"是不是二狗自己"只在这里判）：本机的（同 isLocalUrl），端口是二狗自己的端口之一（守护进程实际
 * 监听的本机端口和外网端口，由守护进程传进来，GuardPlaces.ownPorts）。是的话返回这个端口，不是返回 undefined。
 * 没写协议的（`127.0.0.1:8810/api`、`localhost:8810`，curl 和浏览器工具都认）按 http 补上再看；没写端口的按协议的默认端口
 */
export function ownPortOf(url: string, ownPorts: readonly number[]): number | undefined {
  const parsed = parseUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`);
  if (!parsed || !isLocalHost(parsed.hostname)) return undefined;
  const port = parsed.port !== "" ? Number(parsed.port) : DEFAULT_PORTS[parsed.protocol];
  return port !== undefined && ownPorts.includes(port) ? port : undefined;
}

/** 写着的网址里二狗自己的端口（去重，按出现的先后） */
export function ownPortsOf(urls: readonly unknown[], ownPorts: readonly number[]): number[] {
  const found = urls.flatMap((u) => {
    const port = typeof u === "string" ? ownPortOf(u, ownPorts) : undefined;
    return port === undefined ? [] : [port];
  });
  return [...new Set(found)];
}

/** 发往二狗自己的端口时依据上加的一句（139 号票）：审批卡、时间线上看得到 */
export function ownApiNote(ports: readonly number[]): string {
  return t("guard.ownApiNote", { ports: ports.join(t("pages.common.listSep")) });
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

const URL_IN_TEXT = /https?:\/\/[^\s'"\x60<>|)]+/gi;
/** 往外送的写法：非 GET 的请求（post / put / patch，包括 -Method Post、requests.post、method: 'POST'），发信，curl / wget 带数据或上传 */
const SEND_IN_TEXT =
  /\b(?:post|put|patch)\b|smtplib|Send-MailMessage|\bsendmail\b|\b(?:curl|wget)\b[^\n]*(?:\s-d\b|\s-F\b|\s-T\b|--data|--form|--upload-file|--post-data|--post-file)/i;

/** 一段文字里写着的网址（http、https 开头的） */
export function urlsInText(text: string): string[] {
  return text.match(URL_IN_TEXT) ?? [];
}

/**
 * 一段看不透的文字（内联脚本、拆不开的命令）是不是要往外送（秘书的特别敏感，101 号票）：有往外送的写法就算；写着的网址都是本机的
 * （127.0.0.1、localhost、::1）不算对外——网址里有二狗自己的端口的不算"都是本机"（139 号票，ownPorts 见 ownPortOf）
 */
export function sendsInText(text: string, ownPorts: readonly number[]): boolean {
  const urls = urlsInText(text);
  if (urls.length > 0 && urls.every((u) => isLocalUrl(u) && ownPortOf(u, ownPorts) === undefined)) return false;
  return SEND_IN_TEXT.test(text);
}
