// 除计划确认卡、计划变更卡以外的 13 种卡片（112 号票加了"首版做完了"卡）。负载形状见 model/cards.ts。
import { type ReactNode, useState } from "react";
import { toHash } from "../../app/route.ts";
import {
  type ApprovalPayload,
  type BuildDonePayload,
  CARD_ACTION_LABEL,
  type CharterPayload,
  type GoLivePayload,
  type PairingPayload,
  type ParallelPayload,
  type ProgressPayload,
  type QuestionsPayload,
  type SuggestProjectPayload,
  type SuggestTaskPayload,
  type WorkOrderPayload,
} from "../../model/cards.ts";
import { DISPOSITION_LABEL, MONDAY_FIRST, weekdayLabel } from "../../model/labels.ts";
import { nowIso, timeLabel } from "../../util/time.ts";
import type { Toolkit } from "../../model/types.ts";
import {
  automatedAccessHint,
  ACCEPTANCE_VERDICT_LABEL,
  describeSchedule,
  nextClockTime,
  BUILD_DONE_CHOICE_LABEL,
  buildDoneTitle,
  checklistMissing,
  GO_LIVE_BY_LABEL,
  GO_LIVE_CHOICE_LABEL,
  type GoLiveChecklistItem,
  goLiveTitle,
  maxDayOfMonth,
  monthName,
  OPERATIONS_PUT_IN_USE_LABEL,
  CHARTER_DECISION_LABEL,
  PROJECT_KIND_LABEL,
  type QuickActionCardPayload,
  quickActionFieldLabels,
  REPEAT_KIND_LABEL,
  REPEAT_KINDS,
  type ReminderSchedule,
  type RepeatKind,
  type RepeatRule,
  repeatRuleOf,
  repeatSchedule,
  runtimeChipText,
  scheduleClockTime,
  type ToolkitChangeCardPayload,
  toolkitText,
  TASK_KIND_HINT,
  internalScopeLabel,
  type McpChangeCardPayload,
  type McpChangeToolView,
  TASK_KIND_LABEL,
  stageLabelIn,
  // 159 号票：给用户看的编号写"t-3「整理发票」"（163 号票）、维护者写它属于谁
  taskLabel,
  TELL_SECRETARY_LABEL,
  tellSecretaryOn,
  SEND_ATTACHMENT_LABEL,
  sendAttachmentOn,
  PURGED_TEXT,
  t,
  tTable,
  type WorkFolderChoice,
  workFolderRuntime,
  folderChoiceLine,
} from "../../state/index.ts";
import { useStore } from "../../app/store.tsx";
import { AssistantName, NamedText } from "../assistant-name.tsx";
import { AutoGrowText } from "../auto-grow-text.tsx";
import { T } from "../i18n.tsx";
import { useRuntimes } from "../runtimes.tsx";
import { type CardProps, CardShell } from "./CardShell.tsx";
import { OperationsPlanSection, useOperationConfirmations } from "./OperationsCards.tsx";

const toolkitList = (xs: readonly string[]) => (xs.length ? xs.join(t("ui.common.listSep")) : t("ui.cards.toolkit.none"));
const onOff = (on: boolean) => (on ? t("ui.cards.toolkit.on") : t("ui.cards.toolkit.off"));

export function toolkitLabel(kit: Toolkit): string {
  return [
    t("ui.cards.toolkit.skills", { list: toolkitList(kit.skills) }),
    t("ui.cards.toolkit.mcp", { list: toolkitList(kit.mcps) }),
    t("ui.cards.toolkit.bash", { state: onOff(kit.bash) }),
    t("ui.cards.toolkit.network", { state: onOff(kit.network) }),
    // 给秘书发消息（102 号票）、发附件（117 号票）默认开着，只在关掉时写
    ...(tellSecretaryOn(kit) ? [] : [t("ui.cards.toolkit.labelOff", { label: TELL_SECRETARY_LABEL })]),
    ...(sendAttachmentOn(kit) ? [] : [t("ui.cards.toolkit.labelOff", { label: SEND_ATTACHMENT_LABEL })]),
  ].join(t("ui.cards.itemSep"));
}

/** 卡片上的按钮（193 号票起网页插件的卡片也用它） */
export function Btn({ kind = "ghost", onClick, children, disabled }: { kind?: "primary" | "ghost" | "danger"; onClick(): void; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" className={`btn ${kind}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function ApprovalCard({ state, payload: p, act }: CardProps<ApprovalPayload>) {
  return (
    <CardShell
      state={state}
      title={<NamedText text={p.source} />}
      actions={
        <>
          <Btn onClick={() => act("deny")}>{t("ui.cards.deny")}</Btn>
          <Btn kind="primary" onClick={() => act("approve")}>
            {t("ui.cards.approval.approveOnce")}
          </Btn>
        </>
      }
    >
      <div className="tool-line">
        {/* tool-title：经典不认，给视觉风格下样式（夜航仪表把工具名排成参数上面一行灰字，39 号票的规矩：补 class，不改结构） */}
        <b className="tool-title">{p.toolTitle}</b> <code>{p.argsSummary}</code>
      </div>
      <div className="chips">
        {p.categoryTitles.map((c) => (
          <span key={c} className="chip chip-op">
            {c}
          </span>
        ))}
        <span className="chip">{t("ui.cards.approval.askFirst")}</span>
      </div>
      <div className="sys-note">{p.reason}</div>
    </CardShell>
  );
}

/**
 * 工具包变更卡（27 号票）：项目维护者不在任务里时要开 bash、加 MCP、开联网，提交它进待我处理。
 * 卡上的"工具包变更"一栏列出要加的能力；批准后加进项目的工具包、维护者按新工具包重新装配，拒绝则不变（可以附一句原因）
 */
export function ToolkitChangeCard({ state, payload: p, done, act }: CardProps<ToolkitChangeCardPayload>) {
  const [note, setNote] = useState("");
  const said = note.trim() ? note.trim() : undefined;
  return (
    <CardShell
      state={state}
      title={t("ui.cards.toolkitChange.title", { project: p.projectName })}
      actions={
        <>
          {/* 中文照旧写"已拒绝""已批准"（和处理结果同一个说法）；英文按钮用动词 */}
          <Btn onClick={() => act("deny", said)}>{t("ui.cards.toolkitChange.deny")}</Btn>
          <Btn kind="primary" onClick={() => act("approve", said)}>
            {t("ui.cards.toolkitChange.approve")}
          </Btn>
        </>
      }
    >
      <div className="sys-note">{p.why}</div>
      <div className="tool-line">
        <T k="ui.cards.toolkitChange.adds" params={{ label: <b>{t("ui.cards.toolkitChange.label")}</b>, list: p.additions.join(t("ui.common.listSep")) }} />
      </div>
      <div className="muted">{t("ui.cards.toolkitChange.before", { toolkit: toolkitText(p.before) })}</div>
      <div className="muted">{p.applied ? t("ui.cards.toolkitChange.applied", { toolkit: toolkitText(p.applied) }) : t("ui.cards.toolkitChange.after", { toolkit: toolkitText(p.after) })}</div>
      {!done && <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("ui.cards.toolkitChange.notePlaceholder")} aria-label={t("ui.cards.toolkitChange.noteLabel")} />}
    </CardShell>
  );
}

/**
 * 提问卡（12 号票）：成批提问，每题带推荐答案。点选项、或者自己写；"全按推荐"一次提交全部答案（每题都取推荐的）。
 * 回答过的卡上显示每题的答案。
 */
export function QuestionsCard({ state, payload: p, done, act }: CardProps<QuestionsPayload>) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const all = p.questions.every((q) => answers[q.id]?.trim());
  const given = Object.fromEntries((p.answers ?? []).map((a) => [a.questionId, a.answer]));
  const submit = (chosen: Record<string, string>) => act("answer", undefined, { answers: p.questions.map((q) => ({ questionId: q.id, answer: chosen[q.id]!.trim() })) });
  return (
    <CardShell
      state={state}
      title={t("ui.cards.questions.title", { count: p.questions.length })}
      actions={
        <>
          <Btn onClick={() => submit(Object.fromEntries(p.questions.map((q) => [q.id, q.recommended])))}>{t("ui.cards.questions.allRecommended")}</Btn>
          <Btn kind="primary" disabled={!all} onClick={() => submit(answers)}>
            {t("ui.cards.questions.submit")}
          </Btn>
        </>
      }
    >
      {p.intro && <div className="agent-says">{p.intro}</div>}
      {p.questions.map((q, qi) => {
        // 推荐的答案不在选项里时也给一个按钮
        const options = q.options.includes(q.recommended) ? q.options : [q.recommended, ...q.options];
        const answer = done ? given[q.id] : answers[q.id];
        return (
          <fieldset key={q.id} className="qa" disabled={done}>
            <legend>
              {qi + 1}. {q.question}
            </legend>
            {q.why && <div className="muted">{q.why}</div>}
            <div className="qa-opts">
              {options.map((o) => (
                <button key={o} type="button" className={`qa-opt${answer === o ? " on" : ""}`} aria-pressed={answer === o} onClick={() => setAnswers({ ...answers, [q.id]: o })}>
                  {o}
                  {o === q.recommended && <span className="qa-rec">{t("ui.cards.questions.recommended")}</span>}
                </button>
              ))}
            </div>
            {done ? (
              answer !== undefined && !options.includes(answer) && <div className="muted">{t("ui.cards.questions.yourAnswer", { answer })}</div>
            ) : (
              // 105 号票：自己写的答案随内容长高（长了也看得全）
              <AutoGrowText
                className="input"
                value={answer !== undefined && !options.includes(answer) ? answer : ""}
                onChange={(text) => setAnswers({ ...answers, [q.id]: text })}
                placeholder={t("ui.cards.questions.ownPlaceholder")}
                aria-label={t("ui.cards.questions.ownLabel", { n: qi + 1 })}
              />
            )}
          </fieldset>
        );
      })}
    </CardShell>
  );
}

/**
 * MCP 登记变更卡（239 号票）：维护者提的加、改、删一条 MCP 登记。卡上列出启动命令、args、环境变量（凭据只写"来自环境变量 X"）、
 * 暴露的工具和只读/联网/快速动作标注。批准后运行时按 name 合并写进数据目录配置区的 mcp.json、顺手拉起这个 MCP 自检，
 * 拒绝则一个字节都不动（可以附一句原因）
 */
/** 一个工具在卡上的标注（只读或幂等、要联网、快速动作） */
function mcpToolMarks(tool: McpChangeToolView): string {
  return [
    tool.readOnlyOrIdempotent === true ? t("ui.cards.mcpChange.markReadOnly") : "",
    tool.network === false ? "" : t("ui.cards.mcpChange.markNetwork"),
    tool.quickAction ? t("ui.cards.mcpChange.markQuickAction", { title: tool.quickAction.title }) : "",
  ]
    .filter(Boolean)
    .join(t("ui.common.listSep"));
}

export function McpChangeCard({ state, payload: p, done, act }: CardProps<McpChangeCardPayload>) {
  const [note, setNote] = useState("");
  const said = note.trim() ? note.trim() : undefined;
  const who = p.submitter.kind === "project" ? t("ui.cards.mcpChange.titleProject", { project: p.submitter.projectName }) : t("ui.cards.mcpChange.titleTask", { task: p.submitter.taskTitle });
  const registration = p.registration;
  const env = Object.entries(registration?.env ?? {});
  return (
    <CardShell
      state={state}
      title={who}
      actions={
        <>
          {/* 中文照旧写"已拒绝""已批准"（和处理结果同一个说法）；英文按钮用动词 */}
          <Btn onClick={() => act("deny", said)}>{t("ui.cards.mcpChange.deny")}</Btn>
          <Btn kind="primary" onClick={() => act("approve", said)}>
            {t("ui.cards.mcpChange.approve")}
          </Btn>
        </>
      }
    >
      {p.why && <div className="sys-note">{p.why}</div>}
      <div className="tool-line">
        <T k="ui.cards.mcpChange.change" params={{ action: t(`ui.cards.mcpChange.action.${p.action}`), name: <code>{p.name}</code> }} />
      </div>
      {registration && (
        <>
          <div className="muted">{t("ui.cards.mcpChange.command", { command: [registration.command, ...(registration.args ?? [])].join(" ") })}</div>
          {registration.cwd && <div className="muted">{t("ui.cards.mcpChange.cwd", { cwd: registration.cwd })}</div>}
          {env.map(([name, value]) => (
            <div className="muted" key={name}>
              {t("ui.cards.mcpChange.env", { name, value: typeof value === "string" ? value : t("ui.cards.mcpChange.envFrom", { variable: value.fromEnv }) })}
            </div>
          ))}
          <ul className="plain-list">
            {Object.entries(registration.tools).map(([name, tool]) => (
              <li key={name}>
                {tool.title} <code>{name}</code>
                <span className="muted">{mcpToolMarks(tool)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {p.check && <div className="muted">{p.check.ok ? t("ui.cards.mcpChange.checkPassed", { tools: p.check.tools.join(t("ui.common.listSep")) }) : t("ui.cards.mcpChange.checkFailed", { problem: p.check.problem ?? t("ui.cards.mcpChange.checkUnknown") })}</div>}
      {!done && <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("ui.cards.mcpChange.notePlaceholder")} aria-label={t("ui.cards.mcpChange.noteLabel")} />}
    </CardShell>
  );
}

/**
 * 进度卡（13 号票）：所属任务、第 N/M 阶段；维护者报告的进展，或者一个阶段的验收结论——每条标准的方式和结果，
 * 谁判的（评审方式的标"评审判定"）。只是告诉你，唯一的动作是"知道了"
 */
export function ProgressCard({ state, payload: p, act }: CardProps<ProgressPayload>) {
  const verdict = p.kind === "acceptance" ? p.acceptance : undefined;
  // 91 号票：第几阶段按依赖图的编号（并行的写 4a、4b，和计划图一致）；认不出这个阶段时用卡上带的编号（93 号票起），
  // 再之前的卡只有计划里的第几个 / 共几个
  const stage = stageLabelIn(useStore().ui, p.taskId, p.stageId, t("ui.cards.progress.stage", { code: p.stageCode ?? `${p.stageIndex}/${p.stageTotal}` }));
  return (
    <CardShell state={state} title={t("ui.cards.progress.title", { task: p.taskTitle, stage, title: p.stageTitle })} actions={<Btn onClick={() => act("ack")}>{t("ui.cards.progress.ack")}</Btn>}>
      {verdict && (
        <div>
          <span className={verdict.passed ? "chip chip-ok" : "chip chip-no"}>{verdict.passed ? t("ui.cards.progress.passed") : t("ui.cards.progress.failed")}</span> <span className="muted">{ACCEPTANCE_VERDICT_LABEL[verdict.judgedBy]}</span>
          <ul className="plain-list">
            {verdict.results.map((r) => (
              <li key={`${r.method}:${r.criterion}`} className={r.passed ? "sys-line" : undefined}>
                {r.passed ? "✓" : "✕"} {r.criterion}
                <span className="muted">{t("ui.cards.progress.method", { method: ACCEPTANCE_VERDICT_LABEL[r.method] })}</span>
                {r.note && <div className="muted">{r.note}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>{p.text}</div>
    </CardShell>
  );
}

/**
 * 快速动作卡（21 号票）：规范化后的动作（对谁做、做什么）。你这一句话里点明了对象和内容的，出来就是"已执行"；
 * 秘书推断出来、要先问的，带"执行"和"取消"。执行之后写上结果。
 */
export function QuickActionCard({ state, payload: p, act }: CardProps<QuickActionCardPayload>) {
  // 秘书转达（103 号票）写"发给""转达的话"，别的动作照旧"对象""内容"
  const labels = quickActionFieldLabels(p.action.type);
  return (
    <CardShell
      state={state}
      title={p.title}
      doneLabel={state.card.status === "handled" && p.result ? t("ui.cards.quickAction.done", { result: p.result }) : undefined}
      actions={
        <>
          <Btn onClick={() => act("cancel")}>{t("ui.cards.quickAction.cancel")}</Btn>
          <Btn kind="primary" onClick={() => act("execute")}>
            {t("ui.cards.quickAction.execute")}
          </Btn>
        </>
      }
    >
      {p.target && (
        <div>
          <span className="muted">{t("ui.cards.quickAction.field", { label: labels.target })}</span>
          {p.target}
        </div>
      )}
      {p.content && (
        <div>
          <span className="muted">{t("ui.cards.quickAction.field", { label: labels.content })}</span>
          {p.content}
        </div>
      )}
      {/* 281 号票：直接写进个人档案的回执，撤销在档案页上（那个字段的"撤销"回到上一个值） */}
      {p.action.type === "personal_file" && state.card.status === "handled" && p.result !== undefined && p.result !== PURGED_TEXT && (
        <a className="link" href={toHash({ tab: "more", page: "files", ...personalFileOf(p.action.params) })}>
          {t("ui.cards.personalFile.openToUndo")}
        </a>
      )}
      {/* 284 号票：开了一次了解你访谈的回执：访谈在记忆 · 管理员那里（记忆插件的页面；插件停用时那一页写没启用） */}
      {p.action.type === "start_interview" && state.card.status === "handled" && (
        <a className="link" href={toHash({ tab: "more", page: "memory", item: "curator" })}>
          {t("ui.cards.quickAction.goInterview")}
        </a>
      )}
      {p.explicit ? (
        <div className="muted">{t("ui.cards.quickAction.explicit")}</div>
      ) : (
        <>
          {p.categories.length > 0 && (
            <div className="chips">
              {p.categories.map((c) => (
                <span key={c} className="chip chip-op">
                  {c}
                </span>
              ))}
              <span className="chip">{DISPOSITION_LABEL[p.disposition]}</span>
            </div>
          )}
          <div className="muted">
            {state.card.status === "pending" ? (
              <T k="ui.cards.quickAction.inferredPending" params={{ name: <AssistantName /> }} />
            ) : (
              <T k="ui.cards.quickAction.inferred" params={{ name: <AssistantName /> }} />
            )}
          </div>
        </>
      )}
    </CardShell>
  );
}

/** 写个人档案的快速动作（281 号票）存的参数里写给的那份档案（新建的人没有编号，去列表） */
function personalFileOf(params: unknown): { item?: string } {
  const id = typeof params === "object" && params !== null ? (params as { personId?: unknown }).personId : undefined;
  return typeof id === "string" ? { item: id } : {};
}

/** "建议发起任务"卡（58 号票）：秘书觉得该发起、用户没点明的事；两个按钮"作为流程""作为长程任务"，点了哪个建哪种 */
export function SuggestTaskCard({ state, payload: p, act }: CardProps<SuggestTaskPayload>) {
  const { ui } = useStore();
  return (
    <CardShell
      state={state}
      title={p.title}
      actions={
        <>
          <Btn onClick={() => act("dismiss")}>{t("ui.cards.notNeeded")}</Btn>
          <Btn onClick={() => act("start_workflow")}>{t("ui.cards.suggestTask.startAs", { kind: TASK_KIND_LABEL.workflow })}</Btn>
          <Btn kind="primary" onClick={() => act("start_task")}>
            {t("ui.cards.suggestTask.startAs", { kind: TASK_KIND_LABEL.long_running })}
          </Btn>
        </>
      }
    >
      <div className="agent-says">{p.why}</div>
      {p.projects && p.projects.length > 0 && <div className="muted">{t("ui.cards.suggestTask.projects", { list: p.projects.join(t("ui.common.listSep")) })}</div>}
      {/* 只写了一个项目（64 号票）：点了建成这个项目的内部任务 */}
      {p.projects?.length === 1 && !p.internal && <div className="muted">{t("ui.cards.suggestTask.willCreateIn", { scope: internalScopeLabel(p.projects[0]!) })}</div>}
      {/* 项目的维护者给的建议卡（64 号票）：点了建出的是这个项目的内部任务 */}
      {p.internal && <div className="muted">{t("ui.cards.suggestTask.createdIn", { scope: internalScopeLabel(p.internal.projectName) })}</div>}
      {state.card.status === "pending" && (
        <div className="muted">
          {t("ui.cards.suggestTask.kindHints", {
            workflow: TASK_KIND_LABEL.workflow,
            workflowHint: TASK_KIND_HINT.workflow,
            task: TASK_KIND_LABEL.long_running,
            taskHint: TASK_KIND_HINT.long_running,
          })}
        </div>
      )}
      {p.taskId && (
        <a className="link" href={toHash({ tab: "tasks", taskId: p.taskId })}>
          {t("ui.cards.suggestTask.open", { kind: p.kind ? TASK_KIND_LABEL[p.kind] : t("ui.cards.suggestTask.task"), task: taskLabel(ui, p.taskId) })}
        </a>
      )}
    </CardShell>
  );
}

export function SuggestProjectCard({ state, payload: p, act }: CardProps<SuggestProjectPayload>) {
  return (
    <CardShell
      state={state}
      title={p.name}
      actions={
        <>
          <Btn onClick={() => act("dismiss")}>{t("ui.cards.notNeeded")}</Btn>
          <Btn kind="primary" onClick={() => act("kickoff")}>
            {t("ui.cards.suggestProject.kickoff")}
          </Btn>
        </>
      }
    >
      <div className="sp-goal">{p.goal}</div>
      {/* 维护者用的运行时（289 号票：点"新建项目"时选的）：插件登记的才写 */}
      {p.runtime !== undefined && <SuggestedRuntime runtime={p.runtime} />}
      {/* 在哪个文件夹做（305 号票：选了能选工作文件夹的运行时才写） */}
      {p.runtime !== undefined && <SuggestedFolder runtime={p.runtime} folder={p.folder} name={p.name} />}
      {p.projectId ? (
        <a className="link" href={toHash({ tab: "projects", projectId: p.projectId, chat: true })}>
          {t("ui.cards.suggestProject.charterChat")}
        </a>
      ) : (
        <div className="muted">{t("ui.cards.suggestProject.hint")}</div>
      )}
    </CardShell>
  );
}

/** 建议立项卡上写的运行时（289 号票） */
function SuggestedRuntime({ runtime }: { runtime: string }) {
  const text = runtimeChipText(useRuntimes(), runtime);
  return text === undefined ? null : <div className="muted sp-runtime">{t("ui.cards.suggestProject.runtime", { runtime: text })}</div>;
}

/** 建议立项卡上写的"在哪个文件夹做"（305 号票）：点"立项"时才定下 */
function SuggestedFolder({ runtime, folder, name }: { runtime: string; folder: WorkFolderChoice | undefined; name: string }) {
  const found = workFolderRuntime(useRuntimes(), runtime);
  return found === undefined ? null : <div className="muted sp-runtime sp-folder">{folderChoiceLine(folder, found.workFolder?.defaultFolder, name)}</div>;
}

/** datetime-local 输入框的值（本地时间，到分钟） */
function localInputValue(iso: string): string {
  return nowIso(new Date(iso)).slice(0, 16);
}

/** 换成一次性：这个钟点下一次出现的那一刻（今天没到就是今天，过了就是明天） */
function onceAt(time: string): ReminderSchedule {
  return { kind: "once", at: nowIso(nextClockTime(time, new Date())) };
}

/** 每年的提醒能选的月份 */
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

/**
 * 改提醒的时间：一次性（哪天几点），或者几点加重复规则（种类和名字取自 REPEAT_KINDS；"按我的工作日"在 29 号票加进去，
 * "每年"在 282 号票：选几月、几日，几日跟着月份最多到月底，2 月能选 29 日）。
 * repeatOnly（76 号票）：发起对话框里"定时"的时间表只能是重复的（一次性的提醒用"只提醒我"），没有"一次性"这一项；
 * label 换掉最后那行的前缀（默认"改成："）
 */
export function ScheduleEditor({
  value,
  onChange,
  repeatOnly,
  onceOnly,
  label = t("ui.cards.schedule.changeTo"),
}: {
  value: ReminderSchedule;
  onChange(s: ReminderSchedule): void;
  repeatOnly?: boolean;
  /** 只选某个时间（日期和时间），不选重复（发起对话框里"定时 · 某个时间做一次"，76 号票） */
  onceOnly?: boolean;
  label?: string;
}) {
  const time = scheduleClockTime(value);
  const rule = repeatRuleOf(value);
  /** 换重复规则或钟点；规则不全（比如周几全取消了）就不换 */
  const setRepeat = (next: RepeatRule, clock: string) => {
    const result = repeatSchedule(next, clock);
    if ("schedule" in result) onChange(result.schedule);
  };
  return (
    <fieldset className="repeat">
      {!onceOnly && (
        <label className="repeat-row">
          <span>{t("ui.cards.schedule.repeat")}</span>
          <select
            className="input"
            value={rule?.kind ?? "once"}
            onChange={(e) => {
              const kind = e.target.value as RepeatKind | "once";
              if (kind === "once") onChange(onceAt(time));
              else setRepeat({ kind, weekdays: rule?.weekdays ?? [1], days: rule?.days ?? [1], ...yearDayFrom(value, rule) }, time);
            }}
          >
            {!repeatOnly && <option value="once">{t("ui.cards.schedule.once")}</option>}
            {REPEAT_KINDS.map((k) => (
              <option key={k} value={k}>
                {REPEAT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      )}
      {value.kind === "once" ? (
        <label className="repeat-row">
          <span>{t("ui.cards.schedule.dateTime")}</span>
          <input
            className="input"
            type="datetime-local"
            value={localInputValue(value.at)}
            onChange={(e) => {
              const at = new Date(e.target.value);
              if (!Number.isNaN(at.getTime())) onChange({ kind: "once", at: nowIso(at) });
            }}
          />
        </label>
      ) : (
        <label className="repeat-row">
          <span>{t("ui.cards.schedule.time")}</span>
          <input className="input" type="time" value={time} onChange={(e) => e.target.value && rule && setRepeat(rule, e.target.value)} />
        </label>
      )}
      {rule?.kind === "weekly" && (
        <div className="day-picks">
          {MONDAY_FIRST.map((d) => {
            const weekdays = rule.weekdays ?? [];
            const on = weekdays.includes(d);
            return (
              <button
                key={d}
                type="button"
                className={`day-pick${on ? " on" : ""}`}
                aria-pressed={on}
                onClick={() => setRepeat({ kind: "weekly", weekdays: on ? weekdays.filter((x) => x !== d) : [...weekdays, d] }, time)}
              >
                {weekdayLabel(d, true)}
              </button>
            );
          })}
        </div>
      )}
      {rule?.kind === "monthly" && (
        <label className="repeat-row">
          <span>{t("ui.cards.schedule.days")}</span>
          <input
            className="input"
            defaultValue={(rule.days ?? []).join(", ")}
            placeholder={t("ui.cards.schedule.daysPlaceholder")}
            onChange={(e) =>
              setRepeat(
                {
                  kind: "monthly",
                  days: e.target.value
                    .split(/[,，\s]+/) // @i18n-ignore data：认用户输入里的中文逗号
                    .map(Number)
                    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 31),
                },
                time,
              )
            }
          />
        </label>
      )}
      {rule?.kind === "yearly" && rule.month !== undefined && rule.day !== undefined && <YearDayPick month={rule.month} day={rule.day} onChange={(next) => setRepeat({ kind: "yearly", ...next }, time)} />}
      <div className="muted">
        {label}
        {describeSchedule(value)}
      </div>
    </fieldset>
  );
}

/** 换成每年时的几月几日：原来是每年的照旧；一次性的取那一天；别的取今天 */
function yearDayFrom(value: ReminderSchedule, rule: RepeatRule | undefined): { month: number; day: number } {
  if (rule?.month !== undefined && rule.day !== undefined) return { month: rule.month, day: rule.day };
  const day = value.kind === "once" ? new Date(value.at) : new Date();
  return { month: day.getMonth() + 1, day: day.getDate() };
}

/** 每年的几月几日（282 号票）：两个下拉，换月份时几日超过那个月的月底就落到月底（2 月最多 29 日，平年在 28 日响） */
function YearDayPick({ month, day, onChange }: { month: number; day: number; onChange(next: { month: number; day: number }): void }) {
  return (
    <div className="repeat-row" role="group" aria-label={t("ui.cards.schedule.yearDay")}>
      <span>{t("ui.cards.schedule.yearDay")}</span>
      <select className="input" aria-label={t("ui.cards.schedule.month")} value={month} onChange={(e) => onChange({ month: Number(e.target.value), day: Math.min(day, maxDayOfMonth(Number(e.target.value))) })}>
        {MONTHS.map((m) => (
          <option key={m} value={m}>
            {monthName(m)}
          </option>
        ))}
      </select>
      <select className="input" aria-label={t("ui.cards.schedule.day")} value={day} onChange={(e) => onChange({ month, day: Number(e.target.value) })}>
        {Array.from({ length: maxDayOfMonth(month) }, (_, i) => i + 1).map((d) => (
          <option key={d} value={d}>
            {t("ui.cards.schedule.dayOfMonth", { day: d })}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * 立项书卡：由维护者交出的结构化立项书生成。项目类型、外部工作目录绑定和工具包在确认时就生效（两个按钮都是）；
 * "确认并开工"同时建出首个建设任务，"只确认，稍后开工"项目留在筹备中
 */
export function CharterCard({ state, payload: p, act }: CardProps<CharterPayload>) {
  const { ui } = useStore();
  const { charter } = p;
  return (
    <CardShell
      state={state}
      title={`${p.projectName}${p.revision > 1 ? t("ui.cards.charter.revision", { revision: p.revision }) : ""}`}
      actions={
        <>
          <Btn onClick={() => act("confirm_later")}>{CHARTER_DECISION_LABEL.later}</Btn>
          <Btn kind="primary" onClick={() => act("confirm_start")}>
            {CHARTER_DECISION_LABEL.start}
          </Btn>
        </>
      }
    >
      <dl className="kv">
        <dt>{t("ui.cards.charter.kind")}</dt>
        <dd>{PROJECT_KIND_LABEL[charter.kind]}</dd>
        <dt>{t("ui.cards.charter.goal")}</dt>
        <dd>{charter.goal}</dd>
        <dt>{t("ui.cards.charter.scope")}</dt>
        <dd>
          <ul className="plain-list">
            {charter.scope.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </dd>
        <dt>{t("ui.cards.charter.firstVersion")}</dt>
        <dd>{charter.firstVersion}</dd>
        <dt>{t("ui.cards.charter.workdir")}</dt>
        <dd>{charter.bindExternal ? t("ui.cards.charter.external", { path: charter.externalPath ?? "" }) : t("ui.cards.charter.inRecords")}</dd>
        <dt>{t("ui.cards.charter.toolkit")}</dt>
        <dd>{toolkitLabel({ skills: p.toolkit.skills, mcps: p.toolkit.mcp, bash: p.toolkit.bash, network: p.toolkit.network })}</dd>
      </dl>
      <div className="muted">{t("ui.cards.charter.note", { start: CHARTER_DECISION_LABEL.start })}</div>
      {p.confirmed?.buildTaskId && (
        <a className="link" href={toHash({ tab: "tasks", taskId: p.confirmed.buildTaskId })}>
          {t("ui.cards.charter.openBuild", { task: taskLabel(ui, p.confirmed.buildTaskId) })}
        </a>
      )}
    </CardShell>
  );
}

/**
 * "首版做完了"卡（112 号票，用户 2026-10-13 定：项目状态变更时找你）：项目的建设任务做完了，写明做成了什么——最后的总结、
 * 每个阶段一行验收结果和交付件、交付件在哪。三个选择：转入使用（项目进入使用中）、继续建设（写一句这一轮要做什么，
 * 维护者照它起草下一轮建设任务的计划）、放弃并归档（先确认一下）。不选就一直停在建设中
 */
export function BuildDoneCard({ state, payload: p, done, act }: CardProps<BuildDonePayload>) {
  const [mode, setMode] = useState<"choose" | "continue" | "abandon">("choose");
  const [request, setRequest] = useState("");
  const { ui } = useStore();
  const next = p.decided?.nextTaskId;
  // 130 号票：带着运营方案的，"转入使用"就是"确认并转入使用"（流程审查要你逐项确认的事项勾完才行）
  const ops = p.operations;
  const confirm = useOperationConfirmations(ops?.items ?? []);
  return (
    <CardShell
      state={state}
      title={buildDoneTitle(p)}
      {...(ops && p.decided?.choice === "put_in_use" ? { doneLabel: t("ui.cards.buildDone.putInUseDone", { label: OPERATIONS_PUT_IN_USE_LABEL }) } : {})}
      actions={
        mode === "continue" ? (
          <div className="plan-reject">
            <textarea className="input" value={request} onChange={(e) => setRequest(e.target.value)} placeholder={t("ui.cards.buildDone.requestPlaceholder")} rows={2} />
            <div className="auth-actions">
              <Btn onClick={() => setMode("choose")}>{t("ui.cards.buildDone.cancel")}</Btn>
              <Btn kind="primary" disabled={!request.trim()} onClick={() => act("keep_building", request.trim())}>
                {BUILD_DONE_CHOICE_LABEL.keep_building}
              </Btn>
            </div>
          </div>
        ) : mode === "abandon" ? (
          <div className="plan-reject">
            <div className="muted">{t("ui.cards.buildDone.abandonNote")}</div>
            <div className="auth-actions">
              <Btn onClick={() => setMode("choose")}>{t("ui.cards.buildDone.cancel")}</Btn>
              <Btn kind="danger" onClick={() => act("abandon")}>
                {BUILD_DONE_CHOICE_LABEL.abandon}
              </Btn>
            </div>
          </div>
        ) : (
          <>
            <Btn kind="danger" onClick={() => setMode("abandon")}>
              {BUILD_DONE_CHOICE_LABEL.abandon}
            </Btn>
            <Btn onClick={() => setMode("continue")}>{BUILD_DONE_CHOICE_LABEL.keep_building}…</Btn>
            {ops ? (
              <Btn kind="primary" disabled={confirm.missing > 0} onClick={() => act("put_in_use", undefined, confirm.asks.length > 0 ? confirm.input : undefined)}>
                {confirm.missing > 0 ? t("ui.cards.buildDone.missing", { count: confirm.missing }) : OPERATIONS_PUT_IN_USE_LABEL}
              </Btn>
            ) : (
              <Btn kind="primary" onClick={() => act("put_in_use")}>
                {BUILD_DONE_CHOICE_LABEL.put_in_use}
              </Btn>
            )}
          </>
        )
      }
    >
      <div className="muted">
        <T
          k="ui.cards.buildDone.allPassed"
          params={{
            task: (
              <a className="link" href={toHash({ tab: "tasks", taskId: p.buildTaskId })}>
                {t("ui.cards.buildDone.taskRef", { id: p.buildTaskId, title: p.buildTaskTitle })}
              </a>
            ),
          }}
        />
      </div>
      {p.summary && <div className="agent-says">{p.summary}</div>}
      {p.stages.length > 0 && (
        <ul className="plain-list build-done-stages">
          {p.stages.map((s) => (
            <li key={s.code}>
              <span className="build-done-stage">{t("ui.cards.buildDone.stage", { code: s.code, title: s.title })}</span>{" "}
              <span className="chip chip-ok">{s.result}</span>
              {s.deliverables.length > 0 && <div className="muted">{t("ui.cards.buildDone.deliverables", { list: s.deliverables.join(t("ui.cards.itemSep")) })}</div>}
            </li>
          ))}
        </ul>
      )}
      <dl className="kv">
        <dt>{t("ui.cards.buildDone.workdir")}</dt>
        <dd>
          <code>{p.workdir}</code>
        </dd>
      </dl>
      {/* 259 号票：转运营检查清单（旧卡没有） */}
      {p.checklist && <GoLiveChecklist items={p.checklist} pending={!done} missingAtConfirm={p.decided?.missing} />}
      {ops && <OperationsPlanSection plan={ops} results={p.decided?.operations} pending={!done} confirm={confirm} projectId={p.projectId} />}
      {next ? (
        <a className="link" href={toHash({ tab: "tasks", taskId: next })}>
          {t("ui.cards.buildDone.openNext", { task: taskLabel(ui, next) })}
        </a>
      ) : (
        !p.decided && (
          <div className="muted">
            {ops ? t("ui.cards.buildDone.choicesOps", { label: OPERATIONS_PUT_IN_USE_LABEL }) : t("ui.cards.buildDone.choices")}
          </div>
        )
      )}
    </CardShell>
  );
}

/**
 * 转运营检查清单（259 号票）："首版做完了"卡、"转入使用"卡上的一节：建设中 → 使用中的每一项，做到的 ✓、没做到的 ✗ 写差什么
 * （做到的也可能带一句说明："确认后开 /apps/p-1-site/"）。还在等时提醒缺的不挡确认；确认过的写照样确认时缺了几项
 */
export function GoLiveChecklist({ items, pending, missingAtConfirm }: { items: readonly GoLiveChecklistItem[]; pending: boolean; missingAtConfirm?: readonly GoLiveChecklistItem[] | undefined }) {
  const missing = checklistMissing(items);
  return (
    <div className="golive-check">
      <div className="golive-check-h">
        {t("ui.cards.goLive.checklistTitle")}{" "}
        <span className={`chip ${missing.length > 0 ? "chip-op" : "chip-ok"}`}>
          {missing.length > 0 ? t("ui.cards.goLive.missingCount", { count: missing.length }) : t("ui.cards.goLive.allDone")}
        </span>
      </div>
      <ul className="golive-list">
        {items.map((i) => (
          <li key={i.id} className={`golive-item ${i.done ? "golive-ok" : "golive-miss"}`}>
            <span className="golive-mark" aria-hidden="true">
              {i.done ? "✓" : "✗"}
            </span>
            <span className="golive-text">
              <span className="golive-label">{i.label}</span>
              {i.detail && <span className="golive-detail">{i.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
      {pending && missing.length > 0 && <div className="muted golive-note">{t("ui.cards.goLive.missingHint")}</div>}
      {!pending && missingAtConfirm && missingAtConfirm.length > 0 && (
        <div className="muted golive-note">{t("ui.cards.goLive.confirmedMissing", { items: missingAtConfirm.map((i) => i.label).join(t("ui.common.listSep")) })}</div>
      )}
    </div>
  );
}

/**
 * "转入使用"确认卡（259 号票）：建设中的项目要转入使用——你在项目页点的、维护者提的、秘书照你说的代办的，都在这里确认才转。
 * 写谁发起的、为什么、转运营检查清单（缺的照样能确认）、带着的运营方案（确认时一起生效，流程要逐项确认的勾完才行）
 */
export function GoLiveCard({ state, payload: p, done, act }: CardProps<GoLivePayload>) {
  const ops = p.operations;
  const confirm = useOperationConfirmations(ops?.items ?? []);
  const confirmLabel = ops ? OPERATIONS_PUT_IN_USE_LABEL : GO_LIVE_CHOICE_LABEL.put_in_use;
  const missingAtConfirm = p.decided?.missing?.length ?? 0;
  const doneLabel =
    p.decided?.choice === "dismiss"
      ? t("ui.cards.goLive.dismissedDone")
      : p.decided?.choice === "put_in_use"
        ? missingAtConfirm > 0
          ? t("ui.cards.goLive.confirmedDoneMissing", { count: missingAtConfirm })
          : t("ui.cards.goLive.confirmedDone")
        : undefined;
  return (
    <CardShell
      state={state}
      title={goLiveTitle(p)}
      tag={<span className="chip">{GO_LIVE_BY_LABEL[p.by]}</span>}
      {...(doneLabel ? { doneLabel } : {})}
      actions={
        <>
          <Btn onClick={() => act("dismiss")}>{GO_LIVE_CHOICE_LABEL.dismiss}</Btn>
          <Btn kind="primary" disabled={confirm.missing > 0} onClick={() => act("put_in_use", undefined, confirm.asks.length > 0 ? confirm.input : undefined)}>
            {confirm.missing > 0 ? t("ui.cards.buildDone.missing", { count: confirm.missing }) : confirmLabel}
          </Btn>
        </>
      }
    >
      {p.why && <div className="agent-says">{p.why}</div>}
      <GoLiveChecklist items={p.checklist} pending={!done} missingAtConfirm={p.decided?.missing} />
      {ops && <OperationsPlanSection plan={ops} results={p.decided?.operations} pending={!done} confirm={confirm} projectId={p.projectId} />}
      {!p.decided && !done && <div className="muted">{t("ui.cards.goLive.choices", { confirm: confirmLabel })}</div>}
    </CardShell>
  );
}

/**
 * 工单卡（17 号票）：涉及多个项目的任务的维护者执行中派出计划外的工单，命中"计划外工单"类别，工单待你确认。
 * "确认派出"之后才进项目维护者的队列，"拒绝"则不派（任务维护者会收到）
 */
export function WorkOrderCard({ state, payload: p, act }: CardProps<WorkOrderPayload>) {
  return (
    <CardShell
      state={state}
      title={`${p.workOrderId} → ${p.projectName}`}
      tag={<span className="chip chip-op">{t("ui.cards.workOrder.unplanned")}</span>}
      actions={
        <>
          <Btn onClick={() => act("deny")}>{WORK_ORDER_CARD_ACTION_LABEL.deny}</Btn>
          <Btn kind="primary" onClick={() => act("dispatch")}>
            {WORK_ORDER_CARD_ACTION_LABEL.dispatch}
          </Btn>
        </>
      }
    >
      <div>
        <b>{p.title}</b>
      </div>
      <div className="muted">
        <T
          k="ui.cards.workOrder.from"
          params={{
            task: (
              <a className="link" href={toHash({ tab: "tasks", taskId: p.taskId })}>
                {t("ui.cards.workOrder.taskTitle", { title: p.taskTitle })}
              </a>
            ),
            stage: p.stageId,
            stageTitle: p.stageTitle,
          }}
        />
      </div>
      {p.instructions !== p.title && <div className="sys-note">{p.instructions}</div>}
      <div className="muted">{t("ui.cards.workOrder.acceptance", { list: p.acceptance.join(t("ui.cards.itemSep")) })}</div>
      <div className="chips">
        {p.categories.map((c) => (
          <span key={c} className="chip chip-op">
            {c}
          </span>
        ))}
      </div>
    </CardShell>
  );
}

/** 工单卡上按钮的字 */
const WORK_ORDER_CARD_ACTION_LABEL = tTable({ dispatch: "ui.cards.workOrder.dispatch", deny: "ui.cards.deny" });

/**
 * 并行确认卡（20 号票）：维护者提议派子 agent 同时做几个阶段（或几步），写明各做什么、在哪个目录里做。
 * 同意了才真正拉起子 agent；不同意（或还没处理）维护者照常一件一件做。
 */
export function ParallelCard({ state, payload: p, act }: CardProps<ParallelPayload>) {
  return (
    <CardShell
      state={state}
      title={t("ui.cards.parallel.title", { task: p.taskTitle, count: p.agents.length })}
      actions={
        <>
          <Btn onClick={() => act("sequential")}>{CARD_ACTION_LABEL.sequential}</Btn>
          <Btn kind="primary" onClick={() => act("parallel")}>
            {CARD_ACTION_LABEL.parallel}
          </Btn>
        </>
      }
    >
      <div className="sys-note">{p.reason}</div>
      <ul className="plain-list">
        {p.agents.map((a) => (
          <li key={a.agentId}>
            <T
              k="ui.cards.parallel.agent"
              params={{
                agent: <b>{a.agentId}</b>,
                stage: a.stageId,
                stageTitle: a.stageTitle,
                step: a.step ? t("ui.cards.parallel.step", { step: a.step }) : "",
                instructions: a.instructions,
              }}
            />
            <div className="muted">{a.ownWorkDir ? t("ui.cards.parallel.ownDir", { dir: a.workDir }) : t("ui.cards.parallel.sharedDir")}</div>
          </li>
        ))}
      </ul>
      <div className="muted">{t("ui.cards.parallel.note")}</div>
    </CardShell>
  );
}

export function codeLabel(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export function fingerprintLabel(fp: string): string {
  return `${fp.slice(0, 4)} ${fp.slice(4)}`;
}

/** 像网络上的自动访问的配对请求（137 号票）：配对卡、批准页上那句醒目的提示（不拦批准） */
export function AutomatedHint({ reason }: { reason: string }) {
  return (
    <div className="pair-bot" role="note">
      <span aria-hidden="true">⚠</span>
      <span>{automatedAccessHint(reason)}</span>
    </div>
  );
}

export function PairingCard({ state, payload: p, act }: CardProps<PairingPayload>) {
  return (
    <CardShell
      state={state}
      title={p.deviceName}
      actions={
        <>
          <Btn onClick={() => act("deny")}>{t("ui.cards.deny")}</Btn>
          <Btn kind="primary" onClick={() => (window.location.hash = toHash({ tab: "pair-approve", cardId: state.card.id }))}>
            {t("ui.cards.pairing.review")}
          </Btn>
        </>
      }
    >
      <div className="pair-codes">
        <div>
          <span className="muted">{t("ui.cards.pairing.shortCode")}</span>
          <b className="mono">{codeLabel(p.shortCode)}</b>
        </div>
        <div>
          <span className="muted">{t("ui.cards.pairing.fingerprint")}</span>
          <b className="mono">{fingerprintLabel(p.fingerprint)}</b>
        </div>
      </div>
      <div className="muted">
        {t("ui.cards.pairing.expires", { from: p.from, time: timeLabel(p.expiresAt) })}
      </div>
      {p.automated && <AutomatedHint reason={p.automated.reason} />}
    </CardShell>
  );
}
