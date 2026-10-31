// 模拟器联调用的临时守护进程（349 号票）：用 packages/daemon 主切面的测试底座起，数据目录、主目录都是临时的，端口由系统挑（不占 8810、8811），
// 秘书接假模型（按剧本回话），不连真的模型、不碰真的二狗。stdout 第一行打 JSON（两个端口），收到 stdin 的 stop 或 stdin 关掉时停掉并删临时目录。
// 只给 frontend/android/e2e/ 下的脚本用。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPendingCards } from "../../../packages/daemon/src/cards/views.ts";
import { startTestDaemon } from "../../../packages/daemon/test/helpers/daemon.ts";
import { removeDir } from "../../../packages/daemon/test/helpers/temp-dir.ts";

const WEB_ROOT = fileURLToPath(new URL("../../../packages/web/dist/", import.meta.url));

/** 秘书的剧本：够用很多轮，每轮回一句（e2e 看网页收到了回话） */
const SCRIPT = Array.from({ length: 200 }, () => ({ kind: "reply", text: "好的，这是假模型的回话。" }) as const);

/** 服务管家的数据目录也是临时的、端口连不上：绝不碰真的服务管家 */
const lsmDir = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-android-e2e-lsm-"));

const td = await startTestDaemon({
  stopOnTestFinished: false,
  webRoot: path.resolve(WEB_ROOT),
  secretary: [...SCRIPT],
  // 组件都算装好了（实际接的是测试底座的假识别）：网页上才有按住说话；什么都不下载
  components: { probes: { gpu: () => "none", detect: () => undefined, provided: () => "e2e" } },
  env: { DEEPSEEK_API_KEY: undefined, ERGO_SVC_PORT: "1", LSM_DATA_DIR: lsmDir },
});

console.log(JSON.stringify({ local: td.url, external: td.externalUrl, dataDir: td.dataDir }));

// 批准收到的配对请求（和用户在电脑上点批准走同一张卡片）；测试底座的 TestFrontend 只能在 vitest 里用，这里直接调卡片服务
async function approve(): Promise<void> {
  const card = listPendingCards(td.daemon.store.reader, ["pairing"])[0];
  if (!card) {
    console.log(JSON.stringify({ approved: false }));
    return;
  }
  await td.daemon.cards.act({ cardId: card.id, action: "approve", expectedVersion: card.version, idempotencyKey: randomUUID() });
  console.log(JSON.stringify({ approved: card.id }));
}

/** 后面的阶段要用：让二狗发一条消息、提醒这类，由 e2e 经 stdin 叫 */
const COMMANDS: Record<string, () => Promise<void>> = { approve };

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await td.daemon.stop();
  for (const dir of [...(td.tempDirs ?? []), lsmDir]) removeDir(dir);
  process.exit(0);
}

process.stdin.on("data", (chunk) => {
  for (const line of String(chunk).split("\n")) {
    const command = line.trim();
    if (command === "stop") void stop();
    else if (COMMANDS[command]) void COMMANDS[command]();
  }
});
process.stdin.on("end", () => void stop());
