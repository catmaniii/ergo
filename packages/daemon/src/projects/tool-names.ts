// 项目相关的工具名（秘书和维护者的系统提示、交给维护者的通知、测试里引用；工具定义在 tools.ts）
/** 秘书的"建议立项"：只产生一张建议立项卡（名字、一句话目标） */
export const SUGGEST_PROJECT_TOOL = "suggest_project";
/** 项目维护者的"提交立项书"：立项问答的结论和提议的工具包，立项书卡放进待我处理 */
export const SUBMIT_CHARTER_TOOL = "submit_charter";
/** 项目维护者的"提立项要求变更"（125 号票）：立项书确认之后改目标、范围、首版，出"立项要求变更"卡等用户确认 */
export const PROPOSE_CHARTER_CHANGE_TOOL = "propose_charter_change";
/** 项目维护者的"提规范改写"（261 号票）：立项书确认之后改本项目的规范（不要某一份、换写法、多一份、恢复照默认、跟新版），出"规范改写"卡等用户确认 */
export const PROPOSE_STANDARD_CHANGE_TOOL = "propose_standard_change";
/** 秘书的"读项目档案"（22 号票）：按项目读任意项目（含已归档）的项目档案，只读，不唤醒维护者 */
export const READ_PROJECT_RECORDS_TOOL = "read_project_records";
/**
 * 项目维护者、秘书的"提转入使用"（259 号票）：建设中的项目要转入使用（转运营）时出"转入使用"确认卡（还在等的就用那一张），
 * 用户在卡上确认才转；两边同名，参数不同（秘书的要写哪个项目）
 */
export const PROPOSE_GO_LIVE_TOOL = "propose_go_live";
