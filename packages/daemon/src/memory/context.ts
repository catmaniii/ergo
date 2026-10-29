// @i18n-ignore-file model：这块简报整个是给秘书（模型）看的上下文块（174 号票）
// 每轮醒来的记忆简报（232 号票，接入设计第 3、5 节）：秘书被唤起时（和每次压缩之后）多一条上下文块，写清二狗对这个人的
// 理解里最要紧的几条——需求、价值观各最多 3 条（带"用户说的 / 推断的 / 用户确认过"和把握）、还拿不准的竞争解释最多 2 组
// （各一句，带能区分的问题）。上下文块走 agent 贡献缝（when: "wake"），每轮现算，空了就是空串、
// 不产生空块（"简报为空的会话照旧只走素材检索"）。
//
// 现算、同步：贡献缝的 text() 是同步的、每条输入之前都要算一遍，所以这里只做只读的同步查询（用户模型快照、竞争假设组），
// 不调 memoryBrief（它是异步的，留给 ask_memory）。
// 264 号票起简报里不再有"可以顺口问：问题箱里优先级最高的那个"：顺口问改由每条输入后面的上下文块交（woven-questions.ts，
// 按这一轮的话挑、话题对上才问、每天最多一个、问没问过记在问题箱里）；简报里再放一个，秘书会不看话题自己问、问了也没人记。
// 字数上限 1200：每条陈述截到 60 字，整段超了从末尾整条整条地丢（先后就是优先级）。
// 266 号票起抬头叫【醒来简报】：每条消息有相关记忆时另有一块【记忆简报】跟在输入后面（message-brief.ts，CONTEXT.md 的"记忆简报"
// 说的是那一块），两块都叫记忆简报秘书分不清。
//
// 330 号票（R5）：需求、价值观里的猜测（还没证实的推断，竞争中分出来了但前提没证实的、组撤下留着的……）也给最多 3 条，
// 标明"猜测"和把握；已经在"还拿不准"那几组里的不重复列。抬头写清：猜测可以照着说、推荐，把握低的留余地。
// 没引擎（插件停用、还没建库、版本对不上）、什么都没有（需求、价值观、拿不准的组一样都没有）、渲染出错
// → 空串（不产生空块，不把这一轮弄坏）。冷启动头一两个月只有"还拿不准"时照样给这几句。
import { type Claim, type Confidence, type MemoryEngine, type UncertainEntry, type UserModelEntry } from "@ergo/memory";

/** 上下文块的 id（插件宿主在前面加上 "memory:"；一个会话里 id 不变，之后只按 id 换文字） */
export const MEMORY_BRIEF_BLOCK_ID = "memory.brief";

/** 这块最多多少字（接设计第 3 节：≤1200 字） */
export const MEMORY_BRIEF_MAX_CHARS = 1200;

/** 各最多几条 */
const LIMIT = { perTier: 3, groups: 2, guesses: 3 } as const;

/** 一条最多几个字（再长就截断加"…"） */
const CLIP = { statement: 60, description: 50, probe: 50 } as const;

const HEADER = "【醒来简报】二狗对你的了解（推断的，带把握；引用时说清是推断的，不是用户说的；\"猜测\"是还没证实的——可以照着说、拿来推荐，把握低的留余地）";

const EPISTEMIC: Readonly<Record<UserModelEntry["label"], string>> = { user_stated: "用户说的", inferred: "推断的", user_confirmed: "用户确认过" };
const CONFIDENCE: Readonly<Record<Confidence, string>> = { low: "低", medium: "中", high: "高" };
const CONFIDENCE_ORDER: Readonly<Record<Confidence, number>> = { low: 0, medium: 1, high: 2 };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
/** 去掉句末的标点，好和后面的括号接上 */
const trimEnd = (text: string) => text.replace(/[。.；;，,\s]+$/, "");

/** 一层的几条：把握高的在前，最多 LIMIT.perTier 条 */
function topOf(model: readonly UserModelEntry[], tier: UserModelEntry["tier"]): UserModelEntry[] {
  return model
    .filter((entry) => entry.tier === tier)
    .toSorted((a, b) => CONFIDENCE_ORDER[b.confidence] - CONFIDENCE_ORDER[a.confidence])
    .slice(0, LIMIT.perTier);
}

/** 这一层的一行：需求 / 价值观 [编号] 陈述（谁说的 · 把握） */
function lineOf(kind: string, entry: UserModelEntry): string {
  return `- ${kind} [${entry.claimId}] ${clip(trimEnd(entry.statement), CLIP.statement)}（${EPISTEMIC[entry.label]} · 把握${CONFIDENCE[entry.confidence]}）`;
}

/** 组里还没找到结果的追问（同 @ergo/memory 的 llm/brief.ts：还没找到结果的在前） */
function probeOf(engine: MemoryEngine, key: string): string | null {
  const probes = engine.rg.registry
    .probesOf(key)
    .map((probe) => engine.store.getProbe(probe.probeId))
    .filter((probe) => probe !== undefined)
    .toSorted((a, b) => Number(a.outcome === "found") - Number(b.outcome === "found"));
  return probes[0]?.ask ?? null;
}

/** 330 号票（R5）：猜测的一行：猜测 · 需求 / 价值观 [编号] 陈述（谁说的 · 把握） */
function guessLineOf(entry: UncertainEntry): string {
  return `- 猜测 · ${entry.tier === "need" ? "需求" : "价值观"} [${entry.claimId}] ${clip(trimEnd(entry.statement), CLIP.statement)}（${EPISTEMIC[entry.label]} · 把握${CONFIDENCE[entry.confidence]}）`;
}

/** 330 号票（R5）：需求、价值观里的猜测，把握高的在前，最多 LIMIT.guesses 条；已经在"还拿不准"那几组里的不列（那几行说了） */
function guessesOf(engine: MemoryEngine, uncertain: readonly UncertainEntry[], listedGroups: ReadonlySet<string>): string[] {
  return uncertain
    .filter((entry) => entry.status === "contested" && (entry.tier === "need" || entry.tier === "value"))
    .filter((entry) => {
      const key = engine.rg.registry.memberOf(entry.claimId)?.groupKey;
      return key === undefined || !listedGroups.has(key);
    })
    .toSorted((a, b) => CONFIDENCE_ORDER[b.confidence] - CONFIDENCE_ORDER[a.confidence])
    .slice(0, LIMIT.guesses)
    .map(guessLineOf);
}

/**
 * 还拿不准的竞争解释：组里没有站得住的那条（成立、把握不低，同简报的判法）、还有两条以上没排除的。各一句。
 * 最多 LIMIT.groups 组；listed 里记下列了哪几组
 */
function uncertainGroups(engine: MemoryEngine, listed: Set<string> = new Set()): string[] {
  const lines: string[] = [];
  for (const group of engine.rg.registry.listGroups({ live: true })) {
    const view = engine.rg.groupView(group.key);
    if (!view) continue;
    const members = view.members
      .map((member) => engine.store.getClaim(member.claim.id))
      .filter((claim): claim is Claim => claim !== undefined && claim.status !== "retracted" && claim.status !== "superseded");
    if (members.length < 2) continue;
    if (members.some((claim) => claim.status === "active" && claim.confidence !== "low")) continue;
    const probe = probeOf(engine, view.key);
    lines.push(`- 还拿不准「${clip(trimEnd(view.description), CLIP.description)}」：几种解释还没分开${probe ? `（能区分的问题：${clip(probe, CLIP.probe)}）` : ""}`);
    listed.add(view.key);
    if (lines.length >= LIMIT.groups) break;
  }
  return lines;
}

/** 按先后整条整条地放，放不下就不放了（先后就是优先级）；最后兜底按字截断 */
function fitLines(lines: readonly string[], max: number): string {
  const kept: string[] = [];
  for (const line of lines) {
    if ([...kept, line].join("\n").length > max) break;
    kept.push(line);
  }
  const text = kept.join("\n");
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * 醒来时给秘书的那块简报（同步、只读、每轮现算）。没有引擎、什么都没有、渲染出错都是空串。
 * 只给秘书（插件装配时 to: { agents: ["secretary"] }）。
 */
export function wakeBriefText(engine: MemoryEngine | undefined): string {
  if (!engine) return "";
  try {
    const at = engine.store.now();
    const model = engine.getUserModel({ at });
    const needs = topOf(model.values, "need");
    const values = topOf(model.values, "value");
    const listed = new Set<string>();
    const groups = uncertainGroups(engine, listed);
    const lines = [HEADER, ...needs.map((entry) => lineOf("需求", entry)), ...values.map((entry) => lineOf("价值观", entry)), ...guessesOf(engine, model.uncertain, listed), ...groups];
    // 只有抬头：什么都没得说，不产生空块
    if (lines.length <= 1) return "";
    return fitLines(lines, MEMORY_BRIEF_MAX_CHARS);
  } catch {
    // 简报出错不能把这一轮弄坏：当成没有
    return "";
  }
}
