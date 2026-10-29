// 第三方许可证清单（318 号票）：发布包里带的、打进网页的、自带的 Node，一个不落地写进 THIRD_PARTY_NOTICES.txt（人看的，全文）
// 和 third-party-licenses.json（机器看的：名字、版本、许可证、从哪来）。
//   - Node.js：它自己的 LICENSE（里面已经列了 Node 带的 OpenSSL、ICU、libuv……）；
//   - node_modules 里带的每个包（deps.ts 的闭包）：sharp 的 libvips（LGPL-3.0，在 @img/sharp-win32-x64 里）、onnxruntime……；
//   - 打进网页 index.html 的：网页的运行时依赖（react、react-markdown……的闭包）、Vite 注入的小段辅助代码、字体（@fontsource，SIL OFL 1.1）。
import fs from "node:fs";
import path from "node:path";
import { dependencyClosure, type LockPackage, type Lockfile } from "./deps.ts";

export interface LicenseItem {
  name: string;
  version: string;
  /** SPDX 写法（package.json 的 license） */
  license: string;
  /** node_modules：随包带的；web：打进了网页；runtime：自带的 Node */
  where: "node_modules" | "web" | "runtime";
  /** 许可证全文（包里的 LICENSE / COPYING / NOTICE……拼起来）；包里没有许可证文件的是 undefined */
  text?: string;
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

function licenseOf(manifest: { license?: unknown; licenses?: unknown }): string {
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license && typeof manifest.license === "object" && "type" in manifest.license) return String((manifest.license as { type: unknown }).type);
  if (Array.isArray(manifest.licenses)) return manifest.licenses.map((l: { type?: string }) => l.type ?? "?").join(" OR ");
  return "UNKNOWN";
}

/** 包目录里的许可证文件全文 */
export function licenseText(dir: string): string | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => LICENSE_FILE.test(n) && fs.statSync(path.join(dir, n)).isFile());
  } catch {
    return undefined;
  }
  if (names.length === 0) return undefined;
  return names
    .sort()
    .map((n) => fs.readFileSync(path.join(dir, n), "utf8").trim())
    .join("\n\n");
}

function itemFor(dir: string, where: LicenseItem["where"]): LicenseItem {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name: string; version: string; license?: unknown; licenses?: unknown };
  const text = licenseText(dir);
  return { name: manifest.name, version: manifest.version, license: licenseOf(manifest), where, ...(text ? { text } : {}) };
}

/** 打进网页的包：网页的运行时依赖的闭包、字体包、Vite（注入的模块预加载辅助代码） */
export function webBundledKeys(repo: string): string[] {
  const lock = JSON.parse(fs.readFileSync(path.join(repo, "package-lock.json"), "utf8")) as Lockfile;
  const web = JSON.parse(fs.readFileSync(path.join(repo, "packages", "web", "package.json"), "utf8")) as LockPackage & { devDependencies?: Record<string, string> };
  const present = (key: string) => fs.existsSync(path.join(repo, key, "package.json"));
  const runtime = dependencyClosure(lock, ["packages/web"], present, () => ({ dependencies: web.dependencies ?? {} })).keys;
  const fonts = Object.keys(web.devDependencies ?? {})
    .filter((n) => n.startsWith("@fontsource"))
    .map((n) => (lock.packages[`packages/web/node_modules/${n}`] ? `packages/web/node_modules/${n}` : `node_modules/${n}`))
    .filter(present);
  const vite = ["packages/web/node_modules/vite", "node_modules/vite"].find(present);
  return [...new Set([...runtime, ...fonts, ...(vite ? [vite] : [])])].sort();
}

/** 收齐许可证：nodeDir 是自带的 Node 所在目录（有 LICENSE）；nodeModulesKeys 是随包带的（deps.ts 的闭包） */
export function collectLicenses(repo: string, nodeModulesKeys: readonly string[], node: { version: string; dir?: string } | undefined): LicenseItem[] {
  const items: LicenseItem[] = [];
  if (node) {
    const text = node.dir ? licenseText(node.dir) : undefined;
    items.push({ name: "Node.js", version: node.version, license: "MIT (and bundled third-party licenses, see text)", where: "runtime", ...(text ? { text } : {}) });
  }
  const seen = new Set<string>();
  for (const key of nodeModulesKeys) {
    const item = itemFor(path.join(repo, key), "node_modules");
    seen.add(`${item.name}@${item.version}`);
    items.push(item);
  }
  for (const key of webBundledKeys(repo)) {
    const item = itemFor(path.join(repo, key), "web");
    if (seen.has(`${item.name}@${item.version}`)) continue;
    seen.add(`${item.name}@${item.version}`);
    items.push(item);
  }
  return items;
}

/** THIRD_PARTY_NOTICES.txt 的内容 */
export function formatNotices(items: readonly LicenseItem[], product: { name: string; version: string }): string {
  const where = { runtime: "bundled runtime / 自带的运行时", node_modules: "app/node_modules", web: "bundled into app/packages/web/dist / 打进了网页" } as const;
  const head = [
    `${product.name} ${product.version} — third-party software notices / 第三方软件许可证`,
    "",
    "This package includes the following third-party software. Each is distributed under its own license, reproduced below.",
    "本软件包带有下列第三方软件，各自按自己的许可证分发，许可证全文附在下面。",
    "",
    ...items.map((i) => `- ${i.name} ${i.version} (${i.license}) — ${where[i.where]}`),
    "",
  ];
  const bodies = items.map((i) =>
    [
      "=".repeat(78),
      `${i.name} ${i.version}`,
      `License: ${i.license}`,
      "=".repeat(78),
      i.text ?? `(No license file shipped in the package; the package declares "${i.license}". / 包里没有许可证文件，包声明的许可证是 ${i.license}。)`,
      "",
    ].join("\n"),
  );
  return `${[...head, ...bodies].join("\n")}\n`;
}

/** 名字 → 版本、许可证（机器看的） */
export function licensesJson(items: readonly LicenseItem[]): string {
  return `${JSON.stringify(
    items.map(({ name, version, license, where }) => ({ name, version, license, where })),
    null,
    2,
  )}\n`;
}
