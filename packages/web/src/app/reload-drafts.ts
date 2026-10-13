// 刷新前留住输入框里没发出去的字（116 号票）：点"二狗有新版本 · 刷新"时，开着的输入框里打了一半的话存进这个标签页的
// sessionStorage，刷新后同一个会话的输入框挂上时放回去（取一次就删掉）。sessionStorage 只属于这个标签页（鸿蒙 App 里就是这个 WebView），
// 刷新还在、关掉就没了，不会跑到别的标签页、别的设备上。存储用不了（隐私模式、禁用了站点数据）时这次就留不住，不抛错。
// 只留打的字：输入框上方的附件、正在录的语音刷新会丢，那时不提示（state/page-update.ts 的 busy）。
// 这里不碰浏览器的全局变量，测试在 Node 里跑；页面上的那一份在 page-update.ts。
import type { DeviceStorage } from "./device-storage.ts";

/** 存在哪个键下：{ 会话 id: 打的字 } */
const KEY = "ergou.reload_drafts";

export interface ReloadDrafts {
  /** 刷新前：存下各个会话输入框里的字（空的、只有空白的不存） */
  keep(drafts: Readonly<Record<string, string>>): void;
  /** 刷新后：这个会话存着的字（取一次就删掉）；没有是 undefined */
  take(conversation: string): string | undefined;
}

export function reloadDraftsIn(storage: () => DeviceStorage): ReloadDrafts {
  const read = (): Record<string, string> => {
    try {
      const raw = storage().getItem(KEY);
      const parsed: unknown = raw === null ? {} : JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return {};
      return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"));
    } catch {
      return {};
    }
  };
  const write = (drafts: Record<string, string>) => {
    try {
      if (Object.keys(drafts).length === 0) storage().removeItem(KEY);
      else storage().setItem(KEY, JSON.stringify(drafts));
    } catch {
      // 存不了就算了：刷新后输入框是空的
    }
  };
  return {
    keep(drafts) {
      const kept = Object.fromEntries(Object.entries(drafts).filter(([, text]) => text.trim() !== ""));
      if (Object.keys(kept).length > 0) write({ ...read(), ...kept });
    },
    take(conversation) {
      const drafts = read();
      const text = drafts[conversation];
      if (text === undefined) return undefined;
      delete drafts[conversation];
      write(drafts);
      return text;
    },
  };
}

/** 开着的输入框：各自现在打的字 */
export interface ComposerDrafts {
  /** 一个输入框挂上：text 取它现在打的字；返回拿下的函数 */
  open(conversation: string, text: () => string): () => void;
  /** 开着的输入框里打的字（会话 id → 字；空的、只有空白的不算） */
  current(): Record<string, string>;
}

export function createComposerDrafts(): ComposerDrafts {
  const open = new Set<{ conversation: string; text: () => string }>();
  return {
    open(conversation, text) {
      const entry = { conversation, text };
      open.add(entry);
      return () => void open.delete(entry);
    },
    current() {
      const drafts: Record<string, string> = {};
      for (const { conversation, text } of open) {
        const t = text();
        if (t.trim() !== "") drafts[conversation] = t;
      }
      return drafts;
    },
  };
}
