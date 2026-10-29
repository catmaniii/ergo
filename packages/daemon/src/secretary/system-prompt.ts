// 秘书的系统提示（规格第 7 节）和秘书专用的压缩指令（22 号票）。71 号票起文字在 md 文件里（本包的 prompts/secretary.md、
// secretary-compaction.md，用户改的在数据目录配置区的 prompts/），这里只填值：
// - 名字（43 号票）：用户给它起的名字；名字变了，秘书在下一轮之前按新的系统提示重新装配（secretary.ts）；
// - 对话审批开着（70 号票）：配置 guard.conversationApprovals，草稿区外的说法跟着它——关着（默认）时大部分直接做、照常记录，
//   特别敏感的（写删草稿区外、对外发送、账户与安全、不可逆的提交）出审批卡（101 号票）；开着时照原来的先经用户批准。
// 工具名、看板变化和系统通知的标记是公用的占位符（prompts/registry.ts），提示文件里直接写 {{view_board}} 这样的。
// 114 号票：给了 agent id（秘书的是 secretary）时，用户在秘书会话的 ⚙ 里给它单独写的提示词照用（追加在后面，或整份替换）。
import type { ConversationApprovals } from "../guard/index.ts";
import type { PromptRenderer } from "../prompts/index.ts";

/**
 * 秘书的系统提示；name 是用户给它起的名字（设置里改，默认"二狗"），approvals 是对话审批的开关（配置 guard.conversationApprovals，
 * 默认关着）；agentId 给了就带上它单独的提示词（114 号票）
 */
export const secretarySystemPrompt = (prompts: PromptRenderer, name: string, approvals: ConversationApprovals = "off", agentId?: string): string =>
  prompts.render("secretary", { 名字: name, 对话审批开着: approvals === "on" }, agentId);

/**
 * 秘书专用的压缩指令（规格第 7 节）：主线会话压缩时写摘要的那次模型调用按它写（接在 pi 的摘要提示后面）。
 * 丢掉任务的执行细节和已解决的问答，涉及的任务只留 ID 和一句话；保留进行中的话题、未回答的问题、刚说的还没处理的指示
 */
export const secretaryCompactionInstructions = (prompts: PromptRenderer): string => prompts.render("secretary-compaction", {});
