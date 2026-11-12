/**
 * "目录授权申请"卡（464）：个人助理、项目或任务的负责人自己申请把一个目录登记进它的目录授权，负载是 FolderGrantRequestCardPayload。
 * 出在它自己的会话里、进待办；要你拍板，没处理时在会话里整张展开、排在这一轮最后，处理后收成一行（state/chat-look.ts）。
 * - 卡上写：谁（标题）、为什么（它自己说的，灰字）、目录、要的操作和多久；这个目录已经登记过的写明已有什么
 *   （"现在只读（长期有效），这次要加写、删"），在所有 agent 都能读的文件夹里的写明"读本来就行"；
 * - 没处理时下面能收窄：只列它要的那几样操作（去掉几样，不能加），多久能改；附一句话（可不写），「不同意」/「同意」；
 *   一样都不勾时「同意」点不了；
 * - 处理之后写登记成了什么（并进已有的之后：操作取并集、到期取更晚的）、附的那句话；没同意的写没同意。
 * 登记不成（目录没了、超过上限……）时卡留着、写出原因（CardShell 的出错那一行）。说法在状态层（state/folder-grants.ts）
 */
import { useState } from "react";
import {
  FOLDER_GRANT_MODE_LABEL,
  FOLDER_GRANT_MODES,
  folderGrantDurationText,
  type FolderGrantMode,
  type FolderGrantRequestApproveInput,
  folderGrantRequestAsk,
  type FolderGrantRequestCardPayload,
  folderGrantRequestDays,
  folderGrantRequestDuration,
  folderGrantRequestDurations,
  folderGrantRequestExisting,
  folderGrantRequestOutcome,
  t,
} from "../../state/index.ts";
import { NamedText } from "../assistant-name.tsx";
import { type CardProps, CardShell } from "./CardShell.tsx";
import { Btn } from "./cards.tsx";

export function FolderGrantRequestCard({ state, payload: p, done, act }: CardProps<FolderGrantRequestCardPayload>) {
  const [modes, setModes] = useState<FolderGrantMode[]>(p.modes);
  const [duration, setDuration] = useState(folderGrantRequestDuration(p.days));
  const [note, setNote] = useState("");
  const said = note.trim() || undefined;
  const ask = folderGrantRequestAsk(p);
  const existing = folderGrantRequestExisting(p);
  const toggle = (m: FolderGrantMode) => setModes((now) => (now.includes(m) ? now.filter((x) => x !== m) : [...now, m]));
  const approve = () => {
    const input: FolderGrantRequestApproveInput = { modes: FOLDER_GRANT_MODES.filter((m) => modes.includes(m)), days: folderGrantRequestDays(duration) };
    act("approve", said, input);
  };
  return (
    <CardShell
      state={state}
      title={<NamedText text={p.agentLabel} />}
      doneLabel={folderGrantRequestOutcome(p)}
      actions={
        <>
          <Btn onClick={() => act("deny", said)}>{t("ui.cards.folderGrantRequest.deny")}</Btn>
          <Btn kind="primary" disabled={modes.length === 0} onClick={approve}>
            {t("ui.cards.folderGrantRequest.approve")}
          </Btn>
        </>
      }
    >
      <div className="agent-says">{p.why}</div>
      <dl className="fgr-facts">
        <dt>{t("ui.cards.folderGrantRequest.path")}</dt>
        <dd className="fgr-path">{p.path}</dd>
        <dt>{t("ui.cards.folderGrantRequest.wants")}</dt>
        <dd>{t("ui.cards.folderGrantRequest.wantsLine", ask)}</dd>
        {existing && (
          <>
            <dt>{t("ui.cards.folderGrantRequest.existing")}</dt>
            <dd>{existing}</dd>
          </>
        )}
      </dl>
      {p.readable && <div className="muted">{t("ui.cards.folderGrantRequest.readable")}</div>}
      {!done && (
        <div className="fgr-narrow">
          <div className="fg-field" role="group" aria-label={t("ui.cards.folderGrantRequest.give")}>
            <span>{t("ui.cards.folderGrantRequest.give")}</span>
            <div className="fg-modes-pick">
              {p.modes.map((m) => (
                <label key={m} className="fg-mode">
                  <input type="checkbox" checked={modes.includes(m)} onChange={() => toggle(m)} />
                  {FOLDER_GRANT_MODE_LABEL[m]}
                </label>
              ))}
            </div>
          </div>
          <label className="fg-field">
            <span>{t("ui.cards.folderGrantRequest.howLong")}</span>
            <select className="input" value={duration} onChange={(e) => setDuration(e.target.value)}>
              {folderGrantRequestDurations(p.days).map((d) => (
                <option key={d} value={d}>
                  {folderGrantDurationText(d)}
                </option>
              ))}
            </select>
          </label>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("ui.cards.folderGrantRequest.notePlaceholder")} aria-label={t("ui.cards.folderGrantRequest.noteLabel")} />
        </div>
      )}
    </CardShell>
  );
}
