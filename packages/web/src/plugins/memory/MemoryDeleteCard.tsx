// 记忆删除卡（21 号票）：秘书检索出的匹配素材和要执行的删法；你核对后（可以去掉几条、换一种删法）确认才执行。
// 193 号票：挪进记忆插件，登记成卡片类型 memory_delete 的画法（plugins/memory/plugin.tsx）；记忆插件停用时这张卡显示占位
// （守护进程那边卡上的动作回"记忆插件没启用"，129 号票）。
import { useState } from "react";
import { useStore } from "../../app/store.tsx";
import { conversationName, MEMORY_COMMAND_LABEL, MEMORY_DELETE_MODE_INFO, MEMORY_DELETE_MODES, type MemoryDeleteCardPayload, type MemoryDeleteInput, type MemoryDeleteMode, PURGED_TEXT, t } from "../../state/index.ts";
import { timeLabel } from "../../util/time.ts";
import { NamedText } from "../../ui/assistant-name.tsx";
import { Btn } from "../../ui/cards/cards.tsx";
import { type CardProps, CardShell } from "../../ui/cards/CardShell.tsx";

export function MemoryDeleteCard({ state, payload: p, done, act }: CardProps<MemoryDeleteCardPayload>) {
  const { ui } = useStore();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(p.matches.map((m) => m.materialId)));
  const [mode, setMode] = useState<MemoryDeleteMode>(p.mode);
  const label = MEMORY_COMMAND_LABEL[mode];
  const chosen = p.matches.filter((m) => picked.has(m.materialId)).map((m) => m.materialId);
  return (
    <CardShell
      state={state}
      title={t("ui.cards.memoryDelete.title", { mode: MEMORY_COMMAND_LABEL[p.mode], count: p.matches.length })}
      doneLabel={p.result ? t("ui.cards.memoryDelete.done", { mode: MEMORY_COMMAND_LABEL[p.result.mode], count: p.result.count }) : undefined}
      actions={
        <>
          <Btn onClick={() => act("cancel")}>{t("ui.cards.memoryDelete.cancel")}</Btn>
          <Btn kind={mode === "purge" ? "danger" : "primary"} disabled={chosen.length === 0} onClick={() => act("delete", undefined, { mode, materialIds: chosen } satisfies MemoryDeleteInput)}>
            {t("ui.cards.memoryDelete.apply", { mode: label, count: chosen.length })}
          </Btn>
        </>
      }
    >
      <fieldset className="md-list" disabled={done}>
        {p.matches.map((m) => (
          <label key={m.materialId} className="check-row">
            <input
              type="checkbox"
              checked={picked.has(m.materialId)}
              onChange={() => {
                const next = new Set(picked);
                if (next.has(m.materialId)) next.delete(m.materialId);
                else next.add(m.materialId);
                setPicked(next);
              }}
            />
            <span>
              {m.purged ? <span className="muted">{PURGED_TEXT}</span> : m.excerpt}
              <span className="muted">
                {" "}
                · {m.kind}
                {m.conversation ? <NamedText text={` · ${conversationName(ui, m.conversation)}`} /> : ""} · {timeLabel(m.time)}
              </span>
            </span>
          </label>
        ))}
        {!done && (
          <>
            <label className="repeat-row">
              <span>{t("ui.cards.memoryDelete.method")}</span>
              <select className="input" value={mode} onChange={(e) => setMode(e.target.value as MemoryDeleteMode)}>
                {MEMORY_DELETE_MODES.map((k) => (
                  <option key={k} value={k}>
                    {MEMORY_COMMAND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <div className="muted">
              <NamedText text={MEMORY_DELETE_MODE_INFO[mode].note} />
            </div>
          </>
        )}
      </fieldset>
    </CardShell>
  );
}

