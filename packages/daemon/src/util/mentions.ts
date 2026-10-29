// 一段文字里有没有"整段地"提到某个编号（265 号票）：前后挨着的不是字母、数字、下划线、连字符才算——证据编号 ev-1000
// 不会当成 ev-10000 的一部分（推理库的编号补零到 4 位，过了 9999 就会有前缀相同的）。彻底删除按编号找问记忆的结果时用
// （memory/purge.ts 找事件日志里的记录、runtime/agent-child/session-rewrite.ts 改会话文件里的行）。
// 272 号票：按编号换行（replaceMentionLines）也挪到这里——会话文件（子进程）和事件日志里的一次性补抹（memory/purge-backfill.ts）
// 用同一个认法。
const ID_CHAR = /[0-9A-Za-z_-]/;

export function mentionsId(text: string, id: string): boolean {
  if (id === "") return false;
  for (let at = text.indexOf(id); at >= 0; at = text.indexOf(id, at + 1)) {
    const before = text[at - 1];
    const after = text[at + id.length];
    if ((before === undefined || !ID_CHAR.test(before)) && (after === undefined || !ID_CHAR.test(after))) return true;
  }
  return false;
}

/** 一行是新的一条（不是上一条的续行）：缩进之后以 -、·、•、*、"1." / "1、" 这类开头 */
const LIST_ITEM = /^\s*(?:[-·•*]|\d+[.、)])\s/; // @i18n-ignore data：认工具结果里的列表写法，不是给人看的文字

/** 这一行里提到的第一个字串（按整段认，ev-1000 不是 ev-10000 的一部分）；没有是 undefined */
const mentioned = (line: string, needles: readonly string[]): string | undefined => needles.find((needle) => mentionsId(line, needle));

const indentOf = (line: string) => line.length - line.trimStart().length;
/** 这一行让没合上的「」多了几层（合上的减掉） */
const quoteDelta = (line: string) => [...line].reduce((n, ch) => n + (ch === "「" ? 1 : ch === "」" ? -1 : 0), 0); // @i18n-ignore data：认简报里引原话的括号

/**
 * 工具结果里提到这些字串的行换成"- 字串 · 删除标记"（字串按整段认）。continuation 时这一条的续行一起换掉：往下缩进、又不是新一条
 * （不以 -、·、"1." 这类开头）的行（问记忆的简报一条记录分几行写：编号、原话、精炼），和这一条里没合上的「」里的行（原话本来就有换行）。
 * 已经是"- 字串 · 删除标记"的行原样留着、不再吃后面的行（272 号票：以前第二遍会把紧跟着的、缩进比它深的别的内容当续行换掉），
 * 所以再换一遍不变（幂等：会话文件每次启动都会按以前的彻底删除再对一遍）。没有要换的是 undefined
 */
export function replaceMentionLines(text: string, needles: readonly string[], marker: string, options: { continuation?: boolean } = {}): string | undefined {
  if (needles.length === 0) return undefined;
  const lines = text.split("\n");
  const out: string[] = [];
  let touched = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const needle = mentioned(line, needles);
    if (needle === undefined) {
      out.push(line);
      continue;
    }
    const replaced = `- ${needle} · ${marker}`;
    out.push(replaced);
    // 已经换过的行不再动、也不再吃后面的行：它的续行上一次已经一起换掉了，后面的是别的内容（缩进比它深也不算它的续行）
    if (line === replaced) continue;
    touched = true;
    if (!options.continuation) continue;
    const indent = indentOf(line);
    let open = Math.max(0, quoteDelta(line));
    while (i + 1 < lines.length) {
      const next = lines[i + 1]!;
      const follows = open > 0 || (next.trim() !== "" && indentOf(next) > indent && !LIST_ITEM.test(next));
      if (!follows) break;
      open = Math.max(0, open + quoteDelta(next));
      i += 1;
    }
  }
  return touched ? out.join("\n") : undefined;
}
