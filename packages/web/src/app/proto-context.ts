// 页面上看板、工具包读的那份只属于演示页的假数据。这里只有形状和空的默认值，假数据本身在 prototype/proto-store.tsx，
// 演示页才装 ProtoProvider；安装版没人装，看板上就只有前端状态层里的真条目（App.tsx）。
import { createContext, useContext } from "react";
import type { BoardEntry, SkillEntry } from "../model/types.ts";

export interface ProtoState {
  board: BoardEntry[];
  skills: SkillEntry[];
}

export interface Proto {
  proto: ProtoState;
  update(f: (s: ProtoState) => ProtoState): void;
}

const EMPTY: Proto = { proto: { board: [], skills: [] }, update: () => undefined };

export const ProtoContext = createContext<Proto>(EMPTY);

export function useProto(): Proto {
  return useContext(ProtoContext);
}
