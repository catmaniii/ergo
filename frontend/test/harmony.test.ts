// 鸿蒙 App（62 号票）：签名材料只在本机，不进仓库（整个仓库都查）；构建脚本找得到 DevEco、从模板生成本机的 build-profile.json5，
// WebView 调试默认关。
// 真正构建要装 DevEco（`npm run build:harmony`），不在这里跑。
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";
import { afterEach, describe, expect, test } from "vitest";
import {
  BUILD_PROFILE,
  BUILD_PROFILE_TEMPLATE,
  devEcoToolsAt,
  ensureBuildProfile,
  findDevEco,
  HARMONY_DIR,
  harmonyTexts,
  hvigorArgs,
  LOCALES_DIR,
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
          "certpath": "C:\\\\Users\\\\someone\\\\.ohos\\\\config\\\\default_ergo_x.cer",
          "keyAlias": "debugKey",
          "keyPassword": "0000001A2B3C",
          "profile": "C:\\\\Users\\\\someone\\\\.ohos\\\\config\\\\default_ergo_x.p7b",
          "signAlg": "SHA256withECDSA",
          "storeFile": "C:\\\\Users\\\\someone\\\\.ohos\\\\config\\\\default_ergo_x.p12",
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
    dir = mkdtempSync(path.join(tmpdir(), "ergo-harmony-"));
    writeFileSync(path.join(dir, BUILD_PROFILE_TEMPLATE), '{ "app": { "signingConfigs": [] } }');
    expect(ensureBuildProfile(dir)).toBe("created");
    expect(readFileSync(path.join(dir, BUILD_PROFILE), "utf8")).toBe('{ "app": { "signingConfigs": [] } }');
  });

  test("已经有了（DevEco 写进了签名）：不动", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ergo-harmony-"));
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

describe("App 原生的字（175 号票）", () => {
  test("自带的每种语言的 harmony.json 收成一份：中文、英文都有，key 一样，只有 harmony.*", () => {
    const texts = harmonyTexts(LOCALES_DIR);
    expect(Object.keys(texts)).toEqual(expect.arrayContaining(["zh-CN", "en"]));
    expect(texts["zh-CN"]!["harmony.address.heading"]).toBe("填二狗的地址");
    expect(texts.en!["harmony.address.heading"]).toBe("Enter Ergo's address");
    expect(Object.keys(texts.en!).toSorted()).toEqual(Object.keys(texts["zh-CN"]!).toSorted());
    for (const messages of Object.values(texts)) expect(Object.keys(messages).every((k) => k.startsWith("harmony."))).toBe(true);
  });

  test("没有 harmony.json 的语言目录跳过，别的区域的 key、不是字符串的不收", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ergo-harmony-texts-"));
    try {
      mkdirSync(path.join(dir, "fr"));
      writeFileSync(path.join(dir, "fr", "harmony.json"), '﻿{"harmony.index.retry":"Réessayer","shell.nav.x":"y","harmony.n":1}');
      mkdirSync(path.join(dir, "de"));
      expect(harmonyTexts(dir)).toEqual({ fr: { "harmony.index.retry": "Réessayer" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("原生桥开着 setTexts，网页认的也是这个名字；生成的 rawfile 不进仓库", () => {
    const bridge = readFileSync(path.join(HARMONY_DIR, "entry/src/main/ets/bridge/NativeBridge.ets"), "utf8");
    expect(/NATIVE_BRIDGE_METHODS: string\[\] = \[[^\]]*'setTexts'/.test(bridge)).toBe(true);
    const web = readFileSync(path.join(REPO, "packages/web/src/app/native-app.ts"), "utf8");
    expect(web).toContain('"setTexts"');
    const ignored = spawnSync("git", ["check-ignore", "-q", "frontend/harmony/entry/src/main/resources/rawfile/harmony-texts.json"], { cwd: REPO });
    expect(ignored.status).toBe(0);
  });
});

/**
 * phone/ 下某个文件里不引用别的东西的函数，单拿出来去掉类型跑（304 号票在模拟器上核对出来的 PhoneData.ets 的 birthdayOf、localDayStart；
 * 308 号票 PhoneGeocode.ets 的 addressOf、nearestIndex）
 */
async function phoneFunction<T>(file: string, name: string): Promise<T> {
  const source = readFileSync(path.join(HARMONY_DIR, `entry/src/main/ets/phone/${file}`), "utf8");
  const text = new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n\\}\\r?\\n`).exec(source)?.[0];
  if (!text) throw new Error(`${file} 里没有 function ${name}`);
  const { code } = await transformWithOxc(text, `${name}.ts`);
  return new Function(`${code}\nreturn ${name};`)() as T;
}
const phoneDataFunction = <T,>(name: string) => phoneFunction<T>("PhoneData.ets", name);

describe("读本机（299、300 号票）", () => {
  test("原生桥开着读本机这一组方法（只给主界面），名字和网页一侧 NATIVE_PHONE_METHODS 一样；只要读全部日历的权限，不要通讯录权限", () => {
    const bridge = readFileSync(path.join(HARMONY_DIR, "entry/src/main/ets/bridge/NativeBridge.ets"), "utf8");
    const main = /NATIVE_BRIDGE_METHODS: string\[\] = \[([^\]]*)\]/.exec(bridge)![1]!;
    const side = /NATIVE_SIDE_BRIDGE_METHODS: string\[\] = \[([^\]]*)\]/.exec(bridge)![1]!;
    const web = readFileSync(path.join(REPO, "packages/web/src/app/native-phone.ts"), "utf8");
    const names = /NATIVE_PHONE_METHODS = \[([^\]]*)\]/.exec(web)![1]!.match(/"[A-Za-z]+"/g)!.map((n) => n.slice(1, -1));
    expect(names).toEqual(["phoneContactsPick", "phoneCalendarState", "phoneCalendarPrepare", "phoneCalendarRead"]);
    for (const name of names) {
      expect(main).toContain(`'${name}'`);
      expect(side).not.toContain(`'${name}'`);
      expect(bridge).toContain(`  ${name}(`);
    }
    const module = readFileSync(path.join(HARMONY_DIR, "entry/src/main/module.json5"), "utf8");
    expect(module).toContain('"ohos.permission.READ_WHOLE_CALENDAR"');
    expect(module).not.toContain("READ_CONTACTS");
  });

  test("300 号票：照片、位置两组方法（只给主界面）名字和网页一侧一样；权限是读相册、读照片位置、定位、长时任务，后台定位走位置类的长时任务", () => {
    const bridge = readFileSync(path.join(HARMONY_DIR, "entry/src/main/ets/bridge/NativeBridge.ets"), "utf8");
    const main = /NATIVE_BRIDGE_METHODS: string\[\] = \[([^\]]*)\]/.exec(bridge)![1]!;
    const side = /NATIVE_SIDE_BRIDGE_METHODS: string\[\] = \[([^\]]*)\]/.exec(bridge)![1]!;
    const web = readFileSync(path.join(REPO, "packages/web/src/app/native-phone.ts"), "utf8");
    const group = (name: string) => new RegExp(`${name} = \\[([^\\]]*)\\]`).exec(web)![1]!.match(/"[A-Za-z]+"/g)!.map((n) => n.slice(1, -1));
    expect(group("NATIVE_PHONE_PHOTOS_METHODS")).toEqual(["phonePhotosState", "phonePhotosPrepare", "phonePhotosRead"]);
    expect(group("NATIVE_PHONE_LOCATION_METHODS")).toEqual(["phoneLocationState", "phoneLocationPrepare", "phoneLocationRecord", "phoneLocationRead", "phoneLocationAck"]);
    for (const name of [...group("NATIVE_PHONE_PHOTOS_METHODS"), ...group("NATIVE_PHONE_LOCATION_METHODS")]) {
      expect(main).toContain(`'${name}'`);
      expect(side).not.toContain(`'${name}'`);
      expect(bridge).toContain(`  ${name}(`);
    }
    const module = readFileSync(path.join(HARMONY_DIR, "entry/src/main/module.json5"), "utf8");
    for (const permission of ["READ_IMAGEVIDEO", "MEDIA_LOCATION", "APPROXIMATELY_LOCATION", "LOCATION", "KEEP_BACKGROUND_RUNNING"]) expect(module).toContain(`"ohos.permission.${permission}"`);
    expect(module).not.toContain("LOCATION_IN_BACKGROUND");
    expect(module).toMatch(/"backgroundModes": \[\s*"location"\s*\]/);
    // 读照片位置、定位的授权说明两种语言都有
    for (const lang of ["base", "en_US"]) {
      const strings = readFileSync(path.join(HARMONY_DIR, `entry/src/main/resources/${lang}/element/string.json`), "utf8");
      for (const name of ["photos_reason", "photo_location_reason", "location_reason"]) expect(strings).toContain(`"${name}"`);
    }
    // 系统的位置开关关着时报 switchOff（网页写明记不到），开关打开时重新订（304 号票在模拟器上碰到：模拟器默认关着）
    const location = readFileSync(path.join(HARMONY_DIR, "entry/src/main/ets/phone/PhoneLocation.ets"), "utf8");
    expect(location).toContain("geoLocationManager.isLocationEnabled()");
    expect(location).toContain("geoLocationManager.on('locationEnabledChange'");
    expect(location).toMatch(/state\.switchOff = !locationEnabled\(\)/);
    // 用户划掉长时任务的通知（系统停了长时任务）：回到只在 App 开着时记
    expect(location).toContain("backgroundTaskManager.on('continuousTaskCancel'");
    expect(location).toContain("this.settings.setLocationRecording(true, false);");
  });

  test("生日按系统通讯录的写法认：labelName 是生日的、没写 labelName 的认 1，不认 SDK 常量 3（那是周年纪念），农历生日不要", async () => {
    const birthdayOf = await phoneDataFunction<(events: { eventDate?: string; labelName?: string; labelId?: number }[] | undefined) => string | undefined>("birthdayOf");
    // 模拟器上通讯录界面里建的一个人原样交回来的（生日 1、周年纪念 3、农历生日 2）
    expect(
      birthdayOf([
        { eventDate: "2025-09-25", labelName: "生日", labelId: 1 },
        { eventDate: "2025-10-25", labelName: "周年纪念", labelId: 3 },
        { eventDate: "2025-11-05", labelName: "农历生日", labelId: 2 },
      ]),
    ).toBe("2025-09-25");
    expect(birthdayOf([{ eventDate: "2025-10-25", labelName: "周年纪念", labelId: 3 }])).toBeUndefined();
    expect(birthdayOf([{ eventDate: "2025-11-05", labelName: "农历生日", labelId: 2 }])).toBeUndefined();
    expect(birthdayOf([{ eventDate: " 1990-03-14 ", labelName: "Birthday", labelId: 7 }])).toBe("1990-03-14");
    expect(birthdayOf([{ eventDate: "2001-07-21", labelId: 1 }])).toBe("2001-07-21");
    expect(birthdayOf([{ eventDate: "2001-07-21", labelId: 3 }])).toBeUndefined();
    expect(birthdayOf([{ eventDate: "", labelName: "生日", labelId: 1 }])).toBeUndefined();
    expect(birthdayOf(undefined)).toBeUndefined();
  });

  test("308 号票：常去的地方那一组（只给主界面）名字和网页一侧一样；照片、位置读出来时转地名，状态里报 geocoder；不加权限", () => {
    const bridge = readFileSync(path.join(HARMONY_DIR, "entry/src/main/ets/bridge/NativeBridge.ets"), "utf8");
    const main = /NATIVE_BRIDGE_METHODS: string\[\] = \[([^\]]*)\]/.exec(bridge)![1]!;
    const side = /NATIVE_SIDE_BRIDGE_METHODS: string\[\] = \[([^\]]*)\]/.exec(bridge)![1]!;
    const web = readFileSync(path.join(REPO, "packages/web/src/app/native-phone.ts"), "utf8");
    const names = /NATIVE_PHONE_PLACE_METHODS = \[([^\]]*)\]/.exec(web)![1]!.match(/"[A-Za-z]+"/g)!.map((n) => n.slice(1, -1));
    expect(names).toEqual(["phonePlaceHere", "phonePlaceFind"]);
    for (const name of names) {
      expect(main).toContain(`'${name}'`);
      expect(side).not.toContain(`'${name}'`);
      expect(bridge).toContain(`  ${name}(`);
    }
    const geocode = readFileSync(path.join(HARMONY_DIR, "entry/src/main/ets/phone/PhoneGeocode.ets"), "utf8");
    expect(geocode).toContain("geoLocationManager.getAddressesFromLocation(request)");
    expect(geocode).toContain("geoLocationManager.isGeocoderAvailable()");
    for (const file of ["PhonePhotos.ets", "PhoneLocation.ets"]) expect(readFileSync(path.join(HARMONY_DIR, `entry/src/main/ets/phone/${file}`), "utf8")).toContain("this.geocoder.addressesOf(spots)");
    expect(readFileSync(path.join(HARMONY_DIR, "entry/src/main/ets/phone/PhoneLocation.ets"), "utf8")).toContain("state.geocoder = this.geocoder.usable();");
  });

  test("308 号票：系统给的地址取城市、区县、街道或地标（每段最多 30 个字，一段都没有是 undefined）；缓存里 200 米以内最近的那一处", async () => {
    const addressOf = await phoneFunction<(geo: Record<string, unknown>) => Record<string, string> | undefined>("PhoneGeocode.ets", "addressOf");
    expect(addressOf({ administrativeArea: "浙江省", subAdministrativeArea: "杭州市", locality: "杭州市", subLocality: "西湖区", roadName: "北山街", premises: "84号", placeName: "浙江省杭州市西湖区北山街84号" })).toEqual({
      city: "杭州市",
      district: "西湖区",
      spot: "北山街",
    });
    expect(addressOf({ administrativeArea: "北京市", subLocality: "朝阳区", premises: " 望京  SOHO " })).toEqual({ city: "北京市", district: "朝阳区", spot: "望京 SOHO" });
    expect(addressOf({ locality: "杭州市", descriptions: ["西湖文化广场"] })).toEqual({ city: "杭州市", spot: "西湖文化广场" });
    // 只给省市区县和详细地址的（模拟器上看到的那几样）：详细地址去掉开头的国家省市区县当街道或地标
    expect(addressOf({ countryName: "中国", administrativeArea: "浙江省", subAdministrativeArea: "杭州市", locality: "杭州市", subLocality: "西湖区", placeName: "中国浙江省杭州市西湖区 北山街道断桥残雪" })).toEqual({
      city: "杭州市",
      district: "西湖区",
      spot: "北山街道断桥残雪",
    });
    expect(addressOf({ administrativeArea: "台湾省", locality: "苗栗县", subLocality: "西湖乡", placeName: "台湾省苗栗县西湖乡" })).toEqual({ city: "苗栗县", district: "西湖乡" });
    expect(addressOf({ roadName: "路".repeat(40) })?.spot).toHaveLength(30);
    expect(addressOf({ countryName: "中国" })).toBeUndefined();
    const nearestIndex = await phoneFunction<(cache: Array<{ lat: number; lon: number }>, lat: number, lon: number, maxM: number) => number>("PhoneGeocode.ets", "nearestIndex");
    const cache = [
      { lat: 30.28, lon: 120.1 },
      { lat: 30.259, lon: 120.13 },
      { lat: 30.2595, lon: 120.13 },
    ];
    expect(nearestIndex(cache, 30.2801, 120.1001, 200)).toBe(0);
    expect(nearestIndex(cache, 30.2596, 120.13, 200)).toBe(2);
    expect(nearestIndex(cache, 30.27, 120.115, 200)).toBe(-1);
    expect(nearestIndex([], 30.28, 120.1, 200)).toBe(-1);
  });

  test("全天日程系统按 UTC 零点存，换成本机那一天的零点；不是 UTC 零点的原样不动", async () => {
    const localDayStart = await phoneDataFunction<(ms: number) => number>("localDayStart");
    expect(localDayStart(Date.UTC(2026, 9, 29))).toBe(new Date(2026, 9, 29).getTime());
    expect(localDayStart(Date.UTC(2026, 10, 5))).toBe(new Date(2026, 10, 5).getTime());
    const timed = Date.UTC(2026, 9, 28, 11, 30);
    expect(localDayStart(timed)).toBe(timed);
  });
});

/**
 * 包名只有一个：二狗的鸿蒙 App 是 com.catmaniii.ergo（2026-10-30 定）。早年的占位名、另一次没落地的名字
 * 都不许再出现在代码、工程、文档、脚本里——包名在 AGC 建完就改不了，写错一处就是让人照着敲错的命令装不上。
 */
test("包名只认 com.catmaniii.ergo：仓库里（除了调研笔记）不许再出现旧包名", () => {
  // 旧名字在这里拼出来：不然这条用例自己就是一处"出现"
  const stale = [["com", "example", "ergou"].join("."), ["io", "github", "catmaniii", "ergo"].join(".")];
  const bad = filesThatWouldBeCommitted()
    .filter((f) => TEXT_FILE.test(f) && !f.startsWith("docs/research/"))
    .filter((f) => {
      const content = readFileSync(path.join(REPO, f), "utf8");
      return stale.some((name) => content.includes(name));
    });
  expect(bad).toEqual([]);
  expect(readFileSync(path.join(HARMONY_DIR, "AppScope", "app.json5"), "utf8")).toContain('"bundleName": "com.catmaniii.ergo"');
});
