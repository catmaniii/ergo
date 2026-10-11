// 地址栏历史（88 号票评审）：页面里跳转压一条新记录，并在新记录上记下从哪来；标题栏的 ‹ 回到上一级时不再压新记录——
// 上一条就是要回的那一页（经这里跳过来的）就后退一步，否则把这一条换成那一页。这样看板 → 点卡进任务 → ‹ 之后按浏览器后退，
// 不会重新打开刚才的任务。鸿蒙的返回键走返回栈的 page 层（page-back.ts），调的是同一个 ‹。
// 不碰浏览器的全局变量：location、history 换成接口，测试在 Node 里跑（test/app/history-nav.test.ts）；页面上那一份在 route.ts。
import { parseHash, toHash } from "./route-hash.ts";

/** 用到的那一点 window.location / window.history */
export interface HistoryEnv {
  readonly location: { hash: string; replace(url: string): void };
  readonly history: { readonly state: unknown; back(): void; replaceState(data: unknown, unused: string): void };
}

/** 记在每条记录上的来处（history.state） */
interface CameFrom {
  readonly ergouFrom: string;
}

function fromOf(state: unknown): string | undefined {
  return typeof state === "object" && state !== null && typeof (state as Partial<CameFrom>).ergouFrom === "string" ? (state as CameFrom).ergouFrom : undefined;
}

/** 同一页的地址可能写法不同（#tasks、#/tasks），按拆出来的页面比 */
function samePage(a: string, b: string): boolean {
  return toHash(parseHash(a)) === toHash(parseHash(b));
}

/** 回到 to 时怎么走：上一条（这一条记下的来处）就是 to，后退一步；没记来处、来处是别的页，就换掉这一条 */
export function backStep(to: string, from: string | undefined): "back" | "replace" {
  return from !== undefined && samePage(from, to) ? "back" : "replace";
}

/** 去 to：压一条新记录，在新记录上记下从哪来；去的就是现在这一页就什么也不做 */
export function pushHash(env: HistoryEnv, to: string): void {
  const from = env.location.hash;
  if (samePage(from, to)) return;
  env.location.hash = to;
  env.history.replaceState({ ergouFrom: from } satisfies CameFrom, "");
}

/** 标题栏的 ‹：回到 to，不压新记录（见 backStep） */
export function backToHash(env: HistoryEnv, to: string): void {
  if (backStep(to, fromOf(env.history.state)) === "back") env.history.back();
  else env.location.replace(to);
}
