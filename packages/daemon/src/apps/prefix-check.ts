// 前缀下自检（132 号票）：转发到服务时它在 /apps/<应用名>/ 下面，页面里以 / 开头的地址（/assets/app.js）会跑到二狗的根上去、
// 写死的本机地址（http://127.0.0.1:5173/…）手机上打不开。抓服务的首页，把这两种找出来——维护者在建设期间、交运营方案之前跑一遍
// （npm run check:app-prefix，见 prefix-check-cli.ts），133 号票上线前也能用 checkAppPrefix 再查一次。
// 只看首页的 HTML：标签上的地址属性（src、href、action、formaction、poster、data、srcset）、<style> 和 style 属性里的 url(…)、@import。
// 脚本里拼出来的地址（fetch("/api/…")）看不出来，前缀约定照样要守（docs/developer-guide.md"转发本机服务的页面"）。
// @i18n-ignore-file model：自检的报告给维护者（模型）和命令行看
import { APP_PREFIX_HEADER, appBasePath } from "@ergo/protocol";
import { isLoopbackHost, type AppPrefixMode } from "./registry.ts";

/** 一处不在前缀下的地址 */
export interface PrefixFinding {
  /** 在哪：属性名（src、href……）或 url()、@import */
  where: string;
  url: string;
  /** root：以 / 开头、不在前缀下；loopback：写死了本机地址 */
  problem: "root" | "loopback";
}

const ATTRIBUTE = /\s(src|href|action|formaction|poster|data|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
const CSS_IMPORT = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;

/** 一个地址有没有问题 */
function problemOf(url: string, basePath: string): PrefixFinding["problem"] | undefined {
  const value = url.trim();
  if (value.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    try {
      const parsed = new URL(value, "http://x");
      return (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "ws:") && isLoopbackHost(parsed.hostname) ? "loopback" : undefined;
    } catch {
      return undefined;
    }
  }
  if (!value.startsWith("/")) return undefined;
  return value === basePath || value.startsWith(`${basePath}/`) || value.startsWith(`${basePath}?`) ? undefined : "root";
}

/** 找出页面里不在前缀下的地址（按出现的先后，同一处同一个地址只算一次） */
export function findOffPrefixUrls(html: string, basePath: string): PrefixFinding[] {
  // 注释不算；脚本的正文不看（里面的字符串看不出是不是地址），<script src> 的属性照看
  const page = html.replace(/<!--[\s\S]*?-->/g, "").replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, "$1$2");
  const found: PrefixFinding[] = [];
  const seen = new Set<string>();
  const add = (where: string, url: string) => {
    const problem = problemOf(url, basePath);
    const key = `${where}\0${url}`;
    if (problem === undefined || seen.has(key)) return;
    seen.add(key);
    found.push({ where, url, problem });
  };
  for (const m of page.matchAll(ATTRIBUTE)) {
    const name = m[1]!.toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (name === "srcset") for (const candidate of value.split(",")) add(name, candidate.trim().split(/\s+/)[0] ?? "");
    else add(name, value);
  }
  for (const m of page.matchAll(CSS_URL)) add("url()", m[1] ?? m[2] ?? m[3] ?? "");
  for (const m of page.matchAll(CSS_IMPORT)) add("@import", m[1] ?? m[2] ?? "");
  return found;
}

export interface PrefixCheckResult {
  /** 抓的是哪个地址 */
  url: string;
  status: number;
  basePath: string;
  findings: PrefixFinding[];
}

/**
 * 抓服务的首页（像转发过来的那样带着 X-Forwarded-Prefix；keep 的服务首页本来就在前缀下）再查。target 是 http://127.0.0.1:<端口>。
 * 连不上抛错
 */
export async function checkAppPrefix(target: string, name: string, prefix: AppPrefixMode = "strip"): Promise<PrefixCheckResult> {
  const basePath = appBasePath(name);
  const url = new URL(prefix === "keep" ? `${basePath}/` : "/", target).href;
  const res = await fetch(url, { headers: { [APP_PREFIX_HEADER]: basePath, "x-forwarded-proto": "http", accept: "text/html" } });
  const html = await res.text();
  return { url, status: res.status, basePath, findings: findOffPrefixUrls(html, basePath) };
}

/** 给人看的报告（命令行和维护者用） */
export function prefixCheckReport(result: PrefixCheckResult): string {
  const head = `前缀下自检：${result.url}（HTTP ${result.status}，前缀 ${result.basePath}/）`;
  if (result.findings.length === 0) return `${head}\n没有发现以 / 开头、不在前缀下的地址，也没有写死的本机地址。（脚本里拼的地址看不出来，照样要守前缀约定）`;
  const lines = result.findings.map((f) => `- ${f.where}: ${f.url}  ${f.problem === "root" ? "以 / 开头、不在前缀下：改成相对地址，或者用 ERGO_BASE_PATH 拼" : "写死了本机地址：手机上打不开，改成相对地址"}`);
  return `${head}\n发现 ${result.findings.length} 处不在前缀下的地址：\n${lines.join("\n")}`;
}
