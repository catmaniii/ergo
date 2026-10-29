// 首次设置向导（319 号票）网页那一半的纯逻辑（app/setup.ts）：现在该显示哪一步、打完一步接着显示哪一步、
// 做完了几步、点了某个步骤显示哪一屏、演示页的假状态、点"以后再说 / 这一步就这样"发出去的那一份请求体、
// 首页那条引导条关掉后记在哪台设备的哪个键上。页面本身见 test/pages/setup-wizard.test.ts，i18n 见 npm run i18n:check。
import { describe, expect, test } from "vitest";
import { navItemOf, parseHash, toHash } from "../../src/app/route-hash.ts";
import {
  demoMarked,
  demoSetupView,
  SETUP_BANNER_KEY,
  setupBannerSettingIn,
  setupCurrentStep,
  setupDoneCount,
  setupMarkBody,
  setupScreenOf,
  setupStep,
  setupStepAfter,
} from "../../src/app/setup.ts";
import { SETUP_STEPS, type SetupStepId, type SetupView } from "../../src/state/index.ts";

/** 一份五步的状态：done、ready 写哪几步 */
function view(done: readonly SetupStepId[] = [], ready: readonly SetupStepId[] = []): SetupView {
  const steps = SETUP_STEPS.map((id) => ({ id, done: done.includes(id), ready: ready.includes(id), optional: true }));
  return { steps, complete: steps.every((step) => step.done) };
}

/** 假的 localStorage */
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

describe("现在该走哪一步、做完了几步", () => {
  test("五步的顺序就是协议包里的那个（语言、模型、组件、手机、安全）", () => {
    expect([...SETUP_STEPS]).toEqual(["language", "model", "components", "phone", "safety"]);
    expect(view().steps.map((step) => step.id)).toEqual([...SETUP_STEPS]);
  });

  test("做完了几步：含点了'以后再说'的（它们 done 也是 true）", () => {
    expect(setupDoneCount(view())).toBe(0);
    expect(setupDoneCount(view(["language", "model"]))).toBe(2);
    expect(setupDoneCount(view([...SETUP_STEPS]))).toBe(5);
  });

  test("现在该显示第一个还没做完的；五步都做完是 undefined（页面写\"设置完了\"）", () => {
    expect(setupCurrentStep(view())?.id).toBe("language");
    expect(setupCurrentStep(view(["language"]))?.id).toBe("model");
    // 中间跳着做完了也算：找的是第一个没做完的
    expect(setupCurrentStep(view(["language", "components"]))?.id).toBe("model");
    expect(setupCurrentStep(view([...SETUP_STEPS]))).toBeUndefined();
  });

  test("打标记之前先认得出是哪一步：不认得的 id 是 undefined", () => {
    expect(setupStep(view(), "phone")?.id).toBe("phone");
    expect(setupStep(view(), "nonsense" as SetupStepId)).toBeUndefined();
  });
});

describe("打完这一步接着显示哪一步", () => {
  test("从它的下一步起往后找第一个还没做完的", () => {
    expect(setupStepAfter(view(), "language")?.id).toBe("model");
    expect(setupStepAfter(view(["components"]), "language")?.id).toBe("model");
    expect(setupStepAfter(view(["model"]), "language")?.id).toBe("components");
  });

  test("后面都做完了是 undefined（页面回到第一个还没做完的；都完了就是\"设置完了\"）", () => {
    expect(setupStepAfter(view(["model", "components", "phone", "safety"]), "language")).toBeUndefined();
    expect(setupStepAfter(view([...SETUP_STEPS]), "safety")).toBeUndefined();
  });

  test("打标记之前的那一步（不认得的 id）也算不出来", () => {
    expect(setupStepAfter(view(), "nonsense" as SetupStepId)).toBeUndefined();
  });
});

describe("现在显示哪一屏", () => {
  test("没点过：第一个还没做完的那一步；五步都做完是\"设置完了\"", () => {
    expect(setupScreenOf(view(), undefined)).toEqual({ kind: "step", id: "language" });
    expect(setupScreenOf(view(["language"]), undefined)).toEqual({ kind: "step", id: "model" });
    expect(setupScreenOf(view([...SETUP_STEPS]), undefined)).toEqual({ kind: "done" });
  });

  test("点了某一步就显示那一步，做完的也能点回去看", () => {
    expect(setupScreenOf(view(["language"]), "language")).toEqual({ kind: "step", id: "language" });
    expect(setupScreenOf(view(), "safety")).toEqual({ kind: "step", id: "safety" });
  });

  test("点的是\"外网访问\"就是那一屏；点的是不认得的 id 回到默认那一屏", () => {
    expect(setupScreenOf(view(), "external")).toEqual({ kind: "external" });
    expect(setupScreenOf(view(["language"]), "nonsense" as SetupStepId)).toEqual({ kind: "step", id: "model" });
  });
});

describe("演示页（没有守护进程）", () => {
  test("假状态：五步都还没做、一个条件都不满足、没全做完", () => {
    const demo = demoSetupView();
    expect(demo.steps.map((step) => step.id)).toEqual([...SETUP_STEPS]);
    expect(demo.steps.every((step) => !step.done && !step.ready)).toBe(true);
    expect(demo.complete).toBe(false);
    expect(setupScreenOf(demo, undefined)).toEqual({ kind: "step", id: "language" });
  });

  test("演示页里点一下：那一步算做完（不请求网络），五步都点完了就是设置完了", () => {
    let demo = demoSetupView();
    for (const id of SETUP_STEPS) demo = demoMarked(demo, id);
    expect(demo.complete).toBe(true);
    expect(setupScreenOf(demo, undefined)).toEqual({ kind: "done" });
    // 只点一步：下一步是模型，别的还没做
    const once = demoMarked(demoSetupView(), "language");
    expect(setupDoneCount(once)).toBe(1);
    expect(setupScreenOf(once, undefined)).toEqual({ kind: "step", id: "model" });
  });
});

describe("点\"以后再说\"和\"这一步就这样\"发出去的那一份", () => {
  test("以后再说是 skip: true；这一步就这样是 skip: false（守护进程当\"看过了 / 做完了\"）", () => {
    expect(setupMarkBody("model", true)).toEqual({ step: "model", skip: true });
    expect(setupMarkBody("model", false)).toEqual({ step: "model", skip: false });
    expect(setupMarkBody("safety", false)).toEqual({ step: "safety", skip: false });
  });
});

describe("首页那条引导条关掉了没有（这台设备）", () => {
  test("键名带 setup 前缀；没关过是 false，关掉之后一直是 true（下次打开也是）", () => {
    expect(SETUP_BANNER_KEY).toBe("ergo-setup-banner-dismissed");
    const storage = memoryStorage();
    const setting = setupBannerSettingIn(() => storage);
    expect(setting.dismissed()).toBe(false);

    let notified = 0;
    setting.subscribe(() => notified++);
    setting.dismiss();
    expect(setting.dismissed()).toBe(true);
    expect(notified).toBe(1);
    expect(storage.items.get(SETUP_BANNER_KEY)).toBe("1");
    // 下次打开：还是关着的
    expect(setupBannerSettingIn(() => storage).dismissed()).toBe(true);
    // 再点一次不重复通知
    setting.dismiss();
    expect(notified).toBe(1);
  });

  test("存储用不了（隐私模式、禁用了站点数据）：读不出按没关过，关掉这次打开里照样收起、不报错", () => {
    const setting = setupBannerSettingIn(() => {
      throw new Error("SecurityError");
    });
    expect(setting.dismissed()).toBe(false);
    expect(() => setting.dismiss()).not.toThrow();
    expect(setting.dismissed()).toBe(true);
  });

  test("退订之后不再通知", () => {
    const setting = setupBannerSettingIn(() => memoryStorage());
    let notified = 0;
    const off = setting.subscribe(() => notified++);
    off();
    setting.dismiss();
    expect(notified).toBe(0);
  });
});

describe("入口的地址", () => {
  test("设置向导是设置下面的一页：#/more/setup，拆得开、拼得回，属于主导航的设置", () => {
    expect(parseHash("#/more/setup")).toEqual({ tab: "more", page: "setup" });
    expect(toHash({ tab: "more", page: "setup" })).toBe("#/more/setup");
    expect(navItemOf({ tab: "more", page: "setup" })).toBe("settings");
  });
});
