// 二狗自己那份 Node（守护进程的 process.execPath）：项目服务的命令、登记的 MCP 的 command 写 node 的都换成它——跟着二狗的 Node 版本走，
// 用安装包装的电脑上 PATH 里可能根本没有 node。带路径的 node、别的程序（npm、python……）原样不动。不给 nodePath 也原样不动。

/** 命令开头的 node（或 node.exe）：后面是空白或命令结束 */
const NODE_HEAD = /^\s*node(?:\.exe)?(?=\s|$)/i;

/** 字符串命令（项目服务）：开头的 node 换成 nodePath，加引号（LSM 经 cmd.exe /d /s /c 跑字符串命令，路径带空格也认） */
export function withOwnNode(command: string, nodePath: string | undefined): string {
  return nodePath && NODE_HEAD.test(command) ? command.replace(NODE_HEAD, `"${nodePath}"`) : command;
}

/** 程序和参数分开、不经 shell 起的（MCP）：程序就是 node 才换，不加引号（引号会被当成文件名的一部分） */
export function ownNodeProgram(program: string, nodePath: string | undefined): string {
  return nodePath && NODE_HEAD.test(program) && program.replace(NODE_HEAD, "").trim() === "" ? nodePath : program;
}
