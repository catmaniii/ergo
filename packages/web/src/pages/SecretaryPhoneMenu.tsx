// 手机竖屏秘书页标题栏右上角的"⋯"（标题栏太挤，文字挤在一起）：发起任务、缩放、这个 agent 的设置都收在这里，
// 标题和活动状态才放得下。宽屏还是一个个按钮。
import { type RefObject, useRef, useState } from "react";
import { t } from "../state/index.ts";
import { useAgentSettingsSheet } from "../ui/agent-settings.tsx";
import type { ConversationHandle } from "../ui/conversation/Conversation.tsx";
import { TaskMenuPopup } from "../ui/task-menu.tsx";
import { useZoomLevel } from "../ui/zoom/zoom-level.ts";
import { StartTaskDialog } from "./shared.tsx";

export function SecretaryPhoneMenu({ agentId, handle }: { agentId: string; handle: RefObject<ConversationHandle | null> }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const settings = useAgentSettingsSheet(agentId, false);
  const level = useZoomLevel();
  const rows = [
    { label: t("pages.startTask.buttonLabel"), pick: () => setStarting(true) },
    { label: level === 0 ? t("ui.conversation.zoomOut") : t("ui.conversation.zoomIn"), pick: () => handle.current?.zoomTo(level === 0 ? 2 : 0) },
    { label: t("ui.agentSettings.gear"), pick: settings.open },
  ];
  return (
    <>
      <button ref={anchor} type="button" className="icon-btn th-more" aria-label={t("pages.secretary.moreActions")} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open && (
        <TaskMenuPopup
          anchor={anchor}
          align="end"
          items={[]}
          head={rows.map((row) => (
            <button
              key={row.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                row.pick();
              }}
            >
              {row.label}
            </button>
          ))}
          onPick={() => setOpen(false)}
          onClose={() => setOpen(false)}
        />
      )}
      {starting && <StartTaskDialog onClose={() => setStarting(false)} />}
      {settings.sheet}
    </>
  );
}
