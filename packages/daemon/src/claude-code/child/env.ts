// Claude Code 子进程交给 claude 的环境变量和可执行文件（287 号票）：292 号票起挪到插件目录的 ../claude-env.ts（守护进程这一侧跑命令行也用），
// 这里照旧转出，子进程里的代码不用改。
export { claudeProcessEnv, findClaudeExecutable, STRIPPED_CLAUDE_ENV } from "../claude-env.ts";
