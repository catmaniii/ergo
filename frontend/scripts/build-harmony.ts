// `npm run build:harmony`（62 号票）：用 DevEco Studio 自带的 hvigor 构建鸿蒙 App，产出 HAP。
// 依赖本机装的 DevEco（DEVECO_HOME，或默认安装位置），所以不进 `npm run check`。
// 本机没配签名时产出 unsigned 的 HAP，并提示怎么签；签名材料只在本机（docs/developer-guide.md"鸿蒙 App"）。
// WebView 调试默认关，`npm run build:harmony -- --webview-debug` 才开（开着的 App 接上 USB 就能被取走设备凭证）。
// 134 号票：先把页面桥（packages/web/src/page-bridge，注入"浏览"里的网页的脚本）打包进 App 的 rawfile/page-bridge.js。
// 175 号票：App 原生的字（共享协议包 locales/<语言>/harmony.json）收进 rawfile/harmony-texts.json。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildPageBridge } from "../../packages/web/build/page-bridge.ts";
import {
  BUILD_PROFILE,
  BUILD_PROFILE_TEMPLATE,
  ensureBuildProfile,
  findDevEco,
  HARMONY_DIR,
  HARMONY_TEXTS_FILE,
  harmonyTexts,
  hapOutputs,
  hvigorArgs,
  LOCALES_DIR,
  parseBuildArgs,
} from "./harmony.ts";

const options = parseBuildArgs(process.argv.slice(2));
if ("error" in options) {
  console.error(options.error);
  process.exit(1);
}

const tools = findDevEco(process.env, process.platform);
if ("error" in tools) {
  console.error(tools.error);
  process.exit(1);
}

if (ensureBuildProfile(HARMONY_DIR) === "created") {
  console.log(`照 ${BUILD_PROFILE_TEMPLATE} 生成了 frontend/harmony/${BUILD_PROFILE}（本机用，不进仓库）`);
}

// 页面桥：每次构建现打包（不进仓库）
const rawfileDir = path.join(HARMONY_DIR, "entry", "src", "main", "resources", "rawfile");
mkdirSync(rawfileDir, { recursive: true });
const pageBridge = await buildPageBridge();
writeFileSync(path.join(rawfileDir, "page-bridge.js"), pageBridge);
console.log(`页面桥：entry/src/main/resources/rawfile/page-bridge.js（${(pageBridge.length / 1024).toFixed(1)} KB）`);

// App 原生的字（175 号票）：自带语言的 harmony.json 收成一份（不进仓库）；二狗的网页交来当前语言之前 App 按系统语言挑一种
const texts = harmonyTexts(LOCALES_DIR);
writeFileSync(path.join(rawfileDir, HARMONY_TEXTS_FILE), JSON.stringify(texts));
console.log(`App 原生的字：entry/src/main/resources/rawfile/${HARMONY_TEXTS_FILE}（${Object.keys(texts).join("、")}）`);

const env = {
  ...process.env,
  DEVECO_SDK_HOME: tools.sdk,
  NODE_HOME: path.dirname(tools.node),
  PATH: [...tools.pathDirs, process.env.PATH ?? ""].join(path.delimiter),
};
if (options.webviewDebug) {
  console.warn("注意：这次构建打开了 WebView 调试。装了这个包的手机接上 USB，任何能跑 hdc 的人都能经 DevTools 看到页面、取走设备凭证 cookie；调试完换回不带 --webview-debug 构建的包。");
}
console.log(`hvigor（${tools.home}）：assembleHap${options.webviewDebug ? "（WebView 调试：开）" : ""}`);
const run = spawnSync(tools.node, hvigorArgs(tools, options), { cwd: HARMONY_DIR, env, stdio: "inherit" });
if (run.error) {
  console.error(`跑不起来 hvigor：${run.error.message}`);
  process.exit(1);
}
if (run.status !== 0) {
  console.error(`hvigor 失败，退出码 ${run.status}`);
  process.exit(run.status ?? 1);
}

const outputs = hapOutputs(HARMONY_DIR);
const describe = (file: string) => `${file}（${(statSync(file).size / 1024).toFixed(1)} KB）`;
if (existsSync(outputs.signed)) {
  console.log(`\n已签名的 HAP：${describe(outputs.signed)}`);
  console.log("装到手机或模拟器：hdc install -r <上面的路径>；启动：hdc shell aa start -a EntryAbility -b com.example.ergou");
} else if (existsSync(outputs.unsigned)) {
  console.log(`\n未签名的 HAP：${describe(outputs.unsigned)}`);
  console.log(
    [
      "装不上未签名的 HAP。签名只要做一次：",
      "  1. 手机打开开发者模式和 USB 调试，用 USB 连上电脑（DevEco 把这台手机登记进调试用的描述文件）；",
      "  2. DevEco Studio 打开 frontend/harmony，File → Project Structure → Project → Signing Configs，登录华为账号，勾上 Automatically generate signature，确定；",
      "  3. 再跑一次 npm run build:harmony，就会产出 entry-default-signed.hap。",
      "签名材料只写进本机的 frontend/harmony/build-profile.json5（不进仓库）和用户目录下的 .ohos/config。详见 docs/developer-guide.md 的\"鸿蒙 App\"。",
    ].join("\n"),
  );
} else {
  console.error(`hvigor 说成功了，但没找到 HAP（${path.dirname(outputs.unsigned)}）`);
  process.exit(1);
}
