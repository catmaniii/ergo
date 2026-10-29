// 素材检索、读素材、问记忆、问记忆管理员、标顺口问这几个工具的名字（模型调用时用的名字；系统提示、彻底删除找工具调用记录、改写会话文件时也引用它）。
/** 检索素材：关键词加语义 */
export const SEARCH_MATERIALS = "search_materials";
/** 读一条素材的全文（166 号票：用户存的网页的正文夹在外部数据标记里） */
export const READ_MATERIAL = "read_material";
/** 问记忆（232 号票）：从推理图谱里取和问题相关的结论（推断，带把握），只给秘书 */
export const ASK_MEMORY = "ask_memory";
/** 问记忆管理员（242 号票）：把用户要深聊、要改/要忘的话转给它，等它答完带回来；只给秘书 */
export const ASK_CURATOR = "ask_curator";
/** 标一下这一轮顺口问了哪个问题（271 号票）：秘书用自己的话问了【顺口问】交给它的那个"了解你问题"就调一次；只给秘书 */
export const MARK_WOVEN_QUESTION = "mark_woven_question";
/** 按原话记一条（337 号票）：用户明确让"帮我记一句"时秘书调它，转给记忆插件槽的 remember；只给秘书，不自己随手记 */
export const REMEMBER_MEMORY = "remember_memory";
