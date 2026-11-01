/**
 * skill 变更卡：负责人提的把一个 skill 加进 skill 库、改、删。卡上给用户看：名字、说明、谁提的、哪个项目或任务、
 * 文件清单和大小、有没有脚本（有的醒目写明"里面有 N 个脚本，用它的 agent 可能会运行"）、SKILL.md 全文（展开看）；改、删的列出在用它的工具包。
 * 确认后运行时复制进 skill 区、自检、配进提交人的工具包；拒绝则一个字节都不动（可以附一句原因）。
 * 提交之后来源又变了的，确认时不进库，卡上写明要重新提交。负载来自守护进程，SKILL.md 当纯文本显示，不渲染。
 */
import { useState } from "react";
import { ASSISTANT_NAME_MARK, type SkillChangeCardPayload, type SkillChangeUser, sizeLabel, t } from "../../state/index.ts";
import { NamedText } from "../assistant-name.tsx";
import { T } from "../i18n.tsx";
import { Btn } from "./cards.tsx";
import { type CardProps, CardShell } from "./CardShell.tsx";

/** 卡的标题：谁提的（项目的负责人、任务的负责人，项目内部的任务带上项目） */
function whoTitle(p: SkillChangeCardPayload): string {
  const s = p.submitter;
  if (s.kind === "project") return t("ui.cards.skillChange.titleProject", { project: s.projectName });
  return s.projectName === undefined ? t("ui.cards.skillChange.titleTask", { task: s.taskTitle }) : t("ui.cards.skillChange.titleTaskInProject", { task: s.taskTitle, project: s.projectName });
}

/** 在用它的一方的叫法（个人助理写名字占位，显示时换成用户起的名字） */
function userLabel(user: SkillChangeUser): string {
  if (user.kind === "assistant") return ASSISTANT_NAME_MARK;
  return t(user.kind === "project" ? "ui.cards.skillChange.userProject" : "ui.cards.skillChange.userTask", { title: user.title ?? "" });
}

/** 改、删的时候：现在谁在用它，确认之后这些工具包会怎样 */
function UsedBy({ p }: { p: SkillChangeCardPayload }) {
  if (p.action === "add") return null;
  const users = p.usedBy ?? [];
  return (
    <>
      {users.length > 0 ? (
        <div className="skill-change-used">
          <NamedText text={t("ui.cards.skillChange.usedBy", { list: users.map(userLabel).join(t("ui.common.listSep")) })} />
        </div>
      ) : (
        <div className="muted">{t("ui.cards.skillChange.usedByNone")}</div>
      )}
      <div className="muted">{t(p.action === "remove" ? "ui.cards.skillChange.removeEffect" : "ui.cards.skillChange.updateEffect")}</div>
    </>
  );
}

/** 加、改的时候：脚本提醒、文件清单、不带的东西、依赖目录、SKILL.md 全文 */
function SourceDetails({ source }: { source: NonNullable<SkillChangeCardPayload["source"]> }) {
  const hidden = source.fileCount - source.files.length;
  return (
    <>
      {source.scriptCount > 0 ? (
        <div className="sys-note sev-alert skill-change-scripts" role="note">
          {t("ui.cards.skillChange.scripts", { count: source.scriptCount })}
        </div>
      ) : (
        <div className="muted">{t("ui.cards.skillChange.noScripts")}</div>
      )}
      <details className="skill-change-more" open>
        <summary>{t("ui.cards.skillChange.files", { count: source.fileCount, size: sizeLabel(source.totalBytes) })}</summary>
        <ul className="plain-list skill-change-files">
          {source.files.map((file) => (
            <li key={file.path}>
              <code>{file.path}</code>
              <span className="muted">
                {" "}
                {sizeLabel(file.bytes)}
                {file.script ? t("ui.cards.skillChange.scriptMark") : ""}
              </span>
            </li>
          ))}
          {hidden > 0 && <li className="muted">{t("ui.cards.skillChange.filesMore", { count: hidden })}</li>}
        </ul>
      </details>
      {source.excluded.length > 0 && <div className="muted">{t("ui.cards.skillChange.excluded", { list: source.excluded.join(t("ui.common.listSep")) })}</div>}
      {source.linked.length > 0 && <div className="muted">{t("ui.cards.skillChange.linked", { list: source.linked.join(t("ui.common.listSep")) })}</div>}
      <details className="skill-change-more">
        <summary>{t("ui.cards.skillChange.skillMd")}</summary>
        <pre className="skill-change-md">{source.skillMd}</pre>
      </details>
      <div className="muted skill-change-path">{t("ui.cards.skillChange.source", { path: source.path })}</div>
    </>
  );
}

/** 确认之后的结果：自检、配没配进工具包；批准了但没改成的写原因 */
function Result({ p }: { p: SkillChangeCardPayload }) {
  return (
    <>
      {p.problem !== undefined && <div className="sys-note sev-alert">{t("ui.cards.skillChange.notApplied", { problem: p.problem })}</div>}
      {p.check && <div className="muted">{p.check.ok ? t(p.action === "remove" ? "ui.cards.skillChange.checkRemoved" : "ui.cards.skillChange.checkPassed") : t("ui.cards.skillChange.checkFailed", { problem: p.check.problem ?? "" })}</div>}
      {p.addedToToolkit === true && <div className="muted">{t("ui.cards.skillChange.addedToToolkit")}</div>}
      {p.toolkitProblem !== undefined && <div className="muted">{t("ui.cards.skillChange.toolkitFailed", { problem: p.toolkitProblem })}</div>}
    </>
  );
}

export function SkillChangeCard({ state, payload: p, done, act }: CardProps<SkillChangeCardPayload>) {
  const [note, setNote] = useState("");
  const said = note.trim() ? note.trim() : undefined;
  return (
    <CardShell
      state={state}
      title={whoTitle(p)}
      // 批准了但没改成：不写"已批准：……"，原因在卡的正文里
      {...(p.problem === undefined ? {} : { doneLabel: t("ui.cards.skillChange.doneNotApplied") })}
      actions={
        <>
          <Btn onClick={() => act("deny", said)}>{t("ui.cards.skillChange.deny")}</Btn>
          <Btn kind="primary" onClick={() => act("approve", said)}>
            {t("ui.cards.skillChange.approve")}
          </Btn>
        </>
      }
    >
      {p.why && <div className="sys-note">{p.why}</div>}
      <div className="tool-line">
        <T k="ui.cards.skillChange.change" params={{ action: t(`ui.cards.skillChange.action.${p.action}`), name: <code>{p.name}</code> }} />
      </div>
      <div className="skill-change-description">{p.description}</div>
      {p.source && <SourceDetails source={p.source} />}
      <UsedBy p={p} />
      <Result p={p} />
      {!done && <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("ui.cards.skillChange.notePlaceholder")} aria-label={t("ui.cards.skillChange.noteLabel")} />}
    </CardShell>
  );
}
