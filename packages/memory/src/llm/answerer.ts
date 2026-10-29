// 大模型回答器（216 号票）：模拟二狗上线时的秘书——读着记忆简报（llm/brief.ts）回答用户的问题。和规则模板的 answerQuestion
// （rg/answer.ts）平行：输入问题、问的时间、场景和一份记忆简报，交回同样的 Answer（route = "llm"），评测照原来的判法判。
// 规则模板保留，给不花钱的测试和对照用。
// - 提示词照秘书的口径写，通用，不针对哪道题、哪个人（ANSWER_SYSTEM 是常量）：依据记忆回答，只有本人的话当依据、别人转述的不当依据；
//   有反证要说出反证的内容；结论下面列着的原话是它的依据，用到结论时要说出具体的事例（219 号票）；
//   证据不够就直说不确定、说缺什么；要做决定、出主意时给具体方案，用户这次明说的要求优先。
//   用户消息里只有问题、问的时间、场景和简报正文（requestFor），没有别的东西。
// - 要求模型只输出一个 JSON：回答文字（每条依据带证据编号）、是否不确定、当依据的证据、提到的反证、提到但不当依据的转述、用到的结论、缺什么。
// - 简报以外的编号（模型编的）从列表和文字里剥掉，记在 invalidIds（照 Honcho"伪造的证据 id 写入前剥离"）；
//   明明是别人转述却放进"依据"的不改，交给评测去判（那正是要量的错）。
// - 引用：依据记成 record、反证记成 counter、用到的结论按它是谁说的记 stated / conclusion（还拿不准的记 open），结论的引用不另带证据——
//   模型没说出来的证据不算它考虑了（模板回答会带上结论的全部支持证据，这里从严）；转述只在文字里。
// - DeepSeek 关思考（deepseek.ts 默认），经 MeteredChat 记用量（用途 answer）。输出解析不了、缺字段：记下错误，回答是空的、算没有结论。
import type { ChatModel, ChatRequest } from "./chat.ts";
import { parseModelJson, isStringArray } from "./json.ts";
import { briefTime, type MemoryBrief } from "./brief.ts";
import { CONTEXT_LABELS } from "../kg/context.ts";
import { classifyQuestion } from "../rg/question.ts";
import type { Answer, Citation } from "../rg/types.ts";

/** 回答最多写多少 token（中文几百字的回答加几个编号列表，留足余量；MeteredChat 的花费上限按它写满算） */
export const ANSWER_MAX_TOKENS = 1500;

export const ANSWER_SYSTEM = `你是用户的私人秘书，正在根据你对用户的记忆回答用户的问题。每次会给你：用户的问题、问的时间和场景，以及一份记忆简报——你记得的、可能和这个问题有关的记录（原话、时间、谁说的），有时还有你对用户的理解（结论、几种还没分出来的解释、用户明说过的要求和禁忌）。

回答的规矩：
1. 只依据记忆简报回答，不编造简报里没有的事、人、时间、编号；简报里没有的就当不知道。
2. 只有用户本人说过、做过的记录能当依据。别人转述的（标着"别人转述"）最多提一句是谁说的、不当依据，不能拿来下结论；被用户纠正过的旧记录不再当依据，以纠正后的为准。
3. 每个依据后面用方括号带上它的证据编号，比如［ev-xxx］；用到一条结论时带上它的结论编号（cl-xxx）。
4. 有和结论不一致的记录（反证）时，要说出反证的内容（那条记录说了什么），不能只给编号。
5. 结论下面列着的原话是这条结论的依据：用到一条结论时，要说出其中具体的事例（什么时候、说了什么、做了什么），带上证据编号，不能只复述结论。
6. 证据不够下结论时，直说"不确定"，并说清还缺什么证据；几种解释还分不出来时，说拿不准，把几种可能和能区分它们的问题说出来。证据够的时候就直接给结论，不要无谓地打折扣。
7. "推断的"结论是推出来的，不是用户亲口说的：拿来用时说明是推断、带上把握，不要说成用户说过。
8. 用户要你做决定、出主意、安排事情时，给出具体的方案（做什么、什么时候、怎么做）。用户这次明说的要求优先，记忆里的偏好和需求只用来调整怎么做，不能推翻这次明说的要求；方案不能违背用户明说过的禁忌。
9. 用中文回答，对用户说"你"，口语、简洁。

只输出一个 JSON 对象，不要别的文字：
{"answer": "给用户的回答", "uncertain": true 或 false（回答里是不是表示了不确定、下不了结论）, "grounds": ["当依据的证据编号"], "counter": ["提到的反证的证据编号"], "hearsay": ["提到了、但不当依据的别人转述的证据编号"], "claims": ["用到的结论编号"], "missing": "不确定时还缺什么证据（有结论时写空串）"}`;

export interface LlmAnswerInput {
  question: string;
  /** 问的时间 */
  at: string;
  context?: string[];
  brief: MemoryBrief;
}

/** 大模型的回答：同 Answer（route = "llm"），另记模型说用了哪些编号、剥掉了哪些、出没出错 */
export interface LlmAnswer extends Answer {
  route: "llm";
  /** 模型说用到的（只留简报里有的） */
  used: { grounds: string[]; counter: string[]; hearsay: string[]; claims: string[] };
  /** 简报里没有、被剥掉的编号 */
  invalidIds: string[];
  /** 输出解析不了、缺字段时的原因；正常是 null */
  error: string | null;
}

const ID = /\b(?:ev|cl)-[A-Za-z0-9_]+(?:[.:-][A-Za-z0-9_]+)*/g;

/** 去掉文字里简报以外的编号，再收拾空了的括号和多出来的顿号 */
function stripIds(text: string, allowed: ReadonlySet<string>): { text: string; removed: string[] } {
  const removed: string[] = [];
  let out = text.replace(ID, (id) => {
    if (allowed.has(id)) return id;
    removed.push(id);
    return "";
  });
  if (removed.length === 0) return { text, removed };
  for (let i = 0; i < 3; i++) {
    out = out
      .replace(/[［[]\s*[、，,]+/g, (m) => m[0]!)
      .replace(/[、，,]+\s*([］\]])/g, "$1")
      .replace(/([、，,])\s*[、，,]+/g, "$1")
      .replace(/[［[]\s*[］\]]/g, "");
  }
  return { text: out, removed };
}

export class LlmAnswerer {
  readonly model: ChatModel;
  private readonly maxTokens: number;

  constructor(model: ChatModel, options: { maxTokens?: number } = {}) {
    this.model = model;
    this.maxTokens = options.maxTokens ?? ANSWER_MAX_TOKENS;
  }

  /** 记在评测结果里的回答器：model:<名> */
  get id(): string {
    return `model:${this.model.name}`;
  }

  /** 发给模型的请求：系统提示固定，用户消息只有问题、问的时间、场景和简报正文 */
  requestFor(input: LlmAnswerInput): ChatRequest {
    const context = input.context ?? input.brief.context;
    const scene = context.length > 0 ? context.map((t) => CONTEXT_LABELS[t] ?? t).join("、") : "没说";
    return {
      purpose: "answer",
      system: ANSWER_SYSTEM,
      user: `问题：${input.question}\n问的时间：${briefTime(input.at)}\n场景：${scene}\n\n记忆简报：\n${input.brief.text}`,
      maxTokens: this.maxTokens,
    };
  }

  async answer(input: LlmAnswerInput): Promise<LlmAnswer> {
    const { question, brief } = input;
    const base = { question, kind: classifyQuestion(question), route: "llm" as const, probes: [], hits: [...brief.hits] };
    const failed = (error: string): LlmAnswer => ({ ...base, text: "", certain: false, citations: [], missing: [], used: { grounds: [], counter: [], hearsay: [], claims: [] }, invalidIds: [], error });
    const response = await this.model.complete(this.requestFor(input));
    let out: Record<string, unknown>;
    try {
      out = parseModelJson(response.content);
    } catch (err) {
      return failed(`${response.truncated ? `输出到了上限（${this.maxTokens}）被截断：` : ""}${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof out.answer !== "string" || out.answer.trim() === "") return failed("输出里没有 answer（回答文字）");
    if (typeof out.uncertain !== "boolean") return failed("输出里的 uncertain 不是 true / false");
    const lists = { grounds: out.grounds ?? [], counter: out.counter ?? [], hearsay: out.hearsay ?? [], claims: out.claims ?? [] };
    for (const [k, v] of Object.entries(lists)) if (!isStringArray(v)) return failed(`输出里的 ${k} 不是字符串数组`);

    const evidence = new Set(brief.evidenceIds);
    const claimSet = new Set(brief.claimIds);
    const invalid = new Set<string>();
    const keep = (ids: readonly string[], allowed: ReadonlySet<string>) => {
      const kept: string[] = [];
      for (const id of ids) {
        if (!allowed.has(id)) invalid.add(id);
        else if (!kept.includes(id)) kept.push(id);
      }
      return kept;
    };
    const used = {
      grounds: keep(lists.grounds as string[], evidence),
      counter: keep(lists.counter as string[], evidence),
      hearsay: keep(lists.hearsay as string[], evidence),
      claims: keep(lists.claims as string[], claimSet),
    };
    const stripped = stripIds(out.answer.trim(), new Set([...evidence, ...claimSet]));
    for (const id of stripped.removed) invalid.add(id);

    // 原话在记录那节，或者只在结论下面（219）
    const textOf = (id: string) => brief.records.find((r) => r.evidenceId === id)?.text ?? brief.profile?.claims.flatMap((c) => c.quotes ?? []).find((q) => q.evidenceId === id)?.text ?? "";
    const citations: Citation[] = [
      ...used.grounds.map((id): Citation => ({ claimId: null, factId: null, evidenceIds: [id], text: textOf(id), role: "record" })),
      ...used.counter.map((id): Citation => ({ claimId: null, factId: null, evidenceIds: [id], text: textOf(id), role: "counter" })),
      ...used.claims.map((id): Citation => {
        const c = [...(brief.profile?.claims ?? []), ...(brief.profile?.hardConstraints ?? []), ...(brief.profile?.groups.flatMap((g) => g.members) ?? [])].find((x) => x.claimId === id);
        const unsure = c !== undefined && (c.status !== "active" || (c.confidence === "low" && c.tier !== "state"));
        const role = unsure ? "open" : c?.epistemic === "inferred" ? "conclusion" : "stated";
        return { claimId: id, factId: null, evidenceIds: [], text: c?.statement ?? "", role };
      }),
    ];
    const missing = out.uncertain && typeof out.missing === "string" && out.missing.trim() !== "" ? [out.missing.trim()] : [];
    return { ...base, text: stripped.text, certain: !out.uncertain, citations, missing, used, invalidIds: [...invalid], error: null };
  }
}
