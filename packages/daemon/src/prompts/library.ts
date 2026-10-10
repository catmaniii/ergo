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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
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
  log?: (line: string) => void;
}

/** 只要填值的一方（装配 agent 的模块）用的 */
export type PromptRenderer = Pick<PromptLibrary, "render">;

/** 启动时查出的问题：哪些文件、错在哪 */
export class PromptFilesBroken extends Error {}

export interface PromptLibrary {
  /** 填好值的一份提示（不带前缀）；用户改的有错、这次缺值时，出错的那一份用默认的 */
  render<Id extends PromptId>(id: Id, values: PromptValuesOf<Id>): string;
  /** 前缀加在 agent 的系统提示前面（前缀是空的原样返回） */
  withPrefix(systemPrompt: string): string;
  /**
   * 这几份提示（连同它们插的片段）用户文件现在的样子（有没有、修改时间、大小）：和拉起时记下的不一样，就是文件被改过
   * （常驻的秘书据此在下一轮之前重新拉起）
   */
  revision(ids: readonly PromptId[]): string;
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
}

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

  return {
    render(id, values) {
      const all = { ...commonValues(id), ...values };
      // 每缺一次就有一份用户改的退回默认的，最多试提示的份数那么多次
      for (;;) {
        try {
          return renderPromptTemplate(nodesFor(id), all, (p) => nodesFor(requirePromptId(p)), id);
        } catch (err) {
          if (!(err instanceof PromptValueMissing) || !fallBack(err, id)) throw err;
        }
      }
    },

    withPrefix(systemPrompt) {
      const prefix = nodesFor("prefix");
      const text = renderPromptTemplate(prefix, {}, () => [], "prefix").trim();
      return text === "" ? systemPrompt : `${text}\n\n${systemPrompt}`;
    },

    revision(ids) {
      const all = [...new Set(ids.flatMap((id) => [id, ...partialsOf(id)]))];
      return all
        .map((id) => {
          const file = userFile(id);
          const stat = file === undefined ? undefined : fs.statSync(file, { throwIfNoEntry: false });
          return `${id}:${stat ? `${stat.mtimeMs}/${stat.size}` : "-"}`;
        })
        .join(";");
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
  };
}

/** 只有默认提示的那一份（测试、不经守护进程的纯函数用）：同一个进程里共用一个 */
let defaults: PromptLibrary | undefined;
export function defaultPromptLibrary(): PromptLibrary {
  defaults ??= createPromptLibrary();
  return defaults;
}
