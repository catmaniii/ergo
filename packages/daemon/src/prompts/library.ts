// 系统提示的文件（71 号票，一份提示一个 md 文件）：默认的在本包的 prompts/<编号>.md（随程序分发、进仓库），
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
// 249 号票起前缀后面还跟一句用户自己的名字（"用户叫「…」，需要称呼用户时用这个名字"；没设就没有），也在 withPrefix 里。
//
// 每个 agent 单独的提示词（114 号票，会话里的 ⚙）：在数据目录配置区的 agent-prompts/ 里按 agent 分，<agent id>.append.md 是接在通用模板
// （这个角色的那一份，用户改过的就是改过的）后面的一段，<agent id>.replace.md 是整份自己写的（替换通用模板，通用模板之后再改不影响它）；
// 一个 agent 只有其中一份。装配这个 agent 的角色提示时带上 agent id（render 的第三个参数）才用它，片段、前缀、别的几份照旧。
// 两种都是提示文件的写法，按这个角色的通用模板查占位符（和设置页同一个检查，协议包的 agentPromptProblem）；存之前查、写错的拒收；
// 文件被直接改坏了、装配时缺了值（任务转为项目后模板换了这类）：这次用通用模板，记一行日志，面板上写明错在哪，agent 照常拉起。
// 存了、恢复用通用模板之后通知 onAgentChange 的（各模块据此让这个 agent 手头这一条处理完后按新的提示重新拉起）。
//
// 插件贡献的（128 号票）：插件宿主收齐的条件、公用占位符、片段（options.plugins），和内核的合成一份清单（registry.ts 的 promptRegistry）。
// 插件的条件在装配时现算（插件这时在不在运行），插件的占位符总有值；插件的片段排在内核的后面，设置页上照样能看、能改、能恢复默认，
// 默认的文件在插件目录里。不给 plugins 时按插件清单里的、都当在运行（测试、纯函数用：和默认全开的守护进程一样）。
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
  t,
} from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";
import { PLUGIN_MANIFEST } from "../plugins/manifest.ts";
import { writeFileAtomic } from "../util/atomic-file.ts";
import { type PluginPrompts, PROMPTS, type PromptDefinition, type PromptId, type PromptRegistry, promptRegistry, type PromptValuesOf, valueDescription, valueOnlyWhen } from "./registry.ts";

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
  /**
   * 插件在系统提示里的（128 号票：插件宿主收齐的条件、占位符、片段）和它们在不在运行（插件的条件按它，装配时现算）；
   * 不填是插件清单里的、都当在运行（测试、纯函数用）
   */
  plugins?: { prompts: readonly PluginPrompts[]; running(plugin: string): boolean };
  /**
   * 这个 agent 自己起的名字（241 号票）：给了 agentId 的角色提示（秘书那份除外——它的名字本来就在 `{{名字}}` 占位里）
   * 末尾加一句"用户叫你「…」"，让模型自我介绍、说到自己时用这个名字。没配（undefined）就不加，和以前一模一样
   */
  agentName?: (agentId: string) => string | undefined;
  /**
   * 用户自己的名字（249 号票："我的名字"）：设了就在每个 agent 的系统提示最前面（前缀后面空一行）加一句"用户叫「…」，
   * 需要称呼用户时用这个名字"，让模型知道该称呼用户什么（对话、念给用户听的话都可以这样叫）。没设（undefined、空串）
   * 就不加，提示和以前**逐字节一样**。现取（改了名字下一次装配就用新的）
   */
  userName?: () => string | undefined;
  log?: (line: string) => void;
}

/** 插件清单里各插件在系统提示里的（不给 plugins 时用；用到时才取清单，免得模块加载时互相引用） */
const manifestPrompts = (): PluginPrompts[] => PLUGIN_MANIFEST.flatMap((p) => (p.prompts ? [p.prompts] : []));

/** 只要填值的一方（装配 agent 的模块）用的 */
export type PromptRenderer = Pick<PromptLibrary, "render">;

/** 启动时查出的问题：哪些文件、错在哪 */
export class PromptFilesBroken extends Error {}

/** 装配时没有值的那个占位符的说法（设置页上的问题里用） */
const missingWhat = (err: { flag?: boolean; placeholder: string }) => (err.flag ? t("prompts.problem.flag", { name: err.placeholder }) : `{{${err.placeholder}}}`);

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
  onChange(listener: (id: string) => void): () => void;
  /** 这个 agent 单独的提示词（114 号票；role 是它的通用模板，按它查对不对）；没有是 undefined */
  agentPrompt(agentId: string, role: PromptId): AgentOwnPrompt | undefined;
  /** 存这个 agent 单独的提示词：占位符照 role 查，写错的拒收；追加的是空的等于恢复用通用模板 */
  saveAgentPrompt(agentId: string, role: PromptId, mode: AgentPromptMode, content: string): void;
  /** 恢复用通用模板（删掉它单独的） */
  resetAgentPrompt(agentId: string): void;
  /** 某个 agent 单独的提示词改了（存、恢复用通用模板）；返回取消订阅 */
  onAgentChange(listener: (agentId: string) => void): () => void;
  /**
   * 这个 agent 自己的名字或者音色改了（241 号票）：和单独的提示词改了走同一条通知，各模块据此让这个 agent
   * 手头这一条处理完后按新的重新装配（名字写进它的系统提示）
   */
  agentChanged(agentId: string): void;
}

/** agent id 能不能当文件名（和 agent 管家认的一样：字母、数字开头，只有字母、数字、点、减号、下划线） */
const AGENT_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 这个 agent 自己起的名字（241 号票）写在它角色提示的末尾：和秘书系统提示里那句一个说法，让模型自我介绍、
 * 说到自己时用这个名字。没配名字的不加，和以前一字不差
 */
const identityLine = (name: string) => `用户叫你「${name}」：自我介绍、说到你自己时用这个名字。`; // @i18n-ignore model：系统提示里给模型看的一句

/**
 * 用户自己的名字那一句（249 号票）：加在每个 agent 的系统提示最前面（前缀后面），让模型知道该怎么称呼用户。
 * 和上面那句（agent 自己的名字）不是一回事；没设就不加，提示逐字节不变
 */
const userNameLine = (name: string) => `用户叫「${name}」，需要称呼用户时用这个名字（对话、念给用户听的话都可以这样叫）。`; // @i18n-ignore model：系统提示里给模型看的一句

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

/** 检查用的 spec：自己的占位符（连同只在某个条件成立时才有值的）加上公用的、插件的条件（128 号票），能插的片段连同插件插进来的 */
export function promptSpec(id: PromptId, registry: PromptRegistry = promptRegistry(manifestPrompts())): PromptTemplateSpec {
  return specOf(registry, id);
}

function specOf(registry: PromptRegistry, id: string): PromptTemplateSpec {
  const d = registry.definition(id);
  const onlyWhen = Object.entries(d.values).flatMap(([name, spec]) => {
    const flag = valueOnlyWhen(spec);
    return flag === undefined ? [] : [[name, flag] as const];
  });
  return {
    values: Object.keys(d.values),
    common: d.common ? registry.common.map((c) => c.name) : [],
    flags: [...Object.keys(d.flags), ...(d.common ? registry.pluginFlags.map((f) => f.name) : [])],
    partials: registry.partials(id),
    onlyWhen: Object.fromEntries(onlyWhen),
  };
}

/** 查一份提示的内容：能不能是空的、占位符对不对；错了返回给人看的说明 */
function problemOf(registry: PromptRegistry, id: string, source: string): { nodes: readonly PromptNode[] } | { problem: string } {
  const d = registry.definition(id);
  if (!d.allowEmpty && source.trim() === "") return { problem: t("prompts.problem.empty") };
  const parsed = parsePromptTemplate(source, specOf(registry, id));
  return parsed.ok ? { nodes: parsed.nodes } : { problem: promptIssuesText(parsed.issues) };
}

/** 设置页上列出的能用的占位符：自己的值、条件（连同插件的）、片段，再加公用的 */
function placeholdersOf(registry: PromptRegistry, id: string): SystemPromptPlaceholder[] {
  const d = registry.definition(id);
  return [
    ...Object.entries(d.values).map(([name, spec]) => {
      const flag = valueOnlyWhen(spec);
      return { name, kind: "value" as const, description: valueDescription(spec), ...(flag === undefined ? {} : { onlyWhen: flag }) };
    }),
    ...Object.entries(d.flags).map(([name, description]) => ({ name, kind: "flag" as const, description })),
    // 插件的条件（128 号票）和这份自己的条件一样列（设置页按条件查）
    ...(d.common ? registry.pluginFlags.map((f) => ({ name: f.name, kind: "flag" as const, description: f.description })) : []),
    ...registry.partials(id).map((p) => ({ name: p, kind: "partial" as const, description: registry.definition(p).title })),
    ...(d.common ? registry.common.map((c) => ({ name: c.name, kind: "value" as const, description: c.description, common: true })) : []),
  ];
}

function summaryOf(registry: PromptRegistry, id: string, loaded: Loaded): SystemPromptSummary {
  const d = registry.definition(id);
  return {
    id,
    title: d.title,
    description: d.description,
    group: d.group,
    state: loaded.state,
    usedIn: registry.includersOf(id).map((p) => registry.definition(p).title),
    ...(loaded.problem === undefined ? {} : { problem: loaded.problem }),
  };
}

/** 单独的提示词按 agent id 起文件名：只认字母、数字开头，字母、数字、`.`、`_`、`-`（114 号票） */
function requireAgentFileId(agentId: string): void {
  if (!AGENT_FILE_ID.test(agentId)) throw new RequestRejected("not_found", t("prompts.noAgent", { agentId }));
}

/** 文件的戳（改动时间和大小），没有文件写 "-"：revision 用 */
function fileStamp(file: string | undefined): string {
  const stat = file === undefined ? undefined : fs.statSync(file, { throwIfNoEntry: false });
  return stat ? `${stat.mtimeMs}/${stat.size}` : "-";
}

export function createPromptLibrary(options: PromptLibraryOptions = {}): PromptLibrary {
  const plugins = options.plugins ?? { prompts: manifestPrompts(), running: () => true };
  const registry = promptRegistry(plugins.prompts);
  const defaultsDir = options.defaultsDir ?? DEFAULT_PROMPTS_DIR;
  const { userDir } = options;
  const log = options.log ?? (() => {});
  const listeners = new Set<(id: string) => void>();
  /** 运行中发现用户的文件有错时只记一次日志（同一份、同样的内容） */
  const reported = new Map<string, string>();
  /** 装配时缺了值的用户的那一份（内容、错在哪）：内容没变就一直用默认的；只记在内存里 */
  const missedAtRender = new Map<string, { source: string; problem: string }>();
  const { agentsDir } = options;
  const agentListeners = new Set<(agentId: string) => void>();
  /** 这个 agent 自己起的名字（241 号票：会话里的 ⚙、设置 · 语音里按 agent 配的；没配是 undefined，跟默认） */
  const agentName = options.agentName;
  /** 用户自己的名字（249 号票：设置 · 身份里的"我的名字"；没设是 undefined，提示一个字不变） */
  const userName = options.userName;
  /** 单独的提示词有错时只记一次日志（同一个 agent、同样的内容） */
  const reportedOwn = new Map<string, string>();
  /** 装配时缺了值的单独的提示词（agent → 内容、错在哪）：内容没变就一直用通用模板 */
  const ownMissed = new Map<string, { source: string; problem: string }>();

  /** 默认的文件：内核的在默认目录里，插件的片段在插件目录里（128 号票） */
  const defaultFile = (id: string) => registry.pluginFile(id) ?? path.join(defaultsDir, `${id}${EXT}`);
  const userFile = (id: string) => (userDir === undefined ? undefined : path.join(userDir, `${id}${EXT}`));
  /** 设置页给的编号：不认得的回"没有这份" */
  const requirePromptId = (id: string): string => {
    if (!registry.has(id)) throw new RequestRejected("not_found", t("prompts.noPrompt", { id }));
    return id;
  };
  /** 公用占位符的值（工具名、标记）和插件的条件（插件此刻在不在运行，128 号票）：只给能用它们的提示 */
  const commonValues = (id: string): Record<string, string | boolean> =>
    registry.definition(id).common
      ? { ...Object.fromEntries(registry.common.map((c) => [c.name, c.value])), ...Object.fromEntries(registry.pluginFlags.map((f) => [f.name, plugins.running(f.plugin)])) }
      : {};

  /** 默认的：有错是编程错误（测试守着），直接抛 */
  const loadDefault = (id: string): { source: string; nodes: readonly PromptNode[] } => {
    const file = defaultFile(id);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      throw new PromptFilesBroken(`默认的系统提示 ${file} 读不了：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log：启动时报的编程错误
    }
    const source = normalizePromptSource(raw);
    const checked = problemOf(registry, id, source);
    if ("problem" in checked) throw new PromptFilesBroken(`默认的系统提示 ${file} 有错：\n${checked.problem}`); // @i18n-ignore log：启动时报的编程错误
    return { source, nodes: checked.nodes };
  };

  /** 用户改的那份原样的内容；没有是 undefined */
  const readUser = (id: string): string | undefined => {
    const file = userFile(id);
    if (file === undefined) return undefined;
    try {
      return fs.readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  };

  const load = (id: string): Loaded => {
    const raw = readUser(id);
    if (raw === undefined) return { state: "default", ...loadDefault(id) };
    const source = normalizePromptSource(raw);
    const checked = problemOf(registry, id, source);
    if ("problem" in checked) return { state: "broken", ...loadDefault(id), problem: checked.problem, broken: source };
    const missed = missedAtRender.get(id);
    if (missed?.source === source) return { state: "broken", ...loadDefault(id), problem: missed.problem, broken: source };
    return { state: "custom", source, nodes: checked.nodes };
  };

  /** 装配时用的：用户的那一份有错就用默认的，记一行日志 */
  const nodesFor = (id: string): readonly PromptNode[] => {
    const loaded = load(id);
    if (loaded.state === "broken" && reported.get(id) !== loaded.broken) {
      reported.set(id, loaded.broken!);
      log(`系统提示 ${userFile(id)} 有错，这次用默认的（在设置 · 系统提示里改好或恢复默认）：${loaded.problem!.replaceAll("\n", "；")}`);
    }
    return loaded.nodes;
  };
  /** 插的片段解析好的样子（片段里的占位符用同一份值） */
  const partialNodes = (p: string) => nodesFor(requirePromptId(p));

  const detailOf = (id: string): SystemPromptDetail => {
    const loaded = load(id);
    const d: PromptDefinition = registry.definition(id);
    return {
      ...summaryOf(registry, id, loaded),
      content: loaded.source,
      defaultContent: loadDefault(id).source,
      ...(loaded.broken === undefined ? {} : { brokenContent: loaded.broken }),
      placeholders: placeholdersOf(registry, id),
      allowEmpty: d.allowEmpty,
      userFile: userFile(id) ?? "",
    };
  };

  /**
   * 装配时缺了值：出错的那一份是用户改的，就记下来（这一份之后用默认的），返回 true 再装配一次；
   * 默认的也缺（程序没给值）是编程错误，返回 false 照样抛
   */
  const fallBack = (err: PromptValueMissing, rendering: PromptId): boolean => {
    if (!registry.has(err.source)) return false;
    const culprit = err.source;
    const loaded = load(culprit);
    if (loaded.state !== "custom") return false;
    missedAtRender.set(culprit, {
      source: loaded.source,
      problem: t("prompts.problem.missedAtRender", { line: err.line, prompt: PROMPTS[rendering].title, what: missingWhat(err) }),
    });
    return true;
  };

  const writableDir = (): string => {
    if (userDir === undefined) throw new RequestRejected("not_allowed", t("prompts.noDataDir"));
    return userDir;
  };

  const changed = (id: string) => {
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

  const removeUser = (id: string): boolean => {
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
    const problem = agentPromptProblem(own.mode, own.source, specOf(registry, role), PROMPTS[role].allowEmpty);
    if (problem !== undefined) return { ...own, problem };
    const missed = ownMissed.get(agentId);
    if (missed?.source === `${role}:${own.source}`) return { ...own, problem: missed.problem };
    const parsed = parsePromptTemplate(own.source, specOf(registry, role));
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

  /**
   * 角色提示末尾那句"用户叫你「…」"（241 号票）：只给带了 agent id 的角色提示，秘书那份不加（它的名字在 `{{名字}}` 占位里，
   * 别重复）；片段、前缀、压缩指令都不经过这里。没配名字、不是角色提示的原样返回
   */
  const withIdentity = (id: string, text: string, agentId: string | undefined): string => {
    if (agentId === undefined || id === "secretary" || agentName === undefined) return text;
    try {
      if (registry.definition(id).group !== "role") return text;
    } catch {
      // 不认得的编号（不该发生）：原样返回，不因为它把这一份装配弄坏
      return text;
    }
    const name = agentName(agentId);
    return name === undefined || name.trim() === "" ? text : `${text}\n\n${identityLine(name)}`;
  };

  return {
    render(id, values, agentId) {
      const all = { ...commonValues(id), ...values };
      // 每缺一次就有一份用户改的（或这个 agent 单独的）退回默认的，最多试提示的份数那么多次
      for (;;) {
        const own = agentId === undefined ? undefined : ownFor(agentId, id);
        try {
          // 整份自己写的替换通用模板；追加的接在通用模板后面（空一行），追加的填出来是空的就不接
          if (own?.mode === "replace") return withIdentity(id, renderPromptTemplate(own.nodes!, all, partialNodes, ownSource(agentId!)), agentId);
          const base = renderPromptTemplate(nodesFor(id), all, partialNodes, id);
          if (own?.mode !== "append") return withIdentity(id, base, agentId);
          const extra = renderPromptTemplate(own.nodes!, all, partialNodes, ownSource(agentId!));
          return withIdentity(id, extra.trim() === "" ? base : `${base}\n\n${extra}`, agentId);
        } catch (err) {
          if (!(err instanceof PromptValueMissing)) throw err;
          if (agentId !== undefined && own && err.source === ownSource(agentId)) {
            ownMissed.set(agentId, { source: `${id}:${own.source}`, problem: t("prompts.problem.ownMissed", { line: err.line, what: missingWhat(err) }) });
            continue;
          }
          if (!fallBack(err, id)) throw err;
        }
      }
    },

    agentChanged(agentId) {
      ownChanged(agentId);
    },

    withPrefix(systemPrompt) {
      const prefix = nodesFor("prefix");
      const text = renderPromptTemplate(prefix, {}, () => [], "prefix").trim();
      // 用户自己的名字（249 号票）：设了才有这一句；没设时 text 原样，和以前逐字节一样
      const name = userName?.();
      const userLine = name === undefined || name.trim() === "" ? "" : userNameLine(name);
      const head = [text, userLine].filter((part) => part !== "").join("\n\n");
      return head === "" ? systemPrompt : `${head}\n\n${systemPrompt}`;
    },

    revision(ids, agentId) {
      const all = [...new Set(ids.flatMap((id) => [id, ...registry.partialsOf(id)]))];
      const files = all.map((id) => `${id}:${fileStamp(userFile(id))}`);
      // 这个 agent 单独的提示词（114 号票）也算：直接改了文件，秘书下一轮之前看得出来
      if (agentId !== undefined && AGENT_FILE_ID.test(agentId)) for (const mode of ["append", "replace"] as const) files.push(`${agentId}.${mode}:${fileStamp(ownFile(agentId, mode))}`);
      return files.join(";");
    },

    check() {
      const problems: string[] = [];
      for (const id of registry.ids) {
        try {
          loadDefault(id);
        } catch (err) {
          problems.push(err instanceof Error ? err.message : String(err));
          continue;
        }
        const loaded = load(id);
        if (loaded.state === "broken") problems.push(`${userFile(id)} 有错（改好，或者删掉它恢复默认）：\n${loaded.problem}`); // @i18n-ignore log：启动时的说明（LSM 里看）
      }
      if (problems.length > 0) throw new PromptFilesBroken(`系统提示有错，守护进程不启动：\n${problems.join("\n")}`); // @i18n-ignore log：启动时的说明（LSM 里看）
      // 不认得的文件（名字写错了）用不上：只提醒
      if (userDir !== undefined && fs.existsSync(userDir)) {
        for (const name of fs.readdirSync(userDir)) {
          if (name.endsWith(EXT) && !registry.has(name.slice(0, -EXT.length))) log(`系统提示的目录里有不认得的文件 ${path.join(userDir, name)}，用不上（文件名要是 ${registry.ids.map((i) => i + EXT).join("、")} 之一）`);
        }
      }
    },

    list() {
      return { prompts: registry.ids.map((id) => summaryOf(registry, id, load(id))), userDir: userDir ?? "" };
    },

    detail(id) {
      return detailOf(requirePromptId(id));
    },

    save(raw, content) {
      const id = requirePromptId(raw);
      writableDir();
      const source = normalizePromptSource(content);
      const checked = problemOf(registry, id, source);
      if ("problem" in checked) throw new RequestRejected("bad_params", t("prompts.notSaved", { problem: checked.problem }));
      const before = readUser(id);
      if (source === loadDefault(id).source) {
        // 和默认的一样：等于恢复默认（以后默认的改了也跟着变）
        if (removeUser(id)) changed(id);
        return detailOf(id);
      }
      if (before !== undefined && normalizePromptSource(before) === source) return detailOf(id);
      // 先写临时文件再改名，被占着时重试（265 号票）
      writeFileAtomic(userFile(id)!, `${source}\n`);
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
      if (agentsDir === undefined) throw new RequestRejected("not_allowed", t("prompts.noDataDirOwn"));
      const source = normalizePromptSource(content);
      const problem = agentPromptProblem(mode, source, specOf(registry, role), PROMPTS[role].allowEmpty);
      if (problem !== undefined) throw new RequestRejected("bad_params", t("prompts.notSaved", { problem }));
      // 追加的是空的：等于不追加，就是恢复用通用模板
      if (mode === "append" && source.trim() === "") {
        if (removeOwn(agentId)) ownChanged(agentId);
        return;
      }
      const before = readOwn(agentId);
      const removed = removeOwn(agentId, mode);
      if (!removed && before?.mode === mode && before.source === source) return;
      writeFileAtomic(ownFile(agentId, mode)!, `${source}\n`);
      ownChanged(agentId);
    },

    resetAgentPrompt(agentId) {
      requireAgentFileId(agentId);
      if (agentsDir === undefined) throw new RequestRejected("not_allowed", t("prompts.noDataDirOwn"));
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
