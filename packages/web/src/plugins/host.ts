// @i18n-ignore-file log：清单写错、登记出错、装配和撤销出错都是给开发者看的（控制台、测试），不给用户看
// 网页插件宿主（193 号票，ADR-0027 的网页插槽）：网页里装网页插件的那部分。照守护进程的插件宿主（packages/daemon/src/plugins/host.ts），
// 借 Cordis 的规矩、不引入 Cordis（调研 19 §3.7、§8.4）：
// 1. 插件经宿主给的 ctx 往类型化插槽里登记（plugins/slots.ts：页面和路由、主导航里的页签（212 号票）、设置分节、对话条目、详情、卡片、看板条目、日历），
//    每次登记都返回撤销函数、记在这个插件名下；停用时倒着撤（单个撤销出错只记日志、不拦着别的），停了以后再经它登记直接报错。
// 2. 插件之间不互相 import：插件只 import 网页核心的公开接口（plugins/api.ts 和核心的模块），核心不 import 插件，
//    插件清单只在 plugins/manifest.ts 一处列（由组合根 App.tsx 引；test/plugins/boundary.test.ts 扫 import 检查）。
// 3. 按守护进程报的状况装和停（apply）：插件频道上的 plugin_status 说这个插件在运行就装，停用了、没装上、守护进程清单里没有就停；
//    还没收到（原型、旧的守护进程）当作全开——默认全开时界面和搬过来之前一样。
// 另外一样，数据契约（owns）：插件在定义里写明它拥有哪些位置（哪页、哪种卡、哪种对话条目……），不管开没开都认得；
// 停用的插件拥有的位置，核心显示一行"（X插件没启用，这条内容暂时看不到）"（unavailable），不报错、不崩。
// 装配时登记的和 owns 写的要一一对上（登记了不归它的、拥有的没登记都算装配出错：这个插件不装，页面照常）。
// 没有 React：React 那一半（Provider、钩子）在 react.tsx；只在 Node 里跑的测试也能直接用它。
import type { Connection } from "../app/connection.ts";
import type { DaemonHttp } from "../app/daemon-http.ts";
import type { PluginStatusView } from "../state/index.ts";
import { SLOT_KEYS, SLOT_NAMES, type SlotMap, type SlotName } from "./slots.ts";

/** 撤销函数 */
export type Undo = () => void;

/** 插件拥有的位置：每个插槽里的键 */
export type WebPluginOwns = { readonly [K in SlotName]?: readonly string[] };

/**
 * 页面的连接和 HTTP（212 号票：浏览插件开场要接上 App 推过来的、报这台设备上的浏览器）：组合根（App.tsx）建宿主时交来；
 * 只在 Node 里跑的测试里没给
 */
export interface WebPluginPage {
  readonly connection: Connection;
  readonly http: DaemonHttp;
  /** 这一页是侧边栏模式（?ergo=side，147 号票）：整页只画侧边栏 */
  readonly sideMode: boolean;
}

/** 插件装配时拿到的 */
export interface WebPluginContext {
  /** 页面的连接和 HTTP（212 号票）；没给（测试）是 undefined */
  readonly page: WebPluginPage | undefined;
  /** 往插槽里放一条（键见 slots.ts 的 SLOT_KEYS）：返回撤销函数，也记在插件名下，停用时倒着撤 */
  register<K extends SlotName>(slot: K, entry: SlotMap[K]): Undo;
  /** 定时器、订阅这类：执行它、记下它交回的撤销函数 */
  effect(execute: () => Undo): void;
}

/** 一个网页插件 */
export interface WebPluginDefinition {
  /** 和守护进程的插件名一样（守护进程报的状况按它对上；配置 plugins.disabled 里写的就是它） */
  readonly name: string;
  /** 给人看的名字（"记忆"）：取值函数，跟着语言；占位那句里写它 */
  readonly title: string;
  /** 数据契约：它拥有的位置（不管开没开都认得，停用时这些位置显示占位） */
  readonly owns: WebPluginOwns;
  /**
   * 设置 · 插件里列的"网页上的页面、栏目"（211 号票，给人看的；守护进程那一半——工具、卡片、定时作业——由守护进程写）。
   * 取值函数，跟着语言
   */
  readonly brings?: readonly string[];
  /** 装配：经 ctx 登记 */
  setup(ctx: WebPluginContext): void;
}

export interface WebPluginHostOptions {
  /** 插件清单 */
  plugins: readonly WebPluginDefinition[];
  /** 页面的连接和 HTTP，交给插件（212 号票）；不给（测试）插件拿到 undefined */
  page?: WebPluginPage;
  /** 装配出错、撤销出错写到哪（默认 console.warn） */
  log?: (line: string) => void;
}

export interface WebPluginHost {
  /** 清单里的插件 */
  readonly plugins: readonly WebPluginDefinition[];
  /** 这个插件现在装着没有 */
  running(name: string): boolean;
  /** 按守护进程报的状况装和停：在运行的装，别的停；undefined（还没收到）当作全开 */
  apply(report: readonly PluginStatusView[] | undefined): void;
  enable(name: string): void;
  disable(name: string): void;
  /** 插槽里这个键现在登记着的；没有（没人登记、插件停了）是 undefined */
  get<K extends SlotName>(slot: K, key: string): SlotMap[K] | undefined;
  /** 插槽里现在登记着的全部：有 order 的按它排，同样的按登记的先后 */
  list<K extends SlotName>(slot: K): readonly SlotMap[K][];
  /** 谁拥有这个位置（不管开没开） */
  ownerOf(slot: SlotName, key: string): WebPluginDefinition | undefined;
  /** 这个位置属于一个没在用的插件：它给人看的名字（占位那句里写）；在用的、不归谁的是 undefined */
  unavailable(slot: SlotName, key: string): string | undefined;
  /** 有变化（装、停）时叫 fn；返回取消订阅的函数 */
  subscribe(fn: () => void): Undo;
  /** 每有一次变化加一（useSyncExternalStore 的快照） */
  version(): number;
}

interface Registration {
  slot: SlotName;
  key: string;
  entry: unknown;
  plugin: string;
  /** 登记的先后（同样的 order 按它排） */
  no: number;
}

interface Slot {
  def: WebPluginDefinition;
  running: boolean;
  /** 这一次装配的：活着的时候才能经它登记 */
  alive: { value: boolean } | undefined;
  undos: Array<{ label: string; undo: Undo }>;
}

/** 插槽里一个键的记号 */
const ownerKey = (slot: SlotName, key: string) => `${slot}\u0000${key}`;

/** 有 order 的按它排，没有的当 0 */
const order = (r: Registration) => {
  const entry = r.entry as { order?: number };
  return typeof entry.order === "number" ? entry.order : 0;
};

export function createWebPluginHost(options: WebPluginHostOptions): WebPluginHost {
  const log = options.log ?? ((line: string) => console.warn(line));
  const slots = new Map<string, Slot>();
  const owners = new Map<string, WebPluginDefinition>();
  for (const def of options.plugins) {
    if (slots.has(def.name)) throw new Error(`网页插件清单里有两个 ${def.name}`);
    slots.set(def.name, { def, running: false, alive: undefined, undos: [] });
    for (const slot of SLOT_NAMES) {
      for (const key of def.owns[slot] ?? []) {
        const other = owners.get(ownerKey(slot, key));
        if (other) throw new Error(`${slot}「${key}」有两个插件拥有：${other.name}、${def.name}`);
        owners.set(ownerKey(slot, key), def);
      }
    }
  }

  const registered = new Map<string, Registration>();
  let registrations = 0;
  let version = 0;
  const listeners = new Set<() => void>();
  const changed = () => {
    version += 1;
    for (const fn of listeners) fn();
  };

  const undoAll = (slot: Slot) => {
    if (slot.alive) slot.alive.value = false;
    slot.alive = undefined;
    for (const { label, undo } of slot.undos.splice(0).toReversed()) {
      try {
        undo();
      } catch (err) {
        log(`网页插件 ${slot.def.name} 撤销 ${label} 出错：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  /** 装配一个插件；出错撤掉已经登记的、算没装上。装上了交回 true */
  const setup = (slot: Slot): boolean => {
    const { def } = slot;
    const alive = { value: true };
    slot.alive = alive;
    const mine = new Set<string>();
    const ctx = {
      page: options.page,
      register<K extends SlotName>(name: K, entry: SlotMap[K]): Undo {
        if (!alive.value) throw new Error(`插件 ${def.name} 已经停了，不能再登记 ${name}`);
        const key = SLOT_KEYS[name](entry);
        const owned: readonly string[] = def.owns[name] ?? [];
        if (!owned.includes(key)) throw new Error(`登记了不归它的 ${name}「${key}」（它拥有的写在定义的 owns 里）`);
        const id = ownerKey(name, key);
        if (registered.has(id)) throw new Error(`${name}「${key}」已经登记过了`);
        registered.set(id, { slot: name, key, entry, plugin: def.name, no: registrations++ });
        mine.add(id);
        let done = false;
        const undo = () => {
          if (done) return;
          done = true;
          if (registered.get(id)?.plugin === def.name) registered.delete(id);
        };
        slot.undos.push({ label: `${name}「${key}」`, undo });
        return undo;
      },
      effect(execute: () => Undo): void {
        if (!alive.value) throw new Error(`插件 ${def.name} 已经停了，不能再登记 effect`);
        slot.undos.push({ label: "effect", undo: execute() });
      },
    } satisfies WebPluginContext;
    try {
      def.setup(ctx);
      for (const name of SLOT_NAMES) {
        const missing = (def.owns[name] ?? []).find((key) => !mine.has(ownerKey(name, key)));
        if (missing !== undefined) throw new Error(`拥有的 ${name}「${missing}」没有登记`);
      }
      return true;
    } catch (err) {
      undoAll(slot);
      log(`网页插件 ${def.name} 装配出错：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  /** 装上（没装着的）；交回有没有变化 */
  const turnOn = (slot: Slot): boolean => {
    if (slot.running) return false;
    slot.running = setup(slot);
    return slot.running;
  };
  /** 停（装着的）；交回有没有变化 */
  const turnOff = (slot: Slot): boolean => {
    if (!slot.running) return false;
    slot.running = false;
    undoAll(slot);
    return true;
  };

  // 一建好就按全开装上（还没收到守护进程报的状况）
  for (const slot of slots.values()) turnOn(slot);

  const byName = (name: string) => slots.get(name);

  return {
    plugins: options.plugins,
    running: (name) => byName(name)?.running === true,
    apply(report) {
      let any = false;
      for (const slot of slots.values()) {
        const on = report === undefined || report.find((p) => p.name === slot.def.name)?.state === "running";
        any = (on ? turnOn(slot) : turnOff(slot)) || any;
      }
      if (any) changed();
    },
    enable(name) {
      const slot = byName(name);
      if (slot && turnOn(slot)) changed();
    },
    disable(name) {
      const slot = byName(name);
      if (slot && turnOff(slot)) changed();
    },
    get<K extends SlotName>(slot: K, key: string) {
      return registered.get(ownerKey(slot, key))?.entry as SlotMap[K] | undefined;
    },
    list<K extends SlotName>(slot: K) {
      return [...registered.values()]
        .filter((r) => r.slot === slot)
        .toSorted((a, b) => order(a) - order(b) || a.no - b.no)
        .map((r) => r.entry as SlotMap[K]);
    },
    ownerOf: (slot, key) => owners.get(ownerKey(slot, key)),
    unavailable(slot, key) {
      const owner = owners.get(ownerKey(slot, key));
      return owner && !byName(owner.name)?.running ? owner.title : undefined;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    version: () => version,
  };
}
