// 从 GitHub 装 skill（465）：设置 · skill 库的导入弹窗里选"GitHub"，填地址，分两步——
// 1. 预览（preview）：地址拆成仓库、ref、子目录（github-url.ts）；下载那个 ref 的源码压缩包（github.com/<owner>/<repo>/archive/<ref>.tar.gz，
//    GitHub 转到 codeload.github.com；没写 ref 用 HEAD，就是默认分支），走守护进程下载组件的同一层（components/transport.ts：
//    跟重定向、走系统代理），解到数据目录临时区里自己的一格（tmp/github-skills/<预览编号>/），**只解用户指的那个子目录**
//    （没指就整个仓库）。解压用 components/tar.ts（跳过链接、拒不安全路径、边读边写），不调系统 tar、不要求装 git；
//    提交号取压缩包全局 pax 头里的 comment（git archive 写的），不调 GitHub API。
//    解出来的交给 skill 库看（library.inspectStaged）：本身有 SKILL.md 是单个 skill，没有的话下面几层里的当集合的成员。
// 2. 安装（install）：用户看过再点。走 skill 库导入的同一段校验和写入（library.installStaged），装完这一格清掉；
//    重名、改名不合规矩这类被拒的留着这一格（改了名再点安装不用重新下）。
// 放弃（discard）马上清；放太久（PREVIEW_TTL_MS）没装的、多出 MAX_PREVIEWS 个的最老的、守护进程上次留下的，都清。只清自己这一格目录。
// 只支持公开仓库，不收、不存任何 token。
//
// 解开时就丢掉的（预览里列出来，不进 skill 区）：链接（符号链接、硬链接这类）、依赖目录（node_modules、.venv、venv——
// 本机导入是按原路径引用，GitHub 来的引用不了临时区）、名字在 Windows 上用不了的（带 : * ? 这类、CON 这类保留名）、
// 只差大小写的重名（Windows 上会互相覆盖，留先来的）。.env*、*.pem、*.key、隐藏目录由 skill 库照本机导入的规矩不带。
// 上限：压缩包 DOWNLOAD_MAX_BYTES；解开的（只算写出来的）不超过本机导入的上限（IMPORT_MAX_BYTES、IMPORT_MAX_FILES）；
// 整个下载 DOWNLOAD_TIMEOUT_MS 没下完算超时。
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { GITHUB_SCRIPTS_SHOWN, type GithubDropReason, type GithubSkillInstallBody, type GithubSkillOrigin, type GithubSkillPreview, IMPORT_NAME_PATTERN, type ImportSkillResult, t } from "@ergo/protocol";
import { safeRelPath } from "../components/manifest.ts";
import { fileSink, TarError, walkTar } from "../components/tar.ts";
import type { Transport } from "../components/transport.ts";
import { RequestRejected } from "../errors.ts";
import { archiveUrl, canonicalUrl, type GithubSkillAddress, looksLikeVersionTag, parseGithubAddress, type RefCandidate, refCandidates } from "./github-url.ts";
import { DEPENDENCY_DIRS, IMPORT_MAX_BYTES, IMPORT_MAX_FILES, normalizeSkillDirName, type SkillLibrary, type StagedInspection } from "./library.ts";

/** 压缩包最大多少字节 */
export const DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
/** 整个下载最多多久（毫秒） */
export const DOWNLOAD_TIMEOUT_MS = 120_000;
/** 预览放多久没装就清掉（毫秒） */
export const PREVIEW_TTL_MS = 30 * 60_000;
/** 最多同时留几个预览（多出来的清最老的） */
export const MAX_PREVIEWS = 5;
/** 隔多久看一次有没有放太久的预览（毫秒） */
const SWEEP_MS = 5 * 60_000;

export interface GithubSkillsOptions {
  library: SkillLibrary;
  /** 临时区里放 GitHub 下载的那一格（数据目录的 tmp/github-skills；skill 库的 stagedDir 也是它） */
  dir: string;
  /** 下载那一层（正式的走系统代理；测试换成假的，绝不连真网络） */
  transport: Transport;
  /** 现在（毫秒） */
  now?: () => number;
  /** 测试调小的上限 */
  limits?: Partial<{ downloadBytes: number; extractBytes: number; extractFiles: number; timeoutMs: number; ttlMs: number; maxPreviews: number }>;
  log: (line: string) => void;
}

export interface GithubSkills {
  /** 第一步：下载、解开、看里面有什么。认不出地址、下不下来、太大、没有 SKILL.md 的抛 RequestRejected（一句人话） */
  preview(url: string): Promise<GithubSkillPreview>;
  /** 第二步：从预览安装（同导入的校验和写入），装完清掉这一格 */
  install(body: GithubSkillInstallBody): ImportSkillResult;
  /** 不装了：清掉这一格；本来就没有了是 false */
  discard(previewId: string): boolean;
  /** 清掉放太久的预览（定时调；测试直接调） */
  sweep(): void;
  /** 停下定时清理（守护进程停的时候） */
  stop(): void;
}

/** 留着的一个预览 */
interface Kept {
  id: string;
  /** 这一格目录 */
  slot: string;
  /** 解出来的来源（交给 skill 库的） */
  root: string;
  /** 仓库里的哪个目录（整个仓库是空串） */
  subdir: string;
  kind: "single" | "collection";
  /** 解开时就丢掉的（链接、依赖目录、Windows 上用不了的名字、只差大小写的）：装完的报告里和库不带的一起列 */
  dropped: readonly string[];
  origin: Omit<GithubSkillOrigin, "installedAt">;
  expiresAt: number;
}

/** 下载回 404：仓库不存在、私有、没有这个 ref */
class NotOnGithub extends RequestRejected {}

const IMPORT_NAME = new RegExp(IMPORT_NAME_PATTERN);

/** Windows 上不能用的名字：带 < > : " | ? * 和控制字符的、结尾是点或空格的、CON 这类保留名 */
function windowsSafeName(name: string): boolean {
  if (/[<>:"|?*]/.test(name) || /[. ]$/.test(name) || [...name].some((c) => (c.codePointAt(0) ?? 0) < 0x20)) return false;
  return !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i.test(name);
}

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createGithubSkills(options: GithubSkillsOptions): GithubSkills {
  const now = options.now ?? Date.now;
  const limits = {
    downloadBytes: options.limits?.downloadBytes ?? DOWNLOAD_MAX_BYTES,
    extractBytes: options.limits?.extractBytes ?? IMPORT_MAX_BYTES,
    extractFiles: options.limits?.extractFiles ?? IMPORT_MAX_FILES,
    timeoutMs: options.limits?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    ttlMs: options.limits?.ttlMs ?? PREVIEW_TTL_MS,
    maxPreviews: options.limits?.maxPreviews ?? MAX_PREVIEWS,
  };
  const kept = new Map<string, Kept>();

  /** 清掉一格（只清 dir 下面这一格自己的目录） */
  const removeSlot = (slot: string) => {
    try {
      fs.rmSync(slot, { recursive: true, force: true });
    } catch (err) {
      options.log(`清理 GitHub skill 的临时目录 ${slot} 出错：${reasonOf(err)}`);
    }
  };

  // 守护进程上次留下的（预览到一半停了、没装也没放弃的）：这一格里的全是自己建的，清掉
  try {
    for (const name of fs.readdirSync(options.dir)) removeSlot(path.join(options.dir, name));
  } catch {
    // 还没有这个目录
  }

  const drop = (id: string): boolean => {
    const k = kept.get(id);
    if (!k) return false;
    kept.delete(id);
    removeSlot(k.slot);
    return true;
  };

  const sweep = () => {
    const at = now();
    for (const k of kept.values()) {
      if (k.expiresAt <= at) {
        drop(k.id);
        options.log(`GitHub skill 的预览 ${k.origin.url} 放太久没装，清掉了`);
      }
    }
  };
  const timer = setInterval(sweep, SWEEP_MS);
  timer.unref();

  /** 下载到 file：只认 200，太大、超时、连不上、404、限流各给一句人话 */
  const download = async (url: string, file: string, address: GithubSkillAddress, ref: string | undefined): Promise<void> => {
    const timeout = AbortSignal.timeout(limits.timeoutMs);
    const timedOut = () => new RequestRejected("internal", t("skills.github.timeout", { seconds: Math.round(limits.timeoutMs / 1000) }));
    const repo = `${address.owner}/${address.repo}`;
    let res: Awaited<ReturnType<Transport>>;
    try {
      res = await options.transport(url, { signal: timeout });
    } catch (err) {
      if (timeout.aborted) throw timedOut();
      throw new RequestRejected("internal", t("skills.github.unreachable", { reason: reasonOf(err) }));
    }
    try {
      if (res.status === 404 || res.status === 410 || res.status === 451) {
        throw new NotOnGithub("not_found", ref === undefined ? t("skills.github.notFound", { repo }) : t("skills.github.notFoundRef", { repo, ref }));
      }
      if (res.status === 403 || res.status === 429) throw new RequestRejected("rate_limited", t("skills.github.rateLimited", { status: res.status }));
      if (res.status !== 200) throw new RequestRejected("internal", t("skills.github.httpError", { status: res.status }));
      const tooBig = () => new RequestRejected("bad_params", t("skills.github.tooBigDownload", { mb: Math.round(limits.downloadBytes / 1024 / 1024) }));
      const length = Number(res.headers["content-length"]);
      if (res.headers["content-length"] !== undefined && Number.isFinite(length) && length > limits.downloadBytes) throw tooBig();
      const out = fs.createWriteStream(file);
      let size = 0;
      try {
        for await (const chunk of res.body) {
          size += chunk.length;
          if (size > limits.downloadBytes) throw tooBig();
          if (!out.write(chunk)) await once(out, "drain");
        }
      } catch (err) {
        if (err instanceof RequestRejected) throw err;
        if (timeout.aborted) throw timedOut();
        throw new RequestRejected("internal", t("skills.github.unreachable", { reason: reasonOf(err) }));
      } finally {
        await new Promise<void>((resolve) => out.end(() => resolve()));
      }
    } finally {
      res.destroy();
    }
  };

  /**
   * 把压缩包里 subdir 下面的解到 dest（去掉压缩包顶上那一层 <仓库>-<ref>/）。压缩包里任何一项路径不安全的整个不用；
   * 链接、依赖目录、Windows 上用不了的名字、只差大小写的重名不解，记进 dropped
   */
  const extract = async (archive: string, dest: string, subdir: string) => {
    let commit: string | undefined;
    let files = 0;
    let bytes = 0;
    const dropped = new Map<string, GithubDropReason>();
    const seen = new Set<string>();
    const prefix = subdir === "" ? "" : `${subdir}/`;
    let found = prefix === "";
    fs.mkdirSync(dest, { recursive: true });
    try {
      await walkTar(
        archive,
        {
          gzip: true,
          onGlobal: (records) => {
            const comment = records.get("comment")?.trim();
            if (comment && /^[0-9a-f]{40}$/i.test(comment)) commit = comment.toLowerCase();
          },
        },
        (entry) => {
          const inRepo = entry.path.split("/").slice(1).join("/");
          if (inRepo === "") return undefined;
          if (!safeRelPath(inRepo)) throw new RequestRejected("not_allowed", t("skills.github.unsafePath", { path: entry.path }));
          if (inRepo === subdir) {
            found = true;
            return undefined;
          }
          if (prefix !== "" && !inRepo.startsWith(prefix)) return undefined;
          found = true;
          const rel = inRepo.slice(prefix.length);
          const segs = rel.split("/");
          const isDir = entry.type === "dir";
          const dirOf = (n: number) => `${segs.slice(0, n).join("/")}/`;
          const depAt = segs.findIndex((s, i) => DEPENDENCY_DIRS.has(s) && (i < segs.length - 1 || isDir));
          if (depAt >= 0) {
            dropped.set(dirOf(depAt + 1), "dependency");
            return undefined;
          }
          const badAt = segs.findIndex((s) => !windowsSafeName(s));
          if (badAt >= 0) {
            dropped.set(badAt < segs.length - 1 || isDir ? dirOf(badAt + 1) : rel, "badName");
            return undefined;
          }
          if (entry.type === "other") {
            dropped.set(rel, "link");
            return undefined;
          }
          const key = rel.toLowerCase();
          if (seen.has(key)) {
            dropped.set(isDir ? `${rel}/` : rel, "duplicate");
            return undefined;
          }
          seen.add(key);
          const target = path.join(dest, ...segs);
          if (isDir) {
            fs.mkdirSync(target, { recursive: true });
            return undefined;
          }
          files += 1;
          bytes += entry.size;
          if (files > limits.extractFiles || bytes > limits.extractBytes) {
            throw new RequestRejected("bad_params", t("skills.github.tooBigExtract", { maxMb: Math.round(limits.extractBytes / 1024 / 1024), maxFiles: limits.extractFiles }));
          }
          return fileSink(target, entry.mode);
        },
      );
    } catch (err) {
      if (err instanceof RequestRejected) throw err;
      if (err instanceof TarError || (err instanceof Error && /incorrect header|unexpected end|invalid/i.test(err.message))) {
        throw new RequestRejected("bad_params", t("skills.github.badArchive", { reason: err.message }));
      }
      throw new RequestRejected("internal", t("skills.github.extractFailed", { reason: reasonOf(err) }));
    }
    return { commit, found, files, bytes, dropped };
  };

  /** 按 ref 和子目录的几种分法从先往后试：404 了、或者这一种分法下没有那个子目录，换下一种 */
  const fetchInto = async (address: GithubSkillAddress, slot: string) => {
    const candidates = refCandidates(address);
    let lastMissing: RefCandidate | undefined;
    for (const [i, candidate] of candidates.entries()) {
      const last = i === candidates.length - 1;
      const archive = path.join(slot, "archive.tar.gz");
      try {
        await download(archiveUrl(address, candidate.ref), archive, address, candidate.ref);
      } catch (err) {
        if (err instanceof NotOnGithub && !last) continue;
        // 前一种分法下载到了、只是没有那个子目录：说没有那个目录，不说找不到仓库
        if (err instanceof NotOnGithub && lastMissing) break;
        throw err;
      }
      // 来源目录的名字：子目录的最后一段，整个仓库的是仓库名（单个 skill 装进去的目录名就从它来）
      const base = candidate.subdir === "" ? address.repo : (candidate.subdir.split("/").at(-1) ?? address.repo);
      const name = windowsSafeName(base) ? base : normalizeSkillDirName(base) || "skill";
      const root = path.join(slot, "src", name);
      try {
        const got = await extract(archive, root, candidate.subdir);
        if (!got.found) {
          lastMissing = candidate;
          fs.rmSync(path.join(slot, "src"), { recursive: true, force: true });
          continue;
        }
        return { candidate, root, ...got };
      } finally {
        fs.rmSync(archive, { force: true });
      }
    }
    throw new RequestRejected("not_found", t("skills.github.noSubdir", { subdir: lastMissing?.subdir ?? address.subdir }));
  };

  const view = (k: Kept, inspection: StagedInspection, dropped: Map<string, GithubDropReason>, collectionDefaults?: { name: string; source: string; version: string; description: string }): GithubSkillPreview => {
    const all = new Map(dropped);
    for (const e of inspection.excluded) {
      const name = e.replace(/\/$/, "").split("/").at(-1) ?? e;
      const lower = name.toLowerCase();
      all.set(e, e.endsWith("/") ? "hidden" : lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".pem") || lower.endsWith(".key") ? "sensitive" : "hidden");
    }
    const { origin } = k;
    const common = {
      previewId: k.id,
      url: origin.url,
      repo: origin.repo,
      ...(origin.ref === undefined ? {} : { ref: origin.ref }),
      ...(origin.commit === undefined ? {} : { commit: origin.commit }),
      subdir: k.subdir,
      fileCount: inspection.fileCount,
      totalBytes: inspection.totalBytes,
      scripts: inspection.scripts.slice(0, GITHUB_SCRIPTS_SHOWN),
      scriptCount: inspection.scripts.length,
      dropped: [...all.entries()].map(([p, reason]) => ({ path: p, reason })).toSorted((a, b) => a.path.localeCompare(b.path)),
      expiresAt: new Date(k.expiresAt).toISOString(),
    };
    if (inspection.kind === "single") {
      const { name, description, dirName, sameName } = inspection;
      return { ...common, kind: "single", single: { name, description, dirName, ...(sameName ? { sameName } : {}) } };
    }
    return {
      ...common,
      kind: "collection",
      members: inspection.members,
      ...(collectionDefaults ? { collection: { ...collectionDefaults, ...(inspection.nameTaken ? { nameTaken: inspection.nameTaken } : {}) } } : {}),
    };
  };

  return {
    async preview(input) {
      sweep();
      const address = parseGithubAddress(input);
      if (!address) throw new RequestRejected("bad_params", t("skills.github.badAddress", { url: input.trim() }));
      fs.mkdirSync(options.dir, { recursive: true });
      const id = randomBytes(9).toString("hex");
      const slot = path.join(options.dir, id);
      fs.mkdirSync(slot);
      try {
        const got = await fetchInto(address, slot);
        const repo = `${address.owner}/${address.repo}`;
        const origin: Kept["origin"] = {
          url: canonicalUrl(address, got.candidate),
          repo,
          ...(got.candidate.ref === undefined ? {} : { ref: got.candidate.ref }),
          ...(got.commit === undefined ? {} : { commit: got.commit }),
        };
        // 集合的默认值：集合名是仓库名（规范成小写短横线），来源是网址，版本是像版本号的标签、不然提交号前 7 位
        const defaultName = normalizeSkillDirName(address.repo).replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
        const collectionName = IMPORT_NAME.test(defaultName) ? defaultName : "github-skills";
        const inspection = options.library.inspectStaged(got.root, collectionName);
        const k: Kept = {
          id,
          slot,
          root: got.root,
          subdir: got.candidate.subdir,
          kind: inspection.kind,
          dropped: [...got.dropped.keys()],
          origin,
          expiresAt: now() + limits.ttlMs,
        };
        const version = got.candidate.ref !== undefined && looksLikeVersionTag(got.candidate.ref) ? got.candidate.ref : (got.commit?.slice(0, 7) ?? got.candidate.ref ?? "HEAD");
        const result = view(
          k,
          inspection,
          got.dropped,
          inspection.kind === "collection" ? { name: collectionName, source: origin.url, version: version.slice(0, 64), description: collectionDescription(got.root) } : undefined,
        );
        kept.set(id, k);
        // 多出来的清最老的
        const extra = [...kept.values()].toSorted((a, b) => a.expiresAt - b.expiresAt).slice(0, Math.max(0, kept.size - limits.maxPreviews));
        for (const old of extra) drop(old.id);
        options.log(`看了 GitHub 上的 skill：${origin.url}（${inspection.kind === "single" ? "单个" : `集合，${inspection.members.length} 个成员`}，提交 ${origin.commit?.slice(0, 7) ?? "不知道"}）`);
        return result;
      } catch (err) {
        removeSlot(slot);
        if (err instanceof RequestRejected) throw err;
        throw new RequestRejected("internal", t("skills.github.previewFailed", { reason: reasonOf(err) }));
      }
    },
    install(body) {
      sweep();
      const k = kept.get(body.previewId);
      if (!k) throw new RequestRejected("not_found", t("skills.github.previewGone"));
      if (k.kind === "single" && body.collection) throw new RequestRejected("bad_params", t("skills.github.notCollection"));
      if (k.kind === "collection" && !body.collection) throw new RequestRejected("bad_params", t("skills.github.needCollection"));
      const github: GithubSkillOrigin = { ...k.origin, installedAt: new Date(now()).toISOString() };
      let result: ImportSkillResult;
      try {
        result = options.library.installStaged({
          root: k.root,
          github,
          ...(body.rename === undefined ? {} : { rename: body.rename }),
          ...(body.collection ? { collection: body.collection } : {}),
        });
      } catch (err) {
        // 重名、名字不合规矩这类：留着这一格，改了再装不用重新下；出了别的错清掉
        if (!(err instanceof RequestRejected) || err.code === "internal") drop(k.id);
        throw err;
      }
      drop(k.id);
      return { ...result, excluded: [...new Set([...result.excluded, ...k.dropped])].toSorted() };
    },
    discard: drop,
    sweep,
    stop() {
      clearInterval(timer);
    },
  };
}

/** 集合的说明：插件清单（.claude-plugin/plugin.json、marketplace.json）里的 description，再不然 README 的第一段；取不到是空串 */
function collectionDescription(root: string): string {
  for (const file of ["plugin.json", "marketplace.json"]) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", file), "utf8")) as { description?: unknown; metadata?: { description?: unknown } };
      const text = typeof doc.description === "string" ? doc.description : typeof doc.metadata?.description === "string" ? doc.metadata.description : "";
      if (text.trim() !== "") return text.trim().slice(0, 300);
    } catch {
      // 没有、读不懂：看下一个
    }
  }
  const readme = fs.existsSync(root) ? fs.readdirSync(root).find((n) => /^readme(\.md|\.markdown|\.txt)?$/i.test(n)) : undefined;
  if (!readme) return "";
  try {
    return firstParagraph(fs.readFileSync(path.join(root, readme), "utf8")).slice(0, 300);
  } catch {
    return "";
  }
}

/** Markdown 的第一段正文：跳过开头的标题、徽章、图片、HTML、空行，取到下一个空行为止，合成一行 */
export function firstParagraph(text: string): string {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      if (out.length > 0) break;
      continue;
    }
    if (inFence) continue;
    if (out.length === 0) {
      if (line === "" || line.startsWith("#") || line.startsWith("<") || line.startsWith("![") || line.startsWith("[![") || /^[-=*_]{3,}$/.test(line) || line.startsWith("---")) continue;
    } else if (line === "" || line.startsWith("#")) break;
    out.push(line);
  }
  return out
    .join(" ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
}
