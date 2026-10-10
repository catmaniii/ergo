// 几个页面共用的部件："发起任务"。（会话的详情页在 ui/detail/，56 号票起取代了这里原来的 WithToolDetail）
import { useState } from "react";
import { useStore } from "../app/store.tsx";
import {
  ASSISTANT_NAME_MARK,
  DEFAULT_TRIGGER_SCHEDULE,
  describeSchedule,
  describeTime,
  onceAtInFuture,
  TIMED_MODE_HINT,
  TIMED_MODE_LABEL,
  TIMED_MODES,
  type TimedMode,
  isPlainTask,
  LONG_RUNNING_TRIGGER_REFUSAL,
  nextClockTime,
  type ReminderSchedule,
  selectableProjectNames,
  START_WHEN,
  START_WHEN_HINT,
  START_WHEN_LABEL,
  type StartWhen,
  startWhenAllowed,
  stillChartering,
  TASK_KIND_HINT,
  TASK_KIND_LABEL,
  TASK_KINDS,
  type TaskKind,
} from "../state/index.ts";
import { AssistantName } from "../ui/assistant-name.tsx";
import { ScheduleEditor } from "../ui/cards/cards.tsx";
import { nowIso } from "../util/time.ts";
import { useToast } from "../ui/toast.tsx";
import { Sheet } from "../ui/common.tsx";

/** "发起任务"按钮：秘书页和任务页都有 */
export function StartTaskButton({ compact }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`btn primary ${compact ? "small" : ""}`} onClick={() => setOpen(true)}>
        ＋ 发起任务
      </button>
      {open && <StartTaskDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * 发起任务（12 号票）：不经秘书判断，守护进程直接建出任务（规划中），出现在看板上；秘书收到通知接着和用户澄清。
 * 58 号票：先选种类（照 AgentSense 的 ScenarioPicker：两个页签，副标题说清两种的区别），建卡时定下、之后不能换；
 * 默认是长程任务。第一行当标题。涉及的项目可以多选，选项来自项目列表（15 号票起是真的：没归档的项目；守护进程同样核对，
 * 不在项目列表里的被拒）；选的项目写进任务，秘书写任务书时以它为依据。
 * 64 号票（用户定）：只选了一个项目的建成这个项目的内部任务（由项目的维护者在项目会话里和你对齐、执行，只在项目页看得到，
 * 不上任务看板）；选了几个项目的是跨项目的任务。流程只能选一个项目（或者不涉及项目）。只选了一个还在立项的项目时说明原因、不让发起。
 * 75 号票（ADR 0025）：做法多一个"普通任务"，排在最前面、默认选中——不经助理澄清，写的这段话就是交给 agent 的任务书，
 * 建出就排队、有名额就开始做，不规划、不授权、不检查，做完自动算完成。
 * 76 号票（ADR 0025）："什么时候做"三选一——现在做一次；定时：按时间表反复做（含"按我的工作日"：建出的任务按时间表反复运行，
 * 流程在计划卡上授权一次，之后每次运行按步骤核对），或者某个时间做一次（用户 2026-10-10 定：选日期和时间，到点做一次、做完即完成）；
 * 只提醒我（不用 agent，到点只发通知：建一条简单提醒，做法、项目都用不上）。
 * 长程任务只能现在做一次（"定时"选不了，写明原因）；事件触发在 77 号票
 */
function StartTaskDialog({ onClose }: { onClose(): void }) {
  const [kind, setKind] = useState<TaskKind>("plain");
  const [what, setWhat] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [when, setWhen] = useState<StartWhen>("once");
  const [schedule, setSchedule] = useState<ReminderSchedule>(DEFAULT_TRIGGER_SCHEDULE);
  const [timedMode, setTimedMode] = useState<TimedMode>("repeat");
  const [doAt, setDoAt] = useState<ReminderSchedule>(() => ({ kind: "once", at: nowIso(nextClockTime("09:00", new Date())) }));
  /** 选了"某个时间做一次"时的此刻（选时间、换时间时现取；渲染时不取时钟） */
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const [remindAt, setRemindAt] = useState<ReminderSchedule>(() => ({ kind: "once", at: nowIso(nextClockTime("09:00", new Date())) }));
  const toast = useToast();
  const { ui, startTask, createReminder } = useStore();
  const remind = when === "remind";
  /** 定时 · 某个时间做一次 */
  const at = when === "schedule" && timedMode === "at";
  /** 某个时间做一次的那个时间已经过了：不能建 */
  const atPassed = at && !onceAtInFuture(doAt, checkedAt);
  const projects = selectableProjectNames(ui);
  // 流程只能选一个项目：选了别的就换成它
  const toggle = (name: string) => setChosen(chosen.includes(name) ? chosen.filter((n) => n !== name) : kind === "workflow" ? [name] : [...chosen, name]);
  const pickKind = (k: TaskKind) => {
    setKind(k);
    if (k === "workflow" && chosen.length > 1) setChosen(chosen.slice(0, 1));
    // 长程任务只能现在做一次
    if (!startWhenAllowed(k, when)) setWhen("once");
  };
  /** 只选了一个项目：建成这个项目的内部任务 */
  const inProject = chosen.length === 1 ? chosen[0] : undefined;
  /** 只选了一个还在立项的项目：确认立项书之前不能在里面发起 */
  const chartering = inProject !== undefined && stillChartering(ui, inProject);
  const submit = () => {
    const request = what.trim();
    if (remind) {
      createReminder(request, remindAt);
      toast(`已建提醒「${request.split("\n")[0]}」：${describeSchedule(remindAt)}，到点${ASSISTANT_NAME_MARK}发通知`);
      onClose();
      return;
    }
    startTask(request, chosen, kind, when === "schedule" ? { kind: "schedule", schedule: at ? doAt : schedule } : undefined);
    const title = request.split("\n")[0];
    toast(at ? atToast(kind, title ?? request, doAt, inProject) : when === "schedule" ? timedToast(kind, title ?? request, schedule, inProject) : startedToast(kind, title ?? request, inProject));
    onClose();
  };
  return (
    <Sheet title="发起任务" onClose={onClose} center>
      {/* 三种做法（75 号票起）：窄的时候页签上只写名字，选中那种的说明写在下面一行；只提醒我用不上做法 */}
      <div className={`sc-picker${remind ? " sc-off" : ""}`} aria-hidden={remind || undefined}>
        <div className="sc-modes" role="tablist">
          {TASK_KINDS.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} className={`sc-mode ${kind === k ? "on" : ""}`} onClick={() => pickKind(k)}>
              <b>
                {TASK_KIND_LABEL[k]}
                {isPlainTask({ kind: k }) ? <em className="sc-default">默认</em> : null}
              </b>
              <span>{TASK_KIND_HINT[k]}</span>
            </button>
          ))}
        </div>
        <div className="sc-mode-hint">{TASK_KIND_HINT[kind]}</div>
      </div>
      <label className="field">
        <span>{remind ? "提醒什么" : "要做什么（第一行当标题）"}</span>
        <textarea
          value={what}
          onChange={(e) => setWhat(e.target.value)}
          placeholder={remind ? "比如：交房租" : when === "schedule" ? TIMED_PLACEHOLDER[kind] : PLACEHOLDER[kind]}
          autoFocus
        />
      </label>
      {/* 什么时候做（76 号票）：现在做一次、定时、只提醒我 */}
      <fieldset className="field when-picker">
        <legend>什么时候做</legend>
        <div className="seg when-seg" role="radiogroup" aria-label="什么时候做">
          {START_WHEN.map((w) => {
            const allowed = startWhenAllowed(kind, w);
            return (
              <button
                key={w}
                type="button"
                role="radio"
                aria-checked={when === w}
                className={`seg-btn${when === w ? " on" : ""}`}
                disabled={!allowed}
                title={allowed ? START_WHEN_HINT[w] : LONG_RUNNING_TRIGGER_REFUSAL}
                onClick={() => setWhen(w)}
              >
                {START_WHEN_LABEL[w]}
              </button>
            );
          })}
        </div>
        <div className="sc-mode-hint">{START_WHEN_HINT[when]}</div>
        {!startWhenAllowed(kind, "schedule") && <div className="hint">{LONG_RUNNING_TRIGGER_REFUSAL}</div>}
        {when === "schedule" && (
          <div className="seg timed-seg" role="radiogroup" aria-label="定时">
            {TIMED_MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={timedMode === m}
                className={`seg-btn${timedMode === m ? " on" : ""}`}
                title={TIMED_MODE_HINT[m]}
                onClick={() => {
                  setTimedMode(m);
                  setCheckedAt(Date.now());
                }}
              >
                {TIMED_MODE_LABEL[m]}
              </button>
            ))}
          </div>
        )}
        {when === "schedule" && <div className="sc-mode-hint">{TIMED_MODE_HINT[timedMode]}</div>}
        {when === "schedule" && !at && <ScheduleEditor value={schedule} onChange={setSchedule} repeatOnly label="时间表：" />}
        {at && (
          <ScheduleEditor
            value={doAt}
            onChange={(s) => {
              setDoAt(s);
              setCheckedAt(Date.now());
            }}
            onceOnly
            label="什么时候："
          />
        )}
        {atPassed && <div className="hint">这个时间已经过了：现在做就选“现在做一次”，或者定一个将来的时间。</div>}
        {remind && <ScheduleEditor value={remindAt} onChange={setRemindAt} label="提醒：" />}
      </fieldset>
      {!remind && (
      <fieldset className="field">
        <legend>{kind === "workflow" ? "在哪个项目里（流程只能选一个）" : "涉及哪些项目（可以多选）"}</legend>
        <label className="check-row">
          <input type="checkbox" checked={chosen.length === 0} onChange={() => setChosen([])} />
          不涉及项目
        </label>
        {projects.map((name) => (
          <label key={name} className="check-row">
            <input type="checkbox" checked={chosen.includes(name)} onChange={() => toggle(name)} />
            {name}
          </label>
        ))}
      </fieldset>
      )}
      {!remind && inProject !== undefined && !chartering && <div className="hint">只选了一个项目：建成「{inProject}」的内部任务，由这个项目的维护者执行，只在项目页上看得到（不上任务看板）。</div>}
      {!remind && chartering && <div className="hint">项目「{inProject}」还在立项，确认立项书后再发起。</div>}
      {!remind && chosen.length > 1 && <div className="hint">选了几个项目：跨项目的任务，在任务看板上。</div>}
      {remind ? (
        <div className="hint">提醒建出后在看板的运营中一组，到点能改、能取消。要 agent 到点去做事的，选“定时”。</div>
      ) : at ? (
        <div className="hint">
          {kind === "workflow"
            ? "维护者把要做的事排成步骤，你在计划卡上授权；到这个时间才开始照步骤做一次，做完就算完成。"
            : "到这个时间在后台做一次，做完自动算完成；"}
          {kind !== "workflow" && (
            <>
              结果由
              <AssistantName />
              在对话里转告，在任务详情里接着说它就接着做。
            </>
          )}
        </div>
      ) : when === "schedule" ? (
        <div className="hint">
          {kind === "workflow"
            ? "维护者把要做的事排成步骤，你在计划卡上授权一次；之后按时间表运行，每次都照授权的步骤做、逐步核对，不再问你。"
            : `建出就登记好时间表，到点在后台运行（不经${inProject === undefined ? "" : "和维护者对齐、不经"}`}
          {kind !== "workflow" && <AssistantName />}
          {kind !== "workflow" && "澄清）；每次一次运行，做不了的记为失败，连续失败 3 次自动暂停。"}
          各次运行接着同一段会话，后面的知道前几次做了什么；在看板的运营中一组，能暂停、恢复、取消。
        </div>
      ) : isPlainTask({ kind }) ? (
        <div className="hint">
          {inProject === undefined ? "发起后不经" : "发起后不用和维护者对齐，项目的维护者在项目里直接做；也不经"}
          <AssistantName />
          澄清：这段话就是交给 agent 的任务书，排到了就开始做。不规划、不授权、不检查（受保护区域、密钥照旧挡住），做完自动算完成，结果由
          <AssistantName />
          在对话里转告；在任务详情里接着说，它就接着做。
        </div>
      ) : (
        <div className="hint">
          {inProject === undefined ? (
            <>
              发起后<AssistantName />先和你对齐意图、写任务书；
            </>
          ) : (
            "发起后项目的维护者先在项目会话里和你对齐意图、写任务书；"
          )}
          {kind === "workflow"
            ? "维护者据此把要做的事排成一串步骤，每一步连同它要满足的条件，经审查修补后放进计划卡。你在计划卡上一次授权之前，它不会动手。"
            : "执行的维护者据此起草分阶段的计划。你在计划卡上确认之前，它不会动手。"}
        </div>
      )}
      {/* 按钮固定在对话框底部：一屏放不下时滚动的是上面的内容 */}
      <div className="auth-actions sc-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn primary" disabled={!what.trim() || (!remind && chartering) || atPassed} onClick={submit}>
          {remind ? "建提醒" : at ? `定好时间，发起${TASK_KIND_LABEL[kind]}` : when === "schedule" ? `建定时的${TASK_KIND_LABEL[kind]}` : `发起${TASK_KIND_LABEL[kind]}`}
        </button>
      </div>
    </Sheet>
  );
}

/** "要做什么"框里的示例：各做法各一句 */
const PLACEHOLDER_LONG = "比如：把家里的路由器换成 Wi-Fi 7，先比价，再给我一份计划";
const PLACEHOLDER: Readonly<Record<TaskKind, string>> = {
  plain: "比如：去搜一下《晴天》这首歌，把音频下成 mp3",
  workflow: "比如：把下载目录里的安装包、截图、文档分到三个文件夹",
  long_running: PLACEHOLDER_LONG,
};

/** 选了"定时"时"要做什么"框里的示例 */
const TIMED_PLACEHOLDER: Readonly<Record<TaskKind, string>> = {
  plain: "比如：每天早上出一份早报，汇总昨天的科技新闻",
  workflow: "比如：每周一把下载目录里的安装包、截图、文档分到三个文件夹",
  long_running: PLACEHOLDER_LONG,
};

/** 定时的任务建出之后的提示（76 号票） */
function timedToast(kind: TaskKind, title: string, schedule: ReminderSchedule, inProject: string | undefined): string {
  const where = inProject === undefined ? "" : `在项目「${inProject}」里`;
  if (kind === "workflow") return `已${where}发起定时的流程「${title}」（${describeSchedule(schedule)}）：先起草步骤，你在计划卡上授权一次后按时间表运行`;
  return `已${where}建定时的普通任务「${title}」：${describeSchedule(schedule)}，到点在后台运行`;
}

/** 某个时间做一次的任务建出之后的提示（76 号票） */
function atToast(kind: TaskKind, title: string, schedule: ReminderSchedule, inProject: string | undefined): string {
  const where = inProject === undefined ? "" : `在项目「${inProject}」里`;
  const time = schedule.kind === "once" ? describeTime(new Date(schedule.at)) : describeSchedule(schedule);
  if (kind === "workflow") return `已${where}发起流程「${title}」：先起草步骤，你在计划卡上授权后，${time} 做一次`;
  return `已${where}建普通任务「${title}」：${time} 在后台做一次，做完${ASSISTANT_NAME_MARK}告诉你`;
}

/** 发起之后的提示：普通任务（75 号票）直接排队开始做；有计划的两种先对齐意图 */
function startedToast(kind: TaskKind, title: string, inProject: string | undefined): string {
  if (isPlainTask({ kind })) {
    return inProject === undefined
      ? `已交给后台：普通任务「${title}」，排到了就开始做，做完${ASSISTANT_NAME_MARK}告诉你`
      : `已在项目「${inProject}」里交给维护者去做：普通任务「${title}」（项目内部任务，在项目页上看）`;
  }
  return inProject === undefined
    ? `已发起${TASK_KIND_LABEL[kind]}「${title}」（规划中），${ASSISTANT_NAME_MARK}会先和你对齐意图`
    : `已在项目「${inProject}」里发起${TASK_KIND_LABEL[kind]}「${title}」（项目内部任务），项目的维护者会先在项目会话里和你对齐意图`;
}
