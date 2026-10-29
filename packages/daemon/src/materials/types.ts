// 素材（规格第 15 节）的词汇：七类素材事件加回避信号、说或做、来源等级、切段，以及统一的信封。
// 第一阶段只积累和建索引，没有素材的页面，所以这些类型只在守护进程里，不进共享协议包。
// 158 号票起设置里能看每条素材的内容：来源等级、切段的形态和注明前端也要认，挪进了共享协议包（这里直接用那几个）。
// 303 号票加了数据源素材的三种（观察到的本人行为、别人写给你的、本人写的）和信封上的出处 origin（哪个数据源、场景、敏感类别）。
import { MATERIAL_SOURCE_LEVELS, type MaterialSegmentForm, type MaterialSegmentNote, type MaterialSourceLevel, tTable } from "@ergo/protocol";
import type { SensitiveCategory } from "../config/config.ts";

/**
 * 素材的种类：七类素材事件，加上回避信号，加上数据源素材的三种（303 号票）。
 * 每一种固定是"说"或"做"（MATERIAL_MODE）：说是用户说出来的话，做是用户的行为（以及系统观察到的不处理）。
 */
export const MATERIAL_KINDS = [
  /** 用户发言：任何会话里用户发的消息（秘书会话、维护者会话），包括附件引用 */
  "user_utterance",
  /** 用户对产出的反应：采纳、修改（附 diff）、要求返工、放弃（13、15 号票接入） */
  "output_reaction",
  /** 审批决定：批准、拒绝、收窄（07、12、14、17、20、27 号票接入）。批准设备配对不算 */
  "approval_decision",
  /** 澄清问题的回答（12、16、17 号票接入） */
  "clarification_answer",
  /** 用户主动投喂的材料：附件菜单里"作为材料投喂"发出的消息（21 号票的入口） */
  "fed_material",
  /** 显式记忆命令：记住、忘掉、彻底删除、别推断（21 号票接入） */
  "memory_command",
  /** 任务结局：完成、失败、取消（13、22 号票接入） */
  "task_outcome",
  /** 回避信号：卡片被用户关掉，或建议卡、提问卡长期（默认 7 天）没处理 */
  "avoidance_signal",
  /** 观察到的本人行为（303 号票，数据源）：挂脖相机的一个时刻、照片的时间地点、去过哪、消费、运动……本人做的事，来源本人 */
  "observed_behavior",
  /** 别人写给你的（303 号票，数据源）：收到的邮件、群里别人的话……只留摘要，来源外部（不可信），只当背景、不撑结论 */
  "received_writing",
  /** 本人写的（303 号票，数据源）：发出的邮件、笔记、日记……本人说的话，来源本人 */
  "own_writing",
] as const;

export type MaterialKind = (typeof MATERIAL_KINDS)[number];

/** 数据源素材的三种（303 号票）：数据源插件只用这三种写素材（data-sources/material.ts 的 dataSourceMaterial） */
export const DATA_SOURCE_MATERIAL_KINDS = ["observed_behavior", "received_writing", "own_writing"] as const satisfies readonly MaterialKind[];
export type DataSourceMaterialKind = (typeof DATA_SOURCE_MATERIAL_KINDS)[number];

/** 数据源素材每种固定的来源等级：本人做的、本人写的是本人；别人写给你的是外部（不可信） */
export const DATA_SOURCE_MATERIAL_SOURCE: Readonly<Record<DataSourceMaterialKind, MaterialSourceLevel>> = {
  observed_behavior: "self",
  received_writing: "external_untrusted",
  own_writing: "self",
};

/** 说或做 */
export type MaterialMode = "say" | "do";

/**
 * 每种素材是说还是做（记忆子地图「素材管理」的结论）：
 * 说是发言、回答、用户主动提供的材料；做是对产出的反应、审批决定、任务结局。
 * 规格没写的两种：显式记忆命令是用户说出来的话，算说；回避信号是用户的行为（关掉、不处理），算做。
 */
export const MATERIAL_MODE: Readonly<Record<MaterialKind, MaterialMode>> = {
  user_utterance: "say",
  output_reaction: "do",
  approval_decision: "do",
  clarification_answer: "say",
  fed_material: "say",
  memory_command: "say",
  task_outcome: "do",
  avoidance_signal: "do",
  observed_behavior: "do",
  received_writing: "say",
  own_writing: "say",
};

/** 名字（设置里的素材页、记忆删除卡上用，跟着当前语言；检索工具给模型的那份在 memory/search-tool.ts） */
export const MATERIAL_KIND_LABEL: Readonly<Record<MaterialKind, string>> = tTable({
  user_utterance: "materials.kind.userUtterance",
  output_reaction: "materials.kind.outputReaction",
  approval_decision: "materials.kind.approvalDecision",
  clarification_answer: "materials.kind.clarificationAnswer",
  fed_material: "materials.kind.fedMaterial",
  memory_command: "materials.kind.memoryCommand",
  task_outcome: "materials.kind.taskOutcome",
  avoidance_signal: "materials.kind.avoidanceSignal",
  observed_behavior: "materials.kind.observedBehavior",
  received_writing: "materials.kind.receivedWriting",
  own_writing: "materials.kind.ownWriting",
});

/**
 * 来源等级：本人、agent、外部（不可信）、系统。
 * 只有"本人"的内容能生成关于用户的判断（第二阶段），也只有它另存原文副本。
 */
export const SOURCE_LEVELS = MATERIAL_SOURCE_LEVELS;
export type SourceLevel = MaterialSourceLevel;

/**
 * 切段的形态（切段的输入 MaterialPiece 和切出来的段用同一套）：
 * 用户打的字、判断不了来历的纯文本、引用块、附件、网页、语音转写、用户接受的 agent 提议、agent 的产出
 */
export type SegmentForm = MaterialSegmentForm;

/** 切段的注明：agent 先提出（用户接受了 agent 的提议）、转写（语音转写） */
export type SegmentNote = MaterialSegmentNote;

/**
 * 切段在原始记录里的位置：消息的第几个 part、part 里的字符范围 [start, end)（UTF-16 下标）；
 * 不是消息的记录（卡片动作、审批……）写字段名，比如 note
 */
export interface SegmentLocator {
  part?: number;
  start?: number;
  end?: number;
  field?: string;
}

/** 媒体引用（09 号票的附件：媒体 id、文件名、类型；mediaId 是入库版本的 sha256） */
export interface MediaRef {
  mediaId: string;
  name?: string;
  mime?: string;
}

/**
 * 一个切段。只有来源是"本人"的切段带文字（并随素材存进原文副本）；
 * 其余只留引用（locator、媒体、网址、卡片）加内容哈希，外加引用的说明 label（文件名、网址、卡片类型和标题），
 * label 进关键词索引，正文不进。
 */
export interface MaterialSegment {
  form: SegmentForm;
  source: SourceLevel;
  notes: SegmentNote[];
  locator: SegmentLocator;
  /** 内容哈希（sha256 十六进制）；附件是媒体的哈希，不知道时没有 */
  sha256?: string;
  /** 文字：只有本人的切段有 */
  text?: string;
  /** 引用的说明：附件的文件名、网页的网址、卡片的类型和标题（进关键词索引；不是内容） */
  label?: string;
  media?: MediaRef;
  url?: string;
  cardId?: string;
}

/** 指向原始记录的引用：产生这条素材的事件，以及事件里具体指的东西（消息、卡片……） */
export interface MaterialRef {
  event: { globalSeq: number; channel: string; seq: number; type: string };
  messageId?: string;
  cardId?: string;
  /** 其他票的原始记录（审批、任务、工单……）的 id */
  recordId?: string;
}

/**
 * 原文副本：本人素材（来源本人，或者有本人切段的）连同信封存成素材区里的一个文件，不可修改、只追加、只有用户能删。
 * 它是本人素材的真相：事件日志里的原始事件没了（删项目时删掉维护者会话），materials.db 也能从它重建出这条素材。
 */
export interface OriginalCopy {
  /** 相对素材区的路径（用 / 分隔） */
  path: string;
  /** 文件内容的 sha256 */
  sha256: string;
}

/**
 * 场景（303 号票）：这件事在什么时候、什么地方、和谁。开始时间就是信封的 time，这里只记别的。
 * 由数据源插件采成素材时给（数据源顺带知道）；记忆插件读成证据时带过去（memory/data-source-evidence.ts）。
 */
export interface MaterialScene {
  /** 结束时间（带时区偏移的 ISO）：一段时间的才有（挂脖相机的一个时刻、一天的位置摘要） */
  end?: string;
  /** 地点：给人看的名字（"望京的公司""西湖"）。地点算位置这一类敏感内容：位置没打开推断时证据里不带它 */
  place?: string;
  /** 和谁：称呼 */
  people?: string[];
  /** 场景标签：插件认得出才给（work、social、travel……，记忆引擎的场景维度）；不认得的读成证据时丢掉 */
  tags?: string[];
}

/** 素材的出处是数据源时（303 号票）：哪个数据源、场景、这条落在哪些敏感类别 */
export interface MaterialOrigin {
  /** 数据源 id（DataSource.id） */
  dataSource: string;
  scene: MaterialScene;
  /**
   * 这条的内容落在哪些敏感类别（健康、财务、位置、关系……）：其中有一类没打开推断，整条就不读成证据。
   * 插件不写就是数据源登记的全部（保守）
   */
  sensitive: SensitiveCategory[];
}

/** 素材的信封 */
export interface Material {
  id: string;
  kind: MaterialKind;
  mode: MaterialMode;
  /** 带时区偏移的 ISO 时间（原始记录的时间） */
  time: string;
  /** 来源会话（秘书、某个维护者的会话）；不来自会话的为 null */
  conversation: string | null;
  /** 所属任务或项目；不知道或不属于的为 null */
  task: string | null;
  project: string | null;
  /** 来源等级：这件事是谁做的、谁说的（切段另有各自的来源） */
  source: SourceLevel;
  ref: MaterialRef;
  /** 情境标签（确定性地由采集规则给出，比如 secretary、with_attachment、card:suggest_task） */
  context: string[];
  segments: MaterialSegment[];
  /** 出处是数据源的（303 号票）：哪个数据源、场景、敏感类别；别的素材没有 */
  origin?: MaterialOrigin;
  /** 原文副本（只有本人素材有） */
  original: OriginalCopy | null;
  /**
   * 不参与推断：用户说过"别推断"（21 号票）。这是素材上的标记，不是素材本身的内容：
   * 不进原文副本，由记忆命令事件派生（materials.db 重建时照样标上）
   */
  noInfer: boolean;
}

/** 采集出来的素材：信封去掉原文副本的引用和标记（原文副本文件里存的就是它） */
export type CapturedMaterial = Omit<Material, "original" | "noInfer">;
