/**
 * skill 变更卡：负责人提的把一个 skill 加进 skill 库、改、删。卡上给用户看：名字、说明、谁提的、哪个项目或任务、
 * 文件清单和大小、有没有脚本（有的醒目写明"里面有 N 个脚本，用它的 agent 可能会运行"）、SKILL.md 全文（展开看）；改、删的列出在用它的工具包。
 * 确认后运行时复制进 skill 区、自检、配进提交人的工具包；拒绝则一个字节都不动（可以附一句原因）。
 * 提交之后来源又变了的，确认时不进库，卡上写明要重新提交。负载来自守护进程，SKILL.md 当纯文本显示，不渲染。
 *
 * 秘书提交的（标题写用户给它起的名字）：只有一份 SKILL.md，不列文件和来源；说明写成"它会改变什么行为"，SKILL.md 全文直接摊开，
 * 下面是同名检查。库里已经有同名的：按钮换成覆盖（能覆盖的才有）、改名（填新名字）、放弃；没有同名的照旧确认、拒绝。
 * 进库后配进它用的 skill，下一轮起能用。
 */
import { useState } from "react";
import { ASSISTANT_NAME_MARK, IMPORT_NAME_PATTERN, type SkillChangeCardPayload, type SkillChangeUser, sizeLabel, t } from "../../state/index.ts";
import { NamedText, useNamedPlain } from "../assistant-name.tsx";
import { T } from "../i18n.tsx";
import { Btn } from "./cards.tsx";
import { type CardProps, CardShell } from "./CardShell.tsx";

const NEW_NAME = new RegExp(IMPORT_NAME_PATTERN);

/** 卡的标题：谁提的（项目的负责人、任务的负责人，项目内部的任务带上项目；秘书写名字占位，显示时换成用户起的名字） */
function whoTitle(p: SkillChangeCardPayload): string {
  const s = p.submitter;
  if (s.kind === "secretary") return t("ui.cards.skillChange.titleSecretary", { name: ASSISTANT_NAME_MARK });
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

/** 秘书提交的：它会改变什么行为（就是触发说明）、SKILL.md 全文（摊开）、同名检查 */
function ProposedDetails({ p }: { p: SkillChangeCardPayload }) {
  const { sameName } = p;
  return (
    <>
      <div className="skill-change-behavior">
        <div className="muted">{t("ui.cards.skillChange.behavior")}</div>
        <div className="skill-change-description">{p.description}</div>
      </div>
      {p.source && (
        <details className="skill-change-more" open>
          <summary>{t("ui.cards.skillChange.skillMd")}</summary>
          <pre className="skill-change-md">{p.source.skillMd}</pre>
        </details>
      )}
      {sameName ? (
        <div className="sys-note sev-alert skill-change-same-name" role="note">
          <div>{t("ui.cards.skillChange.sameNameTaken", { owner: sameName.owner })}</div>
          <div>{sameName.overwritable ? t("ui.cards.skillChange.sameNameOverwrite") : t("ui.cards.skillChange.sameNameFixed", { problem: sameName.problem ?? "" })}</div>
          {/* 能覆盖的：现在在用同名那个的，覆盖了下次装配就是这一份 */}
          {sameName.overwritable && p.usedBy && p.usedBy.length > 0 && (
            <div>
              <NamedText text={t("ui.cards.skillChange.usedBy", { list: p.usedBy.map(userLabel).join(t("ui.common.listSep")) })} />
            </div>
          )}
        </div>
      ) : (
        <div className="muted skill-change-same-name">{t("ui.cards.skillChange.sameNameNone")}</div>
      )}
    </>
  );
}

/** 确认之后的结果：同名时选了什么、自检、配没配进工具包（秘书提交的：配进它用的 skill）；批准了但没改成的写原因 */
function Result({ p }: { p: SkillChangeCardPayload }) {
  const secretary = p.submitter.kind === "secretary";
  return (
    <>
      {p.resolution === "overwrite" && <div className="muted">{t("ui.cards.skillChange.overwritten")}</div>}
      {p.resolution === "rename" && <div className="muted">{t("ui.cards.skillChange.renamedTo", { name: p.renamedTo ?? "" })}</div>}
      {p.problem !== undefined && <div className="sys-note sev-alert">{t("ui.cards.skillChange.notApplied", { problem: p.problem })}</div>}
      {p.check && <div className="muted">{p.check.ok ? t(p.action === "remove" ? "ui.cards.skillChange.checkRemoved" : "ui.cards.skillChange.checkPassed") : t("ui.cards.skillChange.checkFailed", { problem: p.check.problem ?? "" })}</div>}
      {p.addedToToolkit === true && (
        <div className="muted">{secretary ? <NamedText text={t("ui.cards.skillChange.addedToAssistant", { name: ASSISTANT_NAME_MARK })} /> : t("ui.cards.skillChange.addedToToolkit")}</div>
      )}
      {p.toolkitProblem !== undefined && (
        <div className="muted">
          {secretary ? <NamedText text={t("ui.cards.skillChange.assistantFailed", { name: ASSISTANT_NAME_MARK, problem: p.toolkitProblem })} /> : t("ui.cards.skillChange.toolkitFailed", { problem: p.toolkitProblem })}
        </div>
      )}
    </>
  );
}

/** 改名填到一半的样子：放在卡上（不放在按钮那一块里），点了改名没成（新名字也重名）回来还是填着的 */
interface RenameDraft {
  renaming: boolean;
  setRenaming(on: boolean): void;
  name: string;
  setName(name: string): void;
}

/** 和库里同名时的按钮：覆盖（能覆盖的才有）、改名（展开填新名字）、放弃（就是拒绝） */
function SameNameActions({ p, said, act, draft }: { p: SkillChangeCardPayload; said: string | undefined; act: CardProps<SkillChangeCardPayload>["act"]; draft: RenameDraft }) {
  const { renaming, setRenaming, name, setName } = draft;
  const wanted = name.trim();
  const valid = NEW_NAME.test(wanted);
  if (renaming) {
    return (
      <div className="skill-change-rename">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("ui.cards.skillChange.renamePlaceholder")} aria-label={t("ui.cards.skillChange.renameLabel")} />
        {wanted !== "" && !valid && <div className="error">{t("ui.cards.skillChange.renameRule")}</div>}
        <div className="auth-actions">
          <Btn onClick={() => setRenaming(false)}>{t("ui.cards.skillChange.renameBack")}</Btn>
          <Btn kind="primary" disabled={!valid || wanted === p.name} onClick={() => act("rename", said, { name: wanted })}>
            {t("ui.cards.skillChange.renameConfirm")}
          </Btn>
        </div>
      </div>
    );
  }
  return (
    <>
      <Btn onClick={() => act("deny", said)}>{t("ui.cards.skillChange.abandon")}</Btn>
      <Btn onClick={() => setRenaming(true)}>{t("ui.cards.skillChange.rename")}</Btn>
      {p.sameName?.overwritable === true && (
        <Btn kind="danger" onClick={() => act("overwrite", said)}>
          {t("ui.cards.skillChange.overwrite")}
        </Btn>
      )}
    </>
  );
}

/** 处理完之后那一行：批准了但没改成的不写"已批准"；同名时放弃的写"已放弃" */
function doneLabelOf(state: CardProps<SkillChangeCardPayload>["state"], p: SkillChangeCardPayload): string | undefined {
  if (p.problem !== undefined) return t("ui.cards.skillChange.doneNotApplied");
  if (p.sameName && state.card.outcome?.action === "deny") return t("ui.cards.skillChange.doneAbandoned");
  return undefined;
}

export function SkillChangeCard({ state, payload: p, done, act }: CardProps<SkillChangeCardPayload>) {
  const [note, setNote] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");
  const named = useNamedPlain();
  const said = note.trim() ? note.trim() : undefined;
  const secretary = p.submitter.kind === "secretary";
  const doneLabel = doneLabelOf(state, p);
  return (
    <CardShell
      state={state}
      title={<NamedText text={whoTitle(p)} />}
      {...(doneLabel === undefined ? {} : { doneLabel })}
      actions={
        secretary && p.sameName ? (
          <SameNameActions p={p} said={said} act={act} draft={{ renaming, setRenaming, name: newName, setName: setNewName }} />
        ) : (
          <>
            <Btn onClick={() => act("deny", said)}>{t("ui.cards.skillChange.deny")}</Btn>
            <Btn kind="primary" onClick={() => act("approve", said)}>
              {t("ui.cards.skillChange.approve")}
            </Btn>
          </>
        )
      }
    >
      {p.why && <div className="sys-note">{p.why}</div>}
      <div className="tool-line">
        <T k="ui.cards.skillChange.change" params={{ action: t(`ui.cards.skillChange.action.${p.action}`), name: <code>{p.name}</code> }} />
      </div>
      {secretary ? (
        <ProposedDetails p={p} />
      ) : (
        <>
          <div className="skill-change-description">{p.description}</div>
          {p.source && <SourceDetails source={p.source} />}
        </>
      )}
      <UsedBy p={p} />
      <Result p={p} />
      {!done && (
        <input
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={secretary ? named(t("ui.cards.skillChange.notePlaceholderAssistant", { name: ASSISTANT_NAME_MARK })) : t("ui.cards.skillChange.notePlaceholder")}
          aria-label={secretary ? named(t("ui.cards.skillChange.noteLabelAssistant", { name: ASSISTANT_NAME_MARK })) : t("ui.cards.skillChange.noteLabel")}
        />
      )}
    </CardShell>
  );
}
