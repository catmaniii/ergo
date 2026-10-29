// @i18n-ignore-file log：底层出错的说明只进日志（给开发者看）
// 闸门进程（gated-spawn.ts 拉起它；带类型的 bash 工具、MCP 服务进程共用）：先等守护进程把自己放进 Job 对象，再起真正要跑的程序。
// Node 起子进程时会先把它放进 libuv 私有、允许悄悄脱离的 Job；要是这时就起要跑的程序（Git Bash 的 bin/bash.exe 是个启动器，
// 一起来就再起 usr/bin/bash.exe），孙进程会在守护进程把它放进二狗的 Job 之前脱离出去。所以这里什么都不做，
// 直到 stdin 上来第一行"要跑什么"（守护进程放好 Job 之后才送），之后起的进程就都跑不出 Job 了。
//
// 第一行（JSON，GateSpec）：{ file, args, cwd?, stdin }。命令行上只放固定的东西；stdin 是要跑的程序的标准输入从哪来：
// - { values: [...] }：这几个值，每个后面跟一个 NUL，送完就关（带类型的 bash 工具：Git Bash 是 MSYS 程序，命令行上的参数会被
//   它的运行时当成通配符展开、当成响应文件读进来，模型给的值只能从 stdin 送）；之后 stdin 上来的不管；
// - "forward"：之后 stdin 上来的原样转过去，stdin 关了就关它的（MCP 的 stdio 传输据此退出）。
// 要跑的程序的输出直接接到自己的 stdout / stderr（继承句柄，不经这里转手），退出码原样带回。环境由守护进程拉起闸门时给出，照样继承。
import { type ChildProcess, spawn } from "node:child_process";
import type { GateSpec } from "./gated-spawn.ts";

let header = Buffer.alloc(0);
let child: ChildProcess | undefined;
let forward = false;

process.stdin.on("data", (chunk: Buffer) => {
  if (child) {
    if (forward) child.stdin?.write(chunk);
    return;
  }
  header = Buffer.concat([header, chunk]);
  const end = header.indexOf(0x0a);
  if (end < 0) return;
  let spec: GateSpec;
  try {
    spec = JSON.parse(header.subarray(0, end).toString("utf8")) as GateSpec;
  } catch {
    process.stderr.write("闸门进程收到的不是要跑的命令\n");
    process.exit(126);
  }
  const started = spawn(spec.file, [...spec.args], { ...(spec.cwd ? { cwd: spec.cwd } : {}), stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
  child = started;
  started.on("error", (err) => {
    process.stderr.write(`起不来：${err.message}\n`);
    process.exit(127);
  });
  started.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
  // 程序读完值之后再读 stdin 就是读到头了（和不给 stdin 一样，不会卡住等输入）
  started.stdin?.on("error", () => {});
  if (spec.stdin === "forward") {
    forward = true;
    const rest = header.subarray(end + 1);
    if (rest.length > 0) started.stdin?.write(rest);
  } else {
    started.stdin?.end(spec.stdin.values.map((value) => `${value}\0`).join(""));
  }
});
process.stdin.on("end", () => {
  if (!child) process.exit(0);
  if (forward) child.stdin?.end();
});
