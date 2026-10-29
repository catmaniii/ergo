// 素材库 → 证据（224 号票）：MaterialsEvidenceSource 实现 @ergo/memory 的 EvidenceSource，
// 把 ctx.materials（素材库）里的素材映射成 EvidenceDraft，给记忆引擎每晚整理、离线回放用。
//
// 只读：只用 Materials 的 list()，不写素材库、不改素材状态。忘了的、彻底删掉的素材库里已经没有（墓碑），list() 就看不到；
// 标了"别推断"的（设计第 7 节：用户说过别推断的整类不参与推断）在这里跳过。
// 234 号票：敏感类别（健康、情绪、财务、关系）默认允许记录、不用于推断——场景落进没打开的类别时也跳过；
// v1 只有健康有场景标签（domain=health），见 privacy.ts。
//
// 字段照素材库已有的来：
// - 来源级别：素材信封的 source（self / agent / external_untrusted / system），PoC 里 external_untrusted 叫 untrusted；
// - 说或做：素材信封的 mode；种类照 domain/types.ts 的约定（发言、澄清回答、投喂、记忆命令 → utterance，
//   对产出的反应 → reaction，审批 → approval，任务结局、回避信号 → action）；
// - 原文：本人的话取切段的文字，只有说明的（附件文件名、卡片标题这类引用）取说明；
// - 时间：发生时间和知道时间都用素材记的原始记录时间（素材库只记这一个时间）；
// - 精炼陈述：EvidenceDraft 里没有这个字段，事实层由 kg/statement.ts 从原文生成，这里不造；
// - 出处：sourceRef 是素材 id（证据 id 让存储分配 ev-NNNN，不占用 mat- id）。
//
// 场景（最容易踩坑的）：素材的 context 现在装的是管线标签（secretary、voice_transcript、decision:approved、tool:bash、
// category:outside_project），不是推理图谱的场景维度。照搬的话不同工具就是不同"场景"，门槛会被骗过去。所以：
// - 只留落在 CONTEXT_DIMENSIONS（daytype、domain、trip）里的标签，其余一律丢掉；
// - 一个维度标签都没有时，用 clauseContext([], 原文) 从原文按关键词推；推不出来就是空，不硬凑。
//
// 303 号票：数据源的素材（信封上有出处 origin）另走一条路（data-source-evidence.ts）：证据的性质跟着三种素材走（观察到的本人行为 →
// 本人做的、别人写给你的 → 别人转述的、本人写的 → 本人说的），原文后面接一行场景（时间段、地点、和谁），场景标签按日子和插件给的标签；
// 出处里写的敏感类别有一类没打开就不读，位置没打开时不带地点；同一个数据源、同一种、同一天多的合成一条，当天的先不读，每晚有上限。
import { clauseContext, type EvidenceDraft, type EvidenceSource, isKnownContextTag, localDate, type SourceLevel } from "@ergo/memory";
import type { SensitiveCategory } from "../config/config.ts";
import type { Materials } from "../materials/materials.ts";
import type { Material, MaterialKind } from "../materials/types.ts";
import { clockIso, type Clock } from "../scheduler/clock.ts";
import { DATA_SOURCE_EVIDENCE_KIND, digestGroupKey, digestRef, digestText, groupDataSourceItems, sceneParts, sceneTags, withSceneLine } from "./data-source-evidence.ts";
import { inferableByOrigin, inferableBySensitivity, placeInferable } from "./privacy.ts";

/** 素材的来源级别 → 证据的来源级别（只有 external_untrusted 改了名字） */
const SOURCE_LEVEL_OF: Readonly<Record<Material["source"], SourceLevel>> = {
  self: "self",
  agent: "agent",
  external_untrusted: "untrusted",
  system: "system",
};

/** 素材的种类 → 证据的种类（domain/types.ts 第 16 行的约定；303 号票的数据源三种见 data-source-evidence.ts） */
const EVIDENCE_KIND_OF: Readonly<Record<MaterialKind, EvidenceDraft["kind"]>> = {
  user_utterance: "utterance",
  clarification_answer: "utterance",
  fed_material: "utterance",
  memory_command: "utterance",
  output_reaction: "reaction",
  approval_decision: "approval",
  task_outcome: "action",
  avoidance_signal: "action",
  ...DATA_SOURCE_EVIDENCE_KIND,
};

export interface MaterialsEvidenceSourceOptions {
  /** 素材库（ctx.materials）：只读它的 list() */
  materials: Pick<Materials, "list">;
  /** 这批证据的"现在"用的时钟 */
  clock: Clock;
  /**
   * 允许用来推断的敏感类别（配置 memory.sensitiveCategories，默认空 = 都不推断）；
   * 健康按场景标签 domain=health 生效，其余类别是开关占位（见 privacy.ts）
   */
  inferableSensitiveCategories?: readonly SensitiveCategory[];
  /** 已经读进推理库的素材 id（每晚整理按它跳过；303 号票起合成的那条背后的几条素材都在里面，见 ingestedMaterialIds） */
  skip?: ReadonlySet<string>;
  /** 303 号票：这一次最多读进几条数据源的证据（合成的算一条），多的按时间先后留到下次；不给不限（运维脚本） */
  dataSourceLimit?: number;
}

/**
 * 把素材库读成证据（EvidenceSource，name = materials）。
 * 每次 read() 都照素材库现在的样子读一遍：忘了的、后来标了别推断的，下一次就没了。
 * 303 号票：数据源的素材排在后面——当天（按 now）的先不读，同一个数据源、同一种、同一天多的合成一条，最多 dataSourceLimit 条
 */
export class MaterialsEvidenceSource implements EvidenceSource {
  readonly name = "materials";
  readonly now: string;
  private readonly materials: Pick<Materials, "list">;
  private readonly inferableSensitive: readonly SensitiveCategory[];
  private readonly skip: ReadonlySet<string>;
  private readonly dataSourceLimit: number | undefined;

  constructor(options: MaterialsEvidenceSourceOptions) {
    this.materials = options.materials;
    this.now = clockIso(options.clock);
    this.inferableSensitive = options.inferableSensitiveCategories ?? [];
    this.skip = options.skip ?? new Set();
    this.dataSourceLimit = options.dataSourceLimit;
  }

  read(): EvidenceDraft[] {
    const drafts: EvidenceDraft[] = [];
    const fromSources: Material[] = [];
    for (const material of this.materials.list()) {
      if (this.skip.has(material.id)) continue;
      if (material.origin !== undefined) {
        if (inferableDataSourceMaterial(material, this.inferableSensitive)) fromSources.push(material);
        continue;
      }
      const draft = evidenceDraftOf(material, this.inferableSensitive);
      if (draft !== undefined) drafts.push(draft);
    }
    for (const group of groupDataSourceItems(fromSources, localDate(this.now), this.dataSourceLimit)) {
      const draft = dataSourceDraftOf(group, this.inferableSensitive);
      if (draft !== undefined) drafts.push(draft);
    }
    return drafts;
  }
}

/**
 * 一条素材 → 一条证据草稿；不进证据的（标了别推断、敏感类别没打开、没有原文）返回 undefined。
 * 264 号票：顺口问的回答马上回写成证据时也用它（和每晚整理读出来的一模一样，出处是素材 id，整理时按出处跳过、不重复读）。
 * 303 号票：数据源的素材单独读成一条（不合、不看是不是当天）
 */
export function evidenceDraftOf(material: Material, inferableSensitive: readonly SensitiveCategory[] = []): EvidenceDraft | undefined {
  if (material.noInfer) return undefined;
  if (material.origin !== undefined) return dataSourceDraftOf([material], inferableSensitive);
  const text = textOf(material);
  if (text.length === 0) return undefined;
  const context = sceneOf(material.context, text);
  if (!inferableBySensitivity(context, inferableSensitive)) return undefined;
  return {
    sourceLevel: SOURCE_LEVEL_OF[material.source],
    mode: material.mode,
    kind: EVIDENCE_KIND_OF[material.kind],
    text,
    context,
    eventTime: material.time,
    observedAt: material.time,
    sourceRef: material.id,
  };
}

/**
 * 303 号票：一条数据源素材能不能用来推断——没标别推断、有原文、出处里写的敏感类别都打开了、场景（连原文推出的）没落进没打开的敏感类别
 */
function inferableDataSourceMaterial(material: Material, allowed: readonly SensitiveCategory[]): boolean {
  if (material.noInfer || !inferableByOrigin(material.origin, allowed)) return false;
  const text = textOf(material);
  if (text.length === 0) return false;
  const evidenceText = withSceneLine(text, sceneParts(material, placeInferable(allowed)));
  return inferableBySensitivity(sceneTags(material.origin?.scene.tags ?? [], material.time, evidenceText), allowed);
}

/**
 * 303 号票：数据源素材 → 一条证据草稿。一条的：原文后面一行场景，出处是素材 id；几条的（同一个数据源、同一种、同一天，
 * groupDataSourceItems 分好的）：合成一条、一条一行，出处 digest:<素材 id,…>，发生时间是第一条的、知道时间是最后一条的。
 * 证据的性质跟着种类走（来源等级、说或做照素材）；有一条不能用来推断的整组不读（调用方先筛过，这里再守一道）。
 * 每晚整理和启动时对敏感类别（purge-rg.ts 的 reconcile）都用它：同样的素材、同样的设置读出同样的原文
 */
export function dataSourceDraftOf(materials: readonly Material[], inferableSensitive: readonly SensitiveCategory[] = []): EvidenceDraft | undefined {
  const first = materials[0];
  const last = materials.at(-1);
  if (first?.origin === undefined || last === undefined) return undefined;
  if (materials.some((m) => m.origin === undefined || digestGroupKey(m) !== digestGroupKey(first) || !inferableDataSourceMaterial(m, inferableSensitive))) return undefined;
  const placeAllowed = placeInferable(inferableSensitive);
  const items = materials.map((m) => ({ text: textOf(m), parts: sceneParts(m, placeAllowed) }));
  const single = materials.length === 1;
  const text = single ? withSceneLine(items[0]!.text, items[0]!.parts) : digestText(first.origin.dataSource, localDate(first.time), items);
  return {
    sourceLevel: SOURCE_LEVEL_OF[first.source],
    mode: first.mode,
    kind: EVIDENCE_KIND_OF[first.kind],
    text,
    context: sceneTags(
      materials.flatMap((m) => m.origin?.scene.tags ?? []),
      first.time,
      text,
    ),
    eventTime: first.time,
    observedAt: last.time,
    sourceRef: single ? first.id : digestRef(materials.map((m) => m.id)),
  };
}

/**
 * 证据的原文：本人的话取切段的文字，其余取引用的说明（附件文件名、网址、卡片标题）。
 * 和素材库进索引的文字一个口径（memory-db.ts 的 searchTextOf），一处一行的原话连起来。
 */
function textOf(material: Material): string {
  return material.segments
    .map((segment) => (segment.source === "self" ? segment.text : segment.label))
    .filter((text): text is string => text !== undefined && text.length > 0)
    .join("\n");
}

/**
 * 场景：只留场景维度（CONTEXT_DIMENSIONS）里的标签，管线标签丢掉；一个都没有时从原文按关键词推。
 * 推不出来就是空（"不限场景"），不硬凑。
 */
function sceneOf(context: readonly string[], text: string): string[] {
  const tags = [...new Set(context.filter((tag) => isKnownContextTag(tag)))];
  return tags.length > 0 ? tags : clauseContext([], text);
}
