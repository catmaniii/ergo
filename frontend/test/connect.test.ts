// 扫码连接：鸿蒙和安卓的地址校验、连不上的判断、报错文案一致。
// - connect-vectors.tsv 是同一份例子：这里跑鸿蒙的 .ets（去掉类型直接跑）和协议包，安卓的 ConnectCheckTest 在 JVM 上跑；
// - qr-samples.tsv：网页生成的二维码方阵（qrcode-generator），这里核对它和现在生成的一样，安卓的 ConnectCheckTest 用真的 ZXing 解一遍比对内容；
// - 两边用到的 harmony.connect.* 文案键一样，中英都有；
// - 测试入口只有 --webview-debug 的包才有；只加了 ZXing 的最小包。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";
import { describe, expect, test } from "vitest";
import { checkAppAddress } from "../../packages/protocol/src/connection-addresses.ts";
import { HTTP_PATHS } from "../../packages/protocol/src/http.ts";
import { qrMatrix } from "../../packages/web/src/util/qr.ts";
import { harmonyTexts, LOCALES_DIR } from "../scripts/harmony.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ETS = path.join(HERE, "..", "harmony", "entry", "src", "main", "ets");
const KT = path.join(HERE, "..", "android", "app", "src", "main", "java", "com", "catmaniii", "ergo");
const read = (file: string) => readFileSync(file, "utf8").replaceAll("\r\n", "\n");

const vectors = read(path.join(HERE, "connect-vectors.tsv"))
  .split("\n")
  .filter((line) => line.length > 0 && !line.startsWith("#"))
  .map((line) => line.split("\t"));
const of = (kind: string) => vectors.filter((row) => row[0] === kind);

/** 把 .ets 去掉类型跑起来：imports 换成 stubs 里给的，exports 收进返回值 */
async function loadEts(file: string, stubs: Record<string, unknown>, names: readonly string[]): Promise<Record<string, (...args: never[]) => unknown>> {
  const source = read(path.join(ETS, file)).replace(/^import .*$/gm, "");
  const { code } = await transformWithOxc(source, "file.ts");
  const body = code.replace(/^export /gm, "");
  return new Function(...Object.keys(stubs), `${body}\nreturn { ${names.join(", ")} };`)(...Object.values(stubs)) as Record<string, (...args: never[]) => unknown>;
}

const PROBLEM_KEY: Record<string, string> = {
  empty: "harmony.address.empty",
  malformed: "harmony.address.malformed",
  noHost: "harmony.address.noHost",
  credentials: "harmony.address.credentials",
  httpsOnly: "harmony.address.httpsOnly",
};

describe("鸿蒙和协议包：地址校验和同一份例子对得上（安卓在 ConnectCheckTest）", () => {
  test("鸿蒙的 checkServerAddress", async () => {
    const stubs = { url: { URL: { parseURL: (text: string) => new URL(text) } }, t: (key: string) => key };
    const { checkServerAddress } = await loadEts("common/ServerAddress.ets", stubs, ["checkServerAddress"]);
    const check = checkServerAddress as unknown as (text: string) => { address?: unknown; error: string };
    const actual = of("address").map(([, input]) => {
      const checked = check(input!);
      return [input, checked.address === undefined ? checked.error : "ok"];
    });
    expect(actual).toEqual(of("address").map(([, input, expected]) => [input, expected]));
  });

  test("协议包的 checkAppAddress（电脑上二维码放什么、手填的先过它）", () => {
    const actual = of("address").map(([, input]) => {
      const checked = checkAppAddress(input!);
      return [input, checked.ok ? "ok" : PROBLEM_KEY[checked.problem]];
    });
    expect(actual).toEqual(of("address").map(([, input, expected]) => [input, expected]));
  });
});

describe("鸿蒙：连不上的判断和同一份例子对得上", () => {
  const names = ["classifyConnectError", "isErgoAccess", "isTailnetHost", "connectChecklist"] as const;
  const load = async () => (await loadEts("common/ConnectCheck.ets", {}, names)) as unknown as {
    classifyConnectError(code: number): string;
    isErgoAccess(status: number, body: string): boolean;
    isTailnetHost(host: string): boolean;
    connectChecklist(host: string): string[];
  };

  test("看不看得出是 tailnet、提醒检查的先后、对面是不是二狗", async () => {
    const m = await load();
    expect(of("tailnet").map(([, host]) => [host, String(m.isTailnetHost(host!))])).toEqual(of("tailnet").map(([, host, expected]) => [host, expected]));
    expect(of("checks").map(([, host]) => [host, m.connectChecklist(host!).join(",")])).toEqual(of("checks").map(([, host, expected]) => [host, expected]));
    expect(of("access").map(([, status, body]) => [status, body, String(m.isErgoAccess(Number(status), body!))])).toEqual(of("access").map(([, status, body, expected]) => [status, body, expected]));
  });

  test("错误码归类：解析不了、超时、证书、连不上、别的", async () => {
    const m = await load();
    expect(m.classifyConnectError(2300006)).toBe("dns");
    expect(m.classifyConnectError(2300028)).toBe("timeout");
    expect(m.classifyConnectError(2300060)).toBe("cert");
    expect(m.classifyConnectError(2300035)).toBe("cert");
    expect(m.classifyConnectError(2300007)).toBe("refused");
    expect(m.classifyConnectError(2300052)).toBe("notErgo");
    expect(m.classifyConnectError(1)).toBe("other");
  });
});

describe("两边的文案键一样", () => {
  const texts = harmonyTexts(LOCALES_DIR);
  const REASONS = ["dns", "timeout", "cert", "refused", "notErgo", "other"];
  const CHECKS = ["tailnet", "computer", "remote"];

  test("连不上的每种原因、每条提醒中英都有，错误文案里说的超时和代码一样是 10 秒", () => {
    for (const lang of ["zh-CN", "en"]) {
      expect(REASONS.filter((key) => !texts[lang]![`harmony.connect.reason.${key}`])).toEqual([]);
      expect(CHECKS.filter((key) => !texts[lang]![`harmony.connect.check.${key}`])).toEqual([]);
      expect(texts[lang]!["harmony.connect.reason.timeout"]).toContain("10");
    }
    expect(read(path.join(KT, "common/ConnectProbe.kt"))).toContain("TIMEOUT_MS = 10_000");
    expect(read(path.join(ETS, "common/ConnectProbe.ets"))).toContain("TIMEOUT_MS = 10000");
  });

  test("提醒的三条：Tailscale 和 tailnet；二狗和服务管家；VPS、隧道、反代", () => {
    const zh = texts["zh-CN"]!;
    expect(zh["harmony.connect.check.tailnet"]).toMatch(/Tailscale.*tailnet/);
    expect(zh["harmony.connect.check.computer"]).toMatch(/二狗.*服务管家/);
    expect(zh["harmony.connect.check.remote"]).toMatch(/VPS.*隧道.*反代/);
  });

  test("两边代码用的 harmony.connect.*、harmony.address.scan* 是同一批", () => {
    const keysIn = (text: string) => new Set(text.match(/harmony\.(?:connect|address\.scan)[A-Za-z.]*[A-Za-z]/g) ?? []);
    const android = keysIn(read(path.join(KT, "MainActivity.kt")) + read(path.join(KT, "ui/NativePages.kt")));
    const harmony = keysIn(read(path.join(ETS, "pages/Index.ets")));
    expect([...harmony].toSorted()).toEqual([...android].toSorted());
    expect(harmony.size).toBeGreaterThan(8);
  });

  test("确认对面是二狗问的接口和网关的一样（不需要凭证）", () => {
    expect(HTTP_PATHS.access).toBe("/api/access");
    expect(read(path.join(KT, "common/ConnectProbe.kt"))).toContain(`ACCESS_PATH = "${HTTP_PATHS.access}"`);
    expect(read(path.join(ETS, "common/ConnectProbe.ets"))).toContain(`ACCESS_PATH = '${HTTP_PATHS.access}'`);
  });

  test("界面文字不写内部词", () => {
    for (const lang of ["zh-CN", "en"]) {
      const connect = Object.entries(texts[lang]!).filter(([key]) => key.startsWith("harmony.connect.") || key.startsWith("harmony.scan."));
      expect(connect.length).toBeGreaterThan(10);
      expect(connect.filter(([, text]) => /秘书|待我处理|负责人/.test(text))).toEqual([]);
    }
  });
});

describe("安全边界", () => {
  test("喂二维码的测试入口只有 --webview-debug 的包才有：别的应用不能塞一个地址进来", () => {
    const main = read(path.join(KT, "MainActivity.kt"));
    expect(main).toContain("if (!BuildConfig.WEBVIEW_DEBUG || intent == null) return");
    const entry = read(path.join(ETS, "entryability/EntryAbility.ets"));
    expect(/function takeTestScan[\s\S]*?if \(!BuildProfile\.WEBVIEW_DEBUG\) \{\s*return;/.test(entry)).toBe(true);
  });

  test("安卓只加了 ZXing 的最小包（core），没有带界面的那些；相机权限不强求设备有相机", () => {
    const gradle = read(path.join(HERE, "..", "android", "app", "build.gradle.kts"));
    expect(gradle.match(/zxing[^"]*/g)).toEqual(["zxing:core:3.5.3"]);
    expect(gradle).not.toContain("journeyapps");
    const manifest = read(path.join(HERE, "..", "android", "app", "src", "main", "AndroidManifest.xml"));
    expect(manifest).toContain("android.permission.CAMERA");
    expect(manifest).toContain('android:name="android.hardware.camera" android:required="false"');
  });

  test("鸿蒙用系统的扫码界面，不要相机权限", () => {
    expect(read(path.join(ETS, "pages/Index.ets"))).toContain("scanBarcode.startScanForResult");
    expect(read(path.join(HERE, "..", "harmony", "entry", "src", "main", "module.json5"))).not.toContain("ohos.permission.CAMERA");
  });
});

describe("二维码样本（给安卓的 ZXing 解）", () => {
  const FILE = path.join(HERE, "qr-samples.tsv");
  const URLS = ["https://ergo.example.com/", "https://ergo.tail1234.ts.net/", "https://frp.example.com:8443/some/path?x=1", "http://127.0.0.1:18811/"];
  const rowsOf = (url: string) => qrMatrix(url).map((row) => row.map((dark) => (dark ? "1" : "0")).join("")).join(",");

  test("样本和现在网页生成的一样（库升级了跑一次 UPDATE_QR_SAMPLES=1 重新生成）", () => {
    const want = `${URLS.map((url) => `${url}\t${rowsOf(url)}`).join("\n")}\n`;
    if (process.env.UPDATE_QR_SAMPLES === "1" || !existsSync(FILE)) writeFileSync(FILE, want);
    expect(read(FILE)).toBe(want);
  });
});
