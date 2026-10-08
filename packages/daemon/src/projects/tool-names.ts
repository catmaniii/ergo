// 项目相关的工具名（秘书和维护者的系统提示、交给维护者的通知、测试里引用；工具定义在 tools.ts）
/** 秘书的"建议立项"：只产生一张建议立项卡（名字、一句话目标） */
export const SUGGEST_PROJECT_TOOL = "suggest_project";
/** 项目维护者的"提交立项书"：立项问答的结论和提议的工具包，立项书卡放进待我处理 */
export const SUBMIT_CHARTER_TOOL = "submit_charter";
/** 秘书的"读项目档案"（22 号票）：按项目读任意项目（含已归档）的项目档案，只读，不唤醒维护者 */
export const READ_PROJECT_RECORDS_TOOL = "read_project_records";
