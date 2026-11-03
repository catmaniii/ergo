// skill 库：二狗自己的一批 skill，会话只从这里按工具包挑。
// - 框架自带的：程序目录 packages/daemon/skills/ 下（第一阶段只有示例）；
// - 用户自己加的：数据目录的 skill 区（个人数据，随数据目录备份）。用户在设置里的 skill 库页显式导入一份（复制进 skill 区）；
//   本机别处现成的 skill（比如 Claude Code 的 ~/.claude/skills 里的）要用就这样导入。不自动读取 ~/.claude/skills、~/.pi。
// 每个 skill 是一个含 SKILL.md 的目录，名字和说明取 SKILL.md 开头的 frontmatter（name、description；没写 name 的取目录名）。
// **名字照 SKILL.md 原样**：带空格、大写的也认（pstack 的 "Poteto Mode"），和 pi 一样不合 Agent Skills
// 写法的只提示、照常用；二狗不改 skill 的名字。唯一的例外是用户点名的"导入并改名"（matt-pocock 的 tdd → mp-tdd）。
// 名字在库里唯一：导入同名的被拒，并说清和谁重名（框架自带的、你导入的、哪个集合里的）。
// 装配会话时按工具包里的名字解析出目录（pathsOf），经宿主协议的 skillPaths 交给子进程（pi 的 additionalSkillPaths，noSkills；
// pi 从目录里的 SKILL.md 自己读名字，所以名字和目录名不一样也没关系）。
//
// 加的：
// - **集合**：一个目录整套导入（比如 matt-pocock 的 engineering、pstack 插件），skill 区里是 `<集合名>/`：来源的根目录整个复制进来
//   （成员用 ../../ 引用的 README、docs、agents 一起带上，相对路径照样对），外加一份 ergo-collection.json（集合名、来源、版本、
//   一句说明、成员目录、改了名的成员）。成员仍是库里独立的 skill 名；界面上集合显示成一项。
// - **导入并改名**：单个 skill 和集合的成员都能改名（只改目录名和 SKILL.md 里的 name 一行，内容不动）。单个 skill 在 skill 区里的
//   目录名取来源的目录名（改了名的取新名字），不取 skill 名。
// - **不跟任何链接**：来源里（单个 skill、集合的根目录）有符号链接或目录联接的整个拒绝，来源目录本身是链接的也拒绝——
//   不然一个指向数据目录密钥区的联接就会被原样带进 skill 区。依赖目录里的链接只认指向来源目录里面的。
// - **依赖目录不复制、按原路径引用**：node_modules、.venv、venv（本身不能是链接）不复制，在原来的位置建一个目录联接
//   （Windows 的 junction）指向来源里的那个目录（脚本照样找得到依赖；备份不跟链接，所以不进备份）；大小上限只算复制的部分。
// - **不带的东西**：.git 和别的隐藏目录、.env*、*.pem、*.key（任何一层；集合、单个 skill 都一样），报告里列出来。
// - **导入报告**：每个 skill 导入成功与否（集合里不是合规 skill 的成员跳过并写明原因；重名的整套拒绝，说清和谁重名、可以改名）。
//
// **斜杠命令就是 skill 的目录名**（/poteto-mode，不论 SKILL.md 里的名字带不带空格），
// 所以目录名一律是小写、不带空格的写法：导入时把目录名规范化（normalizeSkillDirName：转小写，空格和别的不合适的字符换成 -，
// 连续的 - 合成一个），单个 skill 和集合的成员都是；规范化之后重名的照旧拒绝，说清和谁重名。SKILL.md 一字不动，显示的名字照原样。
// 已经在 skill 区里的不合规的目录名不自动改，启动时记日志、skill 库页上提示（skills/skill-command.ts 的 skillDirProblems）。
//
// 和登记 MCP 走一样的路：负责人也能提交 skill（skills/change.ts 出卡，用户确认了才到这里）。
// 校验和真导入是**同一段逻辑**（checkSingle、planSource、readSkill），不会有"卡批了才发现导不进去"的常见情况，差别只有三处：
// - **来源**：只能是提交人自己的工作目录或项目档案里的一个目录（按真实路径认，经目录联接绕出去的拒绝）；这两处多半在数据目录里，
//   所以不走"来源不能在数据目录里"那条，换成这条；
// - **内容指纹**：读卡时算一份（要复制的文件的相对路径和内容），确认时重算，对不上就不进库；真要进库的是复制到临时目录的那一份，
//   改名就位之前还要再算一次（复制的那一刻来源又变了也挡得住）；
// - **改、删**：只能动单个的、不是框架自带的（用户自己导入的、负责人提交的），集合成员不行。动之前旧版整个挪进 skill 区的 .history/
//   （<目录名>@<时间>，每个 skill 留最近几份；隐藏目录不算 skill），换的时候先挪旧版、再改名就位，第二步失败就把旧版挪回去。
// 负责人提交的在 skill 目录里记一份 .ergo-submission.json（谁提的、什么时候）：skill 库页上标"负责人提交的"。只由运行时写，来源里带的不复制。
// 秘书也能提交（只能加）：来源是运行时把卡上的 SKILL.md 落到秘书草稿区里的一格（skills/change.ts），走的还是这同一段校验和写入；
// 和库里重名时不当场拒绝（previewSubmission 交回同名检查），用户在卡上选覆盖（就是"改"）、改名（同导入并改名）或放弃。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ImportCollectionSpec,
  IMPORT_NAME_PATTERN,
  type ImportReportLine,
  type ImportSkillBody,
  type ImportSkillResult,
  schemaChecker,
  SKILL_CHANGE_FILES_SHOWN,
  type SkillChangeSource,
  type SkillSameName,
  type SkillCollectionEntry,
  type SkillEntry,
  type Static,
  Type,
  t,
} from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";
import { isWithin } from "../guard/index.ts";
import { renameRetrying } from "../util/atomic-file.ts";
import { realPathOf } from "../util/real-path.ts";

/** 框架自带的 skill 所在的目录 */
export const BUILTIN_SKILLS_DIR = fileURLToPath(new URL("../../skills/", import.meta.url));

/** 导入时新起的名字（集合名、改的名）：小写字母、数字和短横线，最长 64；也是 skill 区里的目录名 */
const IMPORT_NAME = new RegExp(IMPORT_NAME_PATTERN);

/**
 * skill 目录名（也就是斜杠命令名）的规范写法：转小写，空格和别的不合适的字符换成 -，连续的 - 合成一个，去掉两头的 -。
 * 留下的只有小写字母（中文这类没有大小写的字也算）、数字和 -。规范不出东西（全是符号）时是空串
 */
export function normalizeSkillDirName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{Ll}\p{Lo}\p{M}\p{Nd}-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** 目录名已经是规范的写法（小写、不带空格） */
export function isNormalSkillDirName(name: string): boolean {
  return name !== "" && normalizeSkillDirName(name) === name;
}

/** 集合名不能叫这个：/skill:目录名 是点 skill 的后备写法，集合名叫 skill 时"skill:目录名"会和它分不清 */
const RESERVED_COLLECTION_NAME = "skill";
/** skill 名最长多少个字（pi 超过 64 只告警；二狗放宽到这么长，再长的多半写错了） */
const SKILL_NAME_MAX = 200;

/** SKILL.md 最大多少字节（只读开头的 frontmatter，太大的不认） */
const SKILL_FILE_MAX = 512 * 1024;
/**
 * 导入时复制的部分最多多少字节、多少个文件（skill 是说明书，不该很大；集合按整个根目录算）。
 * 按原路径引用的依赖目录、不带的东西不算在里面
 */
export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
export const IMPORT_MAX_FILES = 2000;

/** 依赖目录：不复制，在原来的位置建目录联接指向来源里的那个目录 */
const DEPENDENCY_DIRS = new Set(["node_modules", ".venv", "venv"]);

/** 不带进来的文件：密钥、凭据这类（.env、.env.local……、*.pem、*.key） */
function isSensitiveFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".pem") || lower.endsWith(".key");
}

/** 负责人提交的 skill 记谁提的文件（skill 目录的根上，只由运行时写，来源里带的不复制） */
export const SUBMISSION_FILE = ".ergo-submission.json";
/** skill 区里放旧版的目录（改、删之前挪进来；隐藏目录不算 skill） */
export const HISTORY_DIR = ".history";
/** 每个 skill 留最近几份旧版 */
const KEEP_HISTORY = 5;

/** 算脚本的文件（用它的 agent 可能会运行）：这些扩展名，或者开头是 #! 的 */
const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".fish", ".ps1", ".psm1", ".bat", ".cmd", ".vbs", ".py", ".pyw", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx", ".rb", ".pl", ".php", ".lua", ".exe", ".msi", ".jar"]);

function isScript(rel: string, content: Uint8Array): boolean {
  return SCRIPT_EXTENSIONS.has(path.extname(rel).toLowerCase()) || (content[0] === 0x23 && content[1] === 0x21);
}

/** 集合的说明文件（skill 区里集合目录的根上） */
export const COLLECTION_MANIFEST = "ergo-collection.json";

const CollectionManifest = Type.Object({
  format: Type.Literal(1),
  name: Type.String({ pattern: IMPORT_NAME_PATTERN }),
  source: Type.String(),
  version: Type.String(),
  description: Type.String(),
  /** 成员目录（相对集合目录，用 / 分隔；改了名的是改名之后的） */
  members: Type.Array(Type.String({ minLength: 1 })),
  /** 改了名的成员：新名字 → 原来的名字 */
  renamed: Type.Optional(Type.Record(Type.String(), Type.String())),
  /** 从哪个目录导入的、什么时候 */
  importedFrom: Type.String(),
  importedAt: Type.String(),
  /** 按原路径引用的依赖目录（相对集合目录 → 来源里的绝对路径） */
  linked: Type.Optional(Type.Array(Type.Object({ dir: Type.String(), target: Type.String() }))),
  /** 没带进来的（相对来源的根目录） */
  excluded: Type.Optional(Type.Array(Type.String())),
});
type CollectionManifest = Static<typeof CollectionManifest>;
const manifestShape = schemaChecker(CollectionManifest);

export interface SkillLibraryOptions {
  /** 框架自带的 skill 所在的目录（测试可以换） */
  builtinDir: string;
  /** 数据目录的 skill 区（用户导入的） */
  userDir: string;
  /** 数据目录（导入的来源不能在它里面：已经在库里的不用再导入，别的区也不该被拷进 skill 区） */
  dataDir: string;
  /** 现在的时间（集合的说明文件里记导入时间） */
  now?: () => string;
  /** 目录改名（就位、挪旧版）；不给用 renameRetrying（测试换掉它来试失败） */
  renameDir?: (from: string, to: string) => void;
  log: (line: string) => void;
}

/**
 * 负责人、秘书提交的一个来源：source 是目录的绝对路径，roots 是提交人自己能放来源的地方（负责人的工作目录和项目档案）；
 * 改的时候 replacing 是要换掉的 skill 名；加的时候给了 rename 就改名进库（只改目录名和 SKILL.md 里的 name 一行，同导入并改名）
 */
export interface SkillSubmission {
  source: string;
  roots: readonly string[];
  replacing?: string;
  rename?: string;
}

/** 校验过的提交：名字、说明，卡上要的来源详情（读卡时算的内容指纹在里面） */
export interface SkillSubmissionReport {
  name: string;
  description: string;
  source: SkillChangeSource;
}

/** 校验过的提交，库里已有同名的时带着同名检查（秘书提交的卡上让用户选覆盖、改名、放弃） */
export interface SkillSubmissionPreview extends SkillSubmissionReport {
  sameName?: SkillSameName;
}

/** skill 目录里记的谁提的 */
type SubmittedBy = NonNullable<SkillEntry["submittedBy"]>;

/** 库里的一个 skill 和它的目录 */
export interface LibrarySkill {
  entry: SkillEntry;
  dir: string;
}

export interface SkillLibrary {
  /** 库里的全部 skill（框架自带的在前），按名字排；集合的成员带着集合名 */
  list(): SkillEntry[];
  /** 整套导入的集合，按名字排 */
  collections(): SkillCollectionEntry[];
  /** 不在库里的那些名字（扫一遍库） */
  missing(names: readonly string[]): string[];
  /**
   * 名字展开成 skill 名（负责人增减 skill 时用）：skill 名原样，集合名换成它的全部成员；
   * 两样都不是的放进 unknown。skill 名和集合名同名时按 skill 算（导入时不让同名）
   */
  expand(names: readonly string[]): { skills: string[]; unknown: string[] };
  /** 名字 → 库里的 skill 和目录（按给的顺序；库里没有的不在结果里，不记日志） */
  find(names: readonly string[]): LibrarySkill[];
  /** 名字 → skill 目录；库里没有的不在结果里（记日志） */
  pathsOf(names: readonly string[]): string[];
  /** 库里的全部 skill 和它们的目录（和 list 一样的顺序；斜杠命令按目录名算） */
  skills(): LibrarySkill[];
  /**
   * 导入：单个 skill（可以改名），或者把一个目录作为集合整套导入。复制一份进 skill 区；
   * 不合规矩的抛 RequestRejected（bad_params / not_found / conflict / not_allowed）
   */
  importFrom(request: ImportSkillBody): ImportSkillResult;
  /**
   * 校验一个负责人提交的来源：和导入同一段逻辑，一个文件都不写。不合规矩的抛 RequestRejected
   * （来源不在 roots 里、经链接绕出去、没有 SKILL.md、带链接、太大、重名……）
   */
  checkSubmission(request: SkillSubmission): SkillSubmissionReport;
  /**
   * 秘书提交时用：和 checkSubmission 同一段校验，但和库里重名（名字、目录名撞上）时不抛，交回同名检查：撞上的是谁、
   * 能不能覆盖（能覆盖的，来源详情按"改"那条算，目录名是现在那个的）。别的不合规矩照样抛
   */
  previewSubmission(request: Omit<SkillSubmission, "replacing" | "rename">): SkillSubmissionPreview;
  /**
   * 用户确认之后真的写 skill 区：重新校验、核对内容指纹（对不上抛 RequestRejected conflict），复制、就位；
   * 改的时候旧版挪进 .history/，换失败了旧版原样挪回去；改名进库的在核完指纹之后改 SKILL.md 里的 name。
   */
  applySubmission(request: SkillSubmission & { fingerprint: string; submittedBy: Omit<SubmittedBy, "at"> }): { dir: string; backup?: string };
  /** 能改、能删的 skill（单个的、不是框架自带的）；不能的抛 RequestRejected，说清为什么 */
  changeable(name: string): LibrarySkill;
  /** 删一个 skill：整个挪进 .history/（留一份旧版）。不能删的抛 RequestRejected */
  removeSkill(name: string): { backup: string };
}

interface FoundCollection {
  entry: SkillCollectionEntry;
  dir: string;
}

interface Scan {
  skills: LibrarySkill[];
  collections: FoundCollection[];
}

/** 导入前把来源整个看一遍得出的：依赖目录、不带的东西、复制的部分有多大 */
interface SourcePlan {
  /** 来源的真实路径（复制从它开始） */
  root: string;
  /** 依赖目录（相对 root，用 / 分隔） */
  deps: string[];
  /** 不带的（相对 root；目录以 / 结尾） */
  excluded: string[];
  files: number;
  bytes: number;
  /** 要复制的文件（相对 root，用 / 分隔）和大小 */
  entries: { rel: string; size: number }[];
}

export function createSkillLibrary(options: SkillLibraryOptions): SkillLibrary {
  const now = options.now ?? (() => new Date().toISOString());
  const moveDir = options.renameDir ?? renameRetrying;

  const scan = (): Scan => {
    const builtin = scanSingles(options.builtinDir, "framework", options.log).toSorted(byName);
    const user = scanUserDir(options.userDir, options.log);
    const taken = new Map<string, LibrarySkill>(builtin.map((f) => [f.entry.name, f]));
    const keep = (f: LibrarySkill): boolean => {
      const other = taken.get(f.entry.name);
      if (!other) {
        taken.set(f.entry.name, f);
        return true;
      }
      options.log(`skill 区里的 ${f.dir} 和${ownerText(other.entry)} 同名，不用它`);
      return false;
    };
    // 先单个导入的，再按集合名一个个集合的成员：同名的留先来的
    const singles = user.singles.toSorted(byName).filter(keep);
    const collections = user.collections.toSorted((a, b) => a.manifest.name.localeCompare(b.manifest.name));
    const members: LibrarySkill[] = [];
    const found: FoundCollection[] = collections.map((c) => {
      const kept = c.members.toSorted(byName).filter(keep);
      members.push(...kept);
      const { name, source, version, description } = c.manifest;
      return { entry: { name, source, version, description, skills: kept.map((m) => m.entry.name) }, dir: c.dir };
    });
    return { skills: [...builtin, ...[...singles, ...members].toSorted(byName)], collections: found };
  };

  /** 单个 skill 进库之前的规矩（SKILL.md、重名、目录名、大小）：设置里导入、负责人提交走同一段，这里过了就能复制 */
  const checkSingle = (plan: SourcePlan, rename: string | undefined) => {
    const { root } = plan;
    const read = readSkill(root);
    if ("problem" in read) throw new RequestRejected("bad_params", read.problem);
    const name = rename ?? read.name;
    const s = scan();
    const owner = ownerOf(s, name);
    if (owner) throw new RequestRejected("conflict", conflictText([{ name, owner }]));
    // skill 区里的目录名：来源的目录名规范化（改了名的取新名字），不拿 skill 名当目录名；它也是斜杠命令名
    const sourceDir = path.basename(root);
    const dirName = rename ?? normalizeSkillDirName(sourceDir);
    if (dirName === "") throw new RequestRejected("bad_params", t("skills.import.emptyDir", { dir: sourceDir }));
    const sameDir = dirOwner(s, dirName);
    if (sameDir) throw new RequestRejected("conflict", dirConflictText(dirName, sourceDir, sameDir));
    const target = path.join(options.userDir, dirName);
    if (fs.existsSync(target)) {
      throw new RequestRejected(
        "conflict",
        dirName === sourceDir ? t("skills.import.dirTaken", { dir: dirName }) : t("skills.import.dirTakenNormalized", { dir: dirName, source: sourceDir }),
      );
    }
    checkSize(plan);
    return { read, name, sourceDir, dirName, target };
  };

  const importSingle = (plan: SourcePlan, rename: string | undefined): ImportSkillResult => {
    const { root } = plan;
    const { read, name, sourceDir, dirName, target } = checkSingle(plan, rename);
    const linked = copyInto(plan, target, dirName, (staging) => {
      if (name !== read.name) renameInSkillFile(path.join(staging, "SKILL.md"), name);
    });
    const renamed = name !== read.name ? t("skills.import.renamed", { original: read.name }) : undefined;
    options.log(`导入了 skill ${name}（来自 ${root}${renamed ? `，${renamed}` : ""}）`);
    const entry: SkillEntry = { name, description: read.description, origin: "imported" };
    const note = [renamed, rename === undefined ? normalizedDirText(sourceDir, dirName) : undefined, freeNameText(name), ...linked.map(linkedText)].filter(Boolean).join(t("skills.sep"));
    return {
      skills: [entry],
      report: [{ name, dir: ".", ok: true, ...(note ? { note } : {}) }],
      linked: linked.map((l) => ({ dir: joinRel(dirName, l.dir), target: l.target })),
      excluded: plan.excluded,
    };
  };

  const importCollection = (plan: SourcePlan, membersRel: string, spec: ImportCollectionSpec): ImportSkillResult => {
    const { root } = plan;
    const membersRoot = path.join(root, ...splitRel(membersRel));
    if (spec.name === RESERVED_COLLECTION_NAME) {
      throw new RequestRejected("bad_params", t("skills.import.reservedCollection", { reserved: RESERVED_COLLECTION_NAME }));
    }
    const s = scan();
    const owner = ownerOf(s, spec.name);
    if (owner) throw new RequestRejected("conflict", t("skills.import.collectionNameTaken", { name: spec.name, owner }));
    const target = path.join(options.userDir, spec.name);
    if (fs.existsSync(target)) throw new RequestRejected("conflict", t("skills.import.collectionDirTaken", { name: spec.name }));

    // 成员：成员目录下面一层每个含 SKILL.md 的目录（隐藏目录、依赖目录不算）
    const candidates = fs
      .readdirSync(membersRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !DEPENDENCY_DIRS.has(e.name) && fs.existsSync(path.join(membersRoot, e.name, "SKILL.md")))
      .map((e) => e.name)
      .toSorted();
    if (candidates.length === 0) throw new RequestRejected("bad_params", t("skills.import.noMembers", { root: membersRoot }));
    const rename = spec.rename ?? {};
    const report: ImportReportLine[] = [];
    /** 成员：来源里的目录名、原来的 skill 名、导入后的名字、就位后的目录名（改了名的是新名字） */
    const members: { dirName: string; original: string; name: string; description: string; finalDir: string }[] = [];
    for (const dirName of candidates) {
      const read = readSkill(path.join(membersRoot, dirName));
      const dir = joinRel(membersRel, dirName);
      if ("problem" in read) {
        report.push({ name: dirName, dir, ok: false, note: t("skills.import.notValid", { problem: read.problem }) });
        continue;
      }
      const name = rename[read.name] ?? read.name;
      // 就位后的目录名（也是斜杠命令名）：改了名的是新名字，否则是来源的目录名规范化
      const finalDir = name === read.name ? normalizeSkillDirName(dirName) : name;
      if (finalDir === "") {
        report.push({ name: read.name, dir, ok: false, note: t("skills.import.emptyMemberDir", { dir: dirName }) });
        continue;
      }
      members.push({ dirName, original: read.name, name, description: read.description, finalDir });
    }
    const strayRenames = Object.keys(rename).filter((k) => !members.some((m) => m.original === k));
    if (strayRenames.length > 0) throw new RequestRejected("bad_params", t("skills.import.strayRenames", { names: strayRenames.join(t("skills.listSep")) }));
    if (members.length === 0) {
      const lines = report.map((r) => t("skills.import.reportLine", { name: r.name, note: r.note ?? "" })).join(t("skills.sep"));
      throw new RequestRejected("bad_params", t("skills.import.noValidMembers", { root: membersRoot, lines }));
    }

    // 重名（按 skill 原来的名字，改了名的按新名字）：和库里已有的、集合名、集合里别的成员；改名后的目录和来源里别的目录撞上也不行
    const conflicts: { name: string; owner: string }[] = [];
    for (const m of members) {
      const existing = ownerOf(s, m.name);
      if (existing) conflicts.push({ name: m.name, owner: existing });
      else if (m.name === spec.name) conflicts.push({ name: m.name, owner: t("skills.conflict.self") });
      else if (members.some((o) => o !== m && o.name === m.name)) conflicts.push({ name: m.name, owner: t("skills.conflict.sameName", { name: m.name }) });
      else if (members.some((o) => o !== m && o.finalDir === m.finalDir)) {
        const other = members.find((o) => o !== m && o.finalDir === m.finalDir)!;
        conflicts.push({ name: m.name, owner: t("skills.conflict.sameDir", { name: other.name, dir: other.dirName, finalDir: m.finalDir }) });
      } else if (m.finalDir !== m.dirName && fs.existsSync(path.join(membersRoot, m.finalDir))) conflicts.push({ name: m.name, owner: t("skills.conflict.sourceDir", { dir: joinRel(membersRel, m.finalDir) }) });
    }
    if (conflicts.length > 0) throw new RequestRejected("conflict", t("skills.import.collectionConflict", { name: spec.name, conflicts: conflictText(dedupeConflicts(conflicts)) }));

    checkSize(plan);
    const renamedDirs = new Map(members.filter((m) => m.finalDir !== m.dirName).map((m) => [joinRel(membersRel, m.dirName), joinRel(membersRel, m.finalDir)]));
    const linked = copyInto(
      plan,
      target,
      spec.name,
      (staging) => {
        if (fs.existsSync(path.join(staging, COLLECTION_MANIFEST))) throw new RequestRejected("bad_params", t("skills.import.manifestClash", { file: COLLECTION_MANIFEST }));
        // 点名改名的成员动目录名和 SKILL.md 的 name 一行；目录名不规范的只改目录名；别的一个字不动
        for (const m of members) {
          if (m.name === m.original && m.finalDir === m.dirName) continue;
          const from = path.join(staging, ...splitRel(joinRel(membersRel, m.dirName)));
          const to = path.join(staging, ...splitRel(joinRel(membersRel, m.finalDir)));
          if (from !== to) renameRetrying(from, to);
          if (m.name !== m.original) renameInSkillFile(path.join(to, "SKILL.md"), m.name);
        }
      },
      (rel) => renamedRel(rel, renamedDirs),
    );
    const manifest: CollectionManifest = {
      format: 1,
      name: spec.name,
      source: spec.source.trim(),
      version: spec.version.trim(),
      description: spec.description.trim(),
      members: members.map((m) => joinRel(membersRel, m.finalDir)),
      ...(members.some((m) => m.name !== m.original) ? { renamed: Object.fromEntries(members.filter((m) => m.name !== m.original).map((m) => [m.name, m.original])) } : {}),
      importedFrom: root,
      importedAt: now(),
      ...(linked.length > 0 ? { linked } : {}),
      ...(plan.excluded.length > 0 ? { excluded: plan.excluded } : {}),
    };
    fs.writeFileSync(path.join(target, COLLECTION_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);

    for (const m of members) {
      const memberDir = joinRel(membersRel, m.finalDir);
      const notes = [
        ...(m.name !== m.original ? [t("skills.import.renamed", { original: m.original })] : []),
        // 目录名不规范的照样改名（不拒绝这个成员），提醒一句相对引用的事
        ...(m.name === m.original && m.finalDir !== m.dirName ? [t("skills.import.dirRenamed", { from: m.dirName, to: m.finalDir })] : []),
        ...[freeNameText(m.name)].filter((note): note is string => note !== undefined),
        ...linked.filter((l) => l.dir === memberDir || l.dir.startsWith(`${memberDir}/`)).map(linkedText),
      ];
      report.push({ name: m.name, dir: joinRel(membersRel, m.dirName), ok: true, ...(notes.length > 0 ? { note: notes.join(t("skills.sep")) } : {}) });
    }
    report.sort((a, b) => a.dir.localeCompare(b.dir));
    const skipped = report.filter((r) => !r.ok).length;
    options.log(`导入了集合 ${spec.name}（来自 ${root}，${members.length} 个 skill${skipped > 0 ? `，跳过 ${skipped} 个不合规的` : ""}）`);
    const skills = members.map((m): SkillEntry => ({ name: m.name, description: m.description, origin: "imported", collection: spec.name })).toSorted((a, b) => a.name.localeCompare(b.name));
    return {
      skills,
      collection: { name: spec.name, source: manifest.source, version: manifest.version, description: manifest.description, skills: skills.map((k) => k.name) },
      report,
      linked: linked.map((l) => ({ dir: joinRel(spec.name, l.dir), target: l.target })),
      excluded: plan.excluded,
    };
  };

  const find = (names: readonly string[]): LibrarySkill[] => {
    const found = scan().skills;
    return names.flatMap((name) => found.find((f) => f.entry.name === name) ?? []);
  };

  /**
   * 负责人提交的来源：要在它自己的工作目录或项目档案里面（是它们下面的一个目录，不是它们本身）。全按真实路径比：
   * 路径上哪一层是目录联接、绕到外面去的，这里就挡住了。这两处多半在数据目录里，所以不查"来源不能在数据目录里"；
   * skill 区自己的东西不用再提交，整个包住数据目录的照旧不行
   */
  const submissionRoot = (source: string, roots: readonly string[]): string => {
    const { dir, realDir } = realSourceDir(source, "skills.import.notDir");
    const realRoots = roots.map((r) => realPathOf(r) ?? path.resolve(r));
    if (realRoots.some((r) => isWithin(r, realDir) && isWithin(realDir, r))) throw new RequestRejected("not_allowed", t("skills.change.sourceIsRoot", { dir }));
    if (!realRoots.some((r) => isWithin(realDir, r))) throw new RequestRejected("not_allowed", t("skills.change.outsideRoots", { dir, roots: realRoots.join(t("skills.listSep")) }));
    if (isWithin(realDir, realPathOf(options.userDir) ?? options.userDir)) throw new RequestRejected("not_allowed", t("skills.change.inSkillArea", { dir }));
    if (isWithin(realPathOf(options.dataDir) ?? options.dataDir, realDir)) throw new RequestRejected("not_allowed", t("skills.import.containsDataDir", { dir }));
    return realDir;
  };

  const changeable = (name: string): LibrarySkill => {
    const skill = scan().skills.find((f) => f.entry.name === name);
    if (!skill) throw new RequestRejected("not_found", t("skills.change.notInLibrary", { name }));
    if (skill.entry.origin === "framework") throw new RequestRejected("not_allowed", t("skills.change.framework", { name }));
    if (skill.entry.collection) throw new RequestRejected("not_allowed", t("skills.change.inCollection", { name, collection: skill.entry.collection }));
    return skill;
  };

  /** 改的时候的规矩：要换的那个能改、新的 SKILL.md 名字不变（工具包里记的是名字）、大小；目录名（斜杠命令）沿用现在的 */
  const checkReplacing = (plan: SourcePlan, replacing: string) => {
    const existing = changeable(replacing);
    const read = readSkill(plan.root);
    if ("problem" in read) throw new RequestRejected("bad_params", read.problem);
    if (read.name !== replacing) throw new RequestRejected("conflict", t("skills.change.nameChanged", { name: replacing, now: read.name }));
    checkSize(plan);
    return { read, existing, dirName: path.basename(existing.dir) };
  };

  /** 进库之前的全部校验（加、改；加的可以改名），算好卡上要的来源详情 */
  const checkPlan = (plan: SourcePlan, replacing: string | undefined, rename?: string) => {
    if (rename !== undefined && !IMPORT_NAME.test(rename)) throw new RequestRejected("bad_params", t("skills.import.badName", { name: rename }));
    const checked = replacing === undefined ? checkSingle(plan, rename) : checkReplacing(plan, replacing);
    const name = "name" in checked ? checked.name : checked.read.name;
    return { checked, report: { name, description: checked.read.description, source: sourceReport(plan, checked.dirName) } satisfies SkillSubmissionReport };
  };

  /**
   * 和库里重名时的同名检查：撞上的是谁；同名的是能改的单个 skill 就能覆盖（来源详情按"改"那条算），
   * 别的（框架自带的、集合成员、集合名、只是目录名撞上）只能改名或放弃
   */
  const sameNameOf = (plan: SourcePlan): SkillSubmissionPreview => {
    const read = readSkill(plan.root);
    if ("problem" in read) throw new RequestRejected("bad_params", read.problem);
    checkSize(plan);
    const s = scan();
    const dirName = normalizeSkillDirName(path.basename(plan.root));
    const owner = ownerOf(s, read.name) ?? dirOwner(s, dirName) ?? t("skills.owner.dir", { dir: dirName });
    if (!s.skills.some((f) => f.entry.name === read.name)) {
      return { name: read.name, description: read.description, source: sourceReport(plan, dirName), sameName: { owner, overwritable: false, problem: t("skills.change.sameNameNotSkill") } };
    }
    try {
      return { ...checkPlan(plan, read.name).report, sameName: { owner, overwritable: true } };
    } catch (err) {
      if (!(err instanceof RequestRejected) || err.code === "internal") throw err;
      return { name: read.name, description: read.description, source: sourceReport(plan, dirName), sameName: { owner, overwritable: false, problem: err.message } };
    }
  };

  /** 旧版放哪：.history/<目录名>@<时间>，时间到毫秒的数字，同一毫秒里再来一次加序号 */
  const historySlot = (dirName: string): string => {
    const historyDir = path.join(options.userDir, HISTORY_DIR);
    fs.mkdirSync(historyDir, { recursive: true });
    const stamp = now().replace(/[^0-9]/g, "").slice(0, 17);
    for (let i = 0; ; i += 1) {
      const slot = path.join(historyDir, i === 0 ? `${dirName}@${stamp}` : `${dirName}@${stamp}-${i}`);
      if (!fs.existsSync(slot)) return slot;
    }
  };

  /** 每个 skill 只留最近几份旧版；里面的目录联接只拆链接，不碰来源里的依赖。删不掉不算失败，记日志 */
  const pruneHistory = (dirName: string): void => {
    const historyDir = path.join(options.userDir, HISTORY_DIR);
    const names = fs.readdirSync(historyDir).filter((n) => n.startsWith(`${dirName}@`)).toSorted();
    for (const name of names.slice(0, Math.max(0, names.length - KEEP_HISTORY))) {
      const old = path.join(historyDir, name);
      try {
        unlinkLinks(old);
        fs.rmSync(old, { recursive: true, force: true });
      } catch (err) {
        options.log(`清理 skill 的旧版 ${old} 出错：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  return {
    list: () => scan().skills.map((f) => f.entry),
    collections: () => scan().collections.map((c) => c.entry),
    missing(names) {
      const known = new Set(scan().skills.map((f) => f.entry.name));
      return names.filter((n) => !known.has(n));
    },
    expand(names) {
      const s = scan();
      const skills: string[] = [];
      const unknown: string[] = [];
      for (const name of names) {
        if (s.skills.some((f) => f.entry.name === name)) skills.push(name);
        else {
          const collection = s.collections.find((c) => c.entry.name === name);
          if (collection) skills.push(...collection.entry.skills);
          else unknown.push(name);
        }
      }
      return { skills: [...new Set(skills)], unknown };
    },
    find,
    skills: () => scan().skills,
    pathsOf(names) {
      const found = find(names);
      for (const name of names) if (!found.some((f) => f.entry.name === name)) options.log(`要装配的 skill ${name} 不在 skill 库里（可能被删了），这次装配不带它`);
      return found.map((f) => f.dir);
    },
    checkSubmission(request) {
      return checkPlan(planSource(submissionRoot(request.source, request.roots), ""), request.replacing, request.rename).report;
    },
    previewSubmission(request) {
      const plan = planSource(submissionRoot(request.source, request.roots), "");
      try {
        return checkPlan(plan, undefined).report;
      } catch (err) {
        if (!(err instanceof RequestRejected) || err.code !== "conflict") throw err;
        return sameNameOf(plan);
      }
    },
    applySubmission(request) {
      const plan = planSource(submissionRoot(request.source, request.roots), "");
      const { checked, report } = checkPlan(plan, request.replacing, request.rename);
      const changedText = t("skills.change.sourceChanged", { dir: plan.root });
      if (report.source.fingerprint !== request.fingerprint) throw new RequestRejected("conflict", changedText);
      const submittedBy: SubmittedBy = { ...request.submittedBy, at: now() };
      // 就位之前再核一次：真要进库的是复制到临时目录的这一份（复制的那一刻来源又变了也挡得住）；改名、记谁提的放在核完之后，不算进指纹
      const seal = (staging: string) => {
        if (stagingPrint(staging) !== request.fingerprint) throw new RequestRejected("conflict", changedText);
        if (request.rename !== undefined) renameInSkillFile(path.join(staging, "SKILL.md"), request.rename);
        fs.writeFileSync(path.join(staging, SUBMISSION_FILE), `${JSON.stringify({ format: 1, ...submittedBy }, null, 2)}\n`);
      };
      const { dirName } = checked;
      let dir: string;
      let backup: string | undefined;
      if ("existing" in checked) {
        const target = checked.existing.dir;
        dir = target;
        copyInto(plan, target, dirName, seal, undefined, (staging) => {
          // 先把旧版挪走，新的再改名就位；第二步失败把旧版挪回去，skill 库和没发生过一样
          const slot = historySlot(dirName);
          moveDir(target, slot);
          try {
            moveDir(staging, target);
          } catch (err) {
            moveDir(slot, target);
            throw err;
          }
          backup = slot;
        });
        pruneHistory(dirName);
      } else {
        dir = checked.target;
        copyInto(plan, checked.target, dirName, seal);
      }
      options.log(`${request.replacing === undefined ? "收进了" : "换掉了"}${request.submittedBy.kind === "secretary" ? "秘书" : "负责人"}提交的 skill ${report.name}（来自 ${plan.root}）`);
      return { dir, ...(backup === undefined ? {} : { backup }) };
    },
    changeable,
    removeSkill(name) {
      const existing = changeable(name);
      const dirName = path.basename(existing.dir);
      try {
        const backup = historySlot(dirName);
        moveDir(existing.dir, backup);
        pruneHistory(dirName);
        options.log(`删了 skill ${name}（旧版在 ${backup}）`);
        return { backup };
      } catch (err) {
        throw new RequestRejected("internal", t("skills.change.removeFailed", { name, message: err instanceof Error ? err.message : String(err) }));
      }
    },
    importFrom(request) {
      const { dir, realDir } = realSourceDir(request.path, request.collection ? "skills.import.notDirCollection" : "skills.import.notDir");
      const realData = realPathOf(options.dataDir) ?? options.dataDir;
      if (isWithin(realDir, realData)) throw new RequestRejected("not_allowed", t("skills.import.inDataDir", { dir }));
      if (isWithin(realData, realDir)) throw new RequestRejected("not_allowed", t("skills.import.containsDataDir", { dir }));
      if (request.collection && request.rename !== undefined) throw new RequestRejected("bad_params", t("skills.import.collectionRename"));
      const newNames = [request.rename, request.collection?.name, ...Object.values(request.collection?.rename ?? {})].filter((n): n is string => n !== undefined);
      const badName = newNames.find((n) => !IMPORT_NAME.test(n));
      if (badName !== undefined) throw new RequestRejected("bad_params", t("skills.import.badName", { name: badName }));
      if (!request.collection) return importSingle(planSource(realDir, ""), request.rename);
      if (fs.existsSync(path.join(realDir, "SKILL.md"))) throw new RequestRejected("bad_params", t("skills.import.isSkill"));
      const membersRel = normalizeRel(request.collection.skillsDir ?? "");
      if (membersRel === undefined) throw new RequestRejected("bad_params", t("skills.import.membersRel", { dir: request.collection.skillsDir }));
      const membersStat = fs.lstatSync(path.join(realDir, ...splitRel(membersRel)), { throwIfNoEntry: false });
      if (!membersStat?.isDirectory() || membersStat.isSymbolicLink()) throw new RequestRejected("bad_params", t("skills.import.noMembersDir", { dir: membersRel }));
      return importCollection(planSource(realDir, membersRel), membersRel, request.collection);
    },
  };

  /**
   * 复制来源到 skill 区的 target：先复制到旁边的临时目录，就位前做 prepare（改名、改 SKILL.md 的 name），
   * 再改名就位，中途出错不留半个。依赖目录、不带的东西不复制（链接本来就不该有，复制时再挡一道）；依赖目录建目录联接指回来源。
   * 返回这些联接（相对 target，用 / 分隔，经 mapRel 换成就位后的位置）。place 是怎么就位（改 skill 的时候要先挪旧版），不给是直接改名
   */
  function copyInto(plan: SourcePlan, target: string, label: string, prepare: (staging: string) => void, mapRel: (rel: string) => string = (rel) => rel, place?: (staging: string) => void): { dir: string; target: string }[] {
    const { root } = plan;
    const skip = new Set([...plan.deps, ...plan.excluded.map((e) => e.replace(/\/$/, ""))]);
    fs.mkdirSync(options.userDir, { recursive: true });
    const staging = path.join(options.userDir, `.importing-${label}-${process.pid}-${Date.now()}`);
    const links: { dir: string; target: string }[] = [];
    try {
      fs.cpSync(root, staging, {
        recursive: true,
        filter: (src) => {
          const rel = path.relative(root, src).split(path.sep).join("/");
          if (rel === "") return true;
          if (skip.has(rel)) return false;
          // 看过之后才冒出来的链接（不该有）：不跟、不复制
          return !fs.lstatSync(src).isSymbolicLink();
        },
      });
      for (const dep of plan.deps) {
        // 建联接前再核一次：依赖目录还是真实目录、还在来源里面
        const abs = path.join(root, ...splitRel(dep));
        const real = realPathOf(abs);
        if (fs.lstatSync(abs).isSymbolicLink() || real === undefined || !isWithin(real, root)) throw new RequestRejected("not_allowed", t("skills.import.depChanged", { dir: dep }));
        fs.symlinkSync(real, path.join(staging, ...splitRel(dep)), "junction");
        links.push({ dir: mapRel(dep), target: real });
      }
      prepare(staging);
      // 刚复制进来的文件被杀毒扫着、目录被索引碰着时，整个目录改名等一会儿重试
      if (place) place(staging);
      else moveDir(staging, target);
    } catch (err) {
      removeStaging(staging);
      if (err instanceof RequestRejected) throw err;
      throw new RequestRejected("internal", t("skills.import.copyFailed", { message: err instanceof Error ? err.message : String(err) }));
    }
    return links;
  }

  /** 删掉没就位的临时目录：先拆掉里面的目录联接（只删链接本身，不碰来源里的依赖） */
  function removeStaging(staging: string): void {
    try {
      if (fs.existsSync(staging)) unlinkLinks(staging);
      fs.rmSync(staging, { recursive: true, force: true });
    } catch (err) {
      options.log(`清理导入到一半的临时目录 ${staging} 出错：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** 来源目录：绝对路径、真实目录（本身不能是符号链接、目录联接）。交回真实路径 */
function realSourceDir(source: string, notDirKey: "skills.import.notDir" | "skills.import.notDirCollection"): { dir: string; realDir: string } {
  if (!path.isAbsolute(source)) throw new RequestRejected("bad_params", t("skills.import.notAbsolute", { path: source }));
  const dir = path.resolve(source);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    throw new RequestRejected("not_found", t("skills.import.notFound", { dir }));
  }
  // 不跟链接：来源目录本身是符号链接、目录联接的不导入
  if (stat.isSymbolicLink()) throw new RequestRejected("not_allowed", t("skills.import.symlink", { dir }));
  if (!stat.isDirectory()) throw new RequestRejected("bad_params", t(notDirKey, { dir }));
  return { dir, realDir: realPathOf(dir) ?? dir };
}

/**
 * 导入前把来源（真实路径）整个看一遍，不跟任何链接：
 * - 复制的部分里有符号链接、目录联接的整个拒绝（列出是哪些、指向哪）；
 * - 依赖目录（node_modules、.venv、venv）本身不能是链接；它里面的链接只认真实路径在来源目录里面的；
 * - .git 和别的隐藏目录、.env*、*.pem、*.key 不带（成员所在的子目录那条路上的不算）；
 * - 数一下复制的部分有多少文件、多少字节。
 */
function planSource(root: string, membersRel: string): SourcePlan {
  const deps: string[] = [];
  const excluded: string[] = [];
  const links: string[] = [];
  const entries: { rel: string; size: number }[] = [];
  let files = 0;
  let bytes = 0;
  const onMembersPath = (rel: string) => membersRel === rel || membersRel.startsWith(`${rel}/`);
  const walk = (dir: string, rel: string, inDep: boolean) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const relPath = joinRel(rel, name);
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) {
        const real = realPathOf(abs);
        // 依赖目录里指向来源里面的链接（npm、pnpm 的工作区链接）：不复制（依赖目录整个按原路径引用），放过
        if (inDep && real !== undefined && isWithin(real, root)) continue;
        links.push(`${relPath} → ${real ?? linkTarget(abs)}`);
        continue;
      }
      if (st.isDirectory()) {
        if (inDep) walk(abs, relPath, true);
        else if (DEPENDENCY_DIRS.has(name)) {
          deps.push(relPath);
          walk(abs, relPath, true);
        } else if (name.startsWith(".") && !onMembersPath(relPath)) excluded.push(`${relPath}/`);
        else walk(abs, relPath, false);
        continue;
      }
      if (inDep) continue;
      if (isSensitiveFile(name) || name === SUBMISSION_FILE) {
        excluded.push(relPath);
        continue;
      }
      files += 1;
      bytes += st.size;
      entries.push({ rel: relPath, size: st.size });
    }
  };
  walk(root, "", false);
  if (links.length > 0) {
    const shown = links.slice(0, 10).join(t("skills.sep"));
    throw new RequestRejected(
      "not_allowed",
      links.length > 10 ? t("skills.import.linksMore", { links: shown, count: links.length, n: links.length }) : t("skills.import.links", { links: shown }),
    );
  }
  return { root, deps, excluded: excluded.toSorted(), files, bytes, entries };
}

/**
 * 内容指纹：每个要复制的文件的相对路径和内容（按路径排好），加上依赖目录的名字（里面的内容按原路径引用、不复制，不算）。
 * onFile 拿到读到的内容（卡上的 SKILL.md 全文、脚本标记和指纹是同一次读的，不会对不上）
 */
function contentPrint(root: string, files: readonly string[], deps: readonly string[], onFile?: (rel: string, content: Buffer) => void): string {
  const hash = createHash("sha256");
  for (const rel of files.toSorted()) {
    const content = fs.readFileSync(path.join(root, ...splitRel(rel)));
    onFile?.(rel, content);
    hash.update(`file:${rel}\0${content.length}\0${createHash("sha256").update(content).digest("hex")}\n`);
  }
  for (const dep of deps.toSorted()) hash.update(`dep:${dep}\n`);
  return hash.digest("hex");
}

/** 复制到临时目录的那一份的指纹：依赖目录在这里已经是目录联接 */
function stagingPrint(staging: string): string {
  const files: string[] = [];
  const deps: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = joinRel(rel, e.name);
      if (e.isSymbolicLink()) deps.push(relPath);
      else if (e.isDirectory()) walk(path.join(dir, e.name), relPath);
      else files.push(relPath);
    }
  };
  walk(staging, "");
  return contentPrint(staging, files, deps);
}

/** 卡上要的来源详情：文件清单（脚本在前，最多 SKILL_CHANGE_FILES_SHOWN 行）、脚本数、SKILL.md 全文、内容指纹 */
function sourceReport(plan: SourcePlan, dirName: string): SkillChangeSource {
  const scripts = new Set<string>();
  let skillMd = "";
  let fingerprint: string;
  try {
    fingerprint = contentPrint(
      plan.root,
      plan.entries.map((e) => e.rel),
      plan.deps,
      (rel, content) => {
        if (isScript(rel, content)) scripts.add(rel);
        if (rel === "SKILL.md") skillMd = content.toString("utf8");
      },
    );
  } catch (err) {
    throw new RequestRejected("bad_params", t("skills.change.unreadable", { message: err instanceof Error ? err.message : String(err) }));
  }
  const files = plan.entries
    .map((e) => ({ path: e.rel, bytes: e.size, ...(scripts.has(e.rel) ? { script: true } : {}) }))
    .toSorted((a, b) => Number(b.script === true) - Number(a.script === true) || a.path.localeCompare(b.path))
    .slice(0, SKILL_CHANGE_FILES_SHOWN);
  return { path: plan.root, dirName, skillMd, files, fileCount: plan.files, totalBytes: plan.bytes, scriptCount: scripts.size, excluded: plan.excluded, linked: plan.deps, fingerprint };
}

function linkTarget(abs: string): string {
  try {
    return fs.readlinkSync(abs);
  } catch {
    return t("skills.link.unreadable");
  }
}

const byName = (a: LibrarySkill, b: LibrarySkill) => a.entry.name.localeCompare(b.entry.name);

/** 已经在库里的这个名字是谁（框架自带的、你导入的、哪个集合里的）；集合名也算 */
function ownerOf(s: Scan, name: string): string | undefined {
  const skill = s.skills.find((f) => f.entry.name === name);
  if (skill) return ownerText(skill.entry);
  if (s.collections.some((c) => c.entry.name === name)) return t("skills.owner.collection", { name });
  return undefined;
}

/**
 * 目录名（斜杠命令名）已经被谁占了：skill 区第一层的单个 skill、集合，和框架自带的 skill（单个的目录名和它们一样，
 * /目录名 就分不清是谁）。集合里的成员不算：目录名和它们相同时，集合里的写成"集合名:目录名"
 */
function dirOwner(s: Scan, dirName: string): string | undefined {
  const skill = s.skills.find((f) => !f.entry.collection && path.basename(f.dir) === dirName);
  if (skill) return ownerText(skill.entry);
  const collection = s.collections.find((c) => path.basename(c.dir) === dirName);
  return collection ? t("skills.owner.collection", { name: collection.entry.name }) : undefined;
}

function dirConflictText(dirName: string, sourceDir: string, owner: string): string {
  const which = dirName === sourceDir ? t("skills.dirName", { dir: dirName }) : t("skills.dirNameNormalized", { source: sourceDir, dir: dirName });
  return t("skills.import.dirConflict", { which, owner, dir: dirName });
}

/** 目录名规范过了：报告里提一句 */
function normalizedDirText(sourceDir: string, dirName: string): string | undefined {
  return sourceDir === dirName ? undefined : t("skills.import.dirNormalized", { dir: dirName, source: sourceDir });
}

/** 拆掉一个目录里的全部链接（只删链接本身，不碰它指向的东西） */
function unlinkLinks(d: string): void {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isSymbolicLink()) fs.rmSync(p, { force: true });
    else if (e.isDirectory()) unlinkLinks(p);
  }
}

/** 库里一个 skill 是谁的：说给人听的 */
function ownerText(entry: SkillEntry): string {
  if (entry.origin === "framework") return t("skills.owner.framework", { name: entry.name });
  if (entry.collection) return t("skills.owner.inCollection", { collection: entry.collection, name: entry.name });
  return t("skills.owner.imported", { name: entry.name });
}

function conflictText(conflicts: readonly { name: string; owner: string }[]): string {
  return t("skills.conflict.text", { conflicts: conflicts.map((c) => t("skills.conflict.item", { name: c.name, owner: c.owner })).join(t("skills.sep")) });
}

function dedupeConflicts(conflicts: readonly { name: string; owner: string }[]) {
  return [...new Map(conflicts.map((c) => [`${c.name}\0${c.owner}`, c])).values()];
}

/** 名字不是 Agent Skills 的写法（小写字母、数字、短横线）：照原样用，报告里提一句 */
function freeNameText(name: string): string | undefined {
  return IMPORT_NAME.test(name) ? undefined : t("skills.import.freeName", { name });
}

function linkedText(link: { dir: string; target: string }): string {
  return t("skills.import.linked", { dir: link.dir, target: link.target });
}

/** 相对路径规范成用 / 分隔、不带首尾的 /；走出根目录的（..）、绝对路径不认 */
function normalizeRel(rel: string): string | undefined {
  const parts = rel.split(/[\\/]+/).filter((p) => p !== "" && p !== ".");
  if (path.isAbsolute(rel) || parts.some((p) => p === "..")) return undefined;
  return parts.join("/");
}

const splitRel = (rel: string): string[] => rel.split("/").filter(Boolean);
const joinRel = (base: string, name: string): string => (base ? `${base}/${name}` : name);

/** 依赖目录在改名之后的位置：落在改了名的成员目录里的跟着换 */
function renamedRel(rel: string, renamed: ReadonlyMap<string, string>): string {
  for (const [from, to] of renamed) {
    if (rel === from) return to;
    if (rel.startsWith(`${from}/`)) return `${to}${rel.slice(from.length)}`;
  }
  return rel;
}

/** 一个目录下面一层的各个 skill 目录（含 SKILL.md 的） */
function scanSingles(root: string, origin: SkillEntry["origin"], log: (line: string) => void): LibrarySkill[] {
  return topDirs(root).flatMap((dir) => {
    if (!fs.existsSync(path.join(dir, "SKILL.md"))) return [];
    const found = foundSkill(dir, origin, undefined, log);
    return found ? [found] : [];
  });
}

/** skill 区：一层的单个 skill（含 SKILL.md），和集合（含 ergo-collection.json） */
function scanUserDir(root: string, log: (line: string) => void): { singles: LibrarySkill[]; collections: { manifest: CollectionManifest; dir: string; members: LibrarySkill[] }[] } {
  const singles: LibrarySkill[] = [];
  const collections: { manifest: CollectionManifest; dir: string; members: LibrarySkill[] }[] = [];
  for (const dir of topDirs(root)) {
    if (fs.existsSync(path.join(dir, "SKILL.md"))) {
      const found = foundSkill(dir, "imported", undefined, log);
      if (found) singles.push(found);
      continue;
    }
    const manifestFile = path.join(dir, COLLECTION_MANIFEST);
    if (!fs.existsSync(manifestFile)) continue;
    const manifest = readManifest(manifestFile, log);
    if (!manifest) continue;
    const members = manifest.members.flatMap((rel) => {
      const normalized = normalizeRel(rel);
      if (normalized === undefined || normalized === "") {
        log(`集合 ${manifest.name} 的成员目录 ${rel} 不对（要写集合目录下面的相对路径），不认`);
        return [];
      }
      const memberDir = path.join(dir, ...splitRel(normalized));
      if (!fs.existsSync(path.join(memberDir, "SKILL.md"))) {
        log(`集合 ${manifest.name} 的成员 ${rel} 没有 SKILL.md（可能被删了），不认`);
        return [];
      }
      const found = foundSkill(memberDir, "imported", manifest.name, log);
      return found ? [found] : [];
    });
    collections.push({ manifest, dir, members });
  }
  return { singles, collections };
}

/** 下面一层的目录（导入到一半留下的临时目录、隐藏目录不算） */
function topDirs(root: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    // 目录还没有（还没导入过）
    return [];
  }
  return names.filter((n) => !n.startsWith(".")).flatMap((n) => {
    const dir = path.join(root, n);
    return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? [dir] : [];
  });
}

function foundSkill(dir: string, origin: SkillEntry["origin"], collection: string | undefined, log: (line: string) => void): LibrarySkill | undefined {
  const read = readSkill(dir);
  if ("problem" in read) {
    log(`skill 目录 ${dir} 不认：${read.problem}`);
    return undefined;
  }
  const submittedBy = origin === "imported" && !collection ? readSubmission(dir) : undefined;
  return { entry: { name: read.name, description: read.description, origin, ...(collection ? { collection } : {}), ...(submittedBy ? { submittedBy } : {}) }, dir };
}

/** skill 目录里记的谁提的；没有、读不懂的算用户自己导入的 */
function readSubmission(dir: string): SubmittedBy | undefined {
  const file = path.join(dir, SUBMISSION_FILE);
  if (!fs.existsSync(file)) return undefined;
  try {
    const { kind, title, at } = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SubmittedBy>;
    if (typeof at !== "string") return undefined;
    if (kind === "secretary") return { kind, at };
    return (kind === "project" || kind === "task") && typeof title === "string" ? { kind, title, at } : undefined;
  } catch {
    return undefined;
  }
}

function readManifest(file: string, log: (line: string) => void): CollectionManifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log(`集合的说明文件 ${file} 读不了：${err instanceof Error ? err.message : String(err)}，这个集合不认`);
    return undefined;
  }
  if (manifestShape.check(parsed)) return parsed;
  log(`集合的说明文件 ${file} 不对：${manifestShape.firstError(parsed)}，这个集合不认`);
  return undefined;
}

/**
 * 读一个 skill 目录的 SKILL.md：名字和说明。名字照原样（和 pi 一样：不合 Agent Skills 写法的只告警、照常用），
 * 只挡空的、太长的、带控制字符的
 */
function readSkill(dir: string): { name: string; description: string } | { problem: string } {
  const file = path.join(dir, "SKILL.md");
  let text: string;
  try {
    if (fs.statSync(file).size > SKILL_FILE_MAX) return { problem: t("skills.read.tooBig", { kb: SKILL_FILE_MAX / 1024 }) };
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { problem: t("skills.read.noFile", { dir }) };
  }
  const front = frontmatter(text);
  if (!front) return { problem: t("skills.read.noFrontmatter") };
  const name = front.name ?? path.basename(dir);
  if (name.trim() === "") return { problem: t("skills.read.emptyName") };
  if ([...name].length > SKILL_NAME_MAX) return { problem: t("skills.read.nameTooLong", { max: SKILL_NAME_MAX }) };
  if ([...name].some((c) => (c.codePointAt(0) ?? 0) < 0x20 || c === "\u007f")) return { problem: t("skills.read.controlChars") };
  const description = front.description?.trim();
  if (!description) return { problem: t("skills.read.noDescription") };
  return { name, description };
}

/**
 * SKILL.md 开头的 frontmatter 里的 name、description（YAML 的一小部分：单行的值，可以带引号；
 * 说明写成多行的 `>`、`|` 块也认）
 */
export function frontmatter(text: string): { name?: string; description?: string } | undefined {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return undefined;
  const out: { name?: string; description?: string } = {};
  const body = lines.slice(1, end);
  for (let i = 0; i < body.length; i++) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(body[i]!);
    if (!m) continue;
    const key = m[1]!;
    if (key !== "name" && key !== "description") continue;
    let value = m[2]!.trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block: string[] = [];
      while (i + 1 < body.length && (/^\s+\S/.test(body[i + 1]!) || body[i + 1]!.trim() === "")) block.push(body[++i]!.trim());
      value = block.join(value.startsWith(">") ? " " : "\n").trim();
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** SKILL.md 去掉开头的 frontmatter 之后的正文（/目录名、/skill:目录名 展开时用） */
export function skillBody(text: string): string {
  const m = /^﻿?---[ \t]*\r?\n[\s\S]*?^---[ \t]*(?:\r?\n|$)/m.exec(text);
  return (m && m.index === 0 ? text.slice(m[0].length) : text).trim();
}

/**
 * 导入并改名：SKILL.md 的 frontmatter 里的 name 换成新名字（没有 name 这一行就在开头补一行），别的一个字不动
 * （换行符、BOM、正文照旧）
 */
export function withSkillName(text: string, name: string): string {
  const m = /^(﻿?---[ \t]*(\r?\n))([\s\S]*?)(^---[ \t]*$)/m.exec(text);
  if (!m || m.index !== 0) return text;
  const [, open, eol, body] = m as unknown as [string, string, string, string];
  const line = /^name[ \t]*:.*$/m;
  const next = line.test(body) ? body.replace(line, `name: ${name}`) : `name: ${name}${eol}${body}`;
  return `${open}${next}${text.slice(open.length + body.length)}`;
}

function renameInSkillFile(file: string, name: string): void {
  fs.writeFileSync(file, withSkillName(fs.readFileSync(file, "utf8"), name));
}

/** 复制的部分超过上限的拒绝（依赖目录、不带的东西不算） */
function checkSize(plan: SourcePlan): void {
  if (plan.files > IMPORT_MAX_FILES || plan.bytes > IMPORT_MAX_BYTES) {
    throw new RequestRejected(
      "bad_params",
      t("skills.import.tooBig", { files: plan.files, kb: Math.round(plan.bytes / 1024), maxFiles: IMPORT_MAX_FILES, maxMb: IMPORT_MAX_BYTES / 1024 / 1024 }),
    );
  }
}
