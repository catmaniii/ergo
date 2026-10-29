// 测试用的假数据源插件（295 号票，只在测试里）：照"数据源"贡献点在数据契约里登记两个数据源，不连任何真的服务——
// - fake（"假数据源"）：要填 Key 才算连着（Key 存进密钥区），"远端"是这里的 fakeRemote（测试往 next 里放几条，同步时拉回来），
//   两种用法都有（按需查给秘书一个工具"查假数据源"、导入每天 04:00 定期），用到健康、位置两类敏感内容，认导入文件夹里开头是 FAKE 的 .fake 文件；
// - fake-bills（"假账单"）：没有连接（只靠导入文件夹），认开头是"假账单"的 .csv，一行一条。
// 导入的记录写成插件自己的事件（频道 fake-source，类型 fake_record / fake_bill），经 ctx.materialSources.register 采成素材。
// 303 号票起用数据源的素材写法（dataSourceMaterial）：一条记录默认是"观察到的本人行为"，测试也能给"别人写给你的""本人写的"，
// 带场景（结束时间、地点、和谁、场景标签）和这条落在哪些敏感类别（不给是数据源登记的全部）。
// 主切面经 startTestDaemon 的 extraPlugins 接在插件清单后面，和真插件走同一条装配路径；假内核里经 startPluginKernel 装上。
import { defineHostTool } from "../../src/agent-manager/host-tools.ts";
import type { DataSource } from "../../src/data-sources/api.ts";
import { dataSourceMaterial } from "../../src/data-sources/material.ts";
import type { SensitiveCategory } from "../../src/config/config.ts";
import type { DataSourceMaterialKind } from "../../src/materials/types.ts";
import type { EventStore } from "../../src/events/event-store.ts";
import { PURGED_TEXT, type EventType, Type } from "@ergo/protocol";
import { type PluginDefinition, serviceKey } from "../../src/plugins/host.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { clockIso } from "../../src/scheduler/clock.ts";

export const FAKE_SOURCE_PLUGIN = "fake-source";
export const FAKE_SOURCE_PLUGIN_TITLE = "假数据源";
export const FAKE_SOURCE_ID = "fake";
export const FAKE_BILLS_ID = "fake-bills";
/** 插件自己的事件 */
export const FAKE_CHANNEL = "fake-source";
export const FAKE_RECORD = "fake_record";
export const FAKE_BILL = "fake_bill";
/** 按需查的工具名 */
export const FAKE_QUERY_TOOL = "query_fake_source";
/** 测试用的 Key（出错的原因里带着它时内核要换成 ***） */
export const FAKE_KEY = "fake-key-1234567890";

export interface FakeRecordPayload {
  id: string;
  text: string;
  at: string;
  /** 从哪来：同步拉的、导入的文件名 */
  from: string;
  /** 303：素材种类（不写是观察到的本人行为） */
  kind?: DataSourceMaterialKind;
  /** 303：场景——结束时间、地点、和谁、场景标签 */
  end?: string;
  place?: string;
  people?: string[];
  tags?: string[];
  /** 303：这条落在哪些敏感类别（不写是数据源登记的全部） */
  sensitive?: SensitiveCategory[];
  /** 303：别人写给你的正文（只进检索） */
  body?: string;
}

/** 测试往"远端"里放的一条：一句话，或者带种类、场景、敏感类别的一条（at 不给用现在） */
export type FakeRecordInput = string | (Omit<FakeRecordPayload, "id" | "from" | "at"> & { at?: string });

/** 假的"远端"：测试往 next 里放几条，下一次同步拉回来；fail 给了就抛这句（带着 Key 也照抛） */
export const fakeRemote = {
  next: [] as FakeRecordInput[],
  fail: undefined as string | undefined,
  /** 同步卡在这里，测试放行（测"正在同步"） */
  gate: undefined as Promise<void> | undefined,
  /** 叫过几次同步、各是什么触发的 */
  syncs: [] as Array<"manual" | "scheduled">,
  /** 断开时插件自己的清理收到的 purge */
  disconnects: [] as boolean[],
  /** 导入文件时抛这句 */
  importFail: undefined as string | undefined,
  /** 306：远端不认 Key 了——下一次同步、按需查回"Key 失效了"，插件记下（keyRefused） */
  refuseKey: false,
  /** 306：插件记下的"Key 失效了"（连接状态是出错；重新填 Key、出错后再试时远端又认了清掉） */
  keyRefused: false,
  /** 306：出错后内核替它再试了几次 */
  rechecks: 0,
};

export function resetFakeRemote(): void {
  fakeRemote.next = [];
  fakeRemote.fail = undefined;
  fakeRemote.gate = undefined;
  fakeRemote.syncs = [];
  fakeRemote.disconnects = [];
  fakeRemote.importFail = undefined;
  fakeRemote.refuseKey = false;
  fakeRemote.keyRefused = false;
  fakeRemote.rechecks = 0;
}

interface FakeService {
  write(type: string, items: readonly FakeRecordInput[], from: string): number;
  list(type: string): FakeRecordPayload[];
}

const FAKE = serviceKey<FakeService>("fake-source");

function fakeService(store: EventStore, now: () => string): FakeService {
  let n = store.read(FAKE_CHANNEL).length;
  return {
    write(type, items, from) {
      for (const item of items) {
        n += 1;
        const record = typeof item === "string" ? { text: item } : item;
        store.append({ channel: FAKE_CHANNEL, type, payload: { ...record, id: `${type}-${n}`, at: record.at ?? now(), from } satisfies FakeRecordPayload });
      }
      return items.length;
    },
    list: (type) => store.read(FAKE_CHANNEL, 0, type).map((e) => e.payload as FakeRecordPayload),
  };
}

/** 假数据源插件 */
export const fakeDataSourcePlugin: PluginDefinition = {
  name: FAKE_SOURCE_PLUGIN,
  title: FAKE_SOURCE_PLUGIN_TITLE,
  summary: "测试用的数据源",
  needs: [KERNEL.store, KERNEL.clock],
  provides: [FAKE],
  contracts(ctx) {
    const fake: DataSource = {
      id: FAKE_SOURCE_ID,
      title: "假数据源",
      summary: "测试用：每次同步拉回几条假记录",
      sensitive: ["health", "location"],
      usages: { query: { default: true }, import: { default: true, schedule: { kind: "daily", time: "04:00" } } },
      records: [{ channel: FAKE_CHANNEL, type: FAKE_RECORD }],
      files: [
        {
          title: "假记录文件（.fake）",
          extensions: [".fake"],
          sniff: (head) => head.toString("utf8").startsWith("FAKE"),
          async import(file) {
            if (fakeRemote.importFail) throw new Error(fakeRemote.importFail);
            const { readFile } = await import("node:fs/promises");
            const lines = (await readFile(file.path, "utf8")).split(/\r?\n/).slice(1).filter(Boolean);
            return { added: ctx.active(FAKE).write(FAKE_RECORD, lines, file.name) };
          },
        },
      ],
      status: (c) => {
        if (!c.secrets.has("key")) return { connection: "not_connected" };
        return fakeRemote.keyRefused ? { connection: "error", problem: "Key 失效了", account: "fake-user" } : { connection: "connected", account: "fake-user" };
      },
      async configure(values, c) {
        const key = values.key?.trim() ?? "";
        if (key === "" || key === "bad") return { connection: "error", problem: "Key 不对" };
        c.secrets.set("key", key);
        fakeRemote.keyRefused = false;
        return { connection: "connected", account: "fake-user" };
      },
      async sync(c) {
        fakeRemote.syncs.push(c.trigger);
        if (fakeRemote.gate) await fakeRemote.gate;
        if (fakeRemote.refuseKey) {
          fakeRemote.keyRefused = true;
          throw new Error("Key 失效了");
        }
        if (fakeRemote.fail) throw new Error(fakeRemote.fail);
        const texts = fakeRemote.next.splice(0);
        return { added: ctx.active(FAKE).write(FAKE_RECORD, texts, "sync") };
      },
      disconnect(c) {
        fakeRemote.disconnects.push(c.purge);
      },
      // 306：出错后内核每小时叫一次——远端又认 Key 了就清掉"Key 失效了"
      recheck() {
        fakeRemote.rechecks += 1;
        if (!fakeRemote.refuseKey) fakeRemote.keyRefused = false;
        return Promise.resolve();
      },
      tools: () => [
        defineHostTool({
          name: FAKE_QUERY_TOOL,
          title: "查假数据源",
          description: "查假数据源里的记录",
          parameters: Type.Object({}),
          readOnlyOrIdempotent: true,
          nature: "look",
          run: () => {
            if (fakeRemote.refuseKey) {
              fakeRemote.keyRefused = true;
              return { text: "Key 失效了", isError: true };
            }
            return { text: ctx.active(FAKE).list(FAKE_RECORD).map((r) => r.text).join("\n") || "没有记录" };
          },
        }),
      ],
    };
    const bills: DataSource = {
      id: FAKE_BILLS_ID,
      title: "假账单",
      summary: "测试用：放进导入文件夹的假账单，一行一条",
      sensitive: ["finance"],
      usages: { import: { default: true } },
      records: [{ channel: FAKE_CHANNEL, type: FAKE_BILL }],
      files: [
        {
          title: "假账单（.csv）",
          extensions: [".csv"],
          sniff: (head) => head.toString("utf8").startsWith("假账单"),
          async import(file) {
            const { readFile } = await import("node:fs/promises");
            const lines = (await readFile(file.path, "utf8")).split(/\r?\n/).slice(1).filter(Boolean);
            return { added: ctx.active(FAKE).write(FAKE_BILL, lines, file.name) };
          },
        },
      ],
    };
    ctx.dataSources.register(fake);
    ctx.dataSources.register(bills);
    // 导入的记录采成素材（ADR-0006，303 号票的写法）；彻底删除时只换原话
    for (const [type, source] of [
      [FAKE_RECORD, fake],
      [FAKE_BILL, bills],
    ] as const) {
      ctx.materialSources.register({
        name: `fake-source-${type}`,
        eventType: type as EventType,
        capture: (event) => {
          const p = event.payload as FakeRecordPayload;
          return [
            dataSourceMaterial(source, {
              kind: p.kind ?? "observed_behavior",
              text: p.text,
              time: p.at,
              scene: { ...(p.end === undefined ? {} : { end: p.end }), ...(p.place === undefined ? {} : { place: p.place }), ...(p.people === undefined ? {} : { people: p.people }), ...(p.tags === undefined ? {} : { tags: p.tags }) },
              ...(p.sensitive === undefined ? {} : { sensitive: p.sensitive }),
              ...(p.body === undefined ? {} : { indexText: p.body }),
              recordId: p.id,
            }),
          ];
        },
      });
      // 原话、地点、和谁、正文都是用户的数据，一起换掉
      ctx.purge.register({
        eventType: type,
        rewrite: (event) => {
          const { id, at, from, kind } = event.payload as FakeRecordPayload;
          return { id, at, from, ...(kind === undefined ? {} : { kind }), text: PURGED_TEXT } satisfies FakeRecordPayload;
        },
      });
    }
  },
  setup(ctx) {
    const store = ctx.use(KERNEL.store);
    const clock = ctx.use(KERNEL.clock);
    ctx.provide(FAKE, fakeService(store, () => clockIso(clock)));
  },
};
