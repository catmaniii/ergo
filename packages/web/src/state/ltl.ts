// 把规则原文（planguard 格式的 JSON 表达式）还原成可读的形式化写法（60 号票：计划详情的"检测项全览"）。
//
// 来源：AgentSense web/src/ui/ltl.ts（D:\code\claudecode\user_agent_sense_of_security，bedf5a5），检测项全览（RuleBook）用到的部分原样搬：
// expr、formulaOf、apiExpr、apiFormulaOf、repairsOf、costText、objectiveText。没搬的：conformanceItems、END_OBLIGATION
// （执行时的计划一致性检查项，属于单次调用的"怎么判的"，不在本票）。
// 改动只有写法：缩进、类型（原文的 Expr 是 any，这里收成 unknown 再按形状取）、`noUncheckedIndexedAccess` 要的判空。
// 引用前缀的中文说法照原文；二狗的规则里另有几种引用（$current.paths、$current.outward、$current.secrets、$prior.paths……），
// 原文不认识的照样只换前缀（"本步.paths"），和原文对不认识的引用的处理一样。
//
// 规则是只看过去的一阶时序逻辑：每条都是"一旦触发某个动作，过去必须发生过某事"或者"一旦触发，当下必须满足某条件"。
// 前者写成 G(φ → O ψ)，O 是过去时态的"曾经发生过"；后者写成 G(φ → ψ)。这里只做渲染，判定仍然由守护进程的引擎负责。

type Expr = unknown;
type Obj = Record<string, unknown>;

const isObj = (e: unknown): e is Obj => typeof e === "object" && e !== null && !Array.isArray(e);
const asList = (e: unknown): unknown[] => (Array.isArray(e) ? e : []);

const INFIX: Readonly<Record<string, string>> = { eq: "=", ne: "≠", lt: "<", le: "≤", gt: ">", ge: "≥", add: "+" };
const NAMED: Readonly<Record<string, string>> = { startswith: "前缀是", matches: "匹配", in: "∈", as_list: "列表", time: "时刻", quantity: "量", fmt_time: "时刻" };

const ref = (s: string) =>
  s
    .replace(/^\$facts\./, "环境.")
    .replace(/^\$current\./, "本步.")
    .replace(/^\$prior\./, "先前步.")
    .replace(/^\$call\./, "本次调用.")
    .replace(/^\$step\./, "所属步.")
    .replace(/^\$row\./, "行.")
    .replace(/^\$plan\./, "计划.")
    .replace(/^\$deliverables\./, "交付件.")
    .replace(/^\$deliverable\./, "这次交的.")
    .replace(/^\$task\./, "任务.")
    // 规则参数按规则集实例分开放（$params.<实例>.<名字>）；公式里只写名字
    .replace(/^\$params\.[\w-]+\./, "参数.")
    .replace(/^\$doc\./, "文档.")
    .replace(/^\$flight\b/, "所选航班")
    .replace(/\.args\./, ".参数.");

/** 一个表达式的中文写法 */
export function expr(e: Expr): string {
  if (e === null || e === undefined) return "⊤";
  if (typeof e === "string") return e.startsWith("$") ? ref(e) : JSON.stringify(e);
  if (typeof e === "number" || typeof e === "boolean") return String(e);
  if (Array.isArray(e)) return e.map(expr).join(", ");
  if (!isObj(e)) return String(e);

  const keys = Object.keys(e);
  if (keys.length === 1) {
    const k = keys[0]!;
    const v = e[k];
    if (k === "and") return `(${asList(v).map(expr).join(" ∧ ")})`;
    if (k === "or") return `(${asList(v).map(expr).join(" ∨ ")})`;
    if (k === "not") return `¬${expr(v)}`;
    if (k === "present") return `已给出(${expr(v)})`;
    if (k === "$unknown") return "未知";
    if (INFIX[k]) return `${asList(v).map(expr).join(` ${INFIX[k]} `)}`;
    // get(本步.args, "itemId") 就是 本步.参数.itemId
    if (k === "get" && Array.isArray(v) && v.length === 2 && typeof v[1] === "string") return `${expr(v[0])}.${v[1]}`.replace(/\.args\./, ".参数.");
    if (k === "if") {
      const [c, a, b] = asList(v);
      return `(${expr(c)} ? ${expr(a)} : ${expr(b)})`;
    }
    if (isObj(v) && k === "all") {
      const name = v.as ? String(v.as) : "行";
      return `∀ ${name} ∈ ${expr(v.from)}. ${expr(v.where ?? true)}`;
    }
    if (isObj(v) && k === "count") return `#{ ${expr(v.from)}${v.where ? ` 满足 ${expr(v.where)}` : ""} }`;
    if (isObj(v) && (k === "select" || k === "any" || k === "find" || k === "sum")) {
      const q = { select: "取", any: "∃", find: "取一个", sum: "∑" }[k];
      const where = v.where ? ` 满足 ${expr(v.where)}` : "";
      const map = v.map ? ` 的 ${expr(v.map)}` : "";
      return `${q} ${expr(v.from)}${where}${map}`;
    }
    if (NAMED[k]) return `${NAMED[k]}(${expr(v)})`;
    return `${k}(${expr(v)})`;
  }
  return `{ ${keys.map((k) => `${k}: ${expr(e[k])}`).join(", ")} }`;
}

/** 触发条件：哪个工具的调用、在什么情况下会让这条规则开始看 */
function trigger(rule: Obj): string {
  const t = isObj(rule.trigger) ? rule.trigger.tool : undefined;
  const tools = Array.isArray(t) ? t : t ? [t] : [];
  const parts = [tools.length ? `调用(${tools.join(" 或 ")})` : "任意动作"];
  if (rule.when) parts.push(expr(rule.when));
  if (rule.unless) parts.push(`¬${expr(rule.unless)}`);
  return parts.join(" ∧ ");
}

/** for_each 是全称量词，要套在整条蕴含外面，不是并进触发条件里 */
function quantifier(rule: Obj): string {
  return isObj(rule.for_each) ? `∀ ${String(rule.for_each.var)} ∈ ${expr(rule.for_each.in)}. ` : "";
}

/** 要求：过去必须发生过（O），或当下必须成立 */
function consequent(rule: Obj): { text: string; past: boolean } {
  const r = isObj(rule.require) ? rule.require : {};
  if (isObj(r.before)) {
    const where = r.before.where ? ` ∧ ${expr(r.before.where)}` : "";
    return { text: `调用(${String(r.before.tool)})${where}`, past: true };
  }
  if (isObj(r.not_before)) {
    const where = r.not_before.where ? ` ∧ ${expr(r.not_before.where)}` : "";
    return { text: `调用(${String(r.not_before.tool)})${where}`, past: true };
  }
  if (r.check) return { text: expr(r.check), past: false };
  return { text: "⊤", past: false };
}

export interface RuleFormula {
  /** G(φ → O ψ) 这样的整体形状 */
  formula: string;
  antecedent: string;
  consequent: string;
  /** 结论是不是过去时态 */
  past: boolean;
  negated: boolean;
}

/** 一条规则的中文形式化写法 */
export function formulaOf(rule: Obj): RuleFormula {
  const a = trigger(rule);
  const q = quantifier(rule);
  const c = consequent(rule);
  const negated = isObj(rule.require) && !!rule.require.not_before;
  // 没写 require 的规则是「这种情况本身就不允许出现」
  if (!rule.require) return { formula: `G( ${q}¬( ${a} ) )`, antecedent: a, consequent: "（触发即违规）", past: false, negated: true };
  const rhs = c.past ? `${negated ? "¬" : ""}O(${c.text})` : c.text;
  return { formula: q ? `G( ${q}( ${a}  →  ${rhs} ) )` : `G( ${a}  →  ${rhs} )`, antecedent: a, consequent: c.text, past: c.past, negated };
}

// ───────────────────────── 接口写法 ─────────────────────────
// 同一条规则按接口写：工具名照原样，本次调用的参数直接写参数名，之前那次调用的参数加撇（path′），
// 环境事实写 facts.X，规则参数写 param.X，还没代入的静态参数写 ⟨X⟩。
// 给想核对"到底判的是哪个调用、哪个参数"的人看；和中文写法是同一条规则。

const API_INFIX: Readonly<Record<string, string>> = { ...INFIX, sub: "−", mul: "×", in: "∈" };

/** 静态参数没代入时（规则库里的原文）："$param.tool" → ⟨tool⟩ */
const slot = (s: string) => (s.startsWith("$param.") ? `⟨${s.slice(7)}⟩` : s);

function apiRef(s: string): string {
  let m = /^\$(?:current|call)\.args\.(.+)$/.exec(s);
  if (m) return m[1]!;
  m = /^\$prior\.args\.(.+)$/.exec(s);
  if (m) return `${m[1]!}′`;
  m = /^\$params\.[\w-]+\.(.+)$/.exec(s) ?? /^\$param\.(.+)$/.exec(s);
  if (m) return `param.${m[1]!}`;
  if (s === "$row" || s.startsWith("$row.")) return `r${s.slice(4)}`;
  return s.slice(1);
}

/** 一个表达式的接口写法 */
export function apiExpr(e: Expr): string {
  if (e === null || e === undefined) return "⊤";
  if (typeof e === "string") return e.startsWith("$") ? apiRef(e) : JSON.stringify(e);
  if (typeof e === "number" || typeof e === "boolean") return String(e);
  if (Array.isArray(e)) return e.map(apiExpr).join(", ");
  if (!isObj(e)) return String(e);
  const keys = Object.keys(e);
  if (keys.length !== 1) return `{ ${keys.map((k) => `${k}: ${apiExpr(e[k])}`).join(", ")} }`;
  const k = keys[0]!;
  const v = e[k];
  const o = isObj(v) ? v : {};
  const row = isObj(v) ? (v.as ? String(v.as) : "r") : "r";
  const where = (sep: string) => (o.where ? `${sep}${apiExpr(o.where)}` : "");
  switch (k) {
    case "and":
      return `(${asList(v).map(apiExpr).join(" ∧ ")})`;
    case "or":
      return `(${asList(v).map(apiExpr).join(" ∨ ")})`;
    case "not":
      return `¬${apiExpr(v)}`;
    case "$unknown":
      return "?";
    case "lit":
      return Array.isArray(v) ? `{${v.map(apiExpr).join(", ")}}` : apiExpr(v);
    case "as_list":
      return apiExpr(v);
    case "if": {
      const [c, a, b] = asList(v);
      return `(${apiExpr(c)} ? ${apiExpr(a)} : ${apiExpr(b)})`;
    }
    case "all":
      return `∀ ${row} ∈ ${apiExpr(o.from)}. ${apiExpr(o.where ?? true)}`;
    case "any":
      return o.where ? `∃ ${row} ∈ ${apiExpr(o.from)}. ${apiExpr(o.where)}` : `${apiExpr(o.from)} ≠ ∅`;
    case "count":
      return `#{ ${row} ∈ ${apiExpr(o.from)}${where(" | ")} }`;
    case "select":
    case "sum":
      return `${k === "sum" ? "∑" : ""}{ ${o.map ? `${apiExpr(o.map)} | ` : ""}${row} ∈ ${apiExpr(o.from)}${where(o.map ? ", " : " | ")} }`;
    case "find":
      return `find(${row} ∈ ${apiExpr(o.from)}${where(" | ")})`;
    case "get":
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string") {
        const key = slot(v[1]);
        if (v[0] === "$current.args" || v[0] === "$call.args") return key;
        if (v[0] === "$prior.args") return `${key}′`;
        return `${apiExpr(v[0])}.${key}`;
      }
  }
  if (API_INFIX[k] && Array.isArray(v)) return v.map(apiExpr).join(` ${API_INFIX[k]} `);
  return `${k}(${apiExpr(v)})`;
}

/** 规则里读到的那次调用的参数名，按出现先后 */
function argNames(node: Expr, who: "current" | "prior"): string[] {
  const out: string[] = [];
  const prefix = `$${who}.args.`;
  const walk = (x: Expr) => {
    if (typeof x === "string") {
      if (x.startsWith(prefix)) out.push(x.slice(prefix.length).split(".")[0]!);
    } else if (Array.isArray(x)) x.forEach(walk);
    else if (isObj(x)) {
      if (Array.isArray(x.get) && x.get[0] === `$${who}.args` && typeof x.get[1] === "string") out.push(slot(x.get[1]));
      Object.values(x).forEach(walk);
    }
  };
  walk(node);
  return [...new Set(out)];
}

/** 一次调用：file_delete(path)；几个工具都算时用 ∨ 连起来 */
function apiCall(tools: unknown, args: string[], prime = false): string {
  const list = (Array.isArray(tools) ? tools : tools ? [tools] : []).map((t) => slot(String(t)));
  const a = args.length ? args.map((x) => (prime ? `${x}′` : x)).join(", ") : "…";
  if (!list.length) return `call(${a})`;
  const calls = list.map((t) => `${t}(${a})`);
  return calls.length > 1 ? `(${calls.join(" ∨ ")})` : calls[0]!;
}

/** 一条规则的接口写法，形状和 formulaOf 一样：G(触发 → O 之前的调用) 或 G(触发 → 当下条件) */
export function apiFormulaOf(rule: Obj): string {
  const t = isObj(rule.trigger) ? rule.trigger : {};
  const parts = [apiCall(t.tool, argNames([rule.trigger, rule.for_each, rule.when, rule.unless, rule.require], "current"))];
  if (t.where) parts.push(apiExpr(t.where));
  if (rule.when) parts.push(apiExpr(rule.when));
  if (rule.unless) parts.push(`¬${apiExpr(rule.unless)}`);
  const a = parts.join(" ∧ ");
  const q = isObj(rule.for_each) ? `∀ ${String(rule.for_each.var)} ∈ ${apiExpr(rule.for_each.in)}. ` : "";
  // 没写 require：这种调用本身就不允许
  if (!isObj(rule.require)) return q ? `G( ${q}¬( ${a} ) )` : parts.length > 1 ? `G ¬( ${a} )` : `G ¬${a}`;
  const r = rule.require;
  const past = isObj(r.before) ? r.before : isObj(r.not_before) ? r.not_before : undefined;
  const rhs = past
    ? `${r.not_before ? "¬" : ""}O( ${apiCall(past.tool, argNames(past.where, "prior"), true)}${past.where ? ` ∧ ${apiExpr(past.where)}` : ""} )`
    : apiExpr(r.check);
  return q ? `G( ${q}( ${a}  →  ${rhs} ) )` : `G( ${a}  →  ${rhs} )`;
}

/** 一条规则声明的修法，以及它们各自的代价 */
export interface RepairOption {
  kind: string;
  title: string;
  costs: Record<string, number>;
}

/** 规则声明的修法（AgentSense RuleBook 的 repairsOf；"模型""用户"换成二狗的说法"维护者""你"） */
export function repairsOf(rule: Obj): RepairOption[] {
  return asList(rule.repairs).map((r) => {
    const o = isObj(r) ? r : {};
    const kind = Object.keys(o).find((k) => k !== "cost") ?? "?";
    const body = isObj(o[kind]) ? (o[kind] as Obj) : {};
    const title =
      kind === "insert"
        ? `插入一步 ${String(body.tool)}${body.title ? `（${String(body.title)}）` : ""}`
        : kind === "rewrite"
          ? `改写参数${isObj(body.append) ? `：追加 ${Object.keys(body.append).join("、")}` : isObj(body.set) ? `：设定 ${Object.keys(body.set).join("、")}` : ""}${body.title ? `（${String(body.title)}）` : ""}`
          : kind === "move_after"
            ? `把这一步挪到 ${String(body.tool)} 之后`
            : kind === "confirm"
              ? `交给你确认：${String(body.text ?? "")}`
              : kind === "replan"
                ? `退回维护者重写：${String(body.text ?? "")}`
                : kind;
    return { kind, title, costs: (isObj(o.cost) ? o.cost : {}) as Record<string, number> };
  });
}

const COST_LABEL: Readonly<Record<string, string>> = { interaction: "打扰用户", disclosure: "多暴露信息", ops: "多做动作" };

/** 把代价写成人话；没写代价就是 0 */
export function costText(costs: Record<string, number>): string {
  const parts = Object.entries(costs)
    .filter(([, v]) => v)
    .map(([k, v]) => `${COST_LABEL[k] ?? k} ${v}`);
  return parts.length ? parts.join("、") : "无额外代价";
}

/** 场景级的择优目标，比如「释放的空间越多越好」「花的钱越少越好」（二狗的规则文档没有 objective，只有第一句） */
export function objectiveText(doc: { objective?: unknown } | undefined): string[] {
  const out: string[] = ["先满足硬目标，再挑代价小的修法（打扰用户 > 多暴露信息 > 多做动作）"];
  for (const o of asList(doc?.objective)) {
    const [k, v] = (Object.entries(isObj(o) ? o : {})[0] ?? ["", ""]) as [string, unknown];
    out.push(`在此之上，让 ${String(v)} ${k === "maximize" ? "尽量大" : "尽量小"}`);
  }
  return out;
}
