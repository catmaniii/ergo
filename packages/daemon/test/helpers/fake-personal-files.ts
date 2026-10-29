// 假内核里的个人档案（KERNEL.personalFiles，只在测试里）：记下交来的候选；合成候选核对卡时在假内核的卡片里真建一张
// personal_file_suggest（负载只有交来的称呼），测试能把它改成处理完了（301 号票：Google 联系人一批一批交，看上一张卡处理了没有）。
// 档案里的人、我的名字由测试给。
import { CARD_TYPE_VERSIONS, Type } from "@ergo/protocol";
import type { CardService } from "../../src/cards/cards.ts";
import { type CardTypeRegistry, defineCardType } from "../../src/cards/registry.ts";
import type { EventStore } from "../../src/events/event-store.ts";
import type { CandidateInput, PersonalFilesForMemory, PersonForMemory } from "../../src/personal-files/index.ts";

export interface FakePersonalFiles {
  readonly calls: Array<{ origin: string; inputs: readonly CandidateInput[] }>;
  readonly service: PersonalFilesForMemory;
  /** 接上假内核的卡片（不接的话合成卡片只交回 card-1、card-2……的编号，不真建） */
  attach(kernel: { store: EventStore; cards: CardService; cardTypes: CardTypeRegistry }): void;
  /** 把一张卡改成处理完了 */
  handle(cardId: string): void;
}

export function fakePersonalFiles(options: { people?: () => PersonForMemory[] } = {}): FakePersonalFiles {
  const calls: Array<{ origin: string; inputs: readonly CandidateInput[] }> = [];
  let pending: string[] = [];
  let kernel: { store: EventStore; cards: CardService } | undefined;
  let open: string | undefined;
  let next = 0;
  return {
    calls,
    service: {
      people: () => options.people?.() ?? [],
      background: () => "",
      withheld: () => [],
      onFieldReplaced: () => () => {},
      replacedValues: () => [],
      addCandidates(origin, inputs) {
        calls.push({ origin, inputs });
        pending.push(...inputs.map((i) => i.name));
        return inputs.length;
      },
      composeCandidates() {
        if (pending.length === 0) return undefined;
        const names = pending;
        pending = [];
        if (!kernel) return `card-${++next}`;
        // 还没处理的那张接着往里加（和真的一样）
        if (open !== undefined && kernel.cards.get(open)?.status === "pending") {
          const had = (kernel.cards.get(open)!.payload as { names: string[] }).names;
          kernel.store.append(kernel.cards.buildUpdate(open, { payload: { names: [...had, ...names] } }).event);
          return open;
        }
        const created = kernel.cards.buildCreate({ type: "personal_file_suggest", payload: { names } });
        kernel.store.append(created.event);
        open = created.card.id;
        return open;
      },
    },
    attach(k) {
      kernel = k;
      k.cardTypes.register(
        defineCardType({ type: "personal_file_suggest", version: CARD_TYPE_VERSIONS.personal_file_suggest, payload: Type.Object({ names: Type.Array(Type.String()) }), actions: {}, toText: (p) => p.names.join("、") }),
      );
    },
    handle(cardId) {
      if (!kernel) throw new Error("没接上假内核的卡片");
      kernel.store.append(kernel.cards.buildUpdate(cardId, { status: "handled" }).event);
    },
  };
}
