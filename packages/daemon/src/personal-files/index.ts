// 个人档案（281 号票）：内核的个人数据，照"我的名字"（user-name/）放在内核，停用记忆插件也不丢。
// - 服务：personal-files.ts（读、档案页的改和删、一次写入要追加的事件 prepareWrite——283 号票的每晚候选、284 号票的访谈也走它）；
// - 事件和派生视图：events.ts（内部频道 personal_files、彻底删除的改写函数）、view.ts；
// - 秘书：快速动作 personal_file 和它的核对卡（quick-action.ts），读档案的工具 read_personal_file（read-tool.ts）；
// - 网关的接口在 gateway/http-api.ts（GET / POST /api/personal-files……），组合根（daemon.ts）里单独一段接线。
// - 283 号票：生日、纪念日的每年提醒（annual.ts，提醒建在提醒插件里）、记忆管理员攒的候选和候选核对卡（candidates.ts）、
//   给记忆插件的档案里的人、摘要、不进整理提示的值、字段换了新值（memory-link.ts，经 KERNEL.personalFiles）；"二狗了解到的"经记忆插件现取。
export { carriesValue, PERSONAL_FILE_EVENT, PERSONAL_FILES_CHANNEL, type PersonalFileChange, personalFileEvent, personalFilePurge, type PersonalFileTrail } from "./events.ts";
export { personalFilesView } from "./view.ts";
export { checkFieldFor, createPersonalFilesService, type PersonalFileMemoryPort, type PersonalFilesService, type PersonalFileWrite, type PersonRef } from "./personal-files.ts";
export { personalFileAction, personalFileCardType } from "./quick-action.ts";
export { PERSONAL_FILE_ACTION, READ_PERSONAL_FILE } from "./tool-names.ts";
export { readPersonalFileTool } from "./read-tool.ts";
// 283 号票：每年提醒、候选、给记忆这一侧的
export { annualReminderText, annualSchedule, type AnnualReminderPort } from "./annual.ts";
export { annualPortOf } from "./annual-port.ts";
export { type CandidateInput, NEW_PERSON_MIN_MENTIONS, type PersonalFileCandidates, registerCandidateDeletion } from "./candidates.ts";
export { type FieldReplaced, type PersonalFilesForMemory, type PersonForMemory, type WithheldValue } from "./memory-link.ts";
