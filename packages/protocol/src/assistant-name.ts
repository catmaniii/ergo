// 个人助理的名字（43 号票，规格第 19 节"名称"）：界面上秘书显示为用户起的名字，默认"二狗"（89 号票，用户 2026-10-11 定；
// 原来是"个人助理"，已经存下的名字照旧用、不迁移），设置里改，各设备一样。
// 不引用 TypeBox（事件负载、配置文件、HTTP 请求体的 schema 在 assistant-name-schema.ts），Web 的状态层直接用这里的。
//
// 名字占位：守护进程生成、在界面上显示的话里要提到秘书的（会话里的系统说明、待我处理事项的来源和说明、卡片上的说明……），
// 不把名字写死进事件，而是写 ASSISTANT_NAME_MARK；前端按当前的名字显示（带底色的小标签），所以改名后旧的也跟着变。
// 交给 agent 的话里一律换成领域术语"秘书"（守护进程在宿主协议的出口换，runtime/agent-process.ts），模型看不到占位。
// 43 号票之前存下的事件里写死的旧说法，前端显示时按 LEGACY_WORDING 换成现在的说法（currentWording）。
import { t } from "./i18n/runtime.ts";

/** 默认的名字（也是"恢复默认"之后的名字） */
export const DEFAULT_ASSISTANT_NAME = "二狗"; // @i18n-ignore fixed：用户起的名字不翻

/** 名字最多几个字（按 Unicode 码点数：一个汉字、一个字母、一个 emoji 都算一个） */
export const ASSISTANT_NAME_MAX = 8;

/**
 * 名字占位。用很少有人打的方括号包住，万一漏到别处（没换的纯文字、截短了的一行）也读得懂；
 * 用户起的名字里不能有这两个括号，所以名字换进去以后不会再被当成占位。它是内部记号（事件日志里存的就是它），
 * 89 号票默认名字改成"二狗"时不跟着改
 */
export const ASSISTANT_NAME_MARK = "⟦个人助理⟧"; // @i18n-ignore fixed：内部记号，事件日志里存的就是它

/** 交给 agent 的话里，名字占位换成的领域术语 */
export const ASSISTANT_DOMAIN_TERM = "秘书"; // @i18n-ignore model

const MARK_BRACKETS = /[⟦⟧]/u;
/** 换行：LF、CR、NEL、行分隔符、段分隔符 */
const LINE_BREAK = /[\n\r\u0085\u2028\u2029]/u;
const CONTROL = /\p{Cc}/u;

export type AssistantNameCheck = { ok: true; name: string } | { ok: false; error: string };

/** 起的名字合不合规：去掉首尾空白后 1–8 个字，不能有换行和控制字符；合规时给出要存的名字（去掉了首尾空白） */
export function checkAssistantName(raw: string): AssistantNameCheck {
  const name = raw.trim();
  if (name === "") return { ok: false, error: t("protocol.assistantName.empty") };
  if (LINE_BREAK.test(name)) return { ok: false, error: t("protocol.assistantName.lineBreak") };
  if (CONTROL.test(name)) return { ok: false, error: t("protocol.assistantName.control") };
  if (MARK_BRACKETS.test(name)) return { ok: false, error: t("protocol.assistantName.brackets") };
  const length = Array.from(name).length;
  if (length > ASSISTANT_NAME_MAX) return { ok: false, error: t("protocol.assistantName.tooLong", { max: ASSISTANT_NAME_MAX, length }) };
  return { ok: true, name };
}

/** 一段话拆开的一段：普通文字，或者名字（界面显示成带底色的小标签） */
export type AssistantNameSegment = { readonly text: string } | { readonly name: true };

/** 把一段话按名字占位拆开，按先后；没有占位的就是原样一段，空字符串没有段 */
export function splitAssistantName(text: string): AssistantNameSegment[] {
  const segments: AssistantNameSegment[] = [];
  text.split(ASSISTANT_NAME_MARK).forEach((piece, i) => {
    if (i > 0) segments.push({ name: true });
    if (piece !== "") segments.push({ text: piece });
  });
  return segments;
}

/**
 * 43 号票之前存下的旧说法：事件日志不可改，那时守护进程生成的话里写死了"秘书""待我处理"。前端显示守护进程写的话时先按这张表
 * 换成现在的说法（秘书换成名字占位，待我处理换成"待办"），效果和新的一样。只认这几句固定的话，不做全文替换：
 * 用户说的话、agent 回复里的"秘书"不动。whole 为真的只在整个字段就是这句时才换（事项、审批卡的来源）。
 * 以后改了守护进程给人看的说法、旧数据里还留着旧说法的，在这里加一行
 */
// @i18n-ignore-start fixed：认旧数据里写死的旧说法
export const LEGACY_WORDING: ReadonlyArray<{ old: string; now: string; whole?: true }> = [
  // 审批卡、交给我做、中断、快速动作事项的来源
  { old: "秘书对话", now: `${ASSISTANT_NAME_MARK}对话`, whole: true },
  // 审批卡的纯文本降级
  { old: "审批（秘书对话）：", now: `审批（${ASSISTANT_NAME_MARK}对话）：` },
  // 交给我做、中断事项的说明（开头是来源）
  { old: "秘书对话里要做的这件事守卫判定为", now: `${ASSISTANT_NAME_MARK}对话里要做的这件事守卫判定为` },
  { old: "秘书对话里正在执行", now: `${ASSISTANT_NAME_MARK}对话里正在执行` },
  // 秘书会话里的系统说明：没能回复（模型出错、读附件出错）、处理到一半被打断
  { old: "秘书这次没能回复：", now: `${ASSISTANT_NAME_MARK}这次没能回复：` },
  { old: "处理时中断了，秘书没有接着处理；需要的话请重发。", now: `处理时中断了，${ASSISTANT_NAME_MARK}没有接着处理；需要的话请重发。` },
  // 提醒卡的处理结果
  { old: "秘书按你的话取消了", now: `${ASSISTANT_NAME_MARK}按你的话取消了` },
  // 节假日数据缺失事项的说明
  { old: "（秘书不能联网）。", now: `（${ASSISTANT_NAME_MARK}不能联网）。` },
  // 待我处理在界面上叫"待办"：维护者会话里只给人看的两句说明
  { old: "等你验收：已放进待我处理。", now: "等你验收：已放进待办。" },
  { old: '转给你拍板（待我处理里的"卡住求助"）。', now: '转给你拍板（待办里的"卡住求助"）。' },
];
// @i18n-ignore-end

/** 守护进程写的一段话换成现在的说法（按 LEGACY_WORDING；已经是新说法的原样） */
export function currentWording(text: string): string {
  let out = text;
  for (const { old, now, whole } of LEGACY_WORDING) {
    if (whole) {
      if (out === old) out = now;
    } else if (out.includes(old)) {
      out = out.replaceAll(old, now);
    }
  }
  return out;
}

/** 纯文字的地方（浏览器通知、title、aria-label）：名字占位直接换成名字 */
export function fillAssistantName(text: string, name: string): string {
  return text.replaceAll(ASSISTANT_NAME_MARK, name);
}
