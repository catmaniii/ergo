// 鸿蒙 App（62 号票）：签名材料只在本机，不进仓库（整个仓库都查）；构建脚本找得到 DevEco、从模板生成本机的 build-profile.json5，
// WebView 调试默认关。
// 真正构建要装 DevEco（`npm run build:harmony`），不在这里跑。
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  BUILD_PROFILE,
  BUILD_PROFILE_TEMPLATE,
  devEcoToolsAt,
  ensureBuildProfile,
  findDevEco,
  HARMONY_DIR,
  hvigorArgs,
  parseBuildArgs,
  SIGNING_FILE_EXTENSIONS,
  signingMaterialIn,
} from "../scripts/harmony.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" });
}

/** 整个仓库里会进 git 的文件：已经跟踪的，加上没跟踪、也没被忽略的（git add 会带上） */
function filesThatWouldBeCommitted(): string[] {
  return git("ls-files", "--cached", "--others", "--exclude-standard").split("\n").filter(Boolean);
}

/** 按内容查的文本文件 */
const TEXT_FILE = /\.(json5?|ets|tsx?|[cm]?js|md|txt|ya?ml|properties|html)$/i;

/** 检查器自己：里面有签名材料的样子（认材料用的扩展名、编的签名样本），不按内容查 */
const CHECKER_FILES = new Set(["frontend/scripts/harmony.ts", "frontend/test/harmony.test.ts"]);

/** DevEco 点了"自动生成签名"之后 build-profile.json5 里的样子（路径、口令都是编的） */
const SIGNED_PROFILE = `{
  "app": {
    "signingConfigs": [
      {
        "name": "default",
        "type": "HarmonyOS",
        "material": {
          "certpath": "C:\\\\Users\\\\someone\\\\.ohos\\\\config\\\\default_ergou_x.cer",
          "keyAlias": "debugKey",
          "keyPassword": "0000001A2B3C",
          "profile": "C:\\\\Users\\\\someone\\\\.ohos\\\\config\\\\default_ergou_x.p7b",
          "signAlg": "SHA256withECDSA",
          "storeFile": "C:\\\\Users\\\\someone\\\\.ohos\\\\config\\\\default_ergou_x.p12",
          "storePassword": "0000001A4D5E"
        }
      }
    ],
    "products": [{ "name": "default", "signingConfig": "default" }]
  }
}`;

describe("认出签名材料", () => {
  test("DevEco 自动生成签名后的 build-profile.json5：认出来", () => {
    const found = signingMaterialIn(SIGNED_PROFILE);
    expect(found).toEqual(
      expect.arrayContaining([
        "signingConfigs 不是空的",
        "有 storePassword 字段",
        "有 keyPassword 字段",
        "有 storeFile 字段",
        "有 certpath 字段",
        "有指向 .p12 文件的路径",
        "有指向 .p7b 文件的路径",
        "有指向 .cer 文件的路径",
      ]),
    );
  });

  test("不含签名的模板：干净（说明签名的注释不算）", () => {
    const template = readFileSync(path.join(HARMONY_DIR, BUILD_PROFILE_TEMPLATE), "utf8");
    expect(template).toMatch(/"signingConfigs":\s*\[\]/);
    expect(signingMaterialIn(template)).toEqual([]);
  });
});

describe("签名材料不进仓库", () => {
  test("整个仓库里会进 git 的文件都不带签名材料，也没有证书、描述文件、密钥库、证书请求", () => {
    const files = filesThatWouldBeCommitted();
    expect(files).toContain(`frontend/harmony/${BUILD_PROFILE_TEMPLATE}`);
    expect(files).toContain("package.json");
    const offenders: string[] = [];
    for (const file of files) {
      if (SIGNING_FILE_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext))) {
        offenders.push(`${file}：签名材料文件`);
        continue;
      }
      if (file === `frontend/harmony/${BUILD_PROFILE}`) offenders.push(`${file}：本机的 build-profile.json5 不该进仓库`);
      if (CHECKER_FILES.has(file) || !TEXT_FILE.test(file)) continue;
      for (const finding of signingMaterialIn(readFileSync(path.join(REPO, file), "utf8"))) offenders.push(`${file}：${finding}`);
    }
    expect(offenders).toEqual([]);
  });

  test.each([
    `frontend/harmony/${BUILD_PROFILE}`,
    "frontend/harmony/oh_modules/x",
    "frontend/harmony/build/x",
    "frontend/harmony/entry/build/x",
    "frontend/harmony/.hvigor/x",
    "frontend/harmony/.idea/x",
    "frontend/harmony/local.properties",
    "frontend/harmony/sign/default.p12",
    "release.p12",
    "packages/daemon/x.p7b",
    "docs/x.cer",
    "deploy/x.csr",
  ])("%s 被 .gitignore 忽略", (file) => {
    const ignored = spawnSync("git", ["check-ignore", "-q", "--no-index", file], { cwd: REPO });
    expect(ignored.status).toBe(0);
  });
});

describe("构建参数", () => {
  const tools = devEcoToolsAt("D:\\DevEco", "win32");

  test("默认 WebView 调试关着（-p webviewDebug=false 交给 entry/hvigorfile.ts）", () => {
    expect(parseBuildArgs([])).toEqual({ webviewDebug: false });
    expect(hvigorArgs(tools, { webviewDebug: false })).toEqual(expect.arrayContaining(["-p", "webviewDebug=false", "assembleHap"]));
  });

  test("显式加 --webview-debug 才开", () => {
    expect(parseBuildArgs(["--webview-debug"])).toEqual({ webviewDebug: true });
    expect(hvigorArgs(tools, { webviewDebug: true })).toContain("webviewDebug=true");
  });

  test("不认识的参数（比如拼错了）报错，不悄悄当成没开", () => {
    expect(parseBuildArgs(["--webview-debgu"])).toEqual({ error: expect.stringContaining("--webview-debgu") });
  });
});

describe("从模板生成本机的 build-profile.json5", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("还没有：照模板生成", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ergou-harmony-"));
    writeFileSync(path.join(dir, BUILD_PROFILE_TEMPLATE), '{ "app": { "signingConfigs": [] } }');
    expect(ensureBuildProfile(dir)).toBe("created");
    expect(readFileSync(path.join(dir, BUILD_PROFILE), "utf8")).toBe('{ "app": { "signingConfigs": [] } }');
  });

  test("已经有了（DevEco 写进了签名）：不动", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ergou-harmony-"));
    writeFileSync(path.join(dir, BUILD_PROFILE_TEMPLATE), '{ "app": { "signingConfigs": [] } }');
    writeFileSync(path.join(dir, BUILD_PROFILE), SIGNED_PROFILE);
    expect(ensureBuildProfile(dir)).toBe("kept");
    expect(readFileSync(path.join(dir, BUILD_PROFILE), "utf8")).toBe(SIGNED_PROFILE);
  });
});

/** DevEco 装在 home：它的 Node 和 hvigor 都在 */
function installed(home: string, platform: NodeJS.Platform): Set<string> {
  const tools = devEcoToolsAt(home, platform);
  return new Set([tools.node, tools.hvigorw]);
}

describe("找 DevEco Studio", () => {
  test("设了 DEVECO_HOME：用它；Node、hvigor、SDK 都在它下面", () => {
    const home = "E:\\Tools\\DevEco Studio";
    const files = installed(home, "win32");
    const tools = findDevEco({ DEVECO_HOME: home }, "win32", (f) => files.has(f));
    expect(tools).toEqual({
      home,
      node: "E:\\Tools\\DevEco Studio\\tools\\node\\node.exe",
      hvigorw: "E:\\Tools\\DevEco Studio\\tools\\hvigor\\bin\\hvigorw.js",
      sdk: "E:\\Tools\\DevEco Studio\\sdk",
      pathDirs: ["E:\\Tools\\DevEco Studio\\tools\\node", "E:\\Tools\\DevEco Studio\\tools\\ohpm\\bin"],
    });
  });

  test("没设：在默认安装位置找", () => {
    const files = installed("C:\\Program Files\\Huawei\\DevEco Studio", "win32");
    const tools = findDevEco({}, "win32", (f) => files.has(f));
    expect(tools).toMatchObject({ home: "C:\\Program Files\\Huawei\\DevEco Studio" });
  });

  test("macOS：Node 在 tools/node/bin 下", () => {
    const home = "/Applications/DevEco-Studio.app/Contents";
    const files = installed(home, "darwin");
    expect(findDevEco({}, "darwin", (f) => files.has(f))).toMatchObject({ node: "/Applications/DevEco-Studio.app/Contents/tools/node/bin/node" });
  });

  test("哪儿都没有：说清楚看过哪些位置、怎么办", () => {
    const result = findDevEco({ DEVECO_HOME: "E:\\nowhere" }, "win32", () => false);
    expect(result).toEqual({ error: expect.stringContaining("E:\\nowhere") });
    expect(result).toEqual({ error: expect.stringContaining("DEVECO_HOME") });
  });
});
