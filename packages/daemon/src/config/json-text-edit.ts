// 按文本改 JSON 配置文件里的一节（356 号票）：只换要改的那几个键的字节，别的内容、缩进、换行、键的顺序原样留着——
// 用户手写的配置不会因为页面上改了一项就被重排。调用方先确认文本能被 JSON.parse（这里按合法的 JSON 扫，不再报语法错）。
// 同一个键写了两遍时 JSON.parse 认最后一个，这里也改最后那个；去掉时都去掉。

interface Member {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

interface ObjectSpan {
  /** 左花括号的位置 */
  start: number;
  /** 右花括号之后 */
  end: number;
  members: Member[];
}

function skipSpace(text: string, from: number): number {
  let i = from;
  while (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r") i++;
  return i;
}

function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i + 1;
  }
  return text.length;
}

function valueEnd(text: string, start: number): number {
  const first = text[start];
  if (first === '"') return stringEnd(text, start);
  if (first === "{" || first === "[") {
    let depth = 0;
    for (let i = start; i < text.length; ) {
      const c = text[i];
      if (c === '"') {
        i = stringEnd(text, i);
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return text.length;
  }
  let i = start;
  while (i < text.length && !",}] \t\r\n".includes(text[i]!)) i++;
  return i;
}

function scanObject(text: string, start: number): ObjectSpan {
  const members: Member[] = [];
  let i = skipSpace(text, start + 1);
  if (text[i] === "}") return { start, end: i + 1, members };
  for (;;) {
    const keyStart = i;
    const keyEnd = stringEnd(text, keyStart);
    const valueStart = skipSpace(text, skipSpace(text, keyEnd) + 1);
    const end = valueEnd(text, valueStart);
    members.push({ key: JSON.parse(text.slice(keyStart, keyEnd)) as string, keyStart, valueStart, valueEnd: end });
    i = skipSpace(text, end);
    if (text[i] !== ",") return { start, end: i + 1, members };
    i = skipSpace(text, i + 1);
  }
}

const rootOf = (text: string) => scanObject(text, skipSpace(text, 0));

/** pos 所在那一行开头的空白 */
function indentAt(text: string, pos: number): string {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  let i = lineStart;
  while (text[i] === " " || text[i] === "\t") i++;
  return text.slice(lineStart, i);
}

/** pos 是这一行第一个非空白的字符（对象写成了一行一个键的样子） */
const startsLine = (text: string, pos: number) => text.slice(text.lastIndexOf("\n", pos - 1) + 1, pos).trim() === "";

const newlineOf = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");

const splice = (text: string, from: number, to: number, insert: string) => `${text.slice(0, from)}${insert}${text.slice(to)}`;

/** 一层缩进：顶层第一个键的缩进，顶层是空的或挤在一行就两个空格 */
function indentUnit(text: string): string {
  const first = rootOf(text).members[0];
  if (!first || !startsLine(text, first.keyStart)) return "  ";
  return indentAt(text, first.keyStart) || "  ";
}

/** 值写成文本：多行时每行接上这个键的缩进 */
function render(value: unknown, text: string, indent: string): string {
  return JSON.stringify(value, null, indentUnit(text)).replace(/\n/g, `${newlineOf(text)}${indent}`);
}

function insertMember(text: string, object: ObjectSpan, key: string, value: unknown): string {
  const nl = newlineOf(text);
  const last = object.members.at(-1);
  if (!last) {
    const outer = indentAt(text, object.start);
    const inner = `${outer}${indentUnit(text)}`;
    return splice(text, object.start, object.end, `{${nl}${inner}${JSON.stringify(key)}: ${render(value, text, inner)}${nl}${outer}}`);
  }
  const multiline = startsLine(text, last.keyStart);
  const indent = multiline ? indentAt(text, last.keyStart) : "";
  const separator = multiline ? `,${nl}${indent}` : ", ";
  return splice(text, last.valueEnd, last.valueEnd, `${separator}${JSON.stringify(key)}: ${render(value, text, indent)}`);
}

function removeMember(text: string, object: ObjectSpan, index: number): string {
  const { members } = object;
  if (members.length === 1) return splice(text, object.start, object.end, "{}");
  const member = members[index]!;
  // 不是第一个：连前面的逗号一起去掉；是第一个：连后面的逗号和下一个键之前的空白一起去掉
  return index > 0 ? splice(text, members[index - 1]!.valueEnd, member.valueEnd, "") : splice(text, member.keyStart, members[1]!.keyStart, "");
}

function setMember(text: string, objectStart: number, key: string, value: unknown): string {
  if (value === undefined) {
    let out = text;
    for (;;) {
      const object = scanObject(out, objectStart);
      const index = object.members.findLastIndex((m) => m.key === key);
      if (index < 0) return out;
      out = removeMember(out, object, index);
    }
  }
  const object = scanObject(text, objectStart);
  const found = object.members.findLast((m) => m.key === key);
  if (found) return splice(text, found.valueStart, found.valueEnd, render(value, text, indentAt(text, found.keyStart)));
  return insertMember(text, object, key, value);
}

/**
 * 改顶层 section 这一节里的几个键：给值是设成它（没有就加在这一节最后），给 undefined 是去掉。
 * 没有这一节、又有要设的值时加在顶层最后。只有去掉、这一节又不在时什么都不动。这一节不是对象的调用方先拦下
 */
export function editJsonSection(source: string, section: string, changes: Readonly<Record<string, unknown>>): string {
  let text = source;
  for (const [key, value] of Object.entries(changes)) {
    const member = rootOf(text).members.findLast((m) => m.key === section);
    if (member) text = setMember(text, member.valueStart, key, value);
    else if (value !== undefined) {
      text = insertMember(text, rootOf(text), section, { [key]: value });
    }
  }
  return text;
}
