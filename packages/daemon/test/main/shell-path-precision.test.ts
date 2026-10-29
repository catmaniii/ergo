// 主切面（177 号票）：项目的维护者在对话里跑一条 wo-10（2026-10-19 AI 简报站日报那一轮）那样的 bash——同一条命令里定义变量再用、
// printf 的格式串和 echo 里写着斜杠和命令替换、临时文件写到 $TMPDIR——守卫每个路径都看得准，不出审批卡。
// 测试底座的对话审批开着：不出卡不是靠"超出授权先不管"。临时文件落在工作目录里的 .ergo-tmp（拉起时建好，git 不收）。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, maintainerChannel, type MessagePart } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { seedProject } from "../helpers/projects.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { call, cardsOf, eventually, messagesOf, real, say, write } from "../helpers/task-flow.ts";

const PM1 = maintainerChannel("pm-1");
type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

/** 列候选的脚本：输出几行，写进 $TMPDIR 里的文件 */
const LIST = 'for (const s of ["S01", "S15", "S16"]) console.log(`${s}\\tcandidate`);\n';

/** wo-10 那样的命令：变量在同一条命令里定义、printf 的格式串和 echo 里有斜杠和命令替换、结果写到 $TMPDIR */
const COMMAND = [
  "DATE=2026-10-19 && RAW=raw/$DATE && LOG=logs/$DATE.log && RUN=\"$(date '+%Y-%m-%d %H:%M:%S%z')\" && UA=\"Mozilla/5.0\"",
  'mkdir -p logs "$RAW"',
  "printf '\\n=== fetch run %s（补抓：上轮被中断，S15-11/S16/S17/S18/S20 没跑到） ===\\n' \"$RUN\" >> \"$LOG\"",
  "echo '<item>a</item><item>b</item>' > \"$RAW/S01-1.xml\"",
  "printf '%s\\t%s\\tOK\\t%s\\n' \"$RUN\" S01 \"$(wc -c < $RAW/S01-1.xml | tr -d ' ')\" >> \"$LOG\"",
  "echo \"S01 items: $(grep -o '<item' raw/2026-10-19/S01-1.xml | wc -l) ua=$UA\"",
].join(" && ") + '\nnode list.cjs > "$TMPDIR/cand.txt" 2>&1; echo "exit=$?"; tail -5 "$TMPDIR/cand.txt"';

describe("项目的维护者跑 wo-10 那样的命令", () => {
  it("变量代进去、echo / printf 的字不当路径、临时文件写 $TMPDIR：不出审批卡，照常执行；临时文件在工作目录的 .ergo-tmp 里", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const workDir = path.join(real(dataDir), "projects", "p-1", "workdir");
    const td = await startTestDaemon({
      reuse: { dataDir, homeDir: makeTempDir("ergo-home-") },
      maintainer: (id) => (id === "pm-1" ? [write("list.cjs", LIST), call("bash", { command: COMMAND }), say("抓好了")] : []),
    });
    fs.mkdirSync(workDir, { recursive: true });
    seedProject(td.daemon, "AI 简报站", { state: "in_use", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: true, network: true } });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(Object.fromEntries([CHANNELS.cards, CHANNELS.inbox, CHANNELS.projects, PM1].map((c) => [c, 0])));

    await frontend.sendText("补抓一下今天的源", { conversation: PM1 });
    const bashCall = await eventually(
      () => [messagesOf(frontend, PM1).flatMap((m) => m.message.parts.filter((p): p is ToolCallPart => p.type === "tool_call" && p.tool === "bash"))],
      (calls) => calls.length === 1 && calls[0]!.outcome !== undefined,
      "bash 那次调用的记录",
    );
    expect(bashCall.map((p) => [p.disposition, p.blockedBy ?? null, p.outcome, p.categoryTitles])).toEqual([["do", null, "done", []]]);
    expect(cardsOf(frontend).filter((c) => c.type === "approval")).toEqual([]);

    // 照常执行：日志追加在 logs/2026-10-19.log，候选写在工作目录的 .ergo-tmp 里
    expect(fs.readFileSync(path.join(workDir, "logs", "2026-10-19.log"), "utf8")).toContain("=== fetch run");
    expect(fs.readFileSync(path.join(workDir, ".ergo-tmp", "cand.txt"), "utf8")).toContain("S16\tcandidate");
    expect(fs.readFileSync(path.join(workDir, ".ergo-tmp", ".gitignore"), "utf8")).toContain("*");
  }, 90_000);
});
