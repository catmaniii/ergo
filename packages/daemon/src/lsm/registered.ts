// 服务管家里登记在某个端口上的服务（413）：读它数据目录里的注册表文件（registry/services/*.yaml，加上名下的
// registry/services/owned/<登记方>/*.yaml），不连服务管家。端口是服务管家认服务的身份（service-schema.md 的 probe.port），
// 所以按探活端口找：组件页装的语音合成是 ergo-daemon--audiocpp（名下的），手工登记的是用户自己起的 id（顶层文件）。
// 体检用它判"语音回复开着没有"（服务停着时组件页认不出手工登记的那条）、在修法里写出该开哪一条。
// 只认得手写和服务管家写出来的那种简单 YAML：顶层的 id、name，probe 段里的 port；读不了、看不懂的文件跳过，不抛错。
import fs from "node:fs";
import path from "node:path";

/** 服务管家里的一条服务（体检的修法里写它） */
export interface RegisteredService {
  /** 注册表里的 id（名下的是"登记方--名字"） */
  id: string;
  /** 给人看的名字（没写是 undefined） */
  name?: string;
}

/** 名下服务的 id：登记方--文件名（和 packages/supervisor/src/registry.mjs 的 ownedIdOf 一样） */
const ownedIdOf = (owner: string, base: string) => `${owner}--${base}`;

/** 一个目录下的 .yaml 文件（读不了是空的） */
function yamlFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".yaml"))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/** 名下的服务那几个目录（services/owned/<登记方>/） */
function ownerDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** YAML 标量去掉引号（单引号里两个单引号是一个） */
function scalar(raw: string): string {
  const value = raw.replace(/\s+#.*$/, "").trim();
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) return value.slice(1, -1);
  return value;
}

/** 一份注册表文件里顶层的 id、name 和 probe 段的 port；没写、看不懂的那一样没有 */
export function parseRegistryEntry(text: string): { id?: string; name?: string; port?: number } {
  const out: { id?: string; name?: string; port?: number } = {};
  let inProbe = false;
  /** probe 段里直接那一层的缩进（第一行定）；health 下面更深的那层不算 */
  let probeIndent: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const top = /^([A-Za-z][\w-]*):(.*)$/.exec(line);
    if (top) {
      const [, key, rest] = top;
      inProbe = key === "probe";
      probeIndent = undefined;
      if (key === "id" && rest!.trim() !== "") out.id = scalar(rest!);
      if (key === "name" && rest!.trim() !== "") out.name = scalar(rest!);
      continue;
    }
    if (!inProbe) continue;
    const indent = /^ */.exec(line)![0].length;
    probeIndent ??= indent;
    const port = indent === probeIndent ? /^\s*port:\s*(\d+)\s*(#.*)?$/.exec(line) : null;
    if (port && out.port === undefined) out.port = Number(port[1]);
  }
  return out;
}

/**
 * 服务管家数据目录里，探活端口是 port 的那条服务；没有、目录读不了是 undefined。
 * 顶层文件的 id 是文件里写的（没写按文件名），名下的是"登记方--文件名"（归属只看文件放在哪，和服务管家一样）
 */
export function registeredServiceOnPort(svcDataDir: string, port: number): RegisteredService | undefined {
  const services = path.join(svcDataDir, "registry", "services");
  const owned = path.join(services, "owned");
  const files: Array<{ file: string; owner?: string }> = [
    ...yamlFiles(services).map((file) => ({ file })),
    ...ownerDirs(owned).flatMap((owner) => yamlFiles(path.join(owned, owner)).map((file) => ({ file, owner }))),
  ];
  for (const { file, owner } of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const entry = parseRegistryEntry(text);
    if (entry.port !== port) continue;
    const base = path.basename(file, ".yaml");
    const id = owner === undefined ? (entry.id ?? base) : ownedIdOf(owner, base);
    return { id, ...(entry.name !== undefined && entry.name !== "" ? { name: entry.name } : {}) };
  }
  return undefined;
}
