// 记忆插件宿主（337 号票第一段）：只做"谁在跑"和把调用转给当前插件——还没接进秘书、工具、网页（下一段）。
// - 单活：同时最多一个插件在跑。activate(id) 先把旧的 stop() 再起新的 start()；同一个 id 再 activate 直接返回（不重启）。
//   没起成（start 抛错）时旧的已经停了：宿主不替调用方回滚，谁切谁负责告诉用户。
// - 数据目录：插件的数据目录是 <根目录>/memory/<id>/（根目录由调用方给，通常是数据目录；activate 时建好）。
//   换插件不迁移、不删：旧的那份原样留着，切回来还是它。
// - 版本：插件的 api 不是 MEMORY_API_VERSION 就拒绝启用，消息里写清宿主认哪个、它写的是哪个。
// - 没有在跑时 search/remember/forget/health/observe/callTool 抛 RequestRejected("not_found")，调用方（下一段的工具）据此回话；
//   info()/active()/dataDir() 是查询，不抛。brief/consolidate 没有在跑（或插件没声明这个能力）时回 undefined——那是可选能力，
//   跳过就是"这一轮没有简报""这一夜不整理"，不该让会话崩掉。
// - brief 回落：插件声明了 capabilities.brief 就用它的；没声明就宿主拿 search({ text, limit }) 拼一段纯文本，每条带出处；
//   没有出处的条目不进简报（用户 2026-10-28 定："抽取出来的信息最好能找到原始的"）。
// - brief 回来的东西统一成一份 { text, keys, items, hits }（337 号票）：插件只回字符串时 keys/items/hits 都是空的；
//   回落拼出来的也一样（没有去重的键：调用方每一轮都带）。keys 原样交回调用方，宿主自己不解释那套键。
// - llm/embed/identity 是调用方注入的回调（宿主自己不实现模型调用）：这一段不接真的模型，没注入时插件的 ctx.llm / ctx.embed 抛 not_implemented。
import fs from "node:fs";
import path from "node:path";
import {
  MEMORY_API_VERSION,
  MEMORY_PROVIDER_ID,
  type MemoryBriefInput,
  type MemoryBriefResult,
  type MemoryConsolidateOptions,
  type MemoryConsolidateResult,
  type MemoryEpisode,
  type MemoryForgetResult,
  type MemoryForgetSelector,
  type MemoryHealth,
  type MemoryIdentity,
  type MemoryItem,
  type MemoryLlmRequest,
  type MemoryObserveResult,
  type MemoryProvider,
  type MemoryProviderContext,
  type MemoryProviderInfo,
  type MemoryRememberInput,
  type MemorySearchQuery,
  type MemorySearchResult,
} from "@ergo/protocol";
import { memoryProviderDir } from "../../config/data-dir.ts";
import { RequestRejected } from "../../errors.ts";

/** 简报回落时每条正文最多多少字（超了截一刀，后面还有出处） */
const BRIEF_ITEM_CHARS = 120;

/** 插件清单里登记的一条：id、名字、版本、接口版本都是现成的，宿主不用起实例就能看（界面列清单用） */
export interface MemoryProviderFactory {
  /** 唯一 id：配置 memory.provider 里写的就是它，也是数据目录 <根目录>/memory/<id>/ 的名字 */
  readonly id: string;
  readonly name: { zh: string; en: string };
  readonly version: string;
  /** 接口版本：和 MEMORY_API_VERSION 不一样就不启用 */
  readonly api: number;
  /** 造一个实例（每次 activate 一个新的） */
  create(): MemoryProvider;
}

/** 装了哪些记忆插件（生产里只有会意一个；测试里加假的） */
export interface MemoryProviderRegistry {
  /** 登记一条；同一个 id 登记两次是编程错误，抛 conflict */
  register(factory: MemoryProviderFactory): void;
  /** 登记了哪些 id，按登记的先后 */
  ids(): string[];
  /** 按 id 找那条登记（界面上要名字、版本；没有就 undefined） */
  factory(id: string): MemoryProviderFactory | undefined;
  /** 按 id 造一个实例；没有这个 id 抛 not_found（起没起来是宿主的事） */
  create(id: string): MemoryProvider;
}

export function createMemoryProviderRegistry(): MemoryProviderRegistry {
  const factories = new Map<string, MemoryProviderFactory>();
  return {
    register(factory) {
      const id = checkProviderId(factory.id);
      if (factories.has(id)) throw new RequestRejected("conflict", `记忆插件的 id 重复了：${id}`); // @i18n-ignore log：这一段没接线，只有测试和启动日志看得到
      factories.set(id, factory);
    },
    ids: () => [...factories.keys()],
    factory: (id) => factories.get(id),
    create(id) {
      const factory = factories.get(id);
      if (factory === undefined) throw new RequestRejected("not_found", `没有这个记忆插件：${id}`); // @i18n-ignore log
      return factory.create();
    },
  };
}

export interface MemoryHostOptions {
  /** 根目录（通常是数据目录）：插件的数据目录是它下面的 memory/<id>/ */
  rootDir: string;
  /** 装了哪些插件 */
  registry: MemoryProviderRegistry;
  /** 语言、用户称呼、助手名字这些"现取"的值（宿主不在这层写死；和 ctx.identity() 一样每次现取） */
  identity: () => MemoryIdentity;
  /** 代调模型：走用户配的那个服务商、宿主的限流和记账。不注入时插件的 ctx.llm 抛 not_implemented（这一段还没接模型） */
  llm?: (request: MemoryLlmRequest) => Promise<string>;
  /** 代算向量（用用户装的那个向量模型）。不注入时插件的 ctx.embed 抛 not_implemented */
  embed?: (texts: string[]) => Promise<number[][]>;
  /** 现在（假时钟测试会拨）；默认真实时间 */
  now?: () => Date;
  /** 插件的日志往哪写；默认 console.log */
  log?: (line: string) => void;
  /** 简报回落时取几条（默认 3） */
  briefLimit?: number;
  /** 简报回落时整段最多多少字（默认 400） */
  briefMaxChars?: number;
}

export interface MemoryHost {
  /** 启用一个插件（先停旧的）；同一个 id 再启直接返回，不重启 */
  activate(id: string): Promise<void>;
  /** 停掉在跑的那个（数据目录留着）；没有在跑的什么也不做 */
  deactivate(): Promise<void>;
  /** 现在在跑的是哪个 id（没有就 undefined） */
  active(): string | undefined;
  /** 在跑的那个插件的 info()（没有就 undefined） */
  info(): MemoryProviderInfo | undefined;
  /** 这个插件的数据目录 <根目录>/memory/<id>/（备份、迁移、卸载按整个目录处理；没启用也能算出来） */
  dataDir(id: string): string;
  observe(episode: MemoryEpisode): Promise<MemoryObserveResult>;
  remember(input: MemoryRememberInput): Promise<MemoryItem>;
  search(query: MemorySearchQuery): Promise<MemorySearchResult>;
  forget(selector: MemoryForgetSelector): Promise<MemoryForgetResult>;
  health(): Promise<MemoryHealth>;
  /**
   * 每轮简报：有 brief 能力用插件的，没有就用 search 拼；没有在跑的插件回 undefined。
   * 统一成一份：只回正文的插件（老实现）、回落拼出来的，keys / items / hits 都是空的
   */
  brief(context: MemoryBriefInput): Promise<MemoryBriefResult | undefined>;
  /** 插件自己的整理；没声明 capabilities.consolidate、没有在跑的都回 undefined */
  consolidate(options?: MemoryConsolidateOptions): Promise<MemoryConsolidateResult | undefined>;
  /** 插件额外工具的执行（工具清单见 capabilities.tools） */
  callTool(name: string, args: unknown): Promise<unknown>;
}

export function createMemoryHost(options: MemoryHostOptions): MemoryHost {
  const rootDir = path.resolve(options.rootDir);
  const registry = options.registry;
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  const briefLimit = options.briefLimit ?? 3;
  const briefMaxChars = options.briefMaxChars ?? 400;

  interface Running {
    id: string;
    provider: MemoryProvider;
    info: MemoryProviderInfo;
    abort: AbortController;
  }

  /** 最多这一个在跑 */
  let running: Running | undefined;
  /** 换插件是"停旧的、起新的"两步：串起来做，同时点两次也不会起两个 */
  let queue: Promise<unknown> = Promise.resolve();

  /** 排队做一件会改变"谁在跑"的事（前面那件失败了也接着做下一件） */
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run, run);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function dataDirOf(id: string): string {
    // 路径的算法在内核那一份（data-dir.ts 的 memoryProviderDir）：迁移、工具也按它，不各自拼
    return memoryProviderDir(rootDir, checkProviderId(id));
  }

  function requireRunning(): Running {
    if (running === undefined) throw new RequestRejected("not_found", "现在没有在跑的记忆插件：先在配置里选一个启用"); // @i18n-ignore log：这一段没接线，只有下一段的工具会看到
    return running;
  }

  async function stopRunning(): Promise<void> {
    const active = running;
    if (active === undefined) return;
    // 先摘掉：收尾期间再来的调用一律按"没有在跑"答，不会打到正在关的插件上
    running = undefined;
    active.abort.abort();
    try {
      await active.provider.stop();
    } catch (err) {
      log(`记忆插件 ${active.id} 收尾时报错（照旧当它停了）：${messageOf(err)}`);
    }
    log(`记忆插件停了：${active.id}（数据目录留着：${dataDirOf(active.id)}）`);
  }

  async function activate(id: string): Promise<void> {
    const wanted = checkProviderId(id);
    if (running?.id === wanted) return; // 同一个 id 再激活：不重启
    const factory = registry.factory(wanted);
    if (factory === undefined) throw new RequestRejected("not_found", `没有这个记忆插件：${wanted}`); // @i18n-ignore log
    if (factory.api !== MEMORY_API_VERSION) throw new RequestRejected("conflict", versionText(wanted, factory.api)); // @i18n-ignore log
    // 先停旧的：同一时间只能有一个在跑（旧的数据目录不动）
    await stopRunning();
    const provider = registry.create(wanted);
    const info = provider.info();
    if (info.api !== MEMORY_API_VERSION) throw new RequestRejected("conflict", versionText(wanted, info.api)); // @i18n-ignore log
    if (info.id !== wanted) throw new RequestRejected("conflict", `记忆插件登记的名字和它自己说的对不上：登记的是 ${wanted}，info() 里是 ${info.id}`); // @i18n-ignore log
    const dataDir = dataDirOf(wanted);
    fs.mkdirSync(dataDir, { recursive: true });
    const abort = new AbortController();
    const ctx: MemoryProviderContext = {
      dataDir,
      identity: () => options.identity(),
      llm: async (request) => {
        if (options.llm === undefined) throw new RequestRejected("not_implemented", `记忆插件 ${wanted} 要宿主代调模型，但宿主这一段还没接（ctx.llm）`); // @i18n-ignore log
        return options.llm(request);
      },
      embed: async (texts) => {
        if (options.embed === undefined) throw new RequestRejected("not_implemented", `记忆插件 ${wanted} 要宿主代算向量，但宿主这一段还没接（ctx.embed）`); // @i18n-ignore log
        return options.embed(texts);
      },
      now,
      log,
      signal: abort.signal,
    };
    try {
      await provider.start(ctx);
    } catch (err) {
      // 没起来：把刚起的那个收掉，别留一个半开的实例给下一次
      abort.abort();
      try {
        await provider.stop();
      } catch (stopErr) {
        log(`记忆插件 ${wanted} 没起来，收尾也报了错：${messageOf(stopErr)}`);
      }
      throw err;
    }
    running = { id: wanted, provider, info, abort };
    log(`记忆插件起来了：${wanted}（数据目录 ${dataDir}）`);
  }

  /**
   * 简报回落（插件没声明 capabilities.brief 时）：搜这一轮的话，取前几条拼成纯文本，每条后面括号写出处；
   * 没有出处的条目不进简报；一条都没有就回 undefined（这一轮不带简报）。
   */
  function fallbackBrief(items: readonly MemoryItem[]): string | undefined {
    const lines: string[] = [];
    let used = 0;
    for (const item of items) {
      if (item.sources.length === 0) continue;
      const source = item.sources.map((s) => `${s.kind} ${s.id}`).join("、"); // @i18n-ignore model：给模型看的简报里的分隔符
      const body = oneLine(item.text);
      const text = body.length > BRIEF_ITEM_CHARS ? `${body.slice(0, BRIEF_ITEM_CHARS)}…` : body;
      const line = `- ${text}（出处：${source}）`; // @i18n-ignore model：拼给模型看的简报（出处要能跳回原话）
      if (lines.length > 0 && used + line.length > briefMaxChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length === 0) return undefined;
    return `【记忆简报】\n${lines.join("\n")}`; // @i18n-ignore model：给模型看的简报标题（266 号票的简报也是这个标题）
  }

  return {
    activate: (id) => serial(() => activate(id)),
    deactivate: () => serial(stopRunning),
    active: () => running?.id,
    info: () => running?.info,
    dataDir: dataDirOf,
    observe: async (episode) => requireRunning().provider.observe(episode),
    remember: async (input) => requireRunning().provider.remember(input),
    search: async (query) => requireRunning().provider.search(query),
    forget: async (selector) => requireRunning().provider.forget(selector),
    health: async () => requireRunning().provider.health(),
    brief: async (context) => {
      const active = running;
      if (active === undefined) return undefined;
      if (active.info.capabilities.brief === true && active.provider.brief !== undefined) {
        const result = await active.provider.brief(context);
        if (result === undefined) return undefined;
        // 只回字符串的老实现：只有正文，没有键（不去重），也没有结构化那两样
        return typeof result === "string" ? { text: result, keys: {}, items: [], hits: [] } : { text: result.text, keys: result.keys ?? {}, items: result.items ?? [], hits: result.hits ?? [] };
      }
      const result = await active.provider.search({ text: context.text, limit: briefLimit });
      const text = fallbackBrief(result.items);
      return text === undefined ? undefined : { text, keys: {}, items: [], hits: [] };
    },
    consolidate: async (opts) => {
      const active = running;
      if (active === undefined) return undefined;
      if (active.info.capabilities.consolidate !== true || active.provider.consolidate === undefined) return undefined;
      return active.provider.consolidate(opts ?? {});
    },
    callTool: async (name, args) => {
      const active = requireRunning();
      if (active.provider.callTool === undefined) throw new RequestRejected("not_found", `记忆插件 ${active.id} 没有这个工具：${name}`); // @i18n-ignore log
      return active.provider.callTool(name, args);
    },
  };
}

/** 插件 id 得能当目录名用（挡住 ..、盘符、路径分隔符） */
function checkProviderId(id: string): string {
  if (!MEMORY_PROVIDER_ID.test(id)) {
    throw new RequestRejected("bad_params", `记忆插件的 id 只能用 ${MEMORY_PROVIDER_ID.source}（它会变成数据目录名），实际是 ${JSON.stringify(id)}`); // @i18n-ignore log
  }
  return id;
}

/** 接口版本对不上时给人看的一句话（宿主认哪个、插件写的是哪个） */
function versionText(id: string, actual: number): string {
  return `记忆插件 ${id} 的接口版本对不上，不能启用：宿主这个版本认 ${MEMORY_API_VERSION}，它写的是 ${actual}`; // @i18n-ignore log
}

/** 一段话压成一行（简报里每条一行） */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
