// 个人档案给秘书的名字：快速动作的类型、读档案的工具名。系统提示的占位符（{{personal_file}}、{{read_personal_file}}）
// 和彻底删除时找"读过这个值的调用"都用它；单独一个文件，提示词的登记引它不连带整个模块。
// 449：写档案的参数说明里生日、纪念日怎么写（秘书的 personal_file、记忆管理员访谈里的 propose_personal_file 共用）
/** 写档案的快速动作（秘书经 propose_quick_action 提出） */
export const PERSONAL_FILE_ACTION = "personal_file";
/** 读档案的工具 */
export const READ_PERSONAL_FILE = "read_personal_file";
/** 生日、纪念日的值怎么写（参数说明的一句；存的时候规范成 1990-03-02、--03-02、lunar:--08-15 这样） */
// @i18n-ignore-next model：给秘书、记忆管理员的参数说明
export const ANNUAL_VALUE_HINT = "生日、纪念日只写日子：1990-03-02、3月2日（不记得哪年）、农历八月十五、农历闰四月十五这样，照用户说的公历或农历写；写不出具体哪天（\"下个月\"\"六月中旬\"）就先问用户，不要写";
