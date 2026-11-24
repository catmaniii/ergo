// ergo local-pairing [off]（469）：看、关"本机来的也要配对"。被关在外面时的退路（这台电脑上的浏览器都没配对、已配对的设备不在手边）：
// 在这台电脑上运行（一台电脑上有多份二狗时在那一份的文件夹里运行），关掉这一份的这项设置。打开只在网页上开（设置 · 设备配对），
// 那里正在用的浏览器会自动配上对，不会把自己关在外面。
// - 不带参数：看现在开没开（读这一份的配置文件）；
// - off：二狗在跑就带着本机程序的令牌请它关（PUT /api/local-pairing，马上生效、写进配置）；连不上（没在跑）就直接改这一份的配置文件
//   （下次起来就是关着的）；请它关被拒了（令牌对不上：比如二狗是没有这项设置的旧版本）也改配置文件，说一句要重启才生效。
// 守卫把它当服务管家的命令挡着（guard/shell/programs.ts 的 ERGO_OPS）：agent 不能替用户跑，和停二狗同一级别。
// 退出码：0 做完了（或者只是看）；1 没做成；2 用法不对。
import { HTTP_PATHS, type HttpErrorBody, LOCAL_PAIRING_OFF_COMMAND, type LocalPairingResult, t } from "@ergo/protocol";
import { readPairingConfig, writePairingConfig } from "../config/config.ts";
import { dataDirLayout } from "../config/data-dir.ts";
import { type CliContext, daemonUrl, localTokenHeaders } from "./context.ts";

/** 等二狗回话最多多久 */
const TIMEOUT_MS = 15_000;

export const LOCAL_PAIRING_EXIT = { ok: 0, failed: 1, usage: 2 } as const;


export async function cmdLocalPairing(ctx: CliContext, sub: string | undefined): Promise<number> {
  const { configFile } = dataDirLayout(ctx.dataDir);
  if (sub === undefined || sub === "status") {
    let on: boolean;
    try {
      on = readPairingConfig(configFile).localRequestsNeedPairing;
    } catch (err) {
      ctx.io.err(t("cli.localPairing.badConfig", { reason: err instanceof Error ? err.message : String(err) }));
      return LOCAL_PAIRING_EXIT.failed;
    }
    ctx.io.out(on ? t("cli.localPairing.isOn", { command: LOCAL_PAIRING_OFF_COMMAND }) : t("cli.localPairing.isOff"));
    return LOCAL_PAIRING_EXIT.ok;
  }
  if (sub === "on") {
    ctx.io.err(t("cli.localPairing.onInWeb"));
    return LOCAL_PAIRING_EXIT.usage;
  }
  if (sub !== "off") {
    ctx.io.err(t("cli.localPairing.usage"));
    return LOCAL_PAIRING_EXIT.usage;
  }

  // 二狗在跑：请它关（马上生效，它自己写配置）
  const url = new URL(HTTP_PATHS.localPairing, daemonUrl(ctx));
  let response: Response | undefined;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers: { ...localTokenHeaders(ctx), "content-type": "application/json" },
      body: JSON.stringify({ on: false }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    response = undefined;
  }
  if (response?.ok) {
    const result = (await response.json().catch(() => undefined)) as LocalPairingResult | undefined;
    if (result?.on === false) {
      ctx.io.out(t("cli.localPairing.offNow", { url: daemonUrl(ctx) }));
      return LOCAL_PAIRING_EXIT.ok;
    }
  }
  // 没在跑、被拒了：直接改这一份的配置文件
  let wasOn: boolean | undefined;
  try {
    wasOn = readPairingConfig(configFile).localRequestsNeedPairing;
  } catch {
    // 这一节写坏了：照样改掉（写坏了二狗会拒绝启动）
    wasOn = undefined;
  }
  if (response === undefined && wasOn === false) {
    ctx.io.out(t("cli.localPairing.alreadyOff"));
    return LOCAL_PAIRING_EXIT.ok;
  }
  try {
    writePairingConfig(configFile, { localRequestsNeedPairing: false });
  } catch (err) {
    ctx.io.err(t("cli.localPairing.writeFailed", { file: configFile, reason: err instanceof Error ? err.message : String(err) }));
    return LOCAL_PAIRING_EXIT.failed;
  }
  if (response === undefined) {
    ctx.io.out(t("cli.localPairing.offWritten", { file: configFile }));
    return LOCAL_PAIRING_EXIT.ok;
  }
  ctx.io.out(t("cli.localPairing.offRestart", { file: configFile, reason: await refusalOf(response) }));
  return LOCAL_PAIRING_EXIT.ok;
}

/** 二狗回的错误说法（不是二狗回的 JSON 就写状态码） */
async function refusalOf(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    return (JSON.parse(text) as HttpErrorBody).message;
  } catch {
    return `HTTP ${response.status}`;
  }
}
