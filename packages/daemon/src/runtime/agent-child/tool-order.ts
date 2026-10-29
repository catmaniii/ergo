// 接着会话时工具清单以这次交的为准（273 号票）。
// pi 把工具清单记在会话里的系统消息上：开头一条带开始时的全部工具，之后清单变了（接着会话时这次交的和开始时的不一样，比如插件中途启用、
// 停用）就在接着的地方记一条增减（toolsAdded / toolsRemoved，说明改了的算去掉再加上）。发请求时按这些增减重放：
// - 认会话中途系统消息的模型（faux）原样收到开头一份旧清单、中间一份增减——改了说明的工具出现两次（一次旧的，一次去掉再加上的）；
// - DeepSeek 的请求里工具是整份的 tools 字段（pi 不给它在中途锚定新工具），按重放的结果排：没变的照旧在前，新加的和改了的排到最后，
//   和同样装配的新会话先后不同；会话里增减越积越多，越和新会话对不上。
// 这里给每次请求排一遍（包在 pi 的 transformContext 最外层，pi 自己的几层投影之后）：开头那条系统消息带重放后的全部工具（声明照会话里记的，
// 一个不多一个不少），按这次交给 pi 的先后（会话现在启用的工具，就是装配参数的先后）；之后的系统消息去掉工具增减，只剩增减的整条不要
// （系统提示的分段补丁照旧留在原位）。会话文件不改：增减照旧记着，只是发给模型的工具清单和新会话一致、不重复。
// 没有增减、先后也对的请求原样不动。前缀缓存的取舍见 273 号票的 Comments。
import { contentText, getCurrentTools, type SystemMessage, type Tool } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

type ContextTransform = NonNullable<AgentSession["agent"]["transformContext"]>;
type AgentMessages = Parameters<ContextTransform>[0];
type AgentMessage = AgentMessages[number];

/** 给会话的每次请求排工具清单：包在 agent 现有的 transformContext 外面（pi 建会话时装的几层投影照旧先走） */
export function installToolOrder(session: AgentSession): void {
  const agent = session.agent;
  const previous = agent.transformContext;
  agent.transformContext = async (messages, signal) => {
    const transformed = previous ? await previous(messages, signal) : messages;
    return withDeclaredToolOrder(transformed, session.getActiveToolNames());
  };
}

const isSystem = (message: AgentMessage): message is SystemMessage => message.role === "system";

/**
 * 工具清单并到开头那条系统消息、按 order 的先后（order 里没有的照重放的先后排在后面）；之后的系统消息去掉工具增减。
 * 没什么要改的时返回原来的数组
 */
export function withDeclaredToolOrder(messages: AgentMessages, order: readonly string[]): AgentMessages {
  const head = messages.findIndex(isSystem);
  if (head === -1) return messages;
  const systems = messages.filter(isSystem);
  const tools = ordered(getCurrentTools(systems), order);
  const headTools = (messages[head] as SystemMessage).toolsAdded ?? [];
  const later = systems.slice(1);
  const unchanged = later.every((m) => !m.toolsAdded && !m.toolsRemoved) && sameNames(headTools, tools) && !(messages[head] as SystemMessage).toolsRemoved;
  if (unchanged) return messages;
  return messages.flatMap((message, index): AgentMessage[] => {
    if (!isSystem(message)) return [message];
    const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
    if (index === head) return [{ ...rest, ...(tools.length > 0 ? { toolsAdded: tools } : {}) }];
    // 只剩增减的整条不要（没有文字、没有分段补丁）
    const empty = contentText(rest.content).length === 0 && Object.keys(rest.sections ?? {}).length === 0;
    return empty ? [] : [rest];
  });
}

/** 按 order 的先后排；order 里没有的（照说没有：pi 每次请求前都让会话里的清单和启用的一致）照原来的先后接在后面 */
function ordered(tools: readonly Tool[], order: readonly string[]): Tool[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const known = order.flatMap((name) => byName.get(name) ?? []);
  const listed = new Set(order);
  return [...new Set([...known, ...tools.filter((t) => !listed.has(t.name))])];
}

function sameNames(a: readonly Tool[], b: readonly Tool[]): boolean {
  return a.length === b.length && a.every((t, i) => t.name === b[i]!.name);
}
