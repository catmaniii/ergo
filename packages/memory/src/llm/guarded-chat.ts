// 发给模型之前的两层包装（283 号票，个人档案和记忆联动）：守护进程的每晚整理把真模型包上这两层再交给引擎。
// - withBackground：推理的几步（出假设、出追问、判证据、往上抽、对抗复核）在系统提示末尾加一段背景——个人档案的摘要
//   （"有个 6 岁的女儿""刚搬家"），写明只当情境、不当证据，免得把一切都归给性格（情境只当背景：处境能解释的行为，不往性格、价值观上推）。抽事实、判回答、
//   判预测、认人物信息这几步不加（摘要不是证据，抽事实时混进去会被当成用户说的话）；
// - withRedaction：请求里（系统提示和用户那一段）出现了号码类字段的值（证件号、电话、住址门牌），换成占位再发出去
//   （第二阶段计划"号码类字段不进夜里的整理提示"）。号码中间夹着空格、短横也认（"138 0000 1111"）；住址按字比，中间的空白不算。
// 两层都只改发出去的请求，不改模型的回答；名字照旧是里面那个模型的（manifest、账本按它记）。
import type { ChatModel, ChatPurpose, ChatRequest } from "./chat.ts";

/** 默认加背景的几步：推理（为什么这样）的那几步 */
export const BACKGROUND_PURPOSES: readonly ChatPurpose[] = ["propose", "probes", "judge", "lift", "review"];

/** 一段要藏起来的值：值本身、换成什么 */
export interface RedactedValue {
  value: string;
  /** 换成的占位（给模型看的一小段，如"［号码已略去］"） */
  placeholder: string;
  /** 号码：中间夹着的空白、短横也算（"138 0000 1111" 也认成 13800001111） */
  digits?: boolean;
}

/** 值里少于这么多个字的不藏（太短了会误伤别的话） */
const MIN_REDACT_CHARS = 4;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 一段值的匹配：号码每个字之间允许空白和短横；别的每个字之间允许空白 */
function patternOf(item: RedactedValue): RegExp | undefined {
  const chars = [...item.value.replace(/\s+/g, "")];
  if (chars.length < MIN_REDACT_CHARS) return undefined;
  const gap = item.digits ? "[\\s\\-－—]*" : "\\s*";
  return new RegExp(chars.map(escape).join(gap), "giu");
}

/** 把一段文字里要藏的值换成占位（长的先换，免得短的把长的切开） */
export function redactText(text: string, values: readonly RedactedValue[]): string {
  let out = text;
  const sorted = values.toSorted((a, b) => b.value.length - a.value.length);
  for (const item of sorted) {
    const pattern = patternOf(item);
    if (pattern) out = out.replace(pattern, item.placeholder);
  }
  return out;
}

/** 请求里出现了要藏的值就换成占位再发；没有要藏的原样 */
export function withRedaction(chat: ChatModel, values: () => readonly RedactedValue[]): ChatModel {
  return {
    name: chat.name,
    complete(request: ChatRequest) {
      const list = values();
      if (list.length === 0) return chat.complete(request);
      return chat.complete({ ...request, system: redactText(request.system, list), user: redactText(request.user, list) });
    },
  };
}

/** 推理那几步的系统提示末尾加一段背景（空的不加）；别的步骤原样 */
export function withBackground(chat: ChatModel, background: () => string, purposes: readonly ChatPurpose[] = BACKGROUND_PURPOSES): ChatModel {
  return {
    name: chat.name,
    complete(request: ChatRequest) {
      const text = purposes.includes(request.purpose) ? background().trim() : "";
      if (text === "") return chat.complete(request);
      return chat.complete({ ...request, system: `${request.system}\n\n${text}` });
    },
  };
}
