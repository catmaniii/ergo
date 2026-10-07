/**
 * 会话组件：秘书聊天和维护者会话共用这一个。
 * 维护者会话多出工单分隔线（work_order_divider part）、阶段抽屉（由外面的任务详情放在会话上方或左侧）
 * 和直接下指令的输入框；秘书的输入框多一个附件菜单（含"作为材料投喂"）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useConversation, useStore } from "../../app/store.tsx";
import { clockLabel } from "../../model/labels.ts";
import type { ConversationItem, MessagePart } from "../../state/index.ts";
import { PartView, sizeLabel, type ToolCallPart } from "./parts.tsx";

export type ConversationMode = "secretary" | "maintainer";

export function Conversation({
  conversation,
  mode,
  onToolDetail,
  readOnly,
}: {
  conversation: string;
  mode: ConversationMode;
  onToolDetail?(p: ToolCallPart): void;
  /** 已归档项目的维护者会话只读 */
  readOnly?: string;
}) {
  const items = useConversation(conversation);
  const { sendMessage } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  // 打开时已经有的、以及打开后一小会儿陆续补发进来的，都算历史，不播到达动效（look.css 第 4 条）
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  });
  const [history, setHistory] = useState<Set<string> | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setHistory(new Set(itemsRef.current.map(keyOf))), 600);
    return () => clearTimeout(t);
  }, []);

  // 打开时滚到底；新消息到达时，人在底部附近就跟着滚
  const stick = useRef(true);
  const count = items.length;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current && count > 0) el.scrollTop = el.scrollHeight;
  }, [count]);

  return (
    <div className="conv">
      <div
        className="scroll conv-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {items.length === 0 && <div className="page-placeholder">还没有消息</div>}
        {items.map((it, i) => {
          const day = it.message.time.slice(0, 10);
          const prevDay = i > 0 ? items[i - 1]!.message.time.slice(0, 10) : undefined;
          const fresh = history !== null && !history.has(keyOf(it));
          return (
            <div key={keyOf(it)} className={fresh ? "fx-new" : undefined}>
              {day !== prevDay && <div className="day-sep">{day.slice(5).replace("-", " 月 ")} 日</div>}
              <MessageRow item={it} onToolDetail={onToolDetail} />
            </div>
          );
        })}
      </div>
      {readOnly ? (
        <div className="composer composer-note muted">{readOnly}</div>
      ) : (
        <Composer
          mode={mode}
          onSend={(parts) => {
            stick.current = true;
            sendMessage(conversation, parts);
          }}
        />
      )}
    </div>
  );
}

/** 自己发的消息从乐观显示换成权威消息时 key 不变，React 原地更新，不重播到达动效 */
function keyOf(it: ConversationItem): string {
  return it.idempotencyKey ? `k:${it.idempotencyKey}` : it.message.id;
}

function MessageRow({ item, onToolDetail }: { item: ConversationItem; onToolDetail?(p: ToolCallPart): void }) {
  const { message } = item;
  if (message.speaker === "system") {
    return (
      <div className="msg msg-system">
        {message.parts.map((p, i) =>
          p.type === "text" ? (
            <div key={i} className="sys-note">
              {p.text}
            </div>
          ) : (
            <PartView key={i} part={p} />
          ),
        )}
      </div>
    );
  }
  const side = message.speaker === "user" ? "user" : "assistant";
  return (
    <div className={`msg ${side}${item.kind === "pending" ? ` msg-pending msg-${item.status}` : ""}`}>
      {message.parts.map((p, i) => (
        <div key={i} className={`msg-part part-${p.type}`}>
          <PartView part={p} onToolDetail={onToolDetail} />
        </div>
      ))}
      <div className="msg-meta">
        {item.kind === "pending" ? (item.status === "sending" ? "发送中…" : `发送失败：${item.error ?? ""}`) : clockLabel(message.time)}
      </div>
    </div>
  );
}

interface Attachment {
  name: string;
  mime: string;
  size: number;
  asMaterial: boolean;
}

function Composer({ mode, onSend }: { mode: ConversationMode; onSend(parts: MessagePart[]): void }) {
  const [text, setText] = useState("");
  const [menu, setMenu] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const pickAsMaterial = useRef(false);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  const pick = (opts: { image?: boolean; material?: boolean }) => {
    pickAsMaterial.current = !!opts.material;
    setMenu(false);
    const input = fileInput.current;
    if (!input) return;
    input.accept = opts.image ? "image/*" : "";
    input.click();
  };

  const send = () => {
    const parts: MessagePart[] = attachments.map((a, i): MessagePart =>
      a.mime.startsWith("image/") && !a.asMaterial
        ? { type: "image", mediaId: `local-${i}`, name: a.name, mime: a.mime }
        : { type: "file", mediaId: `local-${i}`, name: a.name, mime: a.mime || "application/octet-stream", size: a.size, asMaterial: a.asMaterial },
    );
    if (text.trim()) parts.push({ type: "text", text: text.trim() });
    if (!parts.length) return;
    onSend(parts);
    setText("");
    setAttachments([]);
  };

  return (
    <div className="composer-wrap">
      {attachments.length > 0 && (
        <div className="attach-list">
          {attachments.map((a, i) => (
            <span key={i} className={`attach${a.asMaterial ? " attach-material" : ""}`}>
              {a.asMaterial ? "材料 · " : ""}
              {a.name}
              <span className="muted"> {sizeLabel(a.size)}</span>
              <button type="button" className="attach-x" aria-label="移除" onClick={() => setAttachments((xs) => xs.filter((_, j) => j !== i))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer">
        {mode === "secretary" && (
          <div className="attach-menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
            <button type="button" className="icon-btn attach-btn" aria-label="附件" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              ＋
            </button>
            {menu && (
              <div className="attach-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => pick({ image: true })}>
                  🖼 图片
                </button>
                <button type="button" role="menuitem" onClick={() => pick({})}>
                  📄 文件
                </button>
                <button type="button" role="menuitem" onClick={() => pick({ material: true })}>
                  📥 作为材料投喂
                  <small>记为你主动提供的材料，供以后理解你</small>
                </button>
              </div>
            )}
          </div>
        )}
        <input
          ref={fileInput}
          type="file"
          hidden
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            // 原型不上传，只记下文件名、类型和大小
            setAttachments((xs) => [...xs, ...files.map((f) => ({ name: f.name, mime: f.type, size: f.size, asMaterial: pickAsMaterial.current }))]);
            e.currentTarget.value = "";
          }}
        />
        <textarea
          value={text}
          rows={1}
          placeholder={mode === "secretary" ? "和秘书说…" : "直接给维护者下指令…"}
          title={mode === "maintainer" ? "维护者在干活时，你的话作为插话，在它下一步之前插入" : undefined}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
          }}
        />
        <button type="button" className="btn primary" disabled={!text.trim() && !attachments.length} onClick={send}>
          发送
        </button>
      </div>
    </div>
  );
}
