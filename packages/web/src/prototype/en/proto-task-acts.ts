// proto-task-acts.ts 里的字对应的英文。左边是中文原文（有插值的地方写 {}），右边是英文
import type { Phrases } from "./phrases.ts";

export const EN_PROTO_TASK_ACTS: Phrases = {
  "{}：执行名额没满，直接回到执行中": "{}: run slots are free, so it goes straight back to running",
  "{}：执行名额满了（{}/{}），先排队": "{}: run slots are full ({}/{}), so it queues first",
  "已暂停": "Paused",
  "已继续": "Continued",
  "已取消": "Canceled",
  "已归档": "Archived",
  "已删除": "Deleted",
  "已重试": "Retried",
  "验收通过，任务完成": "Accepted, task done",
  "已退回，原因交给了负责人": "Sent back, reason passed to the owner",
  "已从这里重做，重开这个阶段和它的下游": "Redoing from here: this stage and everything downstream reopened",
};
