// 原型里设置 · 系统提示（71 号票）的假数据：几份编的提示（文字都是示例，真的由守护进程从 md 文件读），改动只在内存里。
// 占位符的检查和守护进程用同一个函数（状态层的 checkSystemPromptDraft），写错了照样拒收。
import { ASSISTANT_NAME_MARK, checkSystemPromptDraft, normalizePromptSource, type SystemPromptDetail, type SystemPromptList, type SystemPromptPlaceholder } from "../state/index.ts";

const USER_DIR = "D:\\示例\\数据目录\\config\\prompts";

const COMMON: SystemPromptPlaceholder[] = [
  ...["web_search", "web_fetch", "view_board", "submit_plan", "report_progress"].map((name) => ({ name, kind: "value" as const, description: "工具名", common: true })),
  { name: "系统通知标记", kind: "value", description: "运行时发给 agent 的消息开头的标记", common: true },
];

type Seed = Omit<SystemPromptDetail, "content" | "state" | "usedIn" | "userFile">;

const SEEDS: Seed[] = [
  {
    id: "prefix",
    title: "前缀",
    description: "加在每个 agent 的系统提示最前面，默认是空的；范围审视、压缩指令和交接摘要不加。不能写占位符",
    group: "prefix",
    defaultContent: "",
    placeholders: [],
    allowEmpty: true,
  },
  {
    id: "secretary",
    title: ASSISTANT_NAME_MARK,
    description: "对话入口的系统提示。改了之后手头这一条处理完就按新的重新拉起，从下一轮起生效",
    group: "role",
    defaultContent: [
      "（原型里的示例文字）你是用户的个人助理，是默认的对话入口。用中文和用户对话，回答直接、简洁。",
      "用户叫你「{{名字}}」：自我介绍、说到你自己时用这个名字。",
      "{{#对话审批开着}}",
      "草稿区外面的文件读之前要先经用户批准。",
      "{{/对话审批开着}}",
      "{{^对话审批开着}}",
      "草稿区外面的文件可以读，运行时照常记录。",
      "{{/对话审批开着}}",
      "要最新的信息时用 {{web_search}} 搜索，摘要不够就用 {{web_fetch}} 读网页。说任务进展时用 {{view_board}} 查看板为准。",
    ].join("\n"),
    placeholders: [
      { name: "名字", kind: "value", description: "用户给它起的名字（设置里改，默认“二狗”）" },
      { name: "对话审批开着", kind: "flag", description: "配置 guard.conversationApprovals 是 on 时成立（默认关着）" },
      ...COMMON,
    ],
    allowEmpty: false,
  },
  {
    id: "task-maintainer",
    title: "长程任务的维护者",
    description: "任务自己的维护者（不属于项目的长程任务）：起草计划、执行都用这一份",
    group: "role",
    defaultContent: ["（原型里的示例文字）你是一个任务的维护者：这个任务由你起草计划、之后由你执行。用中文。", "收到任务书后起草计划，用 {{submit_plan}} 交出。", "{{> plan-writing}}"].join("\n"),
    placeholders: [{ name: "拉回次数", kind: "value", description: "被拉回几次后再犯就停下（配置 tasks.thresholds.pullBacks）" }, { name: "plan-writing", kind: "partial", description: "计划的写法" }, ...COMMON],
    allowEmpty: false,
  },
  {
    id: "project-maintainer",
    title: "项目的维护者",
    description: "每个项目一个维护者：立项问答、写规格、做项目内部的任务和工单都用这一份；后面接着这一段的固定上下文（项目档案）",
    group: "role",
    defaultContent: ["（原型里的示例文字）你是项目「{{项目名}}」的维护者，用中文。", "对项目的理解存在项目档案里，不靠会话：拿不准时先读项目档案，做完了写回进展。", "{{> plan-writing}}"].join("\n"),
    placeholders: [{ name: "项目名", kind: "value", description: "项目的名字" }, { name: "plan-writing", kind: "partial", description: "计划的写法" }, ...COMMON],
    allowEmpty: false,
  },
  {
    id: "job-maintainer",
    title: "定时作业的维护者",
    description: "不属于项目的定时作业，每次运行都由它做",
    group: "role",
    defaultContent: "（原型里的示例文字）你是一个定时作业的维护者。连续失败 {{连续失败几次暂停}} 次作业自动暂停。",
    placeholders: [
      { name: "连续失败几次暂停", kind: "value", description: "定时作业连续失败几次自动暂停（配置 scheduledJobs.jobFailures）" },
      { name: "对话审批开着", kind: "flag", description: "配置 guard.conversationApprovals 是 on 时成立（默认关着）" },
      ...COMMON,
    ],
    allowEmpty: false,
  },
  {
    id: "plan-writing",
    title: "计划的写法",
    description: "起草计划的维护者都要知道的：阶段、授权项、关注类别、用户说过的限制",
    group: "fragment",
    defaultContent: "（原型里的示例文字）计划的写法：分阶段，每个阶段写交付件、验收标准。",
    placeholders: COMMON,
    allowEmpty: true,
  },
];

/** 原型的系统提示：编的几份，改的只记在内存里 */
export class FakeSystemPrompts {
  /** 用户改过的：编号 → 内容 */
  private readonly custom = new Map<string, string>([["prefix", "（原型里的示例）我住在新加坡，回答用简体中文。"]]);

  list(): SystemPromptList {
    return { prompts: SEEDS.map((s) => this.summary(s)), userDir: USER_DIR };
  }

  detail(id: string): SystemPromptDetail {
    const seed = this.seed(id);
    return { ...this.summary(seed), content: this.custom.get(id) ?? seed.defaultContent, defaultContent: seed.defaultContent, placeholders: seed.placeholders, allowEmpty: seed.allowEmpty, userFile: `${USER_DIR}\\${id}.md` };
  }

  save(id: string, content: string): SystemPromptDetail {
    const check = checkSystemPromptDraft(this.detail(id), content);
    if (!check.ok) throw new Error(`没存：\n${check.problem}`);
    if (check.isDefault) this.custom.delete(id);
    else this.custom.set(id, normalizePromptSource(content));
    return this.detail(id);
  }

  reset(id: string): SystemPromptDetail {
    this.custom.delete(this.seed(id).id);
    return this.detail(id);
  }

  private seed(id: string): Seed {
    const seed = SEEDS.find((s) => s.id === id);
    if (!seed) throw new Error(`没有这份系统提示：${id}`);
    return seed;
  }

  private summary(seed: Seed) {
    return {
      id: seed.id,
      title: seed.title,
      description: seed.description,
      group: seed.group,
      state: this.custom.has(seed.id) ? ("custom" as const) : ("default" as const),
      usedIn: SEEDS.filter((s) => s.placeholders.some((p) => p.kind === "partial" && p.name === seed.id)).map((s) => s.title),
    };
  }
}
