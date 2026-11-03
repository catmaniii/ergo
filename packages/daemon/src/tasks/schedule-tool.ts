// 秘书提议建定时触发的普通任务（schedule_task，守护进程代为执行）：只出一张"定时任务"卡，不建任务。用户在卡上点"确认"才建成
// （和发起对话框里选"定时"建出来的一样：TaskService.buildScheduledFromCard → buildCreate，过 checkedTrigger，看板运营中），
// 点"取消"什么都不建；两种结果都作为一条通知交回秘书（卡片类型在 cards.ts 的 scheduleTaskCardType）。
// - 时间表用共享的重复规则（每天、每 N 天、每周几、每月几号、每年、按我的工作日；不做 cron）加几点。每 N 天的起算日在提议这一刻
//   定下（没给是今天，按守护进程的时钟），写进卡里：隔天才点确认的不会差一天；
// - start（从哪天开始）：每 N 天的就是起算日；别的规则的时间表里存不下"从哪天起"（发起对话框也没有），第一次早于那天的拒绝并说明；
// - 卡上写接下来几次（第一个是首次运行时间）、任务书全文、按什么模型跑，估得出的写每次大概花多少（同类运行的历史用量）；
// - 不挂项目：项目的定时照旧转给项目的负责人走运营方案卡（工具说明写清楚）；
// - 不用用户这一轮点明（它本来就只出卡），一轮最多出一张（出成了才算这一轮的那一张：参数错了改了再试不算）。
// @i18n-ignore-file model：工具说明、参数说明、工具结果都给秘书看，照旧中文；工具的中文名（title，界面上显示）跟着当前语言
import {
  describeSchedule,
  describeTime,
  forModel,
  LOCAL_DATE_PATTERN,
  nextOccurrence,
  nowIso,
  parseClockTime,
  parseLocalDate,
  RepeatRule,
  repeatSchedule,
  type ReminderSchedule,
  SCHEDULE_CARD_UPCOMING,
  type ScheduleContext,
  type ScheduleRunEstimate,
  type ScheduleTaskCardPayload,
  t,
  Type,
} from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { CardService } from "../cards/cards.ts";
import { RequestRejected } from "../errors.ts";
import { PROPOSE_QUICK_ACTION } from "../quick-actions/tool.ts";
import { RELAY_ACTION } from "../secretary/relay.ts";
import { guarded } from "./launch-tools.ts";
import { checkedRuntime, RUNTIME_PARAM, type RuntimeRefusal } from "./secretary-tools.ts";
import { TASK_TOOL } from "./tool-names.ts";

export interface ScheduleTaskToolDeps {
  cards: Pick<CardService, "create">;
  /** 现在（守护进程的时钟）：每 N 天没给起算日的从今天起算，接下来几次从现在往后算 */
  now: () => Date;
  /** 算接下来几次用（按我的工作日要当时的工作日历） */
  scheduleContext: () => ScheduleContext;
  /** 写的运行时现在能不能用（不给就不查） */
  runtimeRefusal?: RuntimeRefusal | undefined;
  /** pi 跑时用什么模型：任务负责人那一行现在的模型 id（新建的任务还没单独配）；不给不写 */
  taskModel?: (() => string | undefined) | undefined;
  /** 同类运行每次大概花多少（runtime 不写是 pi）；估不出是 undefined，卡上就不写数字 */
  estimate?: ((runtime: string | undefined) => ScheduleRunEstimate | undefined) | undefined;
}

const ScheduleTaskParams = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 80, description: "任务卡上的标题（短，说清是什么事），比如“每天收邮件”" }),
    instructions: Type.String({
      minLength: 1,
      maxLength: 4000,
      description: "任务书：每次到点交给 agent 的话（怎么写见工具说明：每次要做什么、做到什么程度、结果交成什么样，只带完成这件事需要的信息）",
    }),
    when: Type.Object(RepeatRule.properties, { description: "时间表的重复规则（必填）：kind 选一种，每 N 天带 interval（和 anchor），每周几带 weekdays，每月几号带 days，每年带 month 和 day" }),
    time: Type.String({ description: "每次几点，HH:mm（24 小时制），比如 08:10" }),
    start: Type.Optional(
      Type.String({
        pattern: LOCAL_DATE_PATTERN,
        description: "从哪天开始（本地日期 YYYY-MM-DD；用户说了“从下周一开始”“从 12 月 1 日起”才写）：每 N 天的就是起算日（when.anchor 写了以它为准）；别的规则第一次早于这天的会被拒，见工具说明",
      }),
    ),
    runtime: RUNTIME_PARAM,
  },
  { additionalProperties: false },
);

/** 工具说明：什么时候用、和别的工具的界线、时间表和任务书怎么写，只写在这里 */
const DESCRIPTION =
  "提议建一个定时触发的普通任务：按时间表反复让一个 agent 干活的事（“每天 8:10 帮我收邮件、挑出要回的”“每周一早上整理下载目录”“每两天看一眼这个网页有没有更新”）。" +
  "它只在聊天里放一张“定时任务”卡，不建任务：卡上写时间表和接下来几次的时间、任务书全文、每次到点会启动一个 agent 照任务书干活、按什么模型跑；" +
  "用户点“确认”才建成（在任务看板的“运营中”，和发起对话框里选“定时”建出来的一样），点“取消”什么都不建。两种结果都会通知你；用户点之前不要说已经建好了。" +
  "不用等用户点明，你判断用户要的是定时反复做的事就用它；一轮最多出一张。" +
  `不用它的：只是到点提醒用户一声、不用 agent 干活的，建简单提醒；将来某个时间只做一次的，用 ${TASK_TOOL.delegateTask} 的 at；现在做一次的，用 ${TASK_TOOL.delegateTask}。` +
  `某个项目的定时（给项目开定时、改运营：“简报站每天 8 点出日报”“记账本的周报改到周一”）不能用它：用 ${PROPOSE_QUICK_ACTION} 的 ${RELAY_ACTION.project} 把用户的话转给那个项目的负责人，由它出“运营方案变更”卡给用户确认（运营方案只能用户本人在卡上确认）。` +
  "时间表：when 写重复规则（每天、每 N 天、每周几、每月几号、每年某月某日、按我的工作日；没有 cron，几分钟一次、一天几次的做不了，照实告诉用户），time 写几点。" +
  "每 N 天的起算日（从哪天起）写 when.anchor 或 start，都不写是今天（今天这个钟点已经过了，第一次就是 N 天后）。" +
  "start 是“从哪天开始”：每 N 天的就是起算日；别的规则从现在起按时间表走，存不下“从哪天起”——第一次早于 start 的会被拒，这时可以问用户换成每 N 天、或者到那天再建，别硬改日期。" +
  "instructions 是任务书：写清每次要做什么、做到什么程度、结果交成什么样（文件放哪、什么格式、要不要通知），只带完成这件事需要的信息（链接、文件在哪、有关的要求），" +
  "不带无关的私人内容——任务书在卡上、任务看板、任务详情里都看得到；执行的 agent 看不到你们的对话，每次运行接着同一段会话，知道前几次做了什么。";

/** 现在往后的几次（严格晚于 after），先到的在前 */
function upcomingOf(schedule: ReminderSchedule, after: Date, context: ScheduleContext): Date[] {
  const out: Date[] = [];
  let at = nextOccurrence(schedule, after, context);
  while (at && out.length < SCHEDULE_CARD_UPCOMING) {
    out.push(at);
    at = nextOccurrence(schedule, at, context);
  }
  return out;
}

/** start 那天的零点（本地）；日历上没有这天的抛 RequestRejected */
function startOfDay(start: string): Date {
  try {
    const { year, month, day } = parseLocalDate(start);
    return new Date(year, month - 1, day);
  } catch {
    throw new RequestRejected("bad_params", `start 写的 ${start} 不是日历上有的日子`);
  }
}

export function scheduleTaskTool(deps: ScheduleTaskToolDeps): HostTool {
  /** 这一轮（用户的一条消息、一条通知）已经出过卡了 */
  const proposed = new Set<string>();
  return defineHostTool({
    name: TASK_TOOL.scheduleTask,
    title: t("tasks.tools.scheduleTask"),
    description: DESCRIPTION,
    parameters: ScheduleTaskParams,
    // 每调用一次多一张卡
    readOnlyOrIdempotent: false,
    run: (args, call) =>
      guarded(() => {
        const turn = call.inputMessageId;
        if (turn !== undefined && proposed.has(turn)) return { text: "这一轮已经给过一张“定时任务”卡了，一轮最多一张。", isError: true };
        const title = args.title.trim();
        const instructions = args.instructions.trim();
        if (!title || !instructions) throw new RequestRejected("bad_params", "标题和任务书都不能是空的：写清楚每次要做什么");
        const now = deps.now();
        const time = parseClockTime(args.time);
        if (time === undefined) throw new RequestRejected("bad_params", `time 要写成 HH:mm（24 小时制），比如 08:10；写的是 ${args.time}`);
        // 每 N 天的起算日：when.anchor，没写用 start，都没写是今天（repeatSchedule 按 now 定下）
        const rule = args.when.kind === "everyNDays" && args.when.anchor === undefined && args.start !== undefined ? { ...args.when, anchor: args.start } : args.when;
        const made = repeatSchedule(rule, time, now);
        if ("error" in made) throw new RequestRejected("bad_params", made.error);
        const { schedule } = made;
        const upcoming = upcomingOf(schedule, now, deps.scheduleContext());
        const first = upcoming[0];
        if (first === undefined) throw new RequestRejected("bad_params", `按 ${forModel(() => describeSchedule(schedule, now))} 算不出下一次`);
        if (args.start !== undefined && first.getTime() < startOfDay(args.start).getTime()) {
          throw new RequestRejected(
            "bad_params",
            `按这个时间表从现在起第一次是 ${forModel(() => describeTime(first, now))}，早于 start（${args.start}）；` +
              "现在的时间表只有每 N 天能定从哪天起（起算日），别的规则存不下“从哪天起”。可以问用户换成每 N 天、或者到那天再建；要么去掉 start，照实告诉用户第一次是哪天。",
          );
        }
        const runtime = checkedRuntime(args.runtime, deps.runtimeRefusal);
        const model = runtime === undefined ? deps.taskModel?.() : undefined;
        const estimate = deps.estimate?.(runtime);
        const payload: ScheduleTaskCardPayload = {
          title,
          instructions,
          schedule,
          upcoming: upcoming.map((d) => nowIso(d)),
          ...(runtime === undefined ? {} : { runtime }),
          ...(model ? { model } : {}),
          ...(estimate ? { estimate } : {}),
        };
        const card = deps.cards.create({ type: "schedule_task", payload });
        if (turn !== undefined) proposed.add(turn);
        const when = forModel(() => `${describeSchedule(schedule, now)}，第一次是 ${describeTime(first, now)}`);
        return {
          text:
            `已在聊天里放了一张“定时任务”卡（任务还没建）：「${payload.title}」，${when}。` +
            "用户点卡上的“确认”才会建成定时任务（任务看板的“运营中”），点“取消”什么都不建；结果会通知你。不要说已经建好了。",
          cardIds: [card.id],
        };
      }),
  });
}
