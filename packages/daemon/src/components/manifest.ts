// 组件清单（323 号票）：随版本发布的一份数据（同目录的 manifest.json），守护进程启动时读一次。
// 每个组件写：id、版本、默认（install 默认装 / ask 问了再装 / detected 检测到才装，detect 写检测什么）、别处已经有了算不算有
// （provided 写查什么）、打开哪些功能（enables）、依赖哪些别的组件（dependsOn）、装到数据目录的哪里（target）、几个下载地址
// （sources，url 里的 {path} 换成文件的路径）、几版（variants：按这台电脑有没有 N 卡、什么平台挑第一个对得上的），每版几部分（parts：
// 一组同源的文件放进 target 下的 dir；还没接上的部分写 pending，这一版就不能从这里装）。文件写大小和 sha256，压缩包写怎么解开（extract）。
// - 默认装不装、哪些功能，用户以后要改只改这份数据；界面上照它显示；
// - 安全：只认清单里的校验值（镜像只是换个地方下，内容对不上就不用）。清单的签名（发布钥匙、minisign）由 318 号票发版时加，
//   这里留好验签的接口（ManifestVerifier）：给了就先验，验不过不用这份清单；没给是"没签名"，照用、界面上写明。
//   318 号票接上：发布包里清单旁边有 manifest.json.minisig（发版时用发布钥匙签的），守护进程按程序里的发布公钥验（shippedManifestVerifier）；
//   开发时（仓库里直接跑）没有签名文件，照"没签名"用。
import fs from "node:fs";
import { COMPONENT_DEFAULTS, schemaChecker, type Static, Type } from "@ergo/protocol";
import { type MinisignPublicKey, verify } from "../release/minisign.ts";
import { releasePublicKey } from "../release/public-key.ts";

const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
/** 数据目录里、或者组件目录里的相对路径：/ 分隔，不能是绝对路径、不能有 ..（parseManifest 里用 safeRelPath 查） */
const RelPath = Type.String({ minLength: 1, maxLength: 300 });

const Source = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
    /** 给人看的名字（Hugging Face、hf-mirror、ModelScope、npm）：产品名，不翻 */
    title: Type.String({ minLength: 1 }),
    /** 下载地址，{path} 换成文件的路径 */
    url: Type.String({ pattern: "^https?://.+\\{path\\}" }),
    /** huggingface：设了环境变量 HF_ENDPOINT 时这一个的域名换成它（以前 npm run download-model 的用法） */
    hub: Type.Optional(Type.Literal("huggingface")),
  },
  { additionalProperties: false },
);

const Extract = Type.Object(
  {
    format: Type.Union([Type.Literal("tgz"), Type.Literal("tar")]),
    /** 去掉每一项路径的前几段（npm 的包里是 package/） */
    strip: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
    /** 解到组件目录下的哪里 */
    to: RelPath,
    /** 解开后大约多大（查磁盘空间用） */
    unpackedSize: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const File = Type.Object(
  {
    /** 下载地址里的 {path}；不解开的文件也照它放进 target（前面加上这部分的 dir） */
    path: RelPath,
    size: Type.Integer({ minimum: 0 }),
    /** 有就核对；没有的只核对大小和名字（小的配置文件，以前的下载命令就是这样） */
    sha256: Type.Optional(Sha256),
    extract: Type.Optional(Extract),
  },
  { additionalProperties: false },
);

const Part = Type.Object(
  {
    /** 这部分的下载地址；不写用组件的 */
    sources: Type.Optional(Type.Array(Source)),
    /** 放进 target 下的哪个子目录 */
    dir: Type.Optional(RelPath),
    files: Type.Optional(Type.Array(File)),
    /** 还没接上的部分（python：用 uv 装 Python 和 faster-whisper；audiocpp：audio.cpp 预编译的程序和模型） */
    pending: Type.Optional(Type.String({ pattern: "^[a-z0-9-]+$" })),
  },
  { additionalProperties: false },
);

const Variant = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
    /** 什么样的电脑用这一版；不写是都行（放最后当兜底） */
    when: Type.Optional(
      Type.Object(
        {
          gpu: Type.Optional(Type.Union([Type.Literal("nvidia"), Type.Literal("none")])),
          platform: Type.Optional(Type.Array(Type.String())),
          arch: Type.Optional(Type.Array(Type.String())),
        },
        { additionalProperties: false },
      ),
    ),
    parts: Type.Array(Part, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const Component = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
    version: Type.String({ minLength: 1, maxLength: 60 }),
    default: Type.Enum(COMPONENT_DEFAULTS),
    /** default 是 detected 时检测什么（on-path:<程序>：PATH 上有这个程序） */
    detect: Type.Optional(Type.String()),
    /** 别处已经有了也算有（voice-recognizer：配置里的识别程序；voice-speech：配置里的合成服务；node-package:<包名>：随程序装好的 npm 包） */
    provided: Type.Optional(Type.String()),
    enables: Type.Array(Type.String({ minLength: 1 })),
    dependsOn: Type.Optional(Type.Array(Type.String())),
    /** 装到数据目录下的哪里 */
    target: RelPath,
    sources: Type.Optional(Type.Array(Source)),
    variants: Type.Array(Variant, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const Manifest = Type.Object(
  {
    format: Type.Literal(1),
    /** 随哪一版发布 */
    release: Type.String({ minLength: 1 }),
    components: Type.Array(Component),
  },
  { additionalProperties: false },
);

export type ManifestSource = Static<typeof Source>;
export type ManifestFile = Static<typeof File>;
export type ManifestPart = Static<typeof Part>;
export type ManifestVariant = Static<typeof Variant>;
export type ManifestComponent = Static<typeof Component>;
export type ComponentManifest = Static<typeof Manifest>;

const checkManifest = schemaChecker(Manifest);

/** 验签（318 号票发版时接上发布钥匙）：清单的原始字节和签名文件的内容，验过回 true */
export type ManifestVerifier = (bytes: Buffer, signature: string | undefined) => boolean;

/** 随程序发布的那份清单 */
export const MANIFEST_URL = new URL("./manifest.json", import.meta.url);

/** 按发布公钥验清单的签名：没有签名、没有公钥、验不过都是 false */
export function minisignManifestVerifier(publicKey: MinisignPublicKey | undefined): ManifestVerifier {
  return (bytes, signature) => signature !== undefined && publicKey !== undefined && verify(bytes, signature, publicKey).ok;
}

/**
 * 随程序发布的清单怎么验（318 号票）：旁边有签名文件（发布包）就按程序里的发布公钥验（验不过 loadManifest 抛错、不用这份）；
 * 没有签名文件（开发时）不验
 */
export function shippedManifestVerifier(env: NodeJS.ProcessEnv = process.env, url: URL = MANIFEST_URL): ManifestVerifier | undefined {
  return fs.existsSync(new URL(`${url.href}.minisig`)) ? minisignManifestVerifier(releasePublicKey(env)) : undefined;
}

export interface LoadedManifest {
  manifest: ComponentManifest;
  /** 验过签名的 */
  signed: boolean;
}

/**
 * 读清单：先按签名验（给了验签的话；签名在旁边的 manifest.json.minisig），再按 schema 和下面的规矩查。
 * 不对就抛（这是发版的错，守护进程照常起来、组件页写明清单坏了由调用方决定）
 */
export function loadManifest(options: { url?: URL; verify?: ManifestVerifier } = {}): LoadedManifest {
  const url = options.url ?? MANIFEST_URL;
  const bytes = fs.readFileSync(url);
  let signed = false;
  if (options.verify) {
    let signature: string | undefined;
    try {
      signature = fs.readFileSync(new URL(`${url.href}.minisig`), "utf8");
    } catch {
      signature = undefined;
    }
    if (!options.verify(bytes, signature)) throw new Error(`组件清单 ${url.pathname} 的签名验不过`); // @i18n-ignore log：发版的错，只进日志
    signed = true;
  }
  return { manifest: parseManifest(JSON.parse(bytes.toString("utf8")) as unknown), signed };
}

/** 按 schema 和规矩查一份清单（测试用自己编的清单也走这里） */
export function parseManifest(raw: unknown): ComponentManifest {
  const error = checkManifest.firstError(raw);
  if (error !== undefined) throw new Error(`组件清单不对：${error}`); // @i18n-ignore log：发版的错
  const manifest = raw as ComponentManifest;
  const ids = new Set<string>();
  for (const c of manifest.components) {
    if (ids.has(c.id)) throw new Error(`组件清单不对：${c.id} 写了两次`); // @i18n-ignore log：发版的错
    ids.add(c.id);
  }
  for (const c of manifest.components) {
    const paths = [c.target, ...c.variants.flatMap((v) => v.parts.flatMap((p) => [...(p.dir ? [p.dir] : []), ...(p.files ?? []).flatMap((f) => [f.path, ...(f.extract ? [f.extract.to] : [])])]))];
    const bad = paths.find((p) => !safeRelPath(p));
    if (bad !== undefined) throw new Error(`组件清单不对：${c.id} 的路径 ${bad} 不是安全的相对路径`); // @i18n-ignore log：发版的错
    if (c.default === "detected" && c.detect === undefined) throw new Error(`组件清单不对：${c.id} 默认是检测到才装，却没写 detect`); // @i18n-ignore log：发版的错
    for (const dep of c.dependsOn ?? []) {
      if (!ids.has(dep) || dep === c.id) throw new Error(`组件清单不对：${c.id} 依赖的 ${dep} 不在清单里`); // @i18n-ignore log：发版的错
    }
    for (const v of c.variants) {
      const keys = new Set<string>();
      for (const part of v.parts) {
        if (part.pending === undefined && (part.files ?? []).length > 0 && (part.sources ?? c.sources ?? []).length === 0) {
          throw new Error(`组件清单不对：${c.id} 的 ${v.id} 有文件却没写下载地址`); // @i18n-ignore log：发版的错
        }
        for (const file of part.files ?? []) {
          const key = fileKey(part, file);
          if (keys.has(key)) throw new Error(`组件清单不对：${c.id} 的 ${v.id} 里 ${key} 写了两次`); // @i18n-ignore log：发版的错
          keys.add(key);
        }
      }
    }
  }
  dependencyOrder(manifest.components);
  return manifest;
}

/** 安全的相对路径：/ 分隔，不是绝对路径、不带盘符和反斜杠，没有空的、. 和 .. 段 */
export function safeRelPath(p: string): boolean {
  if (p.length === 0 || p.includes("\\") || p.includes("\0") || /^[A-Za-z]:/.test(p) || p.startsWith("/")) return false;
  return p.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

/** 一个文件在组件目录里放在哪（相对路径，/ 分隔）：解开的压缩包是解到的目录 */
export function fileKey(part: ManifestPart, file: ManifestFile): string {
  if (file.extract) return file.extract.to;
  return part.dir ? `${part.dir}/${file.path}` : file.path;
}

/** 依赖在前的先后（有环就抛）：装一个组件时先装它依赖的 */
export function dependencyOrder(components: readonly ManifestComponent[]): string[] {
  const byId = new Map(components.map((c) => [c.id, c]));
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, trail: string[]) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") throw new Error(`组件清单不对：依赖绕成了圈（${[...trail, id].join(" → ")}）`); // @i18n-ignore log：发版的错
    state.set(id, "visiting");
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep, [...trail, id]);
    state.set(id, "done");
    order.push(id);
  };
  for (const c of components) visit(c.id, []);
  return order;
}

/** 这台电脑的样子：挑哪一版用 */
export interface MachineProfile {
  platform: string;
  arch: string;
  gpu: "nvidia" | "none";
}

/** 挑第一个对得上的版本；都对不上是 undefined（这台电脑的平台没有这个组件） */
export function pickVariant(component: ManifestComponent, machine: MachineProfile): ManifestVariant | undefined {
  return component.variants.find((v) => {
    const when = v.when;
    if (!when) return true;
    if (when.gpu !== undefined && when.gpu !== machine.gpu) return false;
    if (when.platform !== undefined && !when.platform.includes(machine.platform)) return false;
    if (when.arch !== undefined && !when.arch.includes(machine.arch)) return false;
    return true;
  });
}

/** 一版里要下载的全部文件（连同它属于哪部分），按清单的先后 */
export function variantFiles(variant: ManifestVariant): { part: ManifestPart; file: ManifestFile }[] {
  return variant.parts.flatMap((part) => (part.files ?? []).map((file) => ({ part, file })));
}

/** 一版里还没接上的部分（pending），没有是空的 */
export function pendingParts(variant: ManifestVariant): string[] {
  return variant.parts.flatMap((part) => (part.pending === undefined ? [] : [part.pending]));
}

/** 一个文件从哪几个地方下：这部分写的、没写用组件的；hub 是 huggingface 的、设了 HF_ENDPOINT 时域名换成它，排在最前 */
export function fileSources(component: ManifestComponent, part: ManifestPart, file: ManifestFile, hfEndpoint?: string): { source: ManifestSource; url: string }[] {
  const sources = part.sources ?? component.sources ?? [];
  const urls = sources.map((source) => ({ source, url: source.url.replace("{path}", encodeURI(file.path)) }));
  if (!hfEndpoint) return urls;
  const endpoint = hfEndpoint.replace(/\/+$/, "");
  const swapped = urls
    .filter(({ source }) => source.hub === "huggingface")
    .map(({ source, url }) => ({ source: { ...source, id: `${source.id}-endpoint`, title: new URL(endpoint).host }, url: url.replace(/^https?:\/\/[^/]+/, endpoint) }));
  return [...swapped, ...urls];
}
