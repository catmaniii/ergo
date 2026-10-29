// 会话里的一条输入交给 agent 之前的样子（秘书和维护者共用）：带版本号的投影（conversation/model-projection.ts：
// 时间标记、卡片换成一行摘要、附件按规则内联或只给名字、语音换成识别出的文字，注明"语音转写"），支持视觉的模型另外收到图片；
// 运行时的通知（发言方是 system 的 agentInput 消息）开头标 SYSTEM_NOTICE_TAG，免得模型当成用户说的；
// 秘书转达的话（103 号票：发言方是用户、标着 relayedBy）开头一行 SECRETARY_RELAY_HEAD，对方看得出不是用户在这里打的字。
// 125 号票：维护者的会话里，用户的消息（含秘书转达的）末尾再带一行消息 id（userMessageIdLine）——引用用户原话时照抄它，
// 运行时据此核实（转达的那句按它记下的原话核实）。这一行在投影之外，不改投影的版本。
// 147 号票：浏览侧边栏里发的消息（MessageEnvelope.browsing）末尾再带一段——用户正在内置浏览器里看哪个网页、选中了哪个框、
// 这一轮能用哪几个网页工具，网页上的文字是外部数据。同样在投影之外，不改投影的版本。182 号票：秘书的那段里另加一句"这一轮联网搜索算上
// 鸿蒙 App 的内置浏览器"。212 号票起这段是浏览插件经 agent 贡献的"输入附注"给的（inputNote，开始处理这条输入的那一刻现算；
// agent-host/contributions.ts 的 notes），这里不再认浏览：插件停用时没有这段。
// 210 号票：进过自动重试、晚交过去的语音（重试成功的，重试完了还不行、带着附件或卡片的），投影后面跟一句几点说的、识别晚了
// （lateVoiceNote），免得 agent 以为是刚说的。同样在投影之外，不改投影的版本；给模型看的，照旧只用中文（多语言第 6 条）。
// 用户打的 `/目录名`（82 号票；`/skill:目录名` 是后备写法，72 号票）在投影（加时间标记）之前展开成 skill 的全文
// （skills/skill-command.ts，照 pi 的写法；二狗自己的命令 /workflow、/task 优先，不展开）。
// 289 号票：维护者用的运行时能转交斜杠命令的（Claude Code，能力清单 slash_passthrough），用户打的 `/命令 参数` 原样交给它执行——
// 不展开二狗的 skill、不加时间标记、不带消息 id 那一行（运行时只认开头就是 / 的）；二狗自己的命令（项目会话里的 /workflow、/task）照旧；
// 带着附件、语音、卡片的不算（照常投影）。
// 309 号票：转交时用户按 pi 的习惯打的 /<目录名>（或 /skill:<目录名>）是这次装配的 skill、又不是运行时自己的命令（它报过的）时，换成运行时里的写法
// （Claude Code：工具包 skill 拼成的本地插件 ergo，/ergo:<目录名>），后面的话照留；同名时运行时的命令优先，原样交。会话里记的照旧是用户打的原样。
import fs from "node:fs";
import path from "node:path";
import { type MessageEnvelope, type MessagePart, newNameOf, settledVoiceText, voiceIdsOf } from "@ergo/protocol";
import { getCard } from "../cards/views.ts";
import type { EventStore } from "../events/event-store.ts";
import { loadAttachmentContents } from "../media/attachment-content.ts";
import type { MediaStore } from "../media/media-store.ts";
import type { InputImage } from "../runtime/index.ts";
import { SECRETARY_RELAY_HEAD, SYSTEM_NOTICE_TAG } from "./messages.ts";
import { userMessageIdLine } from "./user-words.ts";
import { expandSkillCommand, SKILL_COMMAND_PREFIX, type SkillCommand, skillCommandsOfDirs } from "../skills/skill-command.ts";
import { type ErgoCommand, ergoCommandAt } from "../slash-commands/commands.ts";
import { getVoice, lateVoicesIn } from "../voice-records/views.ts";
import { MODEL_PROJECTION_VERSION, projectForModel, type VoiceTranscript } from "./model-projection.ts";

export interface AgentInputContext {
  store: EventStore;
  media: MediaStore;
  /** 消息前的时间标记按它换算（配置的 timeZone） */
  timeZone: string;
  /** 模型支不支持图片输入 */
  vision: boolean;
  /** 这个会话装配了的 skill 的目录（用户打 /目录名、/skill:目录名 时展开它们，72、82 号票）；不给就不展开 */
  skillDirs?: readonly string[];
  /**
   * 库里每个 skill 的斜杠命令（82 号票，按整个库算：几个目录名相同时集合里的是"集合名:目录名"），展开时挑出这个会话装配了的；
   * 不给时按目录自己算（目录名就是命令名）
   */
  skillCommands?: () => readonly SkillCommand[];
  /** 这个会话里有的二狗自己的命令（82 号票：打的字被认成它们时 skill 不展开）；不给就没有 */
  ergoCommands?: readonly ErgoCommand[];
  /** 用户的消息末尾带一行消息 id（125 号票：维护者引用用户原话时照抄）；不给就不带 */
  userMessageIds?: boolean;
  /**
   * 输入附注（212 号票，插件经 agent 贡献给的：浏览侧边栏、悬浮按钮发的消息后面那段网页上下文）：接在这条输入自己的文字末尾，
   * 在晚到的语音那句之后、消息 id 那行之前；不给、回 undefined 就不接
   */
  inputNote?: (message: MessageEnvelope) => string | undefined;
  /**
   * 斜杠命令原样交给运行时（289 号票：维护者用的运行时能力清单里 slash_passthrough 是 true，拉起时按子进程的运行时定）。
   * 是的话二狗的 skill 也不展开（运行时有它自己的技能和命令）
   */
  slashPassthrough?: boolean;
  /**
   * 转交的运行时里二狗 skill 的写法（309 号票）：skillCommands 给 skillDirs 在运行时里的命令名（不带 /，一一对应；Claude Code 是 ergo:<目录名>），
   * commands 是运行时自己的命令名（同名时它的优先）。不给就原样转交
   */
  runtimeSlash?: { skillCommands(skillDirs: readonly string[]): readonly string[]; commands(): readonly string[] };
}

/**
 * 原样交给运行时的斜杠命令（289 号票）：用户自己在这里打的、只有文字、开头是 /、不是这个会话里二狗自己的命令；
 * 是的话交回原文（几段文字按换行拼起来；309 号票起二狗的 skill 换成运行时里的写法，见 runtimeSkillText），不是 undefined
 */
export function slashPassthroughText(
  ctx: Pick<AgentInputContext, "slashPassthrough" | "ergoCommands" | "runtimeSlash" | "skillDirs" | "skillCommands">,
  message: Pick<MessageEnvelope, "speaker" | "relayedBy" | "parts">,
): string | undefined {
  if (!ctx.slashPassthrough || message.speaker !== "user" || message.relayedBy !== undefined) return undefined;
  const texts = message.parts.flatMap((p) => (p.type === "text" ? [p.text] : []));
  if (texts.length === 0 || texts.length !== message.parts.length) return undefined;
  const text = texts.join("\n").trim();
  if (!text.startsWith("/") || ergoCommandAt(text, ctx.ergoCommands ?? [])) return undefined;
  return runtimeSkillText(text, ctx) ?? text;
}

/**
 * 转交的 /<目录名>（或后备写法 /skill:<目录名>）是这次装配的 skill（命令名照二狗的算法，skills/skill-command.ts）、又不是运行时自己的命令时，
 * 换成运行时里的写法、后面的话照留（309 号票）；不用换的 undefined
 */
function runtimeSkillText(text: string, ctx: Pick<AgentInputContext, "runtimeSlash" | "skillDirs" | "skillCommands">): string | undefined {
  const slash = ctx.runtimeSlash;
  const token = /^\/(\S+)/.exec(text)?.[1];
  if (!slash || token === undefined) return undefined;
  // 312 号票：按旧习惯打的运行时写法（Claude Code 的插件以前叫 ergou：/ergou:<目录名>）换成现在的
  const renamed = newNameOf(token);
  if (renamed !== token && slash.skillCommands(ctx.skillDirs ?? []).includes(renamed)) return `/${renamed}${text.slice(1 + token.length)}`;
  const fallback = SKILL_COMMAND_PREFIX.slice(1);
  const viaFallback = token.startsWith(fallback);
  // 和运行时自己的命令同名：它的优先（/skill:目录名 是二狗的写法，明说了要 skill）
  if (!viaFallback && slash.commands().includes(token)) return undefined;
  const key = viaFallback ? token.slice(fallback.length) : token;
  const hit = sessionSkillCommands(ctx).find((s) => s.command === key);
  if (!hit) return undefined;
  const dirs = ctx.skillDirs ?? [];
  const at = dirs.findIndex((d) => path.resolve(d) === path.resolve(hit.dir));
  const command = at < 0 ? undefined : slash.skillCommands(dirs)[at];
  return command === undefined ? undefined : `/${command}${text.slice(1 + token.length)}`;
}

/** 这个会话装配了的 skill 的斜杠命令 */
function sessionSkillCommands(ctx: Pick<AgentInputContext, "skillDirs" | "skillCommands">): readonly SkillCommand[] {
  const dirs = ctx.skillDirs ?? [];
  if (dirs.length === 0) return [];
  if (!ctx.skillCommands) return skillCommandsOfDirs(dirs);
  const assembled = new Set(dirs.map((d) => path.resolve(d)));
  return ctx.skillCommands().filter((s) => assembled.has(path.resolve(s.dir)));
}

/** 用户消息的第一段文字以 /目录名（或 /skill:目录名）开头：换成 skill 的全文（别的 part 原样） */
function withSkillCommand(parts: readonly MessagePart[], ctx: AgentInputContext): readonly MessagePart[] {
  const first = parts[0];
  if (first?.type !== "text" || !first.text.startsWith("/")) return parts;
  const text = expandSkillCommand(first.text, sessionSkillCommands(ctx), ctx.ergoCommands ?? []);
  return text === first.text ? parts : [{ ...first, text }, ...parts.slice(1)];
}

/** 消息里引用的卡片的一行摘要：卡片的纯文本降级版本（卡片类型注册表的 toText 生成、存在卡片里的 text） */
function cardSummaries(store: EventStore, parts: readonly MessagePart[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "card_ref") continue;
    const card = getCard(store.reader, part.cardId);
    if (card) out[part.cardId] = card.text;
  }
  return out;
}

/** 消息里的语音的文字（31 号票）：识别完成的取识别出的文字，其余按识别失败 */
function voiceTranscripts(store: EventStore, parts: readonly MessagePart[]): Record<string, VoiceTranscript> {
  const out: Record<string, VoiceTranscript> = {};
  for (const voiceId of voiceIdsOf(parts)) {
    const voice = getVoice(store.reader, voiceId);
    const text = voice && settledVoiceText(voice);
    out[voiceId] = text === undefined ? { kind: "failed" } : { kind: "transcript", text };
  }
  return out;
}

/** 时刻的"时:分"（24 小时制），按配置的时区 */
function clockOf(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/**
 * 进过自动重试、晚交过去的语音（210 号票）：正文后面那句"这条语音是 14:05 说的，识别晚了"（重试完了还不行、带着附件或卡片交过去的，
 * 说这条消息是几点发的、语音最后也没识别出来）。时间是消息的时间（用户说话的时候）；不是晚交的没有
 */
function lateVoiceNote(ctx: AgentInputContext, message: MessageEnvelope): string | undefined {
  const late = lateVoicesIn(ctx.store.reader, message);
  if (late.length === 0) return undefined;
  const time = clockOf(message.time, ctx.timeZone);
  if (late.some((voice) => voice.status === "done")) return `（这条语音是 ${time} 说的，识别晚了）`; // @i18n-ignore model：给模型看的话照旧中文（多语言第 6 条）
  return `（这条消息是 ${time} 发的，语音识别晚了，最后也没识别出来）`; // @i18n-ignore model
}

/** 一条输入交给 agent 时的文字和图片（附件的内容要读文件、PDF 还要抽文本，所以是异步的） */
export async function prepareAgentInput(ctx: AgentInputContext, message: MessageEnvelope): Promise<{ text: string; images: InputImage[] }> {
  // 斜杠命令原样交给运行时（289 号票）
  const passthrough = slashPassthroughText(ctx, message);
  if (passthrough !== undefined) return { text: passthrough, images: [] };
  const attachments = await loadAttachmentContents(ctx.media, message.parts, MODEL_PROJECTION_VERSION);
  const projected = projectForModel({
    version: MODEL_PROJECTION_VERSION,
    // 秘书转达的话不展开 skill 命令：那是秘书写的，不是用户在这里打的命令
    parts: message.speaker === "user" && message.relayedBy === undefined && !ctx.slashPassthrough ? withSkillCommand(message.parts, ctx) : message.parts,
    sentAt: message.time,
    timeZone: ctx.timeZone,
    vision: ctx.vision,
    attachments,
    cards: cardSummaries(ctx.store, message.parts),
    voices: voiceTranscripts(ctx.store, message.parts),
  });
  const images: InputImage[] = [];
  for (const image of projected.images) {
    if (!ctx.media.info(image.mediaId)) continue;
    images.push({ mime: image.mime, data: fs.readFileSync(ctx.media.filePath(image.mediaId)).toString("base64") });
  }
  const late = lateVoiceNote(ctx, message);
  const withLate = late === undefined ? projected.text : `${projected.text}\n${late}`;
  const note = ctx.inputNote?.(message);
  const withNote = note === undefined || note === "" ? withLate : `${withLate}\n${note}`;
  const body = message.speaker === "user" && ctx.userMessageIds ? `${withNote}\n${userMessageIdLine(message.id)}` : withNote;
  const text = message.speaker === "system" ? `${SYSTEM_NOTICE_TAG}\n${body}` : message.relayedBy === "secretary" ? `${SECRETARY_RELAY_HEAD}\n${body}` : body;
  return { text, images };
}
