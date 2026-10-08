// 发给模型之前的投影（规格第 5 节、第 21 节附件）：把一条消息的 part 投影成模型输入，带版本号的纯函数。
// 投影规则固定，同样的输入和版本，输出逐字节相同，保证提示词前缀稳定。
// 每个版本自成一个模块（第 1 版在 projection-v1.ts），用到的常量和小函数都归它自己，别处改了也不会悄悄改变它的输出；
// 要改规则就加一个新版本，旧版本原样留着。
// 读文件、抽 PDF 这些由调用方先做好（它先问这个版本要哪些内容：contentNeeded），作为输入交进来，投影本身不碰文件。
import type { MessagePart } from "@ergou/protocol";
import { projectorV1 } from "./projection-v1.ts";

/** 当前的投影版本 */
export const MODEL_PROJECTION_VERSION = 1;

type FilePart = Extract<MessagePart, { type: "file" }>;

/**
 * 调用方为文件附件准备好的内容（键是媒体 id）：
 * - 文本类：文件开头的原始字节（这个版本要多少就给多少），和文件的总字节数；
 * - PDF：抽出来的全部文本；抽不出来时 text 为 undefined。
 */
export type AttachmentContent = { kind: "text"; head: Uint8Array; totalBytes: number } | { kind: "pdf"; text: string | undefined };

/** 一个文件附件要调用方先准备什么：文本开头若干字节、PDF 抽出的文本，或者什么都不用 */
export type ContentNeeded = { kind: "text_head"; bytes: number } | { kind: "pdf_text" } | undefined;

export interface ProjectionInput {
  version: number;
  parts: readonly MessagePart[];
  /** 消息的发送时间（消息信封里带时区偏移的 ISO 时间） */
  sentAt: string;
  /** 时间标记用的时区（IANA 名字，守护进程配置里的 timeZone） */
  timeZone: string;
  /** 模型支不支持图片输入（从配置读） */
  vision: boolean;
  /** 文件附件的内容，键是媒体 id */
  attachments: Readonly<Record<string, AttachmentContent>>;
  /** 卡片的一行摘要（卡片类型注册表的纯文本降级版本），键是卡片 id */
  cards: Readonly<Record<string, string>>;
  /** 语音的文字（31 号票，调用方从语音对象取来），键是语音 id：识别出的文字，或者识别失败 */
  voices: Readonly<Record<string, VoiceTranscript>>;
}

/** 交给模型时一条语音的文字：识别出来了（识别出的文字）；识别失败 */
export type VoiceTranscript = { kind: "transcript"; text: string } | { kind: "failed" };

export interface ModelInput {
  version: number;
  text: string;
  /** 作为图片输入交给模型的图片（只有支持视觉的模型才有），顺序和正文里的"图片 n"一致 */
  images: Array<{ mediaId: string; mime: string }>;
}

/** 某一版投影 */
export interface Projector {
  project(input: ProjectionInput): ModelInput;
  /** 这个文件附件要调用方先准备什么内容 */
  contentNeeded(part: FilePart): ContentNeeded;
}

const PROJECTORS: Readonly<Record<number, Projector>> = { 1: projectorV1 };

/** 某一版投影；不认识的版本直接报错，不猜 */
export function projectorOf(version: number): Projector {
  const projector = PROJECTORS[version];
  if (!projector) throw new Error(`没有第 ${version} 版的模型投影`);
  return projector;
}

/** 投影一条消息 */
export function projectForModel(input: ProjectionInput): ModelInput {
  return projectorOf(input.version).project(input);
}
