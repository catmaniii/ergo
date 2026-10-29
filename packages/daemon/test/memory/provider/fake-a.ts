// 假记忆插件「甲」（只在测试里，337 号票）：证明"能换一套"——不存真的记忆，只记下宿主调过什么、按 id 分开的数据目录可写。
// 甲声明了 brief 能力：宿主该用甲自己的简报，不回落去 search。
import fs from "node:fs";
import path from "node:path";
import type {
  MemoryBriefInput,
  MemoryBriefResult,
  MemoryConsolidateOptions,
  MemoryConsolidateResult,
  MemoryEpisode,
  MemoryForgetResult,
  MemoryForgetSelector,
  MemoryHealth,
  MemoryItem,
  MemoryObserveResult,
  MemoryProvider,
  MemoryProviderContext,
  MemoryProviderInfo,
  MemoryRememberInput,
  MemorySearchQuery,
  MemorySearchResult,
} from "@ergo/protocol";
import type { MemoryProviderFactory } from "../../../src/memory/provider/host.ts";

/** 甲登记给宿主的说法（id、名字、版本、接口版本） */
export const FAKE_A_INFO: MemoryProviderInfo = {
  api: 1,
  id: "fake-a",
  name: { zh: "假的甲", en: "Fake A" },
  version: "1.0.0",
  capabilities: { brief: true },
  requirements: {},
};

/** 甲：被调过什么全记下来，测试直接看字段 */
export class FakeProviderA implements MemoryProvider {
  /** 每次 start 给的上下文（同一个实例正常只有一次） */
  readonly starts: MemoryProviderContext[] = [];
  readonly searches: MemorySearchQuery[] = [];
  readonly remembered: MemoryRememberInput[] = [];
  readonly forgot: MemoryForgetSelector[] = [];
  readonly observed: MemoryEpisode[] = [];
  /** 每次简报问的是什么（这一轮的话、带过的键）：宿主原样转，不加工 */
  readonly briefs: MemoryBriefInput[] = [];
  readonly items: MemoryItem[] = [];
  stops = 0;
  /** brief 回来的一份（测试想摆键、结构化那两样时设它）；不设就只回一句正文（只回字符串的老实现） */
  briefResult?: MemoryBriefResult;
  /** start 就抛（验"没起来时不留半开的实例"） */
  private readonly failStart: boolean;

  constructor(failStart = false) {
    this.failStart = failStart;
  }

  info(): MemoryProviderInfo {
    return FAKE_A_INFO;
  }

  async start(ctx: MemoryProviderContext): Promise<void> {
    this.starts.push(ctx);
    if (this.failStart) throw new Error("假的甲起不来（测试摆的）");
    // 数据目录是宿主建好交给我的：往里面写个记号，证明按 id 分开、能写
    fs.writeFileSync(path.join(ctx.dataDir, "started.txt"), FAKE_A_INFO.id);
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }

  async observe(episode: MemoryEpisode): Promise<MemoryObserveResult> {
    this.observed.push(episode);
    return { status: "stored" };
  }

  async remember(input: MemoryRememberInput): Promise<MemoryItem> {
    this.remembered.push(input);
    const item: MemoryItem = {
      id: `a-${this.items.length + 1}`,
      kind: input.kind ?? "note",
      text: input.text,
      createdAt: "2026-10-28T09:00:00.000Z",
      sources: input.sources ?? [],
    };
    this.items.push(item);
    return item;
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchResult> {
    this.searches.push(query);
    return { items: [...this.items] };
  }

  async forget(selector: MemoryForgetSelector): Promise<MemoryForgetResult> {
    this.forgot.push(selector);
    return { removed: this.items.length };
  }

  async health(): Promise<MemoryHealth> {
    return { items: this.items.length, bytes: 12 };
  }

  async brief(context: MemoryBriefInput): Promise<MemoryBriefResult | string | undefined> {
    this.briefs.push(context);
    return this.briefResult ?? `甲的简报：${context.text}`;
  }

  async consolidate(_options: MemoryConsolidateOptions): Promise<MemoryConsolidateResult> {
    return { changed: 0 };
  }
}

/** 甲在清单里的那一条（测试从 instances 看宿主造了几个实例、用的是不是同一个） */
export function fakeA(options: { failStart?: boolean } = {}): { factory: MemoryProviderFactory; instances: FakeProviderA[] } {
  const instances: FakeProviderA[] = [];
  return {
    factory: {
      id: FAKE_A_INFO.id,
      name: FAKE_A_INFO.name,
      version: FAKE_A_INFO.version,
      api: FAKE_A_INFO.api,
      create: () => {
        const provider = new FakeProviderA(options.failStart === true);
        instances.push(provider);
        return provider;
      },
    },
    instances,
  };
}
