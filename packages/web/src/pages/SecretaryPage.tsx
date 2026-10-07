// 秘书聊天：唯一的默认对话入口。秘书只有一条长期主线会话。
import { useState } from "react";
import { CHANNELS } from "../state/index.ts";
import { TopBar } from "../ui/common.tsx";
import { Conversation } from "../ui/conversation/Conversation.tsx";
import type { ToolCallPart } from "../ui/conversation/parts.tsx";
import { StartTaskButton, WithToolDetail } from "./shared.tsx";

export function SecretaryPage({ wide }: { wide: boolean }) {
  const [tool, setTool] = useState<ToolCallPart>();
  return (
    <WithToolDetail wide={wide} tool={tool} onClose={() => setTool(undefined)}>
      <div className="chat-col">
        <TopBar title="秘书" sub={wide ? "主线会话" : undefined}>
          <StartTaskButton compact />
        </TopBar>
        <Conversation conversation={CHANNELS.secretary} mode="secretary" onToolDetail={setTool} />
      </div>
    </WithToolDetail>
  );
}
