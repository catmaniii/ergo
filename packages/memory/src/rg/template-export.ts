// 推理库 → 一份 YAML（通用的有向无环图格式：每个节点 id、kind、statement、deps、status），给人看图、拿别的工具查用。253 号票的导出器（守护进程的 npm run memory:dump-template），
// 256 号票补了三处（结论 → 结论的边、--with-evidence 的证据层、domain 和 title）。267 号票起挪到这里；326 号票起每晚校验不再用它（改成直接查库的图谱自检 graph-check.ts）。
//
// 只读：只用 source.all(sql)（守护进程的只读连接、引擎的存储都行），不写任何东西。映射（和 docs/memory-vocabulary.md 那张对照表一致）：
// - `evidence` → `kind: fact`，`deps: []`（只在 withEvidence 时导）：原话就是最底下那一层，状态一律 verified；
// - `facts` → `kind: fact`，默认 `deps: []`（凭据在图外）；withEvidence 时 `deps` 挂上它那几条证据（`fact_evidence`）；
//   状态：active → verified、contested → unverified、corrected/superseded/retracted → retracted；
// - `claims` → `kind: inference`，`deps` = `inferences.premise_ids`（事实 id 和结论 id）+ `links` 里指向事实的支持边；
//   没有前提的按 `kind: fact` 导；状态：active（已验证）→ verified、contested（猜测）→ unverified、retracted / superseded → retracted
//   （329 号票前的老库里还有 needs_review，也按 unverified；复核标记不进状态），
//   依赖里有已撤销的事实时降成 unverified；`title` 写"偏好 · 你明说的 · 把握低 / 临时结论"；`domain` 按场景标签推出方面；
// - `questions` → `kind: question`，`deps: []`；状态：open → open、answered → answered、其余 → dropped；
// - 预测账本先不导。
import { domainsOfTags } from "./domains.ts";

/** 读库要的那一样（守护进程的只读连接、MemoryStore.db 都有） */
export interface TemplateSource {
  all<T = Record<string, unknown>>(sql: string): T[];
}

export interface TemplateExportOptions {
  /** 只导这几层的结论（state、preference、need、value）；不给全导 */
  tiers?: readonly string[];
  /** 最多导几条结论 */
  limit?: number;
  /** 全部事实都导（默认只导被结论用到的） */
  allFacts?: boolean;
  /** 导不导问题（默认导） */
  questions?: boolean;
  /** 连证据层一起导（256 号票，图里多出 证据 → 事实 一层） */
  withEvidence?: boolean;
  /** 生成时间（changelog 和 title 用）；不给用现在 */
  now?: string;
  /** 文件头注释里写的数据来源（给人看的） */
  sourceLabel?: string;
}

export interface TemplateExport {
  yaml: string;
  counts: { evidence: number; facts: number; claims: number; claimsWithoutPremises: number; provisional: number; questions: number };
}

/** YAML 里的状态词（fact、inference 一套：verified / unverified / retracted；question 一套：open / answered / dropped） */
const CLAIM_STATUS: Readonly<Record<string, string>> = {
  active: "verified",
  contested: "unverified",
  needs_review: "unverified",
  retracted: "retracted",
  superseded: "retracted",
};
const FACT_STATUS: Readonly<Record<string, string>> = {
  active: "verified",
  contested: "unverified",
  corrected: "retracted",
  superseded: "retracted",
  retracted: "retracted",
};
const QUESTION_STATUS: Readonly<Record<string, string>> = {
  open: "open",
  answered: "answered",
  expired: "dropped",
  obsolete: "dropped",
  dropped: "dropped",
};

/** 断言那一层的中文说法（title 里用，人看的） */
const TIER_LABEL: Readonly<Record<string, string>> = { state: "近期状态", preference: "偏好", need: "需求", value: "价值观" };
/** 把握（title 里用，人看的；low 就是"存疑"那一档） */
const CONFIDENCE_LABEL: Readonly<Record<string, string>> = { high: "", medium: "", low: "把握低" };
/** 证据原文太长时截断（看图时卡片放不下；原文在库里） */
const EVIDENCE_TEXT_MAX = 240;

/** YAML 里的一行字符串（双引号 + 转义）；换行折成空格，太长的不截（看图时能悬停看全） */
export function yamlString(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\r", "").replaceAll("\n", " ")}"`;
}

function readJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

type Row = Readonly<Record<string, unknown>>;

/** 导出（见文件开头） */
export function exportReasoningTemplate(source: TemplateSource, options: TemplateExportOptions = {}): TemplateExport {
  const all = (sql: string): Row[] => source.all<Row>(sql);
  const withQuestions = options.questions !== false;

  // ---- 1. 选哪些断言 ----
  const limit = options.limit === undefined || Number.isNaN(options.limit) ? undefined : options.limit;
  const claims = all("SELECT id, tier, statement, status, epistemic, confidence, context, predicts FROM claims ORDER BY rowid")
    .filter((c) => options.tiers === undefined || options.tiers.includes(String(c.tier)))
    .slice(0, limit);

  // 每条断言的前提（事实 id 和结论 id：往上抽的结论以别的结论为前提）和指向事实的支持边
  const premises = new Map<string, string[]>();
  /** 往上抽先出的临时结论（256 号票）：rationale 里带着那句"（临时结论：…）" */
  const provisional = new Set<string>();
  for (const row of all("SELECT conclusion_claim_id, premise_ids, rationale FROM inferences")) {
    const id = String(row.conclusion_claim_id);
    premises.set(id, readJson<string[]>(row.premise_ids, []));
    if (String(row.rationale).includes("临时结论")) provisional.add(id);
  }
  const supports = new Map<string, string[]>();
  for (const row of all("SELECT claim_id, target FROM links WHERE polarity = 'supports' AND target LIKE 'fa-%'")) {
    const id = String(row.claim_id);
    const list = supports.get(id) ?? [];
    list.push(String(row.target));
    supports.set(id, list);
  }
  const claimIds = new Set(claims.map((c) => String(c.id)));

  // ---- 2. 事实：默认只导被用到的 ----
  const wantedFacts = new Set<string>();
  if (options.allFacts === true) for (const row of all("SELECT id FROM facts")) wantedFacts.add(String(row.id));
  for (const claim of claims) {
    for (const id of premises.get(String(claim.id)) ?? []) wantedFacts.add(id);
    for (const id of supports.get(String(claim.id)) ?? []) wantedFacts.add(id);
  }
  const facts = all("SELECT id, statement, status FROM facts").filter((f) => wantedFacts.has(String(f.id)));
  const factIds = new Set(facts.map((f) => String(f.id)));
  /** 事实导出成模板以后的状态（判断"结论压在已撤销的事实上"要用这个，不是库里的原状态） */
  const factStatus = new Map(facts.map((f) => [String(f.id), FACT_STATUS[String(f.status)] ?? "unverified"]));

  // ---- 2b. 证据（256 号票，withEvidence 时导）：事实底下那一层 ----
  const evidenceOfFact = new Map<string, string[]>();
  for (const row of all("SELECT fact_id, evidence_id FROM fact_evidence")) {
    const id = String(row.fact_id);
    const list = evidenceOfFact.get(id) ?? [];
    list.push(String(row.evidence_id));
    evidenceOfFact.set(id, list);
  }
  const wantedEvidence = new Set<string>();
  if (options.withEvidence === true) for (const id of factIds) for (const e of evidenceOfFact.get(id) ?? []) wantedEvidence.add(e);
  const evidence = wantedEvidence.size === 0 ? [] : all("SELECT id, text, source_level, event_time, observed_at FROM evidence").filter((e) => wantedEvidence.has(String(e.id)));
  const evidenceIds = new Set(evidence.map((e) => String(e.id)));

  // ---- 3. 拼节点 ----
  const nodes: string[] = [];
  const push = (lines: readonly string[]) => nodes.push(lines.map((line) => `  ${line}`).join("\n"));

  for (const row of evidence) {
    const text = String(row.text).trim();
    const short = text.length > EVIDENCE_TEXT_MAX ? `${text.slice(0, EVIDENCE_TEXT_MAX)}…` : text;
    push([`- id: ${String(row.id)}`, "  kind: fact", `  statement: ${yamlString(short === "" ? "（空）" : short)}`, "  deps: []", "  status: verified", "  basis: stated"]);
  }

  for (const fact of facts) {
    const deps = options.withEvidence === true ? (evidenceOfFact.get(String(fact.id)) ?? []).filter((id) => evidenceIds.has(id)) : [];
    push([
      `- id: ${String(fact.id)}`,
      "  kind: fact",
      `  statement: ${yamlString(String(fact.statement))}`,
      `  deps: [${deps.map((dep) => yamlString(dep)).join(", ")}]`,
      `  status: ${FACT_STATUS[String(fact.status)] ?? "unverified"}`,
      "  basis: stated",
    ]);
  }

  for (const claim of claims) {
    const id = String(claim.id);
    // 256 号票：结论的前提可以是事实、也可以是别的结论（往上抽）；只留导得出来的、别指向自己
    const deps = [...new Set([...(premises.get(id) ?? []), ...(supports.get(id) ?? [])])].filter((dep) => dep !== id && (factIds.has(dep) || claimIds.has(dep)));
    const epistemic = String(claim.epistemic);
    const from = epistemic === "explicit" ? "你明说的" : epistemic === "user_confirmed" ? "你确认过的" : "推断出来的";
    const tier = TIER_LABEL[String(claim.tier)] ?? String(claim.tier);
    const confidence = CONFIDENCE_LABEL[String(claim.confidence)] ?? "";
    const domains = domainsOfTags(readJson<string[]>(claim.context, []));
    const reasons = [tier, from, provisional.has(id) ? "临时结论（等时间跨度）" : confidence].filter((text) => text !== "");
    push([
      `- id: ${id}`,
      deps.length === 0 ? "  kind: fact" : "  kind: inference",
      `  statement: ${yamlString(String(claim.statement))}`,
      `  deps: [${deps.map((dep) => yamlString(dep)).join(", ")}]`,
      `  status: ${deps.some((dep) => factStatus.get(dep) === "retracted") ? "unverified" : (CLAIM_STATUS[String(claim.status)] ?? "unverified")}`,
      `  title: ${yamlString(reasons.join(" · "))}`,
      ...(domains.length === 0 ? [] : [`  domain: ${yamlString(domains.join("-"))}`]),
      `  basis: ${epistemic === "inferred" ? "heuristic" : "stated"}`,
    ]);
  }

  let questionCount = 0;
  if (withQuestions) {
    for (const row of all("SELECT id, text, status FROM questions")) {
      const status = QUESTION_STATUS[String(row.status)] ?? "dropped";
      // 问句的正文可能很长（why 里那一套），模板的 statement 只放问句本身
      if (String(row.text).trim() === "") continue;
      push([`- id: ${String(row.id)}`, "  kind: question", `  statement: ${yamlString(String(row.text))}`, "  deps: []", `  status: ${status}`]);
      questionCount += 1;
    }
  }

  // ---- 4. 拼文件 ----
  const stamp = options.now ?? new Date().toISOString();
  const header = [
    "# 由二狗推理库导出（@ergo/memory 的 exportReasoningTemplate；npm run memory:dump-template）：rg.db → 节点和依赖的 YAML。",
    "# 别手改这份文件——改数据请改库；要调导出规则改 packages/memory/src/rg/template-export.ts。",
    `# 生成时间：${stamp}`,
    ...(options.sourceLabel === undefined ? [] : [`# 数据：${options.sourceLabel}`]),
    `# 映射见 docs/memory-vocabulary.md：evidence → kind: fact（${options.withEvidence === true ? "这一份带证据层" : "默认不导，--with-evidence 才带"}）；` +
      "facts → kind: fact；claims → kind: inference（deps 是前提事实和前提结论）；questions → kind: question。",
    "",
    "version: 1",
    `title: ${yamlString(`二狗的记忆 · 推理图谱（${stamp.slice(0, 10)} 导出）`)}`,
    "",
    "changelog:",
    `  - date: ${yamlString(stamp.slice(0, 10))}`,
    `    change: ${yamlString("由二狗推理库导出（npm run memory:dump-template）")}`,
    "",
    "nodes:",
  ].join("\n");
  const body = nodes.length === 0 ? "  []" : nodes.join("\n");
  return {
    yaml: `${header}\n${body}\n`,
    counts: {
      evidence: evidence.length,
      facts: facts.length,
      claims: claims.length,
      claimsWithoutPremises: claims.filter((c) => (premises.get(String(c.id)) ?? []).length === 0).length,
      provisional: claims.filter((c) => provisional.has(String(c.id))).length,
      questions: questionCount,
    },
  };
}
