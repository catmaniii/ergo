// 记忆插件的网页这一半（193 号票，ADR-0027 的网页插槽；守护进程那一半是 packages/daemon/src/memory/plugin.ts，129 号票）。
// 插件名和守护进程的一样（memory）：守护进程报它在运行就装，配置 plugins.disabled 里停用了就停。登记的：
// - 页面"记忆"（MemoryPage.tsx：顶上"和记忆管理员聊"、档案、结论、问题箱、素材几栏，#/more/memory/…；285 号票重排）和导航里的"记忆"
//   （排在消耗后面、设置前面），放不下时收进"更多"；它里面有成批删除，所以它在时设置里不列内核的"删除素材"（covers）；
//   285 号票：它的"档案"一栏就是内核的个人档案，所以它在时"更多"里不列个人档案、#/more/files[/<编号>] 换到记忆 · 档案（covers + coverRoute）；
// - 会话条目 recall 的画法（RecallLine.tsx："回忆了 N 条记忆 ›"，187 号票）和它的详情"这次用到的记忆"（RecallDetail.tsx）；
// - 卡片类型 memory_delete 的画法（MemoryDeleteCard.tsx：记忆删除卡，21 号票）；
// - 看板条目 memory_curator 的画法（CuratorBoardCard.tsx：记忆整理 · 每天 03:00，点进去是管理员那一层，242 号票）；
// - 记忆页最下面那块"记忆系统 · 会意 v1.0 · 设置"（MemorySettingsSection.tsx，264 号票的三个开关）：336 号票起不登记成设置分节了，
//   跟记忆页一起画（默认收起），设置列表最下面不再有它；336 号票还给这套记忆系统起了名字（「会意」/ Subtext，键在 system.ts），
//   以后别的记忆系统当插件接进来时认得出是哪一套；用户 2026-10-31 定：它是插件，标题写「记忆系统 · 会意 v1.0」/「Memory System · Subtext v1.0」
//   （shell.pages.memory.title），记忆页顶上挂「实验性」标签和一句说明，设置块那句也写明实验性（导航那一项还是"记忆"）；
// - 卡片类型 interview 的画法（InterviewCard.tsx：了解你访谈的约访卡，284 号票）；285 号票起随时开访谈是记忆管理员对话里输入框上面
//   那一行的"开始访谈"（CuratorPage.tsx），/interview 照旧；
// - 卡片类型 interview_files 的画法（InterviewFilesCard.tsx：访谈收尾时这次听到的档案信息合成的一张核对卡，逐条确认，284 号票）。
// 停用时：导航、"更多"里没有记忆，地址 #/more/memory 写"记忆插件没启用"；对话里以前的"回忆了 N 条记忆"、记忆删除卡显示
// "（记忆插件没启用，这条内容暂时看不到）"；设置里列出内核的"删除素材"（素材库和删除是内核的，129 号票：停用时删除照常）；
// 看板上那张记忆整理的卡也不长出来（state/board.ts 按插件的状况决定）。
// 二期的记忆系统（记忆管理者、做梦、记忆简报、用户卡、动机挖掘）的界面往这里加：233 号票加了结论、证据与推理、问题箱三层
// （ClaimsBrowse.tsx、EvidenceBrowse.tsx、QuestionsBrowse.tsx，接口是守护进程的 GET /api/memory/…），242 号票加了管理员
// （CuratorPage.tsx：会话频道 + GET /api/memory/summary）。
import { t } from "../../state/index.ts";
import type { WebPluginDefinition } from "../api.ts";
import { CuratorBoardCard } from "./CuratorBoardCard.tsx";
import { InterviewCard } from "./InterviewCard.tsx";
import { InterviewFilesCard } from "./InterviewFilesCard.tsx";
import { MemoryDeleteCard } from "./MemoryDeleteCard.tsx";
import { MemoryColumn, MemorySection } from "./MemoryPage.tsx";
import { RecallDetailBody } from "./RecallDetail.tsx";
import { RecallItem } from "./RecallLine.tsx";
import { MEMORY_PAGE, memoryCoverRoute } from "./route.ts";

export const memoryWebPlugin: WebPluginDefinition = {
  name: "memory",
  get title() {
    return t("ui.plugins.memory.title");
  },
  owns: { pages: [MEMORY_PAGE], chatItems: ["recall"], details: ["recall"], cards: ["memory_delete", "interview", "interview_files"], boardEntries: ["memory_curator"] },
  // 设置 · 插件里列的网页上的页面、栏目（211 号票）
  get brings() {
    return [t("ui.plugins.memory.brings.page"), t("ui.plugins.memory.brings.recall"), t("ui.plugins.memory.brings.board"), t("ui.plugins.memory.brings.settings")];
  },
  setup(ctx) {
    ctx.register("pages", {
      id: MEMORY_PAGE,
      order: 80,
      icon: "layers",
      get navLabel() {
        return t("shell.nav.memory");
      },
      get title() {
        return t("shell.pages.memory.title");
      },
      get sub() {
        return t("shell.pages.memory.sub");
      },
      covers: ["materials-delete", "files"],
      coverRoute: memoryCoverRoute,
      Section: MemorySection,
      Column: MemoryColumn,
    });
    ctx.register("chatItems", { kind: "recall", Item: RecallItem });
    ctx.register("details", { kind: "recall", Body: RecallDetailBody });
    ctx.register("cards", { type: "memory_delete", Card: MemoryDeleteCard });
    // 284 号票：了解你访谈的约访卡
    ctx.register("cards", { type: "interview", Card: InterviewCard });
    ctx.register("cards", { type: "interview_files", Card: InterviewFilesCard });
    // 242 号票：看板上那张"记忆整理 · 每天 03:00"
    ctx.register("boardEntries", { kind: "memory_curator", Entry: CuratorBoardCard });
  },
};
