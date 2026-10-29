// 原型里的 agent 运行时（286、289 号票）：内核自带的 pi，加上 Claude Code 插件登记的（能力清单、设置项、模型照守护进程的
// claude-code/runtime.ts、settings.ts；模型列表是编的，真的是 Claude Code 起来时报回的）。"个人博客"项目的维护者用 Claude Code
// （卡上标出、⚙ 里多权限模式和思考档位、输入框的候选是 Claude Code 的命令）。
import { type AgentRuntimeView, PI_RUNTIME_ID, RUNTIME_OPERATIONS, type RuntimeCapabilities, type SlashCommandEntry } from "../state/index.ts";

/** Claude Code 运行时的 id（守护进程 claude-code/api.ts 的 CLAUDE_CODE_RUNTIME_ID） */
export const FAKE_CLAUDE_CODE = "claude-code";

/** 用 Claude Code 的维护者（原型里编的）：个人博客项目的维护者、从 Claude Code 会话接管来的"修 CI 的 flaky 测试"（290 号票） */
export const FAKE_CLAUDE_MAINTAINERS: readonly string[] = ["project-blog", "tm-flaky"];

const caps = (yes: readonly string[]): RuntimeCapabilities => Object.fromEntries(RUNTIME_OPERATIONS.map((op) => [op, yes.includes(op)])) as RuntimeCapabilities;

/** 设置 · Claude Code 里定的新建时的默认文件夹（305 号票，原型里只在内存里；编的一个） */
let fakeDefaultFolder: string | undefined = "D:\\work\\claude";

/** 改默认文件夹（原型里只核对是不是从盘符写起的绝对路径；真的还看在不在、是不是文件夹、在不在数据目录和程序目录里） */
export function setFakeDefaultFolder(folder: string | null): void {
  if (folder !== null && folder.trim() !== "" && !/^[a-z]:[\\/]/i.test(folder.trim())) throw new Error(`「${folder}」不是完整的路径：要从盘符写起（比如 D:\\work\\ledger）`);
  fakeDefaultFolder = folder === null || folder.trim() === "" ? undefined : folder.trim();
}

/** 原型的运行时清单（GET /api/runtimes 的样子） */
export function fakeRuntimes(): AgentRuntimeView[] {
  const inherit = { value: "inherit", title: "跟 Claude Code 自己的设置" };
  return [
    { id: PI_RUNTIME_ID, title: "pi", available: true, capabilities: caps(RUNTIME_OPERATIONS.filter((op) => !["slash_passthrough", "take_over", "remote_control", "live_toolkit", "rewind_files"].includes(op))), settings: [] },
    {
      id: FAKE_CLAUDE_CODE,
      title: "Claude Code",
      plugin: "claude-code",
      available: true,
      // 293 号票：撤回、切分支能做，撤回时恢复文件；分支摘要它自己不写（二狗写）
      capabilities: caps(["interject", "compact", "rollback", "branch_switch", "rewind_files", "thinking_levels", "slash_passthrough", "take_over", "live_toolkit"]),
      models: [
        { id: "opus", title: "Opus" },
        { id: "sonnet", title: "Sonnet" },
        { id: "haiku", title: "Haiku" },
      ],
      settings: [
        {
          id: "permission_mode",
          title: "权限模式",
          options: [
            inherit,
            { value: "default", title: "默认（照你的放行规则）" },
            { value: "acceptEdits", title: "自动接受改文件" },
            { value: "plan", title: "计划模式（只看不改，先出计划）" },
            { value: "auto", title: "自动（模型判断要不要放行）" },
            { value: "dontAsk", title: "不问（没放行的一律拒绝）" },
          ],
          default: "inherit",
        },
        {
          id: "effort",
          title: "思考档位",
          options: [inherit, { value: "low", title: "低" }, { value: "medium", title: "中" }, { value: "high", title: "高" }, { value: "xhigh", title: "很高" }, { value: "max", title: "最高" }],
          default: "inherit",
        },
      ],
      // 305 号票：新建时选工作文件夹
      workFolder: fakeDefaultFolder === undefined ? {} : { defaultFolder: fakeDefaultFolder },
    },
  ];
}

/**
 * Claude Code 报的斜杠命令（原型里编的几条，原文照 Claude Code 自己的）。310 号票：守护进程给的样子——内置命令按中文说明表换成中文、
 * 原文留在 originalDescription，参数提示也换；用户自己的命令（/deploy-notes）是二狗的模型翻的，参数提示照它报的
 */
export const FAKE_CLAUDE_COMMANDS: SlashCommandEntry[] = [
  {
    kind: "runtime",
    text: "/compact",
    name: "compact",
    description: "压缩对话：清掉历史、只在上下文里留一份摘要；后面可以写摘要时要特别留意什么",
    originalDescription: "Clear conversation history but keep a summary in context",
    argumentHint: "[摘要时要特别留意的]",
    collection: "Claude Code",
  },
  { kind: "runtime", text: "/context", name: "context", description: "看上下文用了多少：按类别画成彩色格子", originalDescription: "Visualize current context usage as a colored grid", collection: "Claude Code" },
  { kind: "runtime", text: "/review", name: "review", description: "评审一个拉取请求（PR）", originalDescription: "Review a pull request", argumentHint: "[PR 号]", collection: "Claude Code" },
  {
    kind: "runtime",
    text: "/security-review",
    name: "security-review",
    description: "对当前分支还没合并的改动做一次安全审查",
    originalDescription: "Complete a security review of the pending changes on the current branch",
    collection: "Claude Code",
  },
  { kind: "runtime", text: "/usage", name: "usage", description: "看订阅额度用了多少", originalDescription: "Show plan usage limits", collection: "Claude Code" },
  {
    kind: "runtime",
    text: "/deploy-notes",
    name: "deploy-notes",
    description: "给当前分支写发布说明：改了什么、上线前要注意什么（假数据）",
    originalDescription: "Write release notes for the current branch: what changed and what to watch before shipping",
    argumentHint: "[version]",
    collection: "Claude Code",
  },
];

/** 用 Claude Code 的维护者工具包里的 skill（291 号票：写法 /ergo:<目录名>；310 号票：英文说明是二狗的模型翻的） */
export const FAKE_CLAUDE_SKILLS: SlashCommandEntry[] = [
  { kind: "skill", text: "/ergo:demo-tdd", name: "demo-tdd", description: "先写测试再写实现：红、绿、重构（假数据）", originalDescription: "Test-driven development: red, green, refactor" },
  { kind: "skill", text: "/ergo:yt-dlp", name: "yt-dlp", description: "下载视频和图片（假数据）" },
];
