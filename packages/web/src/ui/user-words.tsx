/**
 * 运行时核实过的用户原话（125 号票）：守护进程核对过、单独一栏交来的用户原话——计划变更卡、立项要求变更卡、阶段详情里评审的输入。
 * 和 agent 自己说的（灰字、左边一道灰线的 .agent-says）分开：左边一道"你"的颜色，每条原文旁边一个"运行时核实"小签，
 * 下面写从哪来（时间 · 会话 · 设备，语音转写、经秘书转达另写）。agent 正文里写的"用户已同意"不在这一栏
 */
import { t, USER_WORDS_BADGE, USER_WORDS_TITLE, userWordsRows, type VerifiedUserWords } from "../state/index.ts";
import { NamedText } from "./assistant-name.tsx";

export function UserWordsBlock({ words, title, note }: { words: readonly VerifiedUserWords[] | undefined; title?: string; note?: string }) {
  const rows = userWordsRows(words);
  if (rows.length === 0) return null;
  return (
    <div className="user-words">
      <div className="user-words-h">{title ?? USER_WORDS_TITLE}</div>
      <ul className="user-words-list">
        {rows.map((r) => (
          <li key={r.key}>
            <span className="user-words-text">{t("ui.userWords.quote", { text: r.text })}</span>
            <span className="chip chip-you user-words-badge">{USER_WORDS_BADGE}</span>
            {/* 从哪来里提到秘书的是名字占位（"和<名字>的对话""经<名字>转达"）：按现在的名字显示 */}
            <div className="user-words-src">
              <NamedText text={r.source} />
            </div>
          </li>
        ))}
      </ul>
      {note && <div className="user-words-note">{note}</div>}
    </div>
  );
}
