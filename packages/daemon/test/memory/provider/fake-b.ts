// 假记忆插件「乙」（只在测试里，337 号票）：第二套，证明宿主能换、切换后调用走新的那套。
// 乙**没有** brief 能力：宿主该回落去 search 拼一段简报。api 能写成别的值，用来验"版本对不上不启用"。
import fs from "node:fs";
import path from "node:path";
import type {
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

/** 乙登记给宿主的说法；api 正常是 1，验版本时写 2 */
export function fakeBInfo(api: number): MemoryProviderInfo {
  return { api, id: "fake-b", name: { zh: "假的乙", en: "Fake B" }, version: "1.0.0", capabilities: {}, requirements: {} };
}

/** 乙：search 回 result 里放着的条目（测试按需摆），别的只记下被调过 */
export class FakeProviderB implements MemoryProvider {
  readonly starts: MemoryProviderContext[] = [];
  readonly searches: MemorySearchQuery[] = [];
  readonly remembered: MemoryRememberInput[] = [];
  readonly forgot: MemoryForgetSelector[] = [];
  readonly observed: MemoryEpisode[] = [];
  /** search 要回什么（测试摆条目，比如带出处的、没出处的） */
  result: MemoryItem[] = [];
  stops = 0;
  /** start 时往自己的数据目录写的记号（证明目录按 id 分开） */
  readonly marker: string;
  private readonly api: number;

  constructor(api: number) {
    this.api = api;
    this.marker = "fake-b";
  }

  info(): MemoryProviderInfo {
    return fakeBInfo(this.api);
  }

  async start(ctx: MemoryProviderContext): Promise<void> {
    this.starts.push(ctx);
    fs.writeFileSync(path.join(ctx.dataDir, "started.txt"), this.marker);
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }

  async observe(episode: MemoryEpisode): Promise<MemoryObserveResult> {
    this.observed.push(episode);
    return { status: "skipped" };
  }

  async remember(input: MemoryRememberInput): Promise<MemoryItem> {
    this.remembered.push(input);
    return { id: "b-1", kind: input.kind ?? "note", text: input.text, createdAt: "2026-10-28T09:00:00.000Z", sources: input.sources ?? [] };
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchResult> {
    this.searches.push(query);
    return { items: [...this.result] };
  }

  async forget(selector: MemoryForgetSelector): Promise<MemoryForgetResult> {
    this.forgot.push(selector);
    return { removed: 0 };
  }

  async health(): Promise<MemoryHealth> {
    return { items: this.result.length };
  }
}

/** 乙在清单里的那一条；api 可以写成别的（版本对不上的那个测试用） */
export function fakeB(options: { api?: number } = {}): { factory: MemoryProviderFactory; instances: FakeProviderB[] } {
  const api = options.api ?? 1;
  const instances: FakeProviderB[] = [];
  return {
    factory: {
      id: "fake-b",
      name: { zh: "假的乙", en: "Fake B" },
      version: "1.0.0",
      api,
      create: () => {
        const provider = new FakeProviderB(api);
        instances.push(provider);
        return provider;
      },
    },
    instances,
  };
}
