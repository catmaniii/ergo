// 临时文件，任务、项目这一侧要给守卫的东西（111 号票，用户 2026-10-13 定：任务中间的临时文件和脚本、为了生成阶段交付件临时生成的
// 脚本和数据默认可以改、删；限制只对系统已有的东西和交出去了的交付件；又补充"任务和项目的临时文件都是一样的"）：范围开始的时间、
// 交出去了的交付件（GuardOwnWork，守卫怎么用见 guard/own-temp.ts）。守卫接入每次判定时现取（TaskExecution.ownWork / projectOwnWork）。
// - 按范围认：项目的 agent（项目的维护者做什么都算，和它派的子 agent）按项目——项目开始之后生成的都算，交付件是项目里各任务交出去的；
//   项目外的任务按这个任务；
// - 派生视图 work_times（ergo.db，看板频道的 task、scheduled_job 和项目频道的 project 事件归并）：
//   - 任务第一次进执行中或运营中的时间（任务开始），最近一次交出去的时间——维护者宣布阶段完成（stage_submitted）、任务做完
//     （completed：普通任务每做完一次都算）、定时 / 事件触发的一次运行结束（scheduled_job 的 run_finished）；
//   - 项目开始的时间：建出项目（立项）的时候；工作目录绑定了外部路径的，是绑定（立项书确认：只确认或确认并开工）的时候——
//     那里原来就有的都算已有的；
// - 交付件：长程任务交出去了的阶段（宣布完成过的、在验收或已验收的）的交付件，从交付件的文字里认路径（deliverablePaths）；
//   任务的产出区（outputs/<任务 id>，项目外的任务的工作目录就是它）里最近一次交出去时已经有了的——普通任务做完、定时 / 事件触发的
//   一次运行结束交出去的结果也在这里；
// - 认不准就当交付件（GuardOwnWork.handovers 里不写 dir 的一项：agent 的工作目录也按产出区算）：长程任务交出去了的阶段里有一条交付件
//   认不出路径的。普通任务、流程没有逐个写明的交付件，项目里的（工作目录不是产出区）交出去之后，它们之前生成的中间文件照样是项目的
//   临时文件（用户补充："前一个工单写的中间脚本，下一个工单也能删"）。
import {
  CHANNELS,
  EVENT_TYPES,
  type Plan,
  type ProjectEventPayload,
  type ScheduledJobEventPayload,
  type Task,
  type TaskEventPayload,
  taskKind,
} from "@ergo/protocol";
import type { DerivedView } from "../events/event-store.ts";
import { absolutePathsIn, type GuardOwnWork } from "../guard/index.ts";
import type { Database, ReadonlyDatabase } from "../storage/sqlite.ts";
import { realPathOf } from "../util/real-path.ts";
import { taskWorkdir } from "./task-workdir.ts";

export const workTimesView: DerivedView = {
  name: "work_times",
  // 只归并看板频道（任务和触发登记）和项目频道：新建表时只补这两个频道
  channels: [CHANNELS.board, CHANNELS.projects],
  create(db) {
    const existed = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('task_work_times', 'project_work_times')").length === 2;
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_work_times (task_id TEXT PRIMARY KEY, started_ms INTEGER, handed_over_ms INTEGER);
      CREATE TABLE IF NOT EXISTS project_work_times (project_id TEXT PRIMARY KEY, started_ms INTEGER NOT NULL, bound INTEGER NOT NULL DEFAULT 0);
    `);
    // 111 号票之前的库：从事件日志补一遍（之前的任务、项目也认得出开始、交出去的时间）
    return existed ? undefined : "refill";
  },
  clear: (db) => db.exec("DELETE FROM task_work_times; DELETE FROM project_work_times;"),
  apply(db, event) {
    const ms = Date.parse(event.time);
    if (!Number.isFinite(ms)) return;
    if (event.channel === CHANNELS.board && event.type === EVENT_TYPES.task) {
      const { task, change, from } = event.payload as TaskEventPayload;
      // 第一次进执行中或运营中（定时 / 事件触发的任务登记好就是运营中）
      if ((task.state === "running" || task.state === "operating") && from !== task.state) {
        db.run(
          `INSERT INTO task_work_times (task_id, started_ms) VALUES (?, ?)
           ON CONFLICT (task_id) DO UPDATE SET started_ms = COALESCE(task_work_times.started_ms, excluded.started_ms)`,
          task.id,
          ms,
        );
      }
      if (change === "stage_submitted" || change === "completed") handedOver(db, task.id, ms);
      return;
    }
    if (event.channel === CHANNELS.board && event.type === EVENT_TYPES.scheduledJob) {
      const { job, change } = event.payload as ScheduledJobEventPayload;
      if (change === "run_finished") handedOver(db, job.ownerTaskId ?? job.taskId, ms);
      return;
    }
    if (event.channel === CHANNELS.projects && event.type === EVENT_TYPES.project) {
      const { project, change } = event.payload as ProjectEventPayload;
      // 建出项目是开始；绑定外部工作目录（立项书确认时：只确认是 charter_confirmed，确认并开工是 building_started）从绑定的时候算：
      // 那里原来就有的都是已有的。只认第一次（bound），之后再开工（也是 building_started）不改
      if (change === "created") db.run("INSERT OR IGNORE INTO project_work_times (project_id, started_ms) VALUES (?, ?)", project.id, ms);
      else if ((change === "charter_confirmed" || change === "building_started") && project.workdir.external) {
        db.run(
          `INSERT INTO project_work_times (project_id, started_ms, bound) VALUES (?, ?, 1)
           ON CONFLICT (project_id) DO UPDATE SET started_ms = MAX(project_work_times.started_ms, excluded.started_ms), bound = 1
           WHERE project_work_times.bound = 0`,
          project.id,
          ms,
        );
      }
    }
  },
};

function handedOver(db: Database, taskId: string, ms: number): void {
  db.run(
    `INSERT INTO task_work_times (task_id, handed_over_ms) VALUES (?, ?)
     ON CONFLICT (task_id) DO UPDATE SET handed_over_ms = MAX(COALESCE(task_work_times.handed_over_ms, 0), excluded.handed_over_ms)`,
    taskId,
    ms,
  );
}

/** 一个任务开始、最近一次交出去的时间（毫秒）；还没开始的没有 startedAt */
export function taskWorkTimes(reader: ReadonlyDatabase, taskId: string): { startedAt?: number; handedOverAt?: number } {
  const row = reader.get<{ started_ms: number | null; handed_over_ms: number | null }>("SELECT started_ms, handed_over_ms FROM task_work_times WHERE task_id = ?", taskId);
  return {
    ...(row?.started_ms == null ? {} : { startedAt: Number(row.started_ms) }),
    ...(row?.handed_over_ms == null ? {} : { handedOverAt: Number(row.handed_over_ms) }),
  };
}

/** 一个项目开始的时间（毫秒）；没有记下的是 undefined */
export function projectStartedAt(reader: ReadonlyDatabase, projectId: string): number | undefined {
  const row = reader.get<{ started_ms: number }>("SELECT started_ms FROM project_work_times WHERE project_id = ?", projectId);
  return row === undefined ? undefined : Number(row.started_ms);
}

/**
 * 一个任务交出去了的交付件：认出来的路径，按交出去的时间认的地方（任务干活的地方：产出区，或新建时选的工作文件夹、接管来的会话的工作目录；认不准时连同 agent 的工作目录）。
 * plan 取现在生效的计划，有交出去了的阶段才取
 */
function taskHandovers(reader: ReadonlyDatabase, task: Task, planOf: () => Plan | undefined, outputsDir: string): Pick<GuardOwnWork, "deliverables" | "handovers"> {
  const { handedOverAt } = taskWorkTimes(reader, task.id);
  const deliverables: string[] = [];
  let vague = false;
  let plan: Plan | undefined;
  // 只有长程任务的阶段写着交付件（流程的那一个阶段写的是目标，普通任务没有阶段）
  const stages = taskKind(task) === "long_running" ? (task.stages?.list ?? []) : [];
  for (const stage of stages) {
    if (stage.attempts === 0 && stage.state !== "accepting" && stage.state !== "accepted") continue;
    plan ??= planOf();
    const texts = plan?.stages.find((s) => s.stageId === stage.stageId)?.deliverables ?? [];
    if (texts.length === 0) vague = true;
    for (const text of texts) {
      const found = deliverablePaths(text);
      if (found.length === 0) vague = true;
      deliverables.push(...found);
    }
  }
  if (handedOverAt === undefined && !vague) return { deliverables, handovers: [] };
  const at = handedOverAt === undefined ? {} : { at: handedOverAt };
  const dir = taskWorkdir(task, outputsDir);
  return { deliverables, handovers: [{ dir: realPathOf(dir) ?? dir, ...at }, ...(vague ? [at] : [])] };
}

/**
 * 项目外的任务交给守卫的（GuardOwnWork）：还没开始的没有（起草计划时只能读）。plan 是现在生效的计划（长程任务按它的阶段认交付件），
 * outputsDir 是数据目录的产出区（任务的那一格是 outputs/<任务 id>）
 */
export function taskOwnWork(input: { reader: ReadonlyDatabase; task: Task; plan: Plan | undefined; outputsDir: string }): GuardOwnWork | null {
  const { startedAt } = taskWorkTimes(input.reader, input.task.id);
  if (startedAt === undefined) return null;
  return { startedAt, ...taskHandovers(input.reader, input.task, () => input.plan, input.outputsDir) };
}

/**
 * 项目交给守卫的（GuardOwnWork）：项目开始的时间，项目里各任务（tasks：由项目的维护者执行的、涉及这个项目的）交出去了的交付件，
 * plan 取每个任务现在生效的计划。没记下项目开始的时间的没有
 */
export function projectOwnWork(input: { reader: ReadonlyDatabase; projectId: string; tasks: readonly Task[]; plan: (taskId: string) => Plan | undefined; outputsDir: string }): GuardOwnWork | null {
  const startedAt = projectStartedAt(input.reader, input.projectId);
  if (startedAt === undefined) return null;
  const deliverables: string[] = [];
  const handovers: Array<GuardOwnWork["handovers"][number]> = [];
  for (const task of input.tasks) {
    const own = taskHandovers(input.reader, task, () => input.plan(task.id), input.outputsDir);
    deliverables.push(...own.deliverables);
    handovers.push(...own.handovers);
  }
  return { startedAt, deliverables: [...new Set(deliverables)], handovers };
}

/** 路径前后可以是的：空白、引号、括号、逗号分号冒号、中文标点（连着字母、汉字的不认，免得把"交付report.md"认成一个文件） */
const EDGE = String.raw`[\s"'\x60()\[\]{}<>,;:，。；：、（）「」『』“”‘’《》【】！？!?]`; // @i18n-ignore data
/** 像路径的一段：字母、数字（含汉字）、- _ . 和分隔符，前后是 EDGE（或者开头、结尾） */
const PATH_LIKE = new RegExp(String.raw`(?<=^|${EDGE})[\p{L}\p{N}_\-.\\/]+(?=$|${EDGE})`, "gu");
/** 扩展名：英文字母开头，最多 8 个字母数字 */
const EXTENSION = /\.[a-z][a-z0-9]{0,7}$/i;
/** 汉字和英文字母、数字直接连着："交付report.md"、"报告.md文件" 分不清哪段是文件名，宁可不认（当认不准） */
const GLUED = /\p{Script=Han}[a-z0-9]|[a-z0-9]\p{Script=Han}/iu;

/**
 * 一条交付件的文字里写着的路径（照写的原样，相对路径由守卫按 agent 的工作目录解析）：写死的绝对路径（盘符、Git Bash 的盘符写法，
 * 和扫描脚本同一份 absolutePathsIn），加上相对路径——带扩展名的文件名（`report.md`、`分析报告.md`）、带分隔符的路径（`out/`、`src/foo`）。
 * 前后要是空白、标点或引号（句末的英文句点去掉），汉字和英文字母连着的不认；认不出的（"一份调研报告"）是空数组，
 * 调用方当认不准（工作目录按产出区算）
 */
export function deliverablePaths(text: string): string[] {
  const relative = [...text.matchAll(PATH_LIKE)]
    .map((m) => m[0].replace(/\.+$/, ""))
    // 绝对路径的后半段（盘符后面的、Git Bash 写法）以分隔符开头，不算相对路径；绝对路径另外认
    .filter((p) => !/^[\\/]/.test(p) && !GLUED.test(p) && (/[\\/]/.test(p.replace(/^\.{1,2}[\\/]/, "")) || EXTENSION.test(p)));
  return [...new Set([...absolutePathsIn(text), ...relative])];
}
