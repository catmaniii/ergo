// 目录授权（ADR-0049）的工具名：单独一个文件，子 agent 的装配（sub-agents/assembly.ts：子 agent 一律没有它）、测试都引它，不用拉进整个模块
/** 有表的 agent 申请把一个目录登记进它的目录授权（464：发一张申请卡，用户同意了才登记） */
export const REQUEST_FOLDER_GRANT_TOOL = "request_folder_grant";
