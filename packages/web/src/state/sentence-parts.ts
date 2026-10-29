// 说人话的一句里的小零件（67 号票）：长路径、长网址怎么缩，几个路径怎么并，退回原样时怎么截。
// call-sentence.ts（各工具的模板）和 shell-sentence.ts（通用 bash 拆出来的命令）共用。纯函数。
// 170 号票起"、"和"等 N 个"按当前语言（state.sentenceParts.*）。
import { t } from "./protocol.ts";

/** 句子里的路径超过这么多字就缩（用户 2026-10-10 定） */
export const PATH_MAX = 40;

/** 没有模板、退回"中文名 · 参数值"时截到这么多字 */
export const FALLBACK_MAX = 60;

/**
 * 路径太长时只留末尾几级，前面写"…/"（用户 2026-10-10 定）：从最后一级往前加，加到放不下为止；
 * 最后一级自己就放不下的，留它的末尾。Windows 写法的路径（反斜杠）前面写"…\"，和后面的分隔符一致
 */
export function shortPath(path: string, max = PATH_MAX): string {
  if (path.length <= max) return path;
  const sep = path.lastIndexOf("\\") > path.lastIndexOf("/") ? "\\" : "/";
  const parts = path.split(/[\\/]/).filter((p) => p !== "");
  const head = `…${sep}`;
  let tail = parts.pop() ?? path;
  if (head.length + tail.length > max) return `…${tail.slice(tail.length - (max - 1))}`;
  for (let p = parts.pop(); p !== undefined; p = parts.pop()) {
    const longer = `${p}${sep}${tail}`;
    if (head.length + longer.length > max) break;
    tail = longer;
  }
  return `${head}${tail}`;
}

/**
 * 网址：去掉 http(s)://；太长时留主机名和最后一级（example.com/…/post-12），还放不下就截到 max 字。
 * 网址最要紧的是哪个网站，所以和路径不同，留开头的主机名
 */
export function shortUrl(url: string, max = PATH_MAX): string {
  const bare = url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  if (bare.length <= max) return bare;
  const slash = bare.indexOf("/");
  const host = slash < 0 ? bare : bare.slice(0, slash);
  // 最后一级不算查询串、锚点
  const last = slash < 0 ? "" : (bare.slice(slash + 1).split(/[?#]/)[0]!.split("/").filter((p) => p !== "").pop() ?? "");
  const kept = last ? `${host}/…/${last}` : host;
  return kept.length <= max ? kept : `${kept.slice(0, max - 1)}…`;
}

/** 几个路径：各自缩短，用"、"并起来；超过两个只写前两个和"等 N 个" */
export function pathsText(paths: readonly string[]): string {
  const shown = joinList(paths.slice(0, 2).map((p) => shortPath(p)));
  return paths.length > 2 ? t("state.sentenceParts.andMore", { shown, total: paths.length }) : shown;
}

/** 几样东西用"、"并起来（英文是", "；不用 formatList：中文的结果是"甲、乙和丙"，和原来不一样） */
export function joinList(items: readonly string[]): string {
  return items.join(t("state.sentenceParts.listSep"));
}

/** 截到 max 字（截掉的用"…"顶最后一个字） */
export function cutTo(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
