// 操作回的东西（268 号票，草稿："返回必须有一句能念的 say，细节作附件"）：http（项目服务的调用口）、script（脚本的标准输出）回的
// 都按这里取出能念的那句和附件：
// - 普通 JSON 对象：{ "say": "记好了，午饭 32 块", "detail": <附件，任何 JSON 或文字>, "isError"?: true }；没写 detail 的，
//   say 之外的字段整个当附件；
// - MCP 的 CallToolResult（有 content 数组）：say 写在 structuredContent.say（也认对象上直接写的 say）；content 里的文字接起来
//   （图片、音频、资源写一句占位）连同 structuredContent 里 say 之外的字段当附件；isError: true 算没做成；
// - 别的 JSON、纯文本：没有 say，整个当附件。
// 没给 say 的由二狗按结果补一句（fallbackSay），调用记录里标出来（sayFilled）。
// @i18n-ignore-file model：服务回的内容、二狗补的那句交给秘书（工具结果）
import { oneLine } from "../util/text.ts";
import type { OpKind } from "./manifest.ts";

/** 能念的那句最长多少字（再长的截掉：是一句话，不是报告） */
export const SAY_MAX = 200;

export interface ParsedReply {
  /** 实现给的能念的那句（没给是 undefined） */
  say?: string;
  /** 附件：细节（文字；JSON 写成 JSON） */
  detail: string;
  /** 实现说没做成（isError: true） */
  isError: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** 能念的那句：非空的字符串，压成一行 */
const sayOf = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? oneLine(value, SAY_MAX) : undefined);

/** CallToolResult 的 content 里一项写成文字：文字原样，别的写一句占位 */
function contentText(item: unknown): string {
  if (!isObject(item)) return String(item);
  const c = item as { type?: unknown; text?: unknown; mimeType?: unknown; uri?: unknown; resource?: { uri?: unknown; text?: unknown } };
  if (c.type === "text" && typeof c.text === "string") return c.text;
  if (c.type === "image" || c.type === "audio") return `[${c.type === "image" ? "图片" : "音频"}${typeof c.mimeType === "string" ? ` ${c.mimeType}` : ""}]`;
  if (c.type === "resource_link" && typeof c.uri === "string") return `[资源 ${c.uri}]`;
  if (c.type === "resource" && c.resource) return typeof c.resource.text === "string" ? c.resource.text : `[资源 ${String(c.resource.uri ?? "")}]`;
  return JSON.stringify(item);
}

/** 一个值写成附件的文字 */
const detailOf = (value: unknown): string => (value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value));

/** 去掉几个键之后还剩东西的写成 JSON，没剩的是空 */
function rest(obj: Record<string, unknown>, drop: readonly string[]): string {
  const left = Object.fromEntries(Object.entries(obj).filter(([k]) => !drop.includes(k)));
  return Object.keys(left).length > 0 ? JSON.stringify(left) : "";
}

/** 取出能念的那句和附件（见文件开头） */
export function parseReply(body: string, contentType: string | null): ParsedReply {
  const looksJson = (contentType ?? "").includes("json") || /^\s*[[{"]/.test(body);
  if (!looksJson) return { detail: body, isError: false };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { detail: body, isError: false };
  }
  if (!isObject(json)) return { detail: typeof json === "string" ? json : JSON.stringify(json), isError: false };
  if (Array.isArray(json.content)) {
    const structured = isObject(json.structuredContent) ? json.structuredContent : undefined;
    const say = sayOf(structured?.say) ?? sayOf(json.say);
    const texts = json.content.map(contentText).filter((s) => s !== "");
    const extra = structured ? rest(structured, ["say"]) : json.structuredContent !== undefined ? detailOf(json.structuredContent) : "";
    const detail = [...texts, extra].filter((s) => s !== "").join("\n");
    return { ...(say === undefined ? {} : { say }), detail, isError: json.isError === true };
  }
  const say = sayOf(json.say);
  if (say === undefined) return { detail: JSON.stringify(json), isError: json.isError === true };
  const detail = "detail" in json ? detailOf(json.detail) : rest(json, ["say", "isError"]);
  return { say, detail, isError: json.isError === true };
}

/** 一行、不长、不像 JSON 的附件本身就能念 */
const readable = (text: string) => {
  const t = text.trim();
  return t !== "" && !/[\r\n]/.test(t) && t.length <= 80 && !/^[[{"]/.test(t);
};

/**
 * 实现没给 say 时二狗按结果补的一句（草稿："服务没给 say 的由二狗按结果补一句"）：做成了的附件本身一行能念就用它，
 * 不然按种类说"查好了 / 做好了 / 开始跑了"；没做成的说没做成，带上一行原因
 */
export function fallbackSay(op: { name: string; title?: string; kind: OpKind }, outcome: { ok: boolean; detail: string; reason?: string }): string {
  const what = `「${op.title ?? op.name}」`;
  if (outcome.ok) {
    if (readable(outcome.detail)) return outcome.detail.trim();
    return op.kind === "query" ? `${what}查好了，细节在附件里。` : op.kind === "run" ? `${what}开始跑了。` : `${what}做好了。`;
  }
  const reason = (outcome.reason ?? outcome.detail).trim().split(/\r?\n/)[0] ?? "";
  return reason ? `${what}没做成：${oneLine(reason, 60)}` : `${what}没做成。`;
}
