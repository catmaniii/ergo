// fake-takeover.ts 里的字对应的英文。左边是中文原文（有插值的地方写 {}），右边是英文
import type { Phrases } from "./phrases.ts";

export const EN_TAKEOVER: Phrases = {
  "记账本导出 CSV 和月度汇总": "Ledger CSV export and monthly summary",
  "在终端里开着（进程 21844）": "Open in a terminal (process 21844)",
  "任务 {}「{}」在管（交还之前别的不能接管）": "Task {} “{}” holds it (nothing else can take over until it's handed back)",
  "家里的知识库整理成网站": "Turn the home knowledge base into a website",
  "照片按地点归档的脚本": "Script to file photos by place",
  "夜里跑的数据整理": "Overnight data cleanup",
  "有一个停着的后台会话记着它（c153a547），当作占着": "A stopped background session remembers it (c153a547), so it counts as taken",
};
