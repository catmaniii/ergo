// @i18n-ignore-file model：工具的说明、参数说明和结果都是给秘书（模型）看的（174 号票）；工具的名字走 t()
// 秘书的"记一句"工具（337 号票第二步）：用户明确说"帮我记一句""记住……"时，秘书把**用户的原话**交给它——
// 不对面那张快速动作卡（21 号票那条路要用户核对卡片），而是直接转给记忆插件槽的宿主（host.remember），由在跑的那个记忆插件
// 按原话存下来（会意这一版：写成一条"显式记忆命令"素材、立刻读成证据入库，见 memory/provider/subtext.ts）。
//
// - 只给秘书（和 ask_memory、mark_woven_question 一样经 agent 贡献缝登记到 agents: ["secretary"]），记忆插件停用时它跟着没了；
// - 说明里写明：只有用户让你记的时候才用，不要自己随手记——随手记会把秘书的推断混成用户的话，而这条口径是"按原话存、不让插件去猜"；
// - 过守卫：defineHostTool 的登记写全（不是绕过去自己执行）。它只往记忆里新增、不改已有的东西，所以不落任何内置类别；
//   幂等键按"会话 + 消息 + 原话"算，同一句话再调一次不会记两遍，所以是"只读或幂等"（23 号票被杀后可以直接重跑）；
// - 出处：这条会话 + 秘书正在处理的那条用户消息 + 这一次工具调用（宿主据此把记忆落到会话/消息上，彻底删除时找得回来）；
// - 没记成（记忆插件没启用、推理库这一会儿用不了……）如实回一句，让秘书跟用户说清，不假装记下了。
// 366 号票（用户 2026-11-01："这张图记下来还是尽量可以下载吧"）：加一个可选的 file（文件编号）：用户在长按的网页元素上说记下来时，图、文件本身连同描述、来源网页和地址一起存进素材。
// 不按意图分类，由秘书判断；编号只认这一轮 browse_element_content 取回来的（浏览插件核对），不能传路径（参数按 FILE_REF 校验）。这时 text 是秘书写的描述，不是用户的原话，
// 来源标记跟着变（subtext-runtime.ts）。带不上文件（取不到、超了附件上限……）照实回"只记了文字"。
import { CHANNELS, type MemoryItem, type MemoryRememberInput, type MemorySource, type RememberedFile, t, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool, type HostToolCall } from "../../agent-manager/host-tools.ts";
import { type ElementToRemember, FILE_REF } from "../../browsing/api.ts";
import { getMessage } from "../../conversation/views.ts";
import type { EventStore } from "../../events/event-store.ts";
import { sizeLabel } from "../../media/file-types.ts";
import { REMEMBER_MEMORY } from "../tool-names.ts";

export { REMEMBER_MEMORY } from "../tool-names.ts";

/** 工具交回的一条：宿主转给记忆插件之后拿到的记忆（用来回一句"记下了"） */
export interface RememberToolDeps {
  remember(input: MemoryRememberInput): Promise<MemoryItem>;
  /** 事件日志的读：认秘书正在处理的这条输入属于哪个会话 */
  store: Pick<EventStore, "reader">;
  /** 366 号票：这一次能带上什么（浏览插件给：这一轮长按的元素取回来的文件、来源网页和地址）；浏览插件没启用是 undefined，不给也是 */
  elementToRemember?: (ref: string | undefined, call: HostToolCall) => ElementToRemember | undefined;
}

const RememberParams = Type.Object(
  {
    text: Type.String({
      minLength: 1,
      // @i18n-ignore-start model：参数说明（给秘书看的）
      description:
        "要记住的那一句话：照抄用户的原话（用户说\"帮我记一句：周三下午去取车\"就是\"周三下午去取车\"），不要改写、不要加自己的推断。带 file 时写这个文件是什么（你看到的、用户说的，一两句；看不了图时写用户的话或元素的说明文字，不要猜）",
      // @i18n-ignore-end
    }),
    file: Type.Optional(
      Type.String({
        pattern: FILE_REF,
        // @i18n-ignore-next model：参数说明（给秘书看的）
        description: "要连同这句一起存下的文件的编号（ref-…）：只认这一轮 browse_element_content 给的那个，别的编号、路径都不行",
      }),
    ),
  },
  { additionalProperties: false },
);

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 连文件一起存下了（366 号票）：存了什么、在哪看得到；存的是截图的说清 */
function withFileText(head: string, file: RememberedFile): string {
  const how = file.via === "screenshot" ? `存的是截的这个元素的图，不是原文件${file.partial ? "，只截到了屏幕上看得见的部分" : ""}：告诉用户时说清是截图。` : ""; // @i18n-ignore model：工具结果
  return `${head}，连同文件「${file.name}」（${file.mime}，${sizeLabel(file.size)}）和它的来源一起存进了素材，用户在记忆 · 素材里能看到。${how}不用再复述一遍。`; // @i18n-ignore model：工具结果
}

export function rememberTool(deps: RememberToolDeps): HostTool {
  return defineHostTool({
    name: REMEMBER_MEMORY,
    title: t("memory.tool.remember"),
    // @i18n-ignore-start model：工具说明（给秘书看的）
    description:
      "记一句：用户明确让你记下来的时候（\"帮我记一句……\"\"记住……\"\"这个记一下\"），把**用户的原话**照抄进来存成一条记忆。" +
      "只有用户明确让你记的时候才用，不要自己随手记（你自己的推断、你觉得重要的东西、聊到一半的话题都不记）——记下来的就是用户的话，不是你的判断。" +
      "一句话一条。存好以后不用复述一遍，回一句\"记下了\"就行；用户没让你记的时候不要调它。" +
      "用户在长按的网页元素上说记下来、存起来（\"这张图记下来\"）时，把文件本身带上：先调 browse_element_content 取回来，text 写它是什么，file 写取回来给的文件编号；文件、来源网页和地址会一起存进素材，用户在记忆 · 素材里能看到。" +
      "取不到原文件时存的是截图，要跟用户说清；什么都取不到就不带 file 只记文字，并照实说只记了文字。",
    // @i18n-ignore-end
    parameters: RememberParams,
    // 只往记忆里新增，不改已有的东西：不落任何内置类别
    categories: [],
    // 幂等键按"会话 + 消息 + 原话"算：同一句话再调一次不会记两遍
    readOnlyOrIdempotent: true,
    async run(args, call) {
      const text = args.text.trim();
      if (text === "") return { text: "记什么？要记住的那一句话是空的。", isError: true }; // @i18n-ignore model：工具结果
      const element = deps.elementToRemember?.(args.file, call) ?? (args.file === undefined ? {} : { refused: `没记：内置浏览器插件没启用，${args.file} 这个文件带不上。只记文字就别带 file，并照实说只记了文字。` }); // @i18n-ignore model：工具结果
      if ("refused" in element) return { text: element.refused, isError: true };
      const messageId = call.inputMessageId;
      // 秘书正在处理的那条用户消息在哪个会话：问那条消息自己（这个工具只给秘书，认不出时按秘书的会话）
      const conversation = (messageId === undefined ? undefined : getMessage(deps.store.reader, messageId)?.conversation) ?? CHANNELS.secretary;
      const sources: MemorySource[] = [
        { kind: "conversation", id: conversation },
        ...(messageId === undefined ? [] : [{ kind: "message" as const, id: messageId }]),
        { kind: "tool_call", id: call.toolCallId },
      ];
      try {
        const item = await deps.remember({
          text,
          kind: "note",
          tags: ["manual"],
          sources,
          ...(element.file === undefined ? {} : { file: element.file }),
          ...(element.origin === undefined ? {} : { origin: element.origin }),
        });
        // ingested 不是 true：只记进了素材（还没建库、或者落在没打开的敏感类别里），说清这一会儿检索不到
        const stored = item.extra?.ingested === true ? "" : "（这一条这会儿没进推理检索，素材里留着，能检索到原话）"; // @i18n-ignore model：工具结果
        const head = `记下了（${item.id}）：「${item.text}」${stored}`;
        // 带着文件来的：存下了说清存了什么；插件不存文件、文件带不上的照实说只记了文字
        if (element.file !== undefined && item.extra?.fileStored === true) return { text: withFileText(head, element.file) };
        const missing = element.file !== undefined ? "现在的记忆插件不存文件" : element.note; // @i18n-ignore model：工具结果
        if (missing !== undefined) return { text: `${head}。只记了文字，文件本身没存下来：${missing}。照实告诉用户只记了文字。` }; // @i18n-ignore model：工具结果
        return { text: `${head}。照用户的原话记的，不用改写、也不用再复述一遍。` }; // @i18n-ignore model：工具结果
      } catch (err) {
        return { text: `没记成：${messageOf(err)}。跟用户说清这一句没记上，别假装记下了。`, isError: true }; // @i18n-ignore model：工具结果
      }
    },
  });
}
