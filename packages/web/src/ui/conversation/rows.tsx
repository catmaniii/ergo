// 聊天区精简（57 号票）：对话层里思考、回复、工具调用组这三种怎么画。长什么样由状态层的 chatLook（state/chat-look.ts）给出。
// 思考、回复是 ThinkingRow、AssistantBubble；
// 工具调用那一行小字是用户要的汇总行，样子借工具行的圆点和行尾的 ›。
// 115 号票：agent 之间的来信也是一行（LetterLine），借工具调用那一行的样子（.tool-sum），11 套风格里跟着各自的工具调用行走。
// 187 号票：调用记忆也是一行"回忆了 N 条记忆 ›"，同样借 .tool-sum（193 号票起在记忆插件里：plugins/memory/RecallLine.tsx）。
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type AgentLetter, type ChatLook, REPLY_OPEN_BY_DEFAULT, t } from "../../state/index.ts";
import { NamedText } from "../assistant-name.tsx";

/**
 * 思考：一行字，点一下在原地显示全文、再点收起；旁边"详情 ›"。
 * label 是收着时的那一行（"💭 Agent 的想法（点开看）"，正在想时"💭 Agent 正在想…"，字轻轻明暗）
 */
export function ThinkingRow({ text, label, live, onDetail }: { text: string; label: string; live: boolean; onDetail?: (() => void) | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking">
      <button type="button" className={`thinking-toggle${live && !open ? " think-live" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        {open && text ? text : label}
      </button>
      {onDetail && (
        <button type="button" className="link thinking-more" onClick={onDetail}>
          {t("ui.rows.details")}
        </button>
      )}
    </div>
  );
}

/**
 * 回复里的图片（![名字](地址)）：没有演示图，只写名字（MD_PARTS），
 * 聊天里不去加载外面的图片（详情页里照 56 号票按地址加载）
 */
const MD_PARTS = {
  img: ({ alt }: { alt?: string | undefined }) => <span>{alt}</span>,
};

/**
 * 回复：Markdown，按第一个空行切成第一段和后文；有后文时气泡里给"收起 ▴ / 展开细节 ▾"和"详情 ›"，只有一段的两个都没有。
 * 默认整段展开（REPLY_OPEN_BY_DEFAULT）
 */
export function AssistantBubble({ text, look, onDetail }: { text: string; look: Extract<ChatLook, { form: "reply" }>; onDetail?: (() => void) | undefined }) {
  const [open, setOpen] = useState(REPLY_OPEN_BY_DEFAULT);
  return (
    <div className="bubble md">
      <Markdown remarkPlugins={[remarkGfm]} components={MD_PARTS}>
        {open ? text : look.head}
      </Markdown>
      {look.more && (
        <div className="bubble-more">
          <button type="button" className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? t("ui.rows.collapse") : t("ui.rows.expand")}
          </button>
          {onDetail && (
            <button type="button" className="link-btn" onClick={onDetail}>
              {t("ui.rows.details")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 工具调用组：一行小字"调用了 N 个工具"，后面是小签（"· 1 次被拦下"、"· 1 次做完告诉你"），行尾 ›；整行点开组的详情。
 * 不是气泡。出了状况的整行醒目（左边那道和圆点换成被拦下的颜色，只有等你批准、问过你的换成跟你有关的颜色）；
 * 还有调用在执行时圆点一闪一闪（.tool-running）
 */
export function ToolGroupLine({ look, onOpen }: { look: Extract<ChatLook, { form: "tool_line" }>; onOpen?: (() => void) | undefined }) {
  const cls = `tool-sum${look.alert ? ` tool-sum-${look.alert}` : ""}${look.running ? " tool-running" : ""}`;
  return (
    <button type="button" className={cls} onClick={onOpen} disabled={!onOpen}>
      <span className="tool-dot" />
      <span className="tool-sum-text">{look.text}</span>
      {look.tags.map((tag) => (
        <span key={tag.key} className={`tool-sum-tag tst-${tag.level}`}>
          · {tag.text}
        </span>
      ))}
      {onOpen && <span className="tool-more">›</span>}
    </button>
  );
}

/**
 * agent 之间的来信（115 号票）：一行——图标、种类、一句话总结（放不下的省略）、时间、"详情 ›"，整行点开看全文
 * （宽屏右边的详情栏、手机上的详情页，照工具调用那一行）。种类、总结里的名字占位按现在的名字显示
 */
export function LetterLine({ letter, time, onOpen }: { letter: AgentLetter; time: string | undefined; onOpen?: (() => void) | undefined }) {
  return (
    <button type="button" className={`tool-sum letter-line letter-${letter.kind}`} onClick={onOpen} disabled={!onOpen}>
      <span className="letter-icon" aria-hidden="true">
        {letter.icon}
      </span>
      <span className="letter-kind">
        <NamedText text={letter.label} />
      </span>
      <span className="letter-sum">
        <NamedText text={letter.summary} />
      </span>
      {time && <span className="letter-time">{time}</span>}
      {onOpen && <span className="letter-more">{t("ui.rows.details")}</span>}
    </button>
  );
}
