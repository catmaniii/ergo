// 几个页面共用的部件："发起任务"（289 号票起能选运行时；290 号票起能从已有的 Claude Code 会话接管）。（会话的详情页在 ui/detail/，56 号票起取代了这里原来的 WithToolDetail）
import { useState } from "react";
import { useStore } from "../app/store.tsx";
import {
  ASSISTANT_NAME_MARK,
  defaultEventTrigger,
  describeEventTrigger,
  describeSchedule,
  type EventTrigger,
  eventTriggerMissing,
  fillWhenFromText,
  initialWhenFields,
  NOT_TOUCHED,
  REMIND_MODE_LABEL,
  REMIND_MODES,
  type RemindMode,
  describeTime,
  onceAtInFuture,
  isPlainTask,
  PI_RUNTIME_ID,
  LONG_RUNNING_TRIGGER_REFUSAL,
  type ReminderSchedule,
  selectableProjectNames,
  START_WHEN,
  START_WHEN_HINT,
  START_WHEN_LABEL,
  startWhenAllowed,
  stillChartering,
  t,
  TASK_KIND_HINT,
  TASK_KIND_LABEL,
  TASK_KINDS,
  type TaskKind,
  type TextTime,
  timeFromText,
  tTable,
  touchWhen,
  TASK_MENU_LABEL,
  type WhenFields,
  whenTextHint,
  type WhenTouched,
  EMPTY_FOLDER_DRAFT,
  type FolderDraft,
  folderChoiceOf,
  folderDraftReady,
  type WorkFolderChoice,
  workFolderRuntime,
} from "../state/index.ts";
import { AssistantName } from "../ui/assistant-name.tsx";
import { T } from "../ui/i18n.tsx";
import { EventTriggerEditor } from "../ui/event-trigger-editor.tsx";
import { ScheduleEditor } from "../ui/cards/cards.tsx";
import { RuntimePicker, useRuntimes } from "../ui/runtimes.tsx";
import { TakeoverLink, TakeoverSheet } from "../ui/takeover.tsx";
import { WorkFolderPicker } from "../ui/work-folder.tsx";
import { TimedScheduleEditor } from "../ui/timed-schedule-editor.tsx";
import { useToast } from "../ui/toast.tsx";
import { Sheet } from "../ui/common.tsx";

/** "发起任务"按钮：秘书页和任务页都有 */
export function StartTaskButton({ compact }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`btn primary ${compact ? "small" : ""}`} onClick={() => setOpen(true)}>
        {t("pages.startTask.button")}
      </button>
      {open && <StartTaskDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * 发起任务（12 号票）：不经秘书判断，守护进程直接建出任务（规划中），出现在看板上；秘书收到通知接着和用户澄清。
 * 58 号票：先选种类（两个页签，副标题说清两种的区别），建卡时定下、之后不能换；
 * 默认是长程任务。第一行当标题。涉及的项目可以多选，选项来自项目列表（15 号票起是真的：没归档的项目；守护进程同样核对，
 * 不在项目列表里的被拒）；选的项目写进任务，秘书写任务书时以它为依据。
 * 64 号票（用户定）：只选了一个项目的建成这个项目的内部任务（由项目的维护者在项目会话里和你对齐、执行，只在项目页看得到，
 * 不上任务看板）；选了几个项目的是跨项目的任务。流程只能选一个项目（或者不涉及项目）。只选了一个还在立项的项目时说明原因、不让发起。
 * 75 号票（ADR 0025）：做法多一个"普通任务"，排在最前面、默认选中——不经助理澄清，写的这段话就是交给 agent 的任务书，
 * 建出就排队、有名额就开始做，不规划、不授权、不检查，做完自动算完成。
 * 76 号票（ADR 0025）："什么时候做"三选一——现在做一次；定时：按时间表反复做（含"按我的工作日"：建出的任务按时间表反复运行，
 * 流程在计划卡上授权一次，之后每次运行按步骤核对），或者某个时间做一次（用户 2026-10-10 定：选日期和时间，到点做一次、做完即完成）；
 * 只提醒我（不用 agent，到点只发通知：建一条简单提醒，做法、项目都用不上）。
 * 长程任务只能现在做一次（"定时"选不了，写明原因）。
 * 77 号票："什么时候做"多一个"事件发生时"：选来源、选事件、填过滤条件（EventTriggerEditor，按事件来源登记表画）；建出的普通任务就是运营中，
 * 流程在计划卡上授权一次（步骤的参数里可以写这次事件的值）；长程任务选不了。"只提醒我"也能选"事件发生时提醒"。
 * 97 号票：写的话里说了几点（"明天早上8点……""每天早上8点……"），定时就按几点——写的话变了就重认（state/text-time.ts），
 * 用户还没自己动过的几栏按它填（切到定时、选好一次还是反复、填好时间；提醒时间也是），下面一行写按你写的定在哪；
 * 动过的不再改，和写的不一样时标出来（照样能发起）。状态层的 fillWhenFromText、whenTextHint。
 */
function StartTaskDialog({ onClose }: { onClose(): void }) {
  const [kind, setKind] = useState<TaskKind>("plain");
  const [what, setWhat] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  /** 什么时候做、定时（反复还是一次、时间表、时间）、提醒时间（97 号票起放在一起：写的话里说了几点，没动过的几栏按它填） */
  const [fields, setFields] = useState<WhenFields>(() => initialWhenFields(new Date()));
  const { when, timedMode, schedule, doAt, remindAt } = fields;
  /** 用户自己动过哪几栏：动过的不再按写的话自动改 */
  const [touched, setTouched] = useState<WhenTouched>(NOT_TOUCHED);
  /** 从写的话里认出的时间（写的话变了就重认，此刻在那时现取） */
  const [found, setFound] = useState<TextTime | undefined>(undefined);
  /** 选了"某个时间做一次"时的此刻（选时间、换时间、改写的话时现取；渲染时不取时钟） */
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  /** 事件发生时（77 号票）：一开始是本机文件夹变化 */
  const [eventTrigger, setEventTrigger] = useState<EventTrigger>(() => defaultEventTrigger("folder"));
  const [remindMode, setRemindMode] = useState<RemindMode>("time");
  const [remindEvent, setRemindEvent] = useState<EventTrigger>(() => defaultEventTrigger("folder"));
  /** 跑完自动播报（100 号票）：先勾上，做完秘书直接把要点念成语音，不先问 */
  const [announce, setAnnounce] = useState(false);
  /** 执行它的维护者用的运行时（289 号票）：默认 pi；只选了一个项目的照项目的（不显示这一项） */
  const [runtime, setRuntime] = useState<string>(PI_RUNTIME_ID);
  /** 从已有的会话接管（290 号票）：换成接管的对话框 */
  const [taking, setTaking] = useState(false);
  /** 在哪个文件夹做（305 号票）：选了能选工作文件夹的运行时（Claude Code）才有 */
  const [folder, setFolder] = useState<FolderDraft>(EMPTY_FOLDER_DRAFT);
  /** 用已有文件夹的：交之前核对路径，不对的原因留在对话框里 */
  const [folderError, setFolderError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const toast = useToast();
  const { ui, startTask, createReminder, http } = useStore();
  const runtimes = useRuntimes();
  const remind = when === "remind";
  /** 事件发生时（77 号票） */
  const evented = when === "event";
  /** 事件发生时还缺什么（文件夹能不能监视建的时候守护进程现查） */
  const eventMissing = evented ? eventTriggerMissing(eventTrigger) : remind && remindMode === "event" ? eventTriggerMissing(remindEvent) : [];
  /** "事件发生时"里能选的任务、项目（过滤条件） */
  const eventTasks = Object.values(ui.tasks).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  const eventProjects = Object.values(ui.projects).filter((p) => p.state !== "archived");
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
    // 长程任务只能现在做一次；换回能定时的做法时，"什么时候做"没动过的按写的话再切到定时
    const now = rightNow();
    setFields(fillWhenFromText(fields, touched, found, k, now));
    setCheckedAt(now.getTime());
  };
  /** 写的话变了：重认一遍时间，没动过的几栏按它填 */
  const write = (text: string) => {
    setWhat(text);
    const now = rightNow();
    const next = timeFromText(text, now);
    setFound(next);
    setFields(fillWhenFromText(fields, touched, next, kind, now));
    setCheckedAt(now.getTime());
  };
  /** 用户自己改了某一栏：之后不再按写的话自动改它 */
  const edit = (part: keyof WhenTouched, patch: Partial<WhenFields>) => {
    setTouched(touchWhen(touched, part));
    setFields({ ...fields, ...patch });
  };
  /** 写的话里的时间：按它定好了、和定的不一样、长程任务不能定时 */
  const textHint = whenTextHint({ found, fields, touched, kind, remindMode });
  /** 只选了一个项目：建成这个项目的内部任务 */
  const inProject = chosen.length === 1 ? chosen[0] : undefined;
  /** 只选了一个还在立项的项目：确认立项书之前不能在里面发起 */
  const chartering = inProject !== undefined && stillChartering(ui, inProject);
  /** 选的运行时能选工作文件夹（305 号票）：不是提醒、不是项目内部任务才有这一项 */
  const folderShown = !remind && inProject === undefined && workFolderRuntime(runtimes, runtime) !== undefined;
  const submit = () => {
    // 用已有文件夹的（305 号票）：先核对路径，不对的留在对话框里写明原因
    if (folderShown && folder.mode === "existing") {
      setChecking(true);
      setFolderError(undefined);
      http
        .checkRuntimeFolder(runtime, folder.path.trim())
        .then(
          () => send(folderChoiceOf(folder)),
          (err: unknown) => setFolderError(err instanceof Error ? err.message : String(err)),
        )
        .finally(() => setChecking(false));
      return;
    }
    send(folderShown ? folderChoiceOf(folder) : undefined);
  };
  const send = (chosenFolder: WorkFolderChoice | undefined) => {
    const request = what.trim();
    if (remind) {
      if (remindMode === "event") {
        createReminder(request, { event: remindEvent });
        toast(t("pages.startTask.toast.reminderEvent", { title: request.split("\n")[0], trigger: describeEventTrigger(remindEvent), name: ASSISTANT_NAME_MARK }));
      } else {
        createReminder(request, remindAt);
        toast(t("pages.startTask.toast.reminderTime", { title: request.split("\n")[0], schedule: describeSchedule(remindAt), name: ASSISTANT_NAME_MARK }));
      }
      onClose();
      return;
    }
    // 只选了一个项目的建成项目内部任务：做完不告诉秘书，不带跑完自动播报
    startTask(
      request,
      chosen,
      kind,
      when === "schedule" ? { kind: "schedule", schedule: at ? doAt : schedule } : evented ? eventTrigger : undefined,
      announce && inProject === undefined,
      inProject === undefined && runtime !== PI_RUNTIME_ID ? runtime : undefined,
      chosenFolder,
    );
    const title = request.split("\n")[0];
    toast(
      at
        ? atToast(kind, title ?? request, doAt, inProject)
        : when === "schedule"
          ? timedToast(kind, title ?? request, schedule, inProject)
          : evented
            ? eventToast(kind, title ?? request, eventTrigger, inProject)
            : startedToast(kind, title ?? request, inProject),
    );
    onClose();
  };
  // 从已有的会话接管（290 号票）：普通任务，写的话带过去当"接着让它做什么"
  if (taking) return <TakeoverSheet runtime={runtime} as="task" initial={what} onBack={() => setTaking(false)} onClose={onClose} />;
  return (
    <Sheet title={t("pages.startTask.title")} onClose={onClose} center>
      {/* 三种做法（75 号票起）：窄的时候页签上只写名字，选中那种的说明写在下面一行；只提醒我用不上做法 */}
      <div className={`sc-picker${remind ? " sc-off" : ""}`} aria-hidden={remind || undefined}>
        <div className="sc-modes" role="tablist">
          {TASK_KINDS.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} className={`sc-mode ${kind === k ? "on" : ""}`} onClick={() => pickKind(k)}>
              <b>
                {TASK_KIND_LABEL[k]}
                {isPlainTask({ kind: k }) ? <em className="sc-default">{t("pages.startTask.default")}</em> : null}
              </b>
              <span>{TASK_KIND_HINT[k]}</span>
            </button>
          ))}
        </div>
        <div className="sc-mode-hint">{TASK_KIND_HINT[kind]}</div>
      </div>
      <label className="field">
        <span>{remind ? t("pages.startTask.whatRemind") : t("pages.startTask.whatDo")}</span>
        <textarea
          value={what}
          onChange={(e) => write(e.target.value)}
          placeholder={remind ? t("pages.startTask.placeholder.remind") : when === "schedule" ? TIMED_PLACEHOLDER[kind] : evented ? EVENT_PLACEHOLDER[kind] : PLACEHOLDER[kind]}
          autoFocus
        />
      </label>
      {/* 什么时候做（76 号票）：现在做一次、定时、只提醒我 */}
      <fieldset className="field when-picker">
        <legend>{t("pages.startTask.when")}</legend>
        <div className="seg when-seg" role="radiogroup" aria-label={t("pages.startTask.when")}>
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
                onClick={() => edit("when", { when: w })}
              >
                {START_WHEN_LABEL[w]}
              </button>
            );
          })}
        </div>
        <div className="sc-mode-hint">{START_WHEN_HINT[when]}</div>
        {/* 写的话里有时间时，下面那一行说得更具体（97 号票） */}
        {!startWhenAllowed(kind, "schedule") && !textHint && <div className="hint">{LONG_RUNNING_TRIGGER_REFUSAL}</div>}
        {/* 定时的两种和各自的时间表（98 号票抽成 TimedScheduleEditor，和任务操作菜单里的"改时间"共用） */}
        {when === "schedule" && (
          <TimedScheduleEditor
            mode={timedMode}
            onMode={(m) => {
              edit("timed", { timedMode: m });
              setCheckedAt(Date.now());
            }}
            repeat={schedule}
            onRepeat={(s) => edit("timed", { schedule: s })}
            at={doAt}
            onAt={(s) => {
              edit("timed", { doAt: s });
              setCheckedAt(Date.now());
            }}
            passed={atPassed ? t("pages.startTask.atPassed", { option: START_WHEN_LABEL.once }) : undefined}
          />
        )}
        {evented && <EventTriggerEditor value={eventTrigger} onChange={setEventTrigger} tasks={eventTasks} projects={eventProjects} workflow={kind === "workflow"} />}
        {remind && (
          <div className="seg timed-seg" role="radiogroup" aria-label={t("pages.startTask.remind")}>
            {REMIND_MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={remindMode === m}
                className={`seg-btn${remindMode === m ? " on" : ""}`}
                onClick={() => {
                  setRemindMode(m);
                  setTouched(touchWhen(touched, "remind"));
                }}
              >
                {REMIND_MODE_LABEL[m]}
              </button>
            ))}
          </div>
        )}
        {remind && remindMode === "time" && <ScheduleEditor value={remindAt} onChange={(s) => edit("remind", { remindAt: s })} label={t("pages.startTask.remindAt")} />}
        {remind && remindMode === "event" && <EventTriggerEditor value={remindEvent} onChange={setRemindEvent} tasks={eventTasks} projects={eventProjects} />}
        {/* 写的话里说了几点（97 号票）：按它定好了、和定的不一样（照样能发起）、长程任务不能定时 */}
        {textHint && <div className={`when-text-hint ${textHint.tone}`}>{textHint.text}</div>}
      </fieldset>
      {/* 跑完自动播报（100 号票）：项目内部任务做完不告诉秘书，没有这一项 */}
      {!remind && inProject === undefined && (
        <label className="check-row announce-row">
          <input type="checkbox" checked={announce} onChange={(e) => setAnnounce(e.target.checked)} />
          <span>
            {TASK_MENU_LABEL.voiceAnnounce}
            <span className="muted">
              <T k={(when === "schedule" && !at) || evented ? "pages.startTask.announceEach" : "pages.startTask.announceDone"} params={{ name: <AssistantName /> }} />
            </span>
          </span>
        </label>
      )}
      {/* 运行时（289 号票）：只有 pi 能选时不显示；只选了一个项目的照项目的 */}
      {!remind && inProject === undefined && <RuntimePicker value={runtime} onChange={setRuntime} />}
      {/* 从已有的会话接管（290 号票）：选的运行时能接管才有 */}
      {!remind && inProject === undefined && <TakeoverLink runtime={runtime} onOpen={() => setTaking(true)} />}
      {/* 在哪个文件夹做（305 号票）：选的运行时能选工作文件夹才有 */}
      {folderShown && (
        <WorkFolderPicker
          runtime={runtime}
          as="task"
          title={what}
          draft={folder}
          onChange={(next) => {
            setFolder(next);
            setFolderError(undefined);
          }}
        />
      )}
      {folderShown && folderError && (
        <div className="prompt-broken" role="alert">
          {folderError}
        </div>
      )}
      {!remind && (
      <fieldset className="field">
        <legend>{kind === "workflow" ? t("pages.startTask.projectWorkflow") : t("pages.startTask.projects")}</legend>
        <label className="check-row">
          <input type="checkbox" checked={chosen.length === 0} onChange={() => setChosen([])} />
          {t("pages.startTask.noProject")}
        </label>
        {projects.map((name) => (
          <label key={name} className="check-row">
            <input type="checkbox" checked={chosen.includes(name)} onChange={() => toggle(name)} />
            {name}
          </label>
        ))}
      </fieldset>
      )}
      {!remind && inProject !== undefined && !chartering && <div className="hint">{t("pages.startTask.oneProject", { project: inProject })}</div>}
      {!remind && chartering && <div className="hint">{t("pages.startTask.chartering", { project: inProject })}</div>}
      {!remind && chosen.length > 1 && <div className="hint">{t("pages.startTask.severalProjects")}</div>}
      {remind ? (
        <div className="hint">
          {remindMode === "event" ? t("pages.startTask.hint.remindEvent", { option: START_WHEN_LABEL.event }) : t("pages.startTask.hint.remindTime", { option: START_WHEN_LABEL.schedule })}
        </div>
      ) : evented ? (
        <div className="hint">
          {kind === "workflow" ? t("pages.startTask.hint.eventWorkflow") : t("pages.startTask.hint.eventPlain")}
        </div>
      ) : at ? (
        <div className="hint">
          {kind === "workflow" ? t("pages.startTask.hint.atWorkflow") : <T k="pages.startTask.hint.atPlain" params={{ name: <AssistantName /> }} />}
        </div>
      ) : when === "schedule" ? (
        <div className="hint">
          {kind === "workflow" ? (
            t("pages.startTask.hint.scheduleWorkflow")
          ) : (
            <T k={inProject === undefined ? "pages.startTask.hint.schedulePlain" : "pages.startTask.hint.schedulePlainInProject"} params={{ name: <AssistantName /> }} />
          )}
        </div>
      ) : isPlainTask({ kind }) ? (
        <div className="hint">
          <T k={inProject === undefined ? "pages.startTask.hint.plain" : "pages.startTask.hint.plainInProject"} params={{ name: <AssistantName /> }} />
        </div>
      ) : (
        <div className="hint">
          <T
            k={
              kind === "workflow"
                ? inProject === undefined
                  ? "pages.startTask.hint.workflow"
                  : "pages.startTask.hint.workflowInProject"
                : inProject === undefined
                  ? "pages.startTask.hint.longRunning"
                  : "pages.startTask.hint.longRunningInProject"
            }
            params={{ name: <AssistantName /> }}
          />
        </div>
      )}
      {/* 按钮固定在对话框底部：一屏放不下时滚动的是上面的内容 */}
      <div className="auth-actions sc-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          {t("pages.startTask.cancel")}
        </button>
        <button type="button" className="btn primary" disabled={!what.trim() || (!remind && chartering) || atPassed || eventMissing.length > 0 || (folderShown && !folderDraftReady(folder)) || checking} onClick={submit}>
          {remind ? t("pages.startTask.submit.reminder") : at ? SUBMIT_AT[kind] : when === "schedule" ? SUBMIT_TIMED[kind] : evented ? SUBMIT_EVENT[kind] : SUBMIT_NOW[kind]}
        </button>
      </div>
    </Sheet>
  );
}

/** 此刻（只在点按、输入时取；渲染时不取时钟） */
const rightNow = () => new Date();

/** "要做什么"框里的示例：各做法各一句（长程任务三种时候都是同一句） */
const PLACEHOLDER: Readonly<Record<TaskKind, string>> = tTable({
  plain: "pages.startTask.placeholder.plain",
  workflow: "pages.startTask.placeholder.workflow",
  long_running: "pages.startTask.placeholder.long",
});

/** 选了"定时"时"要做什么"框里的示例 */
const TIMED_PLACEHOLDER: Readonly<Record<TaskKind, string>> = tTable({
  plain: "pages.startTask.placeholder.timedPlain",
  workflow: "pages.startTask.placeholder.timedWorkflow",
  long_running: "pages.startTask.placeholder.long",
});

/** 选了"事件发生时"时"要做什么"框里的示例（77 号票） */
const EVENT_PLACEHOLDER: Readonly<Record<TaskKind, string>> = tTable({
  plain: "pages.startTask.placeholder.eventPlain",
  workflow: "pages.startTask.placeholder.eventWorkflow",
  long_running: "pages.startTask.placeholder.long",
});

/**
 * 发起按钮上的字，各做法一句（171 号票：中文和原来拼出来的一样——"发起"加做法的名字；英文各写各的，做法的名字在句中小写）。
 * 长程任务只能现在做一次，定时、事件触发、某个时间做一次的用不上，照样写着
 */
const SUBMIT_NOW: Readonly<Record<TaskKind, string>> = tTable({
  plain: "pages.startTask.submit.now.plain",
  workflow: "pages.startTask.submit.now.workflow",
  long_running: "pages.startTask.submit.now.longRunning",
});
const SUBMIT_AT: Readonly<Record<TaskKind, string>> = tTable({
  plain: "pages.startTask.submit.at.plain",
  workflow: "pages.startTask.submit.at.workflow",
  long_running: "pages.startTask.submit.at.longRunning",
});
const SUBMIT_TIMED: Readonly<Record<TaskKind, string>> = tTable({
  plain: "pages.startTask.submit.timed.plain",
  workflow: "pages.startTask.submit.timed.workflow",
  long_running: "pages.startTask.submit.timed.longRunning",
});
const SUBMIT_EVENT: Readonly<Record<TaskKind, string>> = tTable({
  plain: "pages.startTask.submit.event.plain",
  workflow: "pages.startTask.submit.event.workflow",
  long_running: "pages.startTask.submit.event.longRunning",
});

/** 定时的任务建出之后的提示（76 号票） */
function timedToast(kind: TaskKind, title: string, schedule: ReminderSchedule, inProject: string | undefined): string {
  const params = { title, schedule: describeSchedule(schedule), project: inProject ?? "" };
  if (kind === "workflow") return t(inProject === undefined ? "pages.startTask.toast.timedWorkflow" : "pages.startTask.toast.timedWorkflowInProject", params);
  return t(inProject === undefined ? "pages.startTask.toast.timedPlain" : "pages.startTask.toast.timedPlainInProject", params);
}

/** 事件触发的任务建出之后的提示（77 号票） */
function eventToast(kind: TaskKind, title: string, trigger: EventTrigger, inProject: string | undefined): string {
  const params = { title, trigger: describeEventTrigger(trigger), project: inProject ?? "" };
  if (kind === "workflow") return t(inProject === undefined ? "pages.startTask.toast.eventWorkflow" : "pages.startTask.toast.eventWorkflowInProject", params);
  return t(inProject === undefined ? "pages.startTask.toast.eventPlain" : "pages.startTask.toast.eventPlainInProject", params);
}

/** 某个时间做一次的任务建出之后的提示（76 号票） */
function atToast(kind: TaskKind, title: string, schedule: ReminderSchedule, inProject: string | undefined): string {
  const time = schedule.kind === "once" ? describeTime(new Date(schedule.at)) : describeSchedule(schedule);
  const params = { title, time, project: inProject ?? "", name: ASSISTANT_NAME_MARK };
  if (kind === "workflow") return t(inProject === undefined ? "pages.startTask.toast.atWorkflow" : "pages.startTask.toast.atWorkflowInProject", params);
  return t(inProject === undefined ? "pages.startTask.toast.atPlain" : "pages.startTask.toast.atPlainInProject", params);
}

/** 发起之后的提示：普通任务（75 号票）直接排队开始做；有计划的两种先对齐意图 */
function startedToast(kind: TaskKind, title: string, inProject: string | undefined): string {
  const params = { title, project: inProject ?? "", kind: TASK_KIND_LABEL[kind], name: ASSISTANT_NAME_MARK };
  if (isPlainTask({ kind })) return t(inProject === undefined ? "pages.startTask.toast.startedPlain" : "pages.startTask.toast.startedPlainInProject", params);
  return t(inProject === undefined ? "pages.startTask.toast.started" : "pages.startTask.toast.startedInProject", params);
}
