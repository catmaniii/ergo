// 一台电脑上可以配置多份二狗（多实例，468）：一份 = 一个数据文件夹，各份互相隔开。
// - 默认那份：~/.ergo（ERGO_DATA_DIR 换过位置的也算默认那份），服务管家里的登记 id 是 ergo-daemon；
// - 别的各份：ergo init 在一个空文件夹里建的，文件夹根部有实例标记文件 ergo-instance.json（format、名字、登记 id），
//   文件夹本身就是这一份的数据目录，登记 id 是 ergo-<名字>。
// 认哪一份（每条 ergo 命令都按这个顺序）：--dir > ERGO_DATA_DIR > 当前目录或它的上级目录里有标记文件的那一份 > ~/.ergo。
// 认出来的数据文件夹里有标记文件就是那一份（登记 id 照标记），没有就是默认那份（ergo-daemon）。
// 服务管家里登记的各份（ergo list、update 重起各份、守卫认"其他各份"）从它的注册表读：只认 ergo-daemon 和 env 里写着 ERGO_SERVICE_ID 的登记。
// 守护进程没有 YAML 库（只有服务管家有），这里和 lsm/registered.ts 一样只认手写和 ergo 写出来的那种简单 YAML。
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DEFAULT_PORTS } from "../config/config.ts";
import { DATA_DIR_ENV, resolveDataDir } from "../config/data-dir.ts";

/** 默认那份二狗在服务管家里登记的 id */
export const DEFAULT_SERVICE_ID = "ergo-daemon";
/** 实例标记文件（放在实例文件夹根部） */
export const INSTANCE_MARKER = "ergo-instance.json";
/** 登记里写给守护进程的变量：它是哪个登记 id（体检、守卫、服务管家工具都按它认"自己"） */
export const SERVICE_ID_ENV = "ERGO_SERVICE_ID";
/** 实例名字：小写字母、数字、连字符（不以连字符开头结尾、不连写两个：服务管家用 "--" 分名下的服务） */
export const INSTANCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 名字最长多少（登记 id 是 ergo-<名字>，名下服务的 id 还要再接 --<名字>） */
export const INSTANCE_NAME_MAX = 32;
/** 新的一份自动挑端口：从这里起、每次加这么多（本机端口用它，外网端口是它 +1） */
export const INSTANCE_PORT_BASE = 8820;
export const INSTANCE_PORT_STEP = 10;
/** 最多试多少组 */
export const INSTANCE_PORT_TRIES = 100;

/** 实例标记文件的内容 */
export interface InstanceMarker {
  format: 1;
  name: string;
  serviceId: string;
}

/** 标记文件在、却读不了或者内容不对：命令不往下做（认错了一份会去停、改别的那份） */
export class InstanceMarkerError extends Error {
  readonly file: string;
  readonly reason: string;
  constructor(file: string, reason: string) {
    super(`${file}: ${reason}`);
    this.file = file;
    this.reason = reason;
  }
}

/** 名字的登记 id */
export function serviceIdOf(name: string): string {
  return `ergo-${name}`;
}

/** 名字哪里不合规；合规是 undefined */
export function nameProblem(name: string): "empty" | "chars" | "long" | "reserved" | undefined {
  if (name === "") return "empty";
  if (name.length > INSTANCE_NAME_MAX) return "long";
  if (!INSTANCE_NAME.test(name)) return "chars";
  // ergo-daemon 是默认那份的
  if (serviceIdOf(name) === DEFAULT_SERVICE_ID) return "reserved";
  return undefined;
}

/** 读一个文件夹的标记文件：没有是 undefined，在却不对抛 InstanceMarkerError */
export function readMarker(dir: string): InstanceMarker | undefined {
  const file = path.join(dir, INSTANCE_MARKER);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw new InstanceMarkerError(file, (err as Error).message);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (err) {
    throw new InstanceMarkerError(file, (err as Error).message);
  }
  const m = raw as Partial<InstanceMarker> | null;
  if (typeof m !== "object" || m === null || m.format !== 1) throw new InstanceMarkerError(file, "format");
  if (typeof m.name !== "string" || nameProblem(m.name) !== undefined) throw new InstanceMarkerError(file, "name");
  if (m.serviceId !== serviceIdOf(m.name)) throw new InstanceMarkerError(file, "serviceId");
  return { format: 1, name: m.name, serviceId: m.serviceId };
}

export function writeMarker(dir: string, name: string): InstanceMarker {
  const marker: InstanceMarker = { format: 1, name, serviceId: serviceIdOf(name) };
  fs.writeFileSync(path.join(dir, INSTANCE_MARKER), `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx" });
  return marker;
}

/** 从 dir 往上找有标记文件的文件夹（dir 自己算）；没有是 undefined */
export function findMarkerDir(dir: string): string | undefined {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, INSTANCE_MARKER))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** 这条命令管的是哪一份 */
export interface ResolvedInstance {
  /** 数据目录（绝对路径） */
  dataDir: string;
  /** 服务管家里的登记 id */
  serviceId: string;
  /** 名字（默认那份没有） */
  name?: string;
  /** 怎么认出来的 */
  source: "dir" | "env" | "marker" | "default";
}

/**
 * 认哪一份：--dir > ERGO_DATA_DIR > 当前目录或上级目录里有标记文件的 > ~/.ergo。认出来的文件夹有标记文件就是那一份，没有就是默认那份。
 * 标记文件在却不对抛 InstanceMarkerError
 */
export function resolveInstance(options: { dir?: string; env: Readonly<Record<string, string | undefined>>; cwd: string; homeDir: string }): ResolvedInstance {
  const { dir, env, cwd, homeDir } = options;
  let dataDir: string;
  let source: ResolvedInstance["source"];
  if (dir !== undefined && dir.trim() !== "") {
    dataDir = path.resolve(cwd, dir.trim());
    source = "dir";
  } else if (env[DATA_DIR_ENV]?.trim()) {
    dataDir = resolveDataDir(env, homeDir);
    source = "env";
  } else {
    const found = findMarkerDir(cwd);
    dataDir = found ?? resolveDataDir({}, homeDir);
    source = found === undefined ? "default" : "marker";
  }
  const marker = readMarker(dataDir);
  return marker === undefined ? { dataDir, serviceId: DEFAULT_SERVICE_ID, source } : { dataDir, serviceId: marker.serviceId, name: marker.name, source };
}

// ───────────────────────── 服务管家里登记的各份 ─────────────────────────

/** 服务管家里登记的一份二狗 */
export interface RegisteredInstance {
  /** 登记 id（默认那份是 ergo-daemon） */
  id: string;
  /** 数据目录（登记的 env 里 ERGO_DATA_DIR 的值；默认那份没写时是 undefined，调用方按 ~/.ergo 算） */
  dataDir?: string;
  /** 登记的探活端口（就是它的本机端口） */
  probePort?: number;
  /** 登记文件 */
  file: string;
}

/** YAML 里一个标量的值（单引号、双引号、不带引号的；不带引号的去掉行尾注释） */
export function yamlScalar(raw: string): string {
  const s = raw.trim();
  if (s.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'/.exec(s);
    return m ? m[1]!.replaceAll("''", "'") : s;
  }
  if (s.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(s);
    if (!m) return s;
    try {
      return JSON.parse(`"${m[1]!.replace(/\\(?!["\\/bfnrtu])/g, "\\\\")}"`) as string;
    } catch {
      return m[1]!;
    }
  }
  return s.replace(/\s+#.*$/, "").trim();
}

/** 登记的 env 里写成 literal 的各项：名字 → 值（块写法、一行写完的 { … } 都认；别的写法认不出就没有） */
export function literalEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^env:(\s|$)/.test(line));
  if (start < 0) return out;
  let end = start + 1;
  while (end < lines.length && (lines[end]!.trim() === "" || /^(\s|#|-(\s|$))/.test(lines[end]!))) end++;
  const body = [lines[start]!.slice("env:".length), ...lines.slice(start + 1, end)].join("\n");
  // 一项一项切开：块写法按 "- " 开头，一行写完的按 { … }
  const items: string[] = [];
  for (const flow of body.matchAll(/\{([^{}]*)\}/g)) items.push(flow[1]!.split(/,(?=\s*[A-Za-z_]+\s*:)/).join("\n"));
  const block = body.replace(/\{[^{}]*\}/g, "").split(/^[ \t]*-(?:[ \t]+|$)/m);
  items.push(...block);
  for (const item of items) {
    const field = (key: string) => {
      const m = new RegExp(`(?:^|\\n)\\s*${key}:\\s*(.*)`).exec(item);
      return m ? yamlScalar(m[1]!) : undefined;
    };
    const name = field("name");
    const from = field("from");
    const value = field("value");
    if (name && from === "literal" && value !== undefined) out.set(name, value);
  }
  return out;
}

/** 顶层的一个键的值（id: x） */
function topValue(text: string, key: string): string | undefined {
  const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(text);
  return m ? yamlScalar(m[1]!) : undefined;
}

/** probe 段里的 port */
function probePort(text: string): number | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^probe:\s*(?:#.*)?$/.test(line));
  if (start < 0) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^\s+port:\s*['"]?(\d+)/.exec(line);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** 一个登记文件是不是一份二狗：ergo-daemon，或者 env 里 ERGO_SERVICE_ID 写的就是它自己的 id */
export function instanceOfEntry(text: string, file: string): RegisteredInstance | undefined {
  const id = topValue(text, "id");
  if (!id) return undefined;
  const env = literalEnv(text);
  if (id !== DEFAULT_SERVICE_ID && env.get(SERVICE_ID_ENV) !== id) return undefined;
  const dataDir = env.get(DATA_DIR_ENV);
  const port = probePort(text);
  return { id, ...(dataDir ? { dataDir: path.resolve(dataDir) } : {}), ...(port !== undefined ? { probePort: port } : {}), file };
}

/** 服务管家里登记的各份二狗（注册表顶层的 registry/services/*.yaml；读不了、看不懂的文件跳过） */
export function registeredInstances(svcDataDir: string): RegisteredInstance[] {
  const dir = path.join(svcDataDir, "registry", "services");
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".yaml"));
  } catch {
    return [];
  }
  const out: RegisteredInstance[] = [];
  for (const name of names.toSorted()) {
    const file = path.join(dir, name);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const found = instanceOfEntry(text, file);
    if (found && !out.some((x) => x.id === found.id)) out.push(found);
  }
  return out;
}

/** 注册表里登记过的全部端口（顶层的、名下的，probe 段里的 port） */
export function registeredPorts(svcDataDir: string): number[] {
  const services = path.join(svcDataDir, "registry", "services");
  const files: string[] = [];
  const collect = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 2) collect(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".yaml")) files.push(full);
    }
  };
  collect(services, 0);
  const ports = new Set<number>();
  for (const file of files) {
    try {
      const port = probePort(fs.readFileSync(file, "utf8"));
      if (port !== undefined) ports.add(port);
    } catch {
      // 读不了的跳过
    }
  }
  return [...ports];
}

/** 一个端口号（不是就是 undefined） */
const validPort = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 65536 ? v : undefined);

/** 一份二狗的两个端口（它数据目录的 config/ergo.json；没写的按默认的 8810 / 8811） */
export function instancePorts(dataDir: string): { local: number; external: number } {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "config", "ergo.json"), "utf8").replace(/^\uFEFF/, "")) as { ports?: { local?: unknown; external?: unknown } };
    return { local: validPort(raw.ports?.local) ?? DEFAULT_PORTS.local, external: validPort(raw.ports?.external) ?? DEFAULT_PORTS.external };
  } catch {
    return { ...DEFAULT_PORTS };
  }
}

/** 服务管家的日志目录里属于这个登记的文件（<id>.out.log 和切下来的、它名下的服务的 <id>--*） */
export function instanceLogFiles(svcDataDir: string, id: string): string[] {
  const dir = path.join(svcDataDir, "logs");
  const lower = id.toLowerCase();
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => {
        const n = name.toLowerCase();
        return n.startsWith(`${lower}.`) || n.startsWith(`${lower}--`);
      })
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

// ───────────────────────── 挑端口 ─────────────────────────

/** 此刻有人在用这个端口：本机连得上，或者在本机绑不上（被占、被系统保留） */
export async function portBusy(port: number): Promise<boolean> {
  const connected = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
  if (connected) return true;
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(false)));
  });
}

/**
 * 给新的一份挑一组端口：本机 base、外网 base+1，从 INSTANCE_PORT_BASE 起每次加 INSTANCE_PORT_STEP；
 * 跳过 taken 里的（服务管家登记里已占的、别的各份配置里的）和此刻有人在用的。都不行是 undefined
 */
export async function pickPorts(taken: ReadonlySet<number>, busy: (port: number) => Promise<boolean> = portBusy): Promise<{ local: number; external: number } | undefined> {
  for (let i = 0; i < INSTANCE_PORT_TRIES; i++) {
    const local = INSTANCE_PORT_BASE + i * INSTANCE_PORT_STEP;
    const external = local + 1;
    if (taken.has(local) || taken.has(external)) continue;
    if ((await busy(local)) || (await busy(external))) continue;
    return { local, external };
  }
  return undefined;
}

/** 守护进程自己是哪个登记：登记的 env 里写的 ERGO_SERVICE_ID，没有看服务管家注入的 LSM_SERVICE_ID，都没有是默认那份 */
export function ownServiceId(env: Readonly<Record<string, string | undefined>>): string {
  return env[SERVICE_ID_ENV]?.trim() || env.LSM_SERVICE_ID?.trim() || DEFAULT_SERVICE_ID;
}
