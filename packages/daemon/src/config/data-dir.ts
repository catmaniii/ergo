// 数据目录的各区（规格第 18 节）。每类东西有固定归宿，任何模块都从这里取路径，不自己拼。
// 312 号票：配置文件 config/ergo.json、事件库 db/ergo.db 以前叫旧名字；新名字的不在、旧名字的在时用旧的（迁移脚本会改名，这是兜底）。
import path from "node:path";
import { pathOrOld } from "./old-names.ts";

export interface DataDirLayout {
  root: string;
  /** 守护进程的 pid 文件（pid、进程启动时间、端口），LSM 的 stop 钩子据此核对要结束的进程 */
  pidFile: string;
  /** 配置（含 MCP 登记、关注类别注册表） */
  config: string;
  /** 配置文件 config/ergo.json（312 号票之前的旧名字还在、新的不在时是旧的） */
  configFile: string;
  /** 关注类别注册表里用户的部分：内置类别的调整和自定义类别（守卫，03 号票） */
  watchCategoriesFile: string;
  /** 个人工作日历：用户的额外上班规则和手动标记（个人数据，29 号票） */
  workdayCalendarFile: string;
  /** 个人助理的名字（43 号票）：用户给它起的名字，界面上处处用它，秘书的系统提示里也有 */
  assistantNameFile: string;
  /**
   * 角色（248 号票，config/agent-roles.json）：{ format: 1, defaultRoleId, roles: [{ id, name, voiceId? }], assignments }。
   * 名字 + 音色绑成一个角色，每个 agent 只选一个；没指定就跟默认角色（名字是全局的名字、音色是全局选中的参考音色）。
   * 只由运行时写（设置 · 角色与声音、会话里的 ⚙），在配置区里，agent 写不了
   */
  agentRolesFile: string;
  /**
   * 我的名字（用户自己的名字，249 号票，config/user-name.json）：{ format: 1, name }。各 agent 的系统提示里知道该称呼用户什么，
   * 界面上能用则用；没有这个文件就是没设。只由运行时写（设置接口）
   */
  userNameFile: string;
  /**
   * 记忆的设置（264 号票，config/memory-settings.json）：{ format: 1, wovenQuestions }——秘书回话时顺口问开不开。
   * 没有这个文件就是默认（开着）。只由运行时写（设置接口）
   */
  memorySettingsFile: string;
  /**
   * 新建时的默认工作文件夹（305 号票，config/work-folders.json）：{ format: 1, defaults: { <运行时 id>: <文件夹> } }——能选工作文件夹的运行时
   * （Claude Code）新的任务、项目默认在它下面新开一个子文件夹。没有这个文件就是都没设。只由运行时写（设置接口）
   */
  workFoldersFile: string;
  /**
   * 旧的名字音色配置（241 号票，config/agent-profiles.json）：248 号票第一次迁移到角色表时读一次，之后保留不删（回滚用），
   * 守护进程不再读它
   */
  agentProfilesFile: string;
  /** 全局语言设置（168 号票）：设置里选的语言（语言代码）；只由运行时写（设置接口） */
  languageFile: string;
  /**
   * 数据源的用法开关（295 号票，config/data-sources.json）：{ format: 1, usages: { <数据源 id>: { query?, import? } } }——按需查、导入
   * 各开没开（没写的按数据源登记的默认）。只由运行时写（设置 · 数据源）
   */
  dataSourcesFile: string;
  /** 设置里的"模型"（73 号票）：默认模型、各个 agent 的覆盖、思考档位、设置页改的看图能力；只由运行时写（设置接口） */
  modelSettingsFile: string;
  /** 设置里 agent 的联网搜索、读网页（154 号票；162 号票起是 DeepSeek、浏览器、agent-browser 三种方式的队列）；只由运行时写（设置接口） */
  webSettingsFile: string;
  /** MCP 登记（27 号票）：登记了才能写进工具包；二狗只读（239 号票起用户确认之后由运行时写，见 mcp/writer.ts） */
  mcpFile: string;
  /** MCP 登记的历史区（239 号票）：每次改之前把旧的复制一份进来（mcp-<时间>.json），只留最近几份 */
  mcpHistoryDir: string;
  /** 秘书用的 skill（72 号票）：设置里的 skill 库页勾选的名单；没有这个文件按默认的（agent-browser、yt-dlp） */
  secretarySkillsFile: string;
  /** 授权的文件夹（134 号票，138 号票起叫这个名字）：秘书和"浏览"里的二狗找文件时搜它们，设置 · 浏览与填框里能看能改 */
  localFoldersFile: string;
  /**
   * 用户改过的各 agent 的系统提示（71 号票，<编号>.md）：有就用它，没有用程序目录里默认的。只由设置页写（用户也可以手改），
   * 在配置区里，agent 写不了
   */
  prompts: string;
  /**
   * 每个 agent 单独的提示词（114 号票，会话里的 ⚙）：<agent id>.append.md（接在通用模板后面）或 <agent id>.replace.md（整份自己写的）。
   * 只由面板写（用户也可以手改），在配置区里，agent 写不了
   */
  agentPrompts: string;
  /**
   * 用户放的语言文件（168 号票，即 ~/.ergo/locales/）：每种语言一个目录（目录名是语言代码），和自带的同名是改译法、不同名是新语言；
   * 守护进程每隔一会儿看一眼，放进来不用重启。个人数据，随数据目录备份
   */
  locales: string;
  /** 更新任务交付、运行时校验后导入的节假日数据（<地区>-<年>.json，和框架自带的同一格式，29 号票） */
  holidaysDir: string;
  /** 密钥：只由 LSM 注入，agent 读不到 */
  secrets: string;
  /**
   * 数据源的密钥（295 号票，密钥区里的 data-sources/<数据源 id>.json）：数据源插件经 ctx.secrets 存的 API Key、应用专用密码、私密地址。
   * 只由守护进程读写（不经 LSM 注入环境），agent 读不到（守卫把整个密钥区挡在外面）；不进备份（密钥区整个不进）
   */
  dataSourceSecrets: string;
  /**
   * 共用的导入文件夹（295 号票）：手动导出的文件（账单、数据副本、Takeout、vCard……）放进来，守护进程认出是哪个数据源的、交给它导入，
   * 导完挪到 importedDir（"已导入"），认不出的留在原地。整个不进备份（nonBackupEntries：Takeout 这类导出可能几十 GB，导入后的数据已经在事件和素材里）
   */
  imports: string;
  /** 导入文件夹里的"已导入"：导完的文件挪到这里（重名的加序号） */
  importedDir: string;
  /** 数据库：内核的 ergo.db、materials.db（推理库 338 号票起在记忆插件自己的目录里，见 rgDb） */
  db: string;
  /** 事件库 db/ergo.db（事件日志和派生视图；312 号票之前的旧名字还在、新的不在时是旧的） */
  eventsDb: string;
  /**
   * 素材库 db/materials.db（内核的，ADR-0006、ADR-0035）：素材和索引的单独的库。
   * **它不是记忆插件的数据**：记忆插件的数据在 <数据目录>/memory/<插件 id>/（见 memory 和 memoryProviderDir），
   * 素材库归内核、记忆插件只是往里采（129 号票起）。这个名字以前叫 db/memory.db，和记忆插件的目录撞了、容易误解
   */
  materialsDb: string;
  /**
   * 素材库的老位置 db/memory.db（改名之前一直开的是它）：引擎不再打开它，只有启动时的迁移读一次、搬成 materials.db
   * （见 materials/migrate-materials.ts）。搬成了它就不在了；迁移没搬成（权限、占用）时它还在，下次启动再试
   */
  legacyMemoryDb: string;
  /**
   * 记忆插件的数据目录都在这里：<数据目录>/memory/<插件 id>/，每个插件自己一格（ADR-0034；默认会意 subtext，
   * 按 memoryProviderDir(id) 算）。内核只整目录备份、恢复、迁移，不读里面的格式
   */
  memory: string;
  /**
   * 推理库（225 号票）：记忆 PoC 的证据、事实、推断、用户模型、问题箱和每晚整理报告。
   * 338 号票起住在会意插件自己的数据目录里（<数据目录>/memory/subtext/rg.db，memoryProviderDir("subtext") 下面）。
   * 比 materials.db 小得多（不含原文），随备份快照一起带走；记忆插件停用、移除都保留
   */
  rgDb: string;
  /**
   * 推理库的老位置 db/rg.db（338 号票之前在那儿）：引擎不再打开它，只有启动时的迁移读一次、搬进插件目录。
   * 搬成了它就不在了；迁移没搬成（权限、占用）时它还在，下次启动再试（见 memory/migrate-rg.ts）
   */
  legacyRgDb: string;
  /** pi 会话 JSONL，每个 agent 一个子目录 */
  sessions: string;
  projects: string;
  /** 不属于任何项目的任务的产出 */
  outputs: string;
  /** 素材区：原文副本（originals/）、按内容哈希存的媒体 */
  materials: string;
  /** 素材区里按内容哈希存的媒体（图片、文件附件）：文件名就是入库版本的 sha256，同样的内容只存一份 */
  media: string;
  /** 模型区：语义检索用的向量模型文件（bge-m3，设置 · 组件或下载命令放进来；不随仓库分发，可以重新下载） */
  models: string;
  /**
   * 组件区（323 号票）：按需下载的大件（语音识别、语音合成、Claude Code 接入……；向量模型照旧装在模型区）、装着的记录 installed.json、
   * 下载用的临时目录 .staging/。不随安装包发布、能重新下载，不进备份
   */
  components: string;
  /** 用户自己加的 skill */
  skills: string;
  /**
   * 参考音色（32 号票，个人数据）：每个音色一个以英文 id 命名的目录（reference.wav、reference.txt、voice.json），
   * 现在用哪一个记在 current.json。audio.cpp 读不了带中文的路径，所以目录和文件名都是英文，显示名另存在 voice.json 里
   */
  voices: string;
  /** 临时区（含秘书草稿区）；不进备份 */
  tmp: string;
  /** 临时区里还没收尾的分片上传 */
  uploads: string;
  /** 秘书的草稿区：临时区里秘书专用的一格，也是秘书的工作目录（和其他临时文件一样 7 天后清理，11 号票） */
  scratch: string;
  backups: string;
  logs: string;
  /** 事件来源的状态（77 号票）：本机文件夹变化的比对底子（folders/<订阅>.json），开机比对补发停机期间的变化用 */
  eventSources: string;
  /** 缓存区（140 号票）：随时能重新做出来的东西，不进备份 */
  cache: string;
  /** 项目的服务首页的缩略图（140 号票，<应用名>.jpg 和截图时间 <应用名>.json）：守护进程自己截的，不进素材、媒体库 */
  serviceThumbnails: string;
  /** 网页候选的缩略图（149 号票，<哈希>.jpg / .png）：守护进程缩的，24 小时没用、总量超了就清 */
  pageThumbnails: string;
  /** 斜杠命令说明的译文（310 号票，按"语言 + 命令名 + 原文"）：二狗的模型翻的，随时能重新翻出来 */
  slashTranslationsFile: string;
}

/**
 * 默认的记忆插件 id（会意 / Subtext，337 号票；配置 memory.provider 不写、写坏了都是它）。
 * 它同时是插件数据目录的名字：<数据目录>/memory/subtext/
 */
export const DEFAULT_MEMORY_PROVIDER_ID = "subtext";

/**
 * 一个记忆插件自己的数据目录：<数据目录>/memory/<插件 id>/（ADR-0034；默认会意 subtext）。
 * 推理库、插件以后的别的文件都放这一格里；宿主（memory/provider/host.ts）、启动时的迁移（组合根里调
 * memory/migrate-rg.ts）和验收、整理这些工具都从这里算，不各自拼 "memory/subtext"——
 * 换插件时只换 id，路径跟着变
 */
export function memoryProviderDir(dataDir: string, id: string = DEFAULT_MEMORY_PROVIDER_ID): string {
  return path.join(path.resolve(dataDir), "memory", id);
}

export function dataDirLayout(dataDir: string): DataDirLayout {
  const root = path.resolve(dataDir);
  const config = path.join(root, "config");
  const materials = path.join(root, "materials");
  const tmp = path.join(root, "tmp");
  return {
    root,
    pidFile: path.join(root, "daemon.pid"),
    config,
    configFile: pathOrOld(path.join(config, "ergo.json")),
    watchCategoriesFile: path.join(config, "watch-categories.json"),
    workdayCalendarFile: path.join(config, "workday-calendar.json"),
    assistantNameFile: path.join(config, "assistant-name.json"),
    userNameFile: path.join(config, "user-name.json"),
    memorySettingsFile: path.join(config, "memory-settings.json"),
    workFoldersFile: path.join(config, "work-folders.json"),
    agentProfilesFile: path.join(config, "agent-profiles.json"),
    agentRolesFile: path.join(config, "agent-roles.json"),
    languageFile: path.join(config, "language.json"),
    dataSourcesFile: path.join(config, "data-sources.json"),
    modelSettingsFile: path.join(config, "model-settings.json"),
    webSettingsFile: path.join(config, "web-settings.json"),
    mcpFile: path.join(config, "mcp.json"),
    mcpHistoryDir: path.join(config, ".history"),
    secretarySkillsFile: path.join(config, "secretary-skills.json"),
    localFoldersFile: path.join(config, "local-folders.json"),
    prompts: path.join(config, "prompts"),
    agentPrompts: path.join(config, "agent-prompts"),
    holidaysDir: path.join(config, "holidays"),
    locales: path.join(root, "locales"),
    secrets: path.join(root, "secrets"),
    dataSourceSecrets: path.join(root, "secrets", "data-sources"),
    imports: path.join(root, "imports"),
    importedDir: path.join(root, "imports", "imported"),
    db: path.join(root, "db"),
    eventsDb: pathOrOld(path.join(root, "db", "ergo.db")),
    materialsDb: path.join(root, "db", "materials.db"),
    legacyMemoryDb: path.join(root, "db", "memory.db"),
    memory: path.join(root, "memory"),
    rgDb: path.join(memoryProviderDir(root), "rg.db"),
    legacyRgDb: path.join(root, "db", "rg.db"),
    sessions: path.join(root, "sessions"),
    projects: path.join(root, "projects"),
    outputs: path.join(root, "outputs"),
    materials,
    media: path.join(materials, "media"),
    models: path.join(root, "models"),
    components: path.join(root, "components"),
    skills: path.join(root, "skills"),
    voices: path.join(root, "voices"),
    tmp,
    uploads: path.join(tmp, "uploads"),
    scratch: path.join(tmp, "scratch"),
    backups: path.join(root, "backups"),
    logs: path.join(root, "logs"),
    eventSources: path.join(root, "event-sources"),
    cache: path.join(root, "cache"),
    serviceThumbnails: path.join(root, "cache", "service-thumbnails"),
    pageThumbnails: path.join(root, "cache", "page-thumbnails"),
    slashTranslationsFile: path.join(root, "cache", "slash-translations.json"),
  };
}

/**
 * 不进备份的东西：数据目录第一层的这几项（名字小写）——密钥区、临时区、本机备份区、pid 文件（规格第 18 节），
 * 还有模型区（向量模型几百 MB，能用 `npm run download-model` 重新下载）、组件区（323 号票：按需下载的大件，能重新下载）、缓存区（140 号票：服务首页的缩略图，随时能重截）、
 * 导入文件夹连同"已导入"（295 号票：手动导出的原始文件，Takeout 这类可能几十 GB；导入后的数据已经在事件和素材里，原始文件用户手里有）。
 * 快照不收它们；从快照恢复时它们也原地不动（不挪走、不覆盖）。两边用同一份，免得一边改了另一边没跟上。
 */
export function nonBackupEntries(layout: DataDirLayout): ReadonlySet<string> {
  return new Set([layout.secrets, layout.tmp, layout.backups, layout.pidFile, layout.models, layout.components, layout.cache, layout.imports].map((p) => path.relative(layout.root, p).toLowerCase()));
}
