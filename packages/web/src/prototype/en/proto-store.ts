// proto-store.tsx 里的字对应的英文。左边是中文原文（有插值的地方写 {}），右边是英文
import type { Phrases } from "./phrases.ts";

export const EN_PROTO_STORE: Phrases = {
  "等执行名额": "Waiting for a run slot",
  "按你的意见重新起草计划": "Redraft the plan with your notes",
  "同步备份端": "Sync the backup side",
  "在现有授权内重排这一步": "Reorder this step within existing permissions",
  "项目「{}」诞生了（筹备中），负责人随之产生": "Project “{}” is born (in preparation), and its owner comes with it",
  "已发起任务「{}」（规划中）": "Started task “{}” (planning)",
  "已开工：发起了首个建设任务，项目进入建设中": "Under way: first build task started, and the project is now being built",
  "立项书已确认，项目留在筹备中": "Charter confirmed, project stays in preparation",
  "立项书改好了，末尾记了这次变更": "Charter updated, with this change noted at the end",
  "已拒绝，立项书不变": "Declined, charter unchanged",
  "规范改好了，记进了项目档案": "Standard updated and noted in the project records",
  "已拒绝，规范不变": "Declined, standard unchanged",
  "改用了规范，建了任务交给负责人补": "Switched to the standard, and a task went to the owner to fill the gaps",
  "不补了，不会再问": "No backfill, won't ask again",
  "计划已确认，任务进入排队中": "Plan confirmed, task is now queued",
  "已打回，意见交给了起草计划的负责人": "Sent back, and your notes went to the plan-drafting owner",
  "已批准，新设备拿到凭证": "Approved, the new device got its credentials",
  "useProto 必须在 ProtoProvider 里用": "useProto must be used inside ProtoProvider",
};
