// 系统提示的文件（71 号票，照 drama_maker 的 prompts/*.md）：默认的在本包的 prompts/<编号>.md（随程序分发、进仓库），
// 用户改的在数据目录配置区的 prompts/<编号>.md（个人数据，随数据目录备份；配置区 agent 写不了）。有用户的就用用户的，没有用默认的。
//
// - 每次装配 agent 时现读文件（render），所以改了下一次装配就生效，不用重启守护进程；秘书是常驻的，按文件的修改时间
//   （revision）在交下一条输入之前看一眼，直接改了文件也从下一轮起生效；
// - 启动时 check() 把默认的和用户改的都查一遍：占位符写错、片段不认得、只在某个条件成立时才有的值写在条件外面……
//   报清楚是哪个文件哪一行，守护进程不起来，不默默用空串（默认的有错是编程错误，测试守着）；
// - 运行中用户直接改坏了文件（没经设置页）：这次装配用默认的，记一行日志，设置页上标"有错"；下次启动照样报错；
// - 装配时万一还是缺值（检查拦不住的：程序这次没给某个值）：出错的那一份（角色本身或它插的片段）退回默认的、标"有错"
//   （只记在内存里，改了文件就重新算），记一行日志，agent 照常拉起，不卡住；
// - 设置页经 save / reset 改：占位符写错的拒收（RequestRejected，HTTP 回 400，写明第几行错在哪）；和默认的一样等于恢复默认（删掉用户的文件）。
//   改了之后通知 onChange 的（秘书据此在手头这一条处理完后按新的提示重新拉起）。
// 前缀（prefix.md）加在每个 agent 的系统提示最前面，由 agent 管家在拉起时加（withPrefix），各模块不用管。
//
// 每个 agent 单独的提示词（114 号票，会话里的 ⚙）：在数据目录配置区的 agent-prompts/ 里按 agent 分，<agent id>.append.md 是接在通用模板
// （这个角色的那一份，用户改过的就是改过的）后面的一段，<agent id>.replace.md 是整份自己写的（替换通用模板，通用模板之后再改不影响它）；
// 一个 agent 只有其中一份。装配这个 agent 的角色提示时带上 agent id（render 的第三个参数）才用它，片段、前缀、别的几份照旧。
// 两种都是提示文件的写法，按这个角色的通用模板查占位符（和设置页同一个检查，协议包的 agentPromptProblem）；存之前查、写错的拒收；
// 文件被直接改坏了、装配时缺了值（任务转为项目后模板换了这类）：这次用通用模板，记一行日志，面板上写明错在哪，agent 照常拉起。
// 存了、恢复用通用模板之后通知 onAgentChange 的（各模块据此让这个 agent 手头这一条处理完后按新的提示重新拉起）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentPromptMode,
  agentPromptProblem,
  normalizePromptSource,
  parsePromptTemplate,
  type PromptNode,
  type PromptTemplateSpec,
  PromptValueMissing,
  promptIssuesText,
  renderPromptTemplate,
  type SystemPromptDetail,
  type SystemPromptList,
  type SystemPromptPlaceholder,
  type SystemPromptState,
  type SystemPromptSummary,
} from "@ergou/protocol";
import { RequestRejected } from "../errors.ts";
import {
  checkPromptRegistry,
  commonPlaceholders,
  includersOf,
  isPromptId,
  partialsOf,
  PROMPT_IDS,
  PROMPTS,
  type PromptDefinition,
  type PromptId,
  type PromptValuesOf,
  valueDescription,
  valueOnlyWhen,
} from "./registry.ts";

/** 本包自带的默认提示所在的目录 */
export const DEFAULT_PROMPTS_DIR = fileURLToPath(new URL("../../prompts/", import.meta.url));

const EXT = ".md";

export interface PromptLibraryOptions {
  /** 默认提示所在的目录；不填是本包的 prompts/ */
  defaultsDir?: string;
  /** 用户改的放在哪（数据目录配置区的 prompts/）；不填就只有默认的（测试、纯函数用） */
  userDir?: string;
  /** 每个 agent 单独的提示词放在哪（数据目录配置区的 agent-prompts/，114 号票）；不填就没有单独的 */
  agentsDir?: string;
  log?: (line: string) => void;
}

/** 只要填值的一方（装配 agent 的模块）用的 */
export type PromptRenderer = Pick<PromptLibrary, "render">;

/** 启动时查出的问题：哪些文件、错在哪 */
export class PromptFilesBroken extends Error {}

/** 一个 agent 单独的提示词（114 号票）：哪种写法、内容（规范化过的）；有错时（这时用通用模板）写明错在哪 */
export interface AgentOwnPrompt {
  mode: AgentPromptMode;
  content: string;
  problem?: string;
}

export interface PromptLibrary {
  /**
   * 填好值的一份提示（不带前缀）；用户改的有错、这次缺值时，出错的那一份用默认的。
   * 给了 agentId（114 号票）：这份是这个 agent 的角色提示，它有单独的提示词就照它（追加在后面，或整份替换）
   */
  render<Id extends PromptId>(id: Id, values: PromptValuesOf<Id>, agentId?: string): string;
  /** 前缀加在 agent 的系统提示前面（前缀是空的原样返回） */
  withPrefix(systemPrompt: string): string;
  /**
   * 这几份提示（连同它们插的片段）用户文件现在的样子（有没有、修改时间、大小）：和拉起时记下的不一样，就是文件被改过
   * （常驻的秘书据此在下一轮之前重新拉起）
   */
  revision(ids: readonly PromptId[], agentId?: string): string;
  /** 启动时查一遍：默认的、用户改的都要对，否则抛 PromptFilesBroken（写明文件和行） */
  check(): void;
  /** 设置页：全部 */
  list(): SystemPromptList;
  /** 设置页：一份 */
  detail(id: string): SystemPromptDetail;
  /** 设置页：保存（占位符写错的拒收）；和默认的一样就是恢复默认 */
  save(id: string, content: string): SystemPromptDetail;
  /** 设置页：恢复默认 */
  reset(id: string): SystemPromptDetail;
  /** 某份提示被设置页改了（保存、恢复默认）；返回取消订阅 */
  onChange(listener: (id: PromptId) => void): () => void;
  /** 这个 agent 单独的提示词（114 号票；role 是它的通用模板，按它查对不对）；没有是 undefined */
  agentPrompt(agentId: string, role: PromptId): AgentOwnPrompt | undefined;
  /** 存这个 agent 单独的提示词：占位符照 role 查，写错的拒收；追加的是空的等于恢复用通用模板 */
  saveAgentPrompt(agentId: string, role: PromptId, mode: AgentPromptMode, content: string): void;
  /** 恢复用通用模板（删掉它单独的） */
  resetAgentPrompt(agentId: string): void;
  /** 某个 agent 单独的提示词改了（存、恢复用通用模板）；返回取消订阅 */
  onAgentChange(listener: (agentId: string) => void): () => void;
}

/** agent id 能不能当文件名（和 agent 管家认的一样：字母、数字开头，只有字母、数字、点、减号、下划线） */
const AGENT_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 单独的提示词出错时，标在 PromptValueMissing 上的"出错的那一份" */
const ownSource = (agentId: string) => `agent:${agentId}`;

/** 一份提示此刻用的版本 */
interface Loaded {
  state: SystemPromptState;
  /** 现在用的内容（规范化过的） */
  source: string;
  nodes: readonly PromptNode[];
  /** 用户的那一份有错时：错在哪、原样的内容 */
  problem?: string;
  broken?: string;
}

/** 检查用的 spec：自己的占位符（连同只在某个条件成立时才有值的）加上公用的 */
export function promptSpec(id: PromptId): PromptTemplateSpec {
  const d: PromptDefinition = PROMPTS[id];
  const onlyWhen = Object.entries(d.values).flatMap(([name, spec]) => {
    const flag = valueOnlyWhen(spec);
    return flag === undefined ? [] : [[name, flag] as const];
  });
  return {
    values: Object.keys(d.values),
    common: d.common ? commonPlaceholders().map((c) => c.name) : [],
    flags: Object.keys(d.flags),
    partials: d.partials,
    onlyWhen: Object.fromEntries(onlyWhen),
  };
}

/** 查一份提示的内容：能不能是空的、占位符对不对；错了返回给人看的说明 */
function problemOf(id: PromptId, source: string): { nodes: readonly PromptNode[] } | { problem: string } {
  const d: PromptDefinition = PROMPTS[id];
  if (!d.allowEmpty && source.trim() === "") return { problem: "不能是空的（要用默认的请恢复默认）" };
  const parsed = parsePromptTemplate(source, promptSpec(id));
  return parsed.ok ? { nodes: parsed.nodes } : { problem: promptIssuesText(parsed.issues) };
}

/** 设置页上列出的能用的占位符：自己的值、条件、片段，再加公用的 */
function placeholdersOf(id: PromptId): SystemPromptPlaceholder[] {
  const d: PromptDefinition = PROMPTS[id];
  return [
    ...Object.entries(d.values).map(([name, spec]) => {
      const flag = valueOnlyWhen(spec);
      return { name, kind: "value" as const, description: valueDescription(spec), ...(flag === undefined ? {} : { onlyWhen: flag }) };
    }),
    ...Object.entries(d.flags).map(([name, description]) => ({ name, kind: "flag" as const, description })),
    ...d.partials.map((p) => ({ name: p, kind: "partial" as const, description: PROMPTS[p].title })),
    ...(d.common ? commonPlaceholders().map((c) => ({ name: c.name, kind: "value" as const, description: c.description, common: true })) : []),
  ];
}

function summaryOf(id: PromptId, loaded: Loaded): SystemPromptSummary {
  const d: PromptDefinition = PROMPTS[id];
  return {
    id,
    title: d.title,
    description: d.description,
    group: d.group,
    state: loaded.state,
    usedIn: includersOf(id).map((p) => PROMPTS[p].title),
    ...(loaded.problem === undefined ? {} : { problem: loaded.problem }),
  };
}

/** 设置页给的编号：不认得的回"没有这份" */
/** 单独的提示词按 agent id 起文件名：只认字母、数字开头，字母、数字、`.`、`_`、`-`（114 号票） */
function requireAgentFileId(agentId: string): void {
  if (!AGENT_FILE_ID.test(agentId)) throw new RequestRejected("not_found", `没有这个 agent：${agentId}`);
}

/** 文件的戳（改动时间和大小），没有文件写 "-"：revision 用 */
function fileStamp(file: string | undefined): string {
  const stat = file === undefined ? undefined : fs.statSync(file, { throwIfNoEntry: false });
  return stat ? `${stat.mtimeMs}/${stat.size}` : "-";
}

function requirePromptId(id: string): PromptId {
  if (!isPromptId(id)) throw new RequestRejected("not_found", `没有这份系统提示：${id}`);
  return id;
}

/** 公用占位符的值（工具名、标记）：只给能用它们的提示 */
function commonValues(id: PromptId): Record<string, string> {
  return PROMPTS[id].common ? Object.fromEntries(commonPlaceholders().map((c) => [c.name, c.value])) : {};
}

export function createPromptLibrary(options: PromptLibraryOptions = {}): PromptLibrary {
  checkPromptRegistry();
  const defaultsDir = options.defaultsDir ?? DEFAULT_PROMPTS_DIR;
  const { userDir } = options;
  const log = options.log ?? (() => {});
  const listeners = new Set<(id: PromptId) => void>();
  /** 运行中发现用户的文件有错时只记一次日志（同一份、同样的内容） */
  const reported = new Map<PromptId, string>();
  /** 装配时缺了值的用户的那一份（内容、错在哪）：内容没变就一直用默认的；只记在内存里 */
  const missedAtRender = new Map<PromptId, { source: string; problem: string }>();
  const { agentsDir } = options;
  const agentListeners = new Set<(agentId: string) => void>();
  /** 单独的提示词有错时只记一次日志（同一个 agent、同样的内容） */
  const reportedOwn = new Map<string, string>();
  /** 装配时缺了值的单独的提示词（agent → 内容、错在哪）：内容没变就一直用通用模板 */
  const ownMissed = new Map<string, { source: string; problem: string }>();

  const defaultFile = (id: PromptId) => path.join(defaultsDir, `${id}${EXT}`);
  const userFile = (id: PromptId) => (userDir === undefined ? undefined : path.join(userDir, `${id}${EXT}`));

  /** 默认的：有错是编程错误（测试守着），直接抛 */
  const loadDefault = (id: PromptId): { source: string; nodes: readonly PromptNode[] } => {
    const file = defaultFile(id);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      throw new PromptFilesBroken(`默认的系统提示 ${file} 读不了：${err instanceof Error ? err.message : String(err)}`);
    }
    const source = normalizePromptSource(raw);
    const checked = problemOf(id, source);
    if ("problem" in checked) throw new PromptFilesBroken(`默认的系统提示 ${file} 有错：\n${checked.problem}`);
    return { source, nodes: checked.nodes };
  };

  /** 用户改的那份原样的内容；没有是 undefined */
  const readUser = (id: PromptId): string | undefined => {
    const file = userFile(id);
    if (file === undefined) return undefined;
    try {
      return fs.readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  };

  const load = (id: PromptId): Loaded => {
    const raw = readUser(id);
    if (raw === undefined) return { state: "default", ...loadDefault(id) };
    const source = normalizePromptSource(raw);
    const checked = problemOf(id, source);
    if ("problem" in checked) return { state: "broken", ...loadDefault(id), problem: checked.problem, broken: source };
    const missed = missedAtRender.get(id);
    if (missed?.source === source) return { state: "broken", ...loadDefault(id), problem: missed.problem, broken: source };
    return { state: "custom", source, nodes: checked.nodes };
  };

  /** 装配时用的：用户的那一份有错就用默认的，记一行日志 */
  const nodesFor = (id: PromptId): readonly PromptNode[] => {
    const loaded = load(id);
    if (loaded.state === "broken" && reported.get(id) !== loaded.broken) {
      reported.set(id, loaded.broken!);
      log(`系统提示 ${userFile(id)} 有错，这次用默认的（在设置 · 系统提示里改好或恢复默认）：${loaded.problem!.replaceAll("\n", "；")}`);
    }
    return loaded.nodes;
  };
  /** 插的片段解析好的样子（片段里的占位符用同一份值） */
  const partialNodes = (p: string) => nodesFor(requirePromptId(p));

  const detailOf = (id: PromptId): SystemPromptDetail => {
    const loaded = load(id);
    const d: PromptDefinition = PROMPTS[id];
    return {
      ...summaryOf(id, loaded),
      content: loaded.source,
      defaultContent: loadDefault(id).source,
      ...(loaded.broken === undefined ? {} : { brokenContent: loaded.broken }),
      placeholders: placeholdersOf(id),
      allowEmpty: d.allowEmpty,
      userFile: userFile(id) ?? "",
    };
  };

  /**
   * 装配时缺了值：出错的那一份是用户改的，就记下来（这一份之后用默认的），返回 true 再装配一次；
   * 默认的也缺（程序没给值）是编程错误，返回 false 照样抛
   */
  const fallBack = (err: PromptValueMissing, rendering: PromptId): boolean => {
    if (!isPromptId(err.source)) return false;
    const culprit = err.source;
    const loaded = load(culprit);
    if (loaded.state !== "custom") return false;
    const what = err.flag ? `条件“${err.placeholder}”` : `{{${err.placeholder}}}`;
    missedAtRender.set(culprit, {
      source: loaded.source,
      problem: `第 ${err.line} 行：装配“${PROMPTS[rendering].title}”时 ${what} 没有值（检查没拦住的情况），这一份先用默认的；改一改或者恢复默认`,
    });
    return true;
  };

  const writableDir = (): string => {
    if (userDir === undefined) throw new RequestRejected("not_allowed", "没有数据目录，改不了系统提示");
    return userDir;
  };

  const changed = (id: PromptId) => {
    reported.delete(id);
    missedAtRender.delete(id);
    for (const l of listeners) {
      try {
        l(id);
      } catch (err) {
        log(`系统提示改动的通知出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
    }
  };

  const removeUser = (id: PromptId): boolean => {
    const file = userFile(id);
    if (file === undefined || !fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  };

  const ownFile = (agentId: string, mode: AgentPromptMode) => (agentsDir === undefined ? undefined : path.join(agentsDir, `${agentId}.${mode}${EXT}`));

  /** 这个 agent 单独的提示词原样的样子（整份的优先：存的时候只留一份，手放了两份时按整份的）；没有是 undefined */
  const readOwn = (agentId: string): { mode: AgentPromptMode; source: string } | undefined => {
    if (!AGENT_FILE_ID.test(agentId)) return undefined;
    for (const mode of ["replace", "append"] as const) {
      const file = ownFile(agentId, mode);
      if (file === undefined) continue;
      try {
        return { mode, source: normalizePromptSource(fs.readFileSync(file, "utf8")) };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    return undefined;
  };

  /** 单独的提示词查一遍：对的给出解析好的样子，错的写明错在哪（按 role 的通用模板查；装配时缺过值的照旧算错） */
  const loadOwn = (agentId: string, role: PromptId): { mode: AgentPromptMode; source: string; nodes?: readonly PromptNode[]; problem?: string } | undefined => {
    const own = readOwn(agentId);
    if (!own) return undefined;
    const problem = agentPromptProblem(own.mode, own.source, promptSpec(role), PROMPTS[role].allowEmpty);
    if (problem !== undefined) return { ...own, problem };
    const missed = ownMissed.get(agentId);
    if (missed?.source === `${role}:${own.source}`) return { ...own, problem: missed.problem };
    const parsed = parsePromptTemplate(own.source, promptSpec(role));
    return parsed.ok ? { ...own, nodes: parsed.nodes } : { ...own, problem: promptIssuesText(parsed.issues) };
  };

  /** 装配时用的单独的提示词：有错的不用（记一行日志，同样的内容只记一次） */
  const ownFor = (agentId: string, role: PromptId) => {
    const own = loadOwn(agentId, role);
    if (!own || own.problem === undefined) return own;
    if (reportedOwn.get(agentId) !== own.source) {
      reportedOwn.set(agentId, own.source);
      log(`agent ${agentId} 单独的提示词 ${ownFile(agentId, own.mode)} 有错，这次用通用模板（在这个 agent 会话的 ⚙ 里改好或恢复用通用模板）：${own.problem.replaceAll("\n", "；")}`);
    }
    return undefined;
  };

  const ownChanged = (agentId: string) => {
    reportedOwn.delete(agentId);
    ownMissed.delete(agentId);
    for (const l of agentListeners) {
      try {
        l(agentId);
      } catch (err) {
        log(`单独的提示词改动的通知出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
    }
  };

  /** 删掉这个 agent 单独的提示词（两种写法的都删）；删了东西返回 true */
  const removeOwn = (agentId: string, keep?: AgentPromptMode): boolean => {
    let removed = false;
    for (const mode of ["append", "replace"] as const) {
      const file = ownFile(agentId, mode);
      if (mode === keep || file === undefined || !fs.existsSync(file)) continue;
      fs.rmSync(file, { force: true });
      removed = true;
    }
    return removed;
  };

  return {
    render(id, values, agentId) {
      const all = { ...commonValues(id), ...values };
      // 每缺一次就有一份用户改的（或这个 agent 单独的）退回默认的，最多试提示的份数那么多次
      for (;;) {
        const own = agentId === undefined ? undefined : ownFor(agentId, id);
        try {
          // 整份自己写的替换通用模板；追加的接在通用模板后面（空一行），追加的填出来是空的就不接
          if (own?.mode === "replace") return renderPromptTemplate(own.nodes!, all, partialNodes, ownSource(agentId!));
          const base = renderPromptTemplate(nodesFor(id), all, partialNodes, id);
          if (own?.mode !== "append") return base;
          const extra = renderPromptTemplate(own.nodes!, all, partialNodes, ownSource(agentId!));
          return extra.trim() === "" ? base : `${base}\n\n${extra}`;
        } catch (err) {
          if (!(err instanceof PromptValueMissing)) throw err;
          if (agentId !== undefined && own && err.source === ownSource(agentId)) {
            const what = err.flag ? `条件“${err.placeholder}”` : `{{${err.placeholder}}}`;
            ownMissed.set(agentId, { source: `${id}:${own.source}`, problem: `第 ${err.line} 行：装配时 ${what} 没有值（检查没拦住的情况），先用通用模板；改一改或者恢复用通用模板` });
            continue;
          }
          if (!fallBack(err, id)) throw err;
        }
      }
    },

    withPrefix(systemPrompt) {
      const prefix = nodesFor("prefix");
      const text = renderPromptTemplate(prefix, {}, () => [], "prefix").trim();
      return text === "" ? systemPrompt : `${text}\n\n${systemPrompt}`;
    },

    revision(ids, agentId) {
      const all = [...new Set(ids.flatMap((id) => [id, ...partialsOf(id)]))];
      const files = all.map((id) => `${id}:${fileStamp(userFile(id))}`);
      // 这个 agent 单独的提示词（114 号票）也算：直接改了文件，秘书下一轮之前看得出来
      if (agentId !== undefined && AGENT_FILE_ID.test(agentId)) for (const mode of ["append", "replace"] as const) files.push(`${agentId}.${mode}:${fileStamp(ownFile(agentId, mode))}`);
      return files.join(";");
    },

    check() {
      const problems: string[] = [];
      for (const id of PROMPT_IDS) {
        try {
          loadDefault(id);
        } catch (err) {
          problems.push(err instanceof Error ? err.message : String(err));
          continue;
        }
        const loaded = load(id);
        if (loaded.state === "broken") problems.push(`${userFile(id)} 有错（改好，或者删掉它恢复默认）：\n${loaded.problem}`);
      }
      if (problems.length > 0) throw new PromptFilesBroken(`系统提示有错，守护进程不启动：\n${problems.join("\n")}`);
      // 不认得的文件（名字写错了）用不上：只提醒
      if (userDir !== undefined && fs.existsSync(userDir)) {
        for (const name of fs.readdirSync(userDir)) {
          if (name.endsWith(EXT) && !isPromptId(name.slice(0, -EXT.length))) log(`系统提示的目录里有不认得的文件 ${path.join(userDir, name)}，用不上（文件名要是 ${PROMPT_IDS.map((i) => i + EXT).join("、")} 之一）`);
        }
      }
    },

    list() {
      return { prompts: PROMPT_IDS.map((id) => summaryOf(id, load(id))), userDir: userDir ?? "" };
    },

    detail(id) {
      return detailOf(requirePromptId(id));
    },

    save(raw, content) {
      const id = requirePromptId(raw);
      const dir = writableDir();
      const source = normalizePromptSource(content);
      const checked = problemOf(id, source);
      if ("problem" in checked) throw new RequestRejected("bad_params", `没存：\n${checked.problem}`);
      const before = readUser(id);
      if (source === loadDefault(id).source) {
        // 和默认的一样：等于恢复默认（以后默认的改了也跟着变）
        if (removeUser(id)) changed(id);
        return detailOf(id);
      }
      if (before !== undefined && normalizePromptSource(before) === source) return detailOf(id);
      fs.mkdirSync(dir, { recursive: true });
      const file = userFile(id)!;
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, `${source}\n`, "utf8");
      fs.renameSync(tmp, file);
      changed(id);
      return detailOf(id);
    },

    reset(raw) {
      const id = requirePromptId(raw);
      writableDir();
      if (removeUser(id)) changed(id);
      return detailOf(id);
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    agentPrompt(agentId, role) {
      const own = loadOwn(agentId, role);
      return own && { mode: own.mode, content: own.source, ...(own.problem === undefined ? {} : { problem: own.problem }) };
    },

    saveAgentPrompt(agentId, role, mode, content) {
      requireAgentFileId(agentId);
      if (agentsDir === undefined) throw new RequestRejected("not_allowed", "没有数据目录，改不了单独的提示词");
      const source = normalizePromptSource(content);
      const problem = agentPromptProblem(mode, source, promptSpec(role), PROMPTS[role].allowEmpty);
      if (problem !== undefined) throw new RequestRejected("bad_params", `没存：\n${problem}`);
      // 追加的是空的：等于不追加，就是恢复用通用模板
      if (mode === "append" && source.trim() === "") {
        if (removeOwn(agentId)) ownChanged(agentId);
        return;
      }
      const before = readOwn(agentId);
      const removed = removeOwn(agentId, mode);
      if (!removed && before?.mode === mode && before.source === source) return;
      fs.mkdirSync(agentsDir, { recursive: true });
      const file = ownFile(agentId, mode)!;
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, `${source}\n`, "utf8");
      fs.renameSync(tmp, file);
      ownChanged(agentId);
    },

    resetAgentPrompt(agentId) {
      requireAgentFileId(agentId);
      if (agentsDir === undefined) throw new RequestRejected("not_allowed", "没有数据目录，改不了单独的提示词");
      if (removeOwn(agentId)) ownChanged(agentId);
    },

    onAgentChange(listener) {
      agentListeners.add(listener);
      return () => agentListeners.delete(listener);
    },
  };
}

/** 只有默认提示的那一份（测试、不经守护进程的纯函数用）：同一个进程里共用一个 */
let defaults: PromptLibrary | undefined;
export function defaultPromptLibrary(): PromptLibrary {
  defaults ??= createPromptLibrary();
  return defaults;
}
