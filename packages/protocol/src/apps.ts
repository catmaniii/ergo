// 守护进程转发本机服务的页面（132 号票）：项目的服务跑在这台电脑上（127.0.0.1:<端口>），手机、平板、外网直接打不开，
// 守护进程按路径把它转发过去——/apps/<应用名>/… → http://127.0.0.1:<端口>/…（只转发登记过的，不是开放代理），
// 网页里的内置浏览器打开的就是这个地址。
// 前缀怎么写、应用名能用哪些字、前缀约定的环境变量和请求头都只写在这里，守护进程的转发、Web 的内置浏览器和地址、测试都从这里取。
// 不引用 TypeBox。
//
// 前缀约定（docs/developer-guide.md"转发本机服务的页面"）：转发到服务时，浏览器眼里服务在 /apps/<应用名>/ 下面。服务要么只用相对地址
// （<script src="assets/app.js">，不写 /assets/app.js），要么读环境变量 ERGO_BASE_PATH（"/apps/<应用名>"）拼地址；
// 每个转发过去的请求也带着 X-Forwarded-Prefix（同一个值）。

/** 转发的路径前缀（后面跟 /<应用名>/） */
export const APPS_PATH = "/apps";

/** 服务读它知道自己在哪个前缀下（133 号票上线服务时由 LSM 注入），值是 appBasePath(应用名)，不带末尾的斜杠 */
export const APP_BASE_PATH_ENV = "ERGO_BASE_PATH";

/** 转发过去的每个请求都带着它，值同 ERGO_BASE_PATH */
export const APP_PREFIX_HEADER = "x-forwarded-prefix";

/**
 * 应用名：小写字母、数字、连字符，字母或数字开头结尾，最长 63——就是一段域名（以后改成独立的源，比如 <应用名>.<二狗的域名>，
 * 用得上，见 docs/developer-guide.md 同源转发的安全取舍）。133 号票登记成 <项目>-<服务>
 */
const APP_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isAppName(name: string): boolean {
  return APP_NAME.test(name);
}

/** 应用的前缀："/apps/<应用名>"（不带末尾的斜杠：ERGO_BASE_PATH、X-Forwarded-Prefix 的值） */
export function appBasePath(name: string): string {
  return `${APPS_PATH}/${name}`;
}

/** 应用里的一个地址：sub 是前缀下面的那一段（不带开头的斜杠，可以带查询串），不给是首页 "/apps/<应用名>/" */
export function appUrl(name: string, sub = ""): string {
  return `${appBasePath(name)}/${sub.replace(/^\/+/, "")}`;
}

/**
 * 拆一个请求地址（路径加查询串，原样的、没解码的）：在 /apps/<应用名> 下面的给出应用名和后面那一段 rest（"/"、"/a/b?x=1"；
 * 只写到应用名的是 "" 或 "?x=1"，网关让它跳到带斜杠的首页）；不在前缀下、应用名写得不对的是 undefined
 */
export function parseAppPath(url: string): { name: string; rest: string } | undefined {
  const head = `${APPS_PATH}/`;
  if (!url.startsWith(head)) return undefined;
  const after = url.slice(head.length);
  const end = after.search(/[/?#]/);
  const name = end < 0 ? after : after.slice(0, end);
  if (!isAppName(name)) return undefined;
  return { name, rest: end < 0 ? "" : after.slice(end) };
}
