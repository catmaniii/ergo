// 首次设置向导（319 号票，用户 2026-10-27 定："只做网页前端，不做终端 ergo onboard"）的页面：地址 #/more/setup，
// 在设置列表最上面（pages/MorePage.tsx），第一次用二狗的时候从首页顶上那条引导条点过来。
// - 五步（共享协议包的 SETUP_STEPS）：① 语言 / 称呼 / 助手名 ② 模型 Key ③ 组件（记忆的向量模型）④ 手机配对 ⑤ 安全默认值说明；
//   左边（手机上是一排）一列步骤，做完的打勾、当前的突出，一屏只显示一步（setupScreenOf 算现在显示哪一屏）；
// - 每步都有"以后再说"（POST skip: true）和"这一步就这样"（POST skip: false）；第⑤步是"看过了"；
//   打完标记用守护进程回的那份整份（useSetup 换掉 view），接着显示下一步（setupStepAfter）；
// - 第⑥屏"外网访问"这一版只放说明和三种方式的地址（Tailscale 推荐 / 自建 Headscale / VPS 隧道），不做自动配置、没有假按钮；
// - 五步都做完（含"以后再说"）显示"设置完了，去用它吧"和一个回到会话页的按钮；
// - 任何时候都能出去接着用（标题栏上的"先不弄了"）。
// 每步的内容尽量复用现有的页：称呼就是设置 · 身份里的那一块（more/UserNameSetting.tsx），安全默认值就是关注类别上面那两个开关
// （more/SafetySwitches.tsx 的 SafetySwitchList），组件走设置 · 组件那一套接口（ComponentsPage 的 componentStateText、sizeLabel），
// 模型 Key 那一步先选服务商（DeepSeek / 自定义 OpenAI 兼容，填完能测连通），再直接填 key（两块和设置 · 模型共用
// ui/model-provider.tsx 和 ui/model-key.tsx，POST /api/model-settings 和 /api/model-settings/key），
// 语言、助手名、手机配对给去设置对应页的跳转。
// 界面上不出现"秘书""待我处理"：说到二狗这个人一律用用户起的名字（ui/assistant-name.tsx）。
import { useEffect, useState } from "react";
import { toHash } from "../app/route-hash.ts";
import type { Navigate } from "../app/route.ts";
import { pageSetupBanner, useSetup, useSetupBannerDismissed } from "../app/page-setup.ts";
import { type SetupScreen, setupDoneCount, setupScreenOf, setupStep, setupStepAfter } from "../app/setup.ts";
import { useStore } from "../app/store.tsx";
import {
  activeLocale,
  COMPONENT_FEATURES,
  componentBusy,
  type ComponentsView,
  type ComponentView,
  SETUP_STEPS,
  type SetupStepId,
  type SetupStepView,
  type SetupView,
  sizeLabel,
  t,
  type ModelSettingsView,
} from "../state/index.ts";
import { NameTag, useAssistantName } from "../ui/assistant-name.tsx";
import { Section, TopBar } from "../ui/common.tsx";
import { T } from "../ui/i18n.tsx";
import { ModelKeySetting } from "../ui/model-key.tsx";
import { ModelProviderSetting } from "../ui/model-provider.tsx";
import { useToast } from "../ui/toast.tsx";
import { componentStateText } from "./more/ComponentsPage.tsx";
import { SafetySwitches } from "./more/SafetySwitches.tsx";
import { UserNameSetting } from "./more/UserNameSetting.tsx";

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 一步的名字（左边那一排、这一步的标题都用它） */
const stepTitle = (id: SetupStepId) => t(`setup.steps.${id}.title`);

/**
 * 左边（手机上是一排）的步骤：做完的打勾、当前的突出；点了能回头看那一步，最后一项是"外网访问"那一屏。
 * 纯渲染（view、现在哪一屏、点了怎么办都由外面给），测试在 Node 里直接渲染
 */
export function SetupRail({ view, screen, onPick }: { view: SetupView; screen: SetupScreen; onPick(at: SetupStepId | "external"): void }) {
  const current = screen.kind === "step" ? screen.id : screen.kind === "external" ? "external" : undefined;
  return (
    <ol className="setup-rail" aria-label={t("setup.rail.label")}>
      {SETUP_STEPS.map((id, i) => {
        const done = setupStep(view, id)?.done ?? false;
        return (
          <li key={id}>
            <button type="button" className={`setup-rail-item${done ? " done" : ""}${current === id ? " on" : ""}`} data-step={id} aria-current={current === id ? "step" : undefined} onClick={() => onPick(id)}>
              <span className="setup-rail-mark" aria-hidden="true">
                {done ? "✓" : i + 1}
              </span>
              <span className="setup-rail-text">{stepTitle(id)}</span>
            </button>
          </li>
        );
      })}
      <li>
        <button
          type="button"
          className={`setup-rail-item setup-rail-extra${current === "external" ? " on" : ""}`}
          data-step="external"
          aria-current={current === "external" ? "step" : undefined}
          onClick={() => onPick("external")}
        >
          <span className="setup-rail-mark" aria-hidden="true">
            →
          </span>
          <span className="setup-rail-text">{t("setup.rail.external")}</span>
        </button>
      </li>
    </ol>
  );
}

/**
 * 一屏的底下一排："以后再说"（skip: true）和"这一步就这样"（skip: false；安全默认值那一步是"看过了"）。
 * 纯渲染：点哪个交给 onMark，打标记的时候两个都点不了
 */
export function SetupActions({ step, busy, onMark }: { step: SetupStepView; busy: boolean; onMark(choice: "skip" | "done"): void }) {
  return (
    <div className="setup-actions">
      <button type="button" className="btn ghost" disabled={busy} onClick={() => onMark("skip")}>
        {t("setup.step.skip")}
      </button>
      <button type="button" className="btn primary" disabled={busy} onClick={() => onMark("done")}>
        {t(step.id === "safety" ? "setup.step.doneSafety" : "setup.step.done")}
      </button>
    </div>
  );
}

/** 设置完了那一屏：一句"设置完了，去用它吧"、回到会话页的按钮，再加一句去外网访问那一屏的说明（名字由外面取好，纯渲染） */
export function SetupDone({ name, onFinish, onExternal }: { name: string; onFinish(): void; onExternal(): void }) {
  return (
    <div className="setup-done">
      <h3>{t("setup.done.title")}</h3>
      <p className="muted">{t("setup.done.sub")}</p>
      <div className="setup-actions">
        <button type="button" className="btn primary" onClick={onFinish}>
          <T k="setup.done.go" params={{ name: <NameTag name={name} /> }} />
        </button>
        <button type="button" className="btn ghost" onClick={onExternal}>
          {t("setup.done.external")}
        </button>
      </div>
    </div>
  );
}

/** 语言、称呼、助手名（第①步）：现在用的语言、我的名字那一块、助手名字，后面两个给去设置对应页的跳转 */
function LanguageStep({ navigate }: { navigate: Navigate }) {
  const name = useAssistantName();
  return (
    <>
      <div className="setup-line">
        <span className="setup-line-key">{t("setup.steps.language.language")}</span>
        <span>{activeLocale().meta.nativeName}</span>
        <button type="button" className="link" onClick={() => navigate({ tab: "more", page: "language" })}>
          {t("setup.steps.language.languageGo")}
        </button>
      </div>
      <UserNameSetting />
      <div className="setup-line">
        <span className="setup-line-key">{t("setup.steps.language.assistantName")}</span>
        <NameTag name={name} />
        <button type="button" className="link" onClick={() => navigate({ tab: "more", page: "roles" })}>
          {t("setup.steps.language.rolesGo")}
        </button>
      </div>
      <div className="setup-note">{t("setup.steps.language.assistantNameNote")}</div>
    </>
  );
}

/**
 * 模型 Key（第②步）：先选服务商——DeepSeek，或者自定义（OpenAI 兼容）服务商（填接口地址、模型 id、接口类型，能测连通），
 * 再填它的 key。两块都和设置 · 模型共用（ui/model-provider.tsx、ui/model-key.tsx），保存后不用重启。
 * 服务商的名字、key 存进哪个文件都得照守护进程给的那份（GET /api/model-settings），所以这一步先取它，取到了才画
 */
function ModelStep({ navigate }: { navigate: Navigate }) {
  const { http } = useStore();
  const [view, setView] = useState<ModelSettingsView>();
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    let live = true;
    http.modelSettings().then(
      (next) => {
        if (live) setView(next);
      },
      (err: unknown) => {
        if (live) setFailed(messageOf(err));
      },
    );
    return () => {
      live = false;
    };
  }, [http]);

  const provider = view === undefined ? undefined : (view.providers.find((p) => p.id === view.settings.provider)?.label ?? view.settings.provider);
  return (
    <>
      {view === undefined && failed === undefined && <div className="muted">{t("ui.modelProvider.loading")}</div>}
      {failed !== undefined && (
        <div className="field-error" role="alert">
          {t("ui.modelProvider.loadFailed", { reason: failed })}
        </div>
      )}
      {view !== undefined && (
        <>
          <ModelProviderSetting view={view} onSaved={setView} />
          <ModelKeySetting provider={provider} apiKey={view.apiKey} onSaved={(apiKey) => setView((now) => (now === undefined ? now : { ...now, apiKey }))} />
        </>
      )}
      <div className="setup-note">{t("setup.steps.model.where")}</div>
      <div>
        <button type="button" className="link" onClick={() => navigate({ tab: "more", page: "models" })}>
          {t("setup.steps.model.go")}
        </button>
      </div>
    </>
  );
}

/** 组件（第③步）：记忆的向量模型那一个，装没装、多大，一个按钮装上（设置 · 组件那一套接口） */
function ComponentsStep({ navigate }: { navigate: Navigate }) {
  const { http } = useStore();
  const [view, setView] = useState<ComponentsView>();
  const [failed, setFailed] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    http.components().then(
      (next) => {
        if (live) setView(next);
      },
      (err: unknown) => {
        if (live) setFailed(messageOf(err));
      },
    );
    return () => {
      live = false;
    };
  }, [http]);

  // 按"它打开哪个功能"认，不写死组件 id（清单里的 id 换了也照样找得到）
  const vector: ComponentView | undefined = view?.components.find((c) => c.enables.some((f) => f.id === COMPONENT_FEATURES.memorySemantic));
  const run = (action: "install" | "update" | "resume") => {
    if (!vector) return;
    setBusy(true);
    setFailed(undefined);
    http
      .componentAction(vector.id, action)
      .then(setView, (err: unknown) => setFailed(t("setup.steps.components.failed", { reason: messageOf(err) })))
      .finally(() => setBusy(false));
  };
  const installable = vector !== undefined && vector.cannotInstall === undefined && ["missing", "failed", "paused", "provided", "update"].includes(vector.state);

  return (
    <>
      {vector === undefined && failed === undefined && <div className="muted">{t("setup.steps.components.working")}</div>}
      {vector === undefined && failed !== undefined && (
        <div className="field-error" role="alert">
          {failed}
        </div>
      )}
      {view !== undefined && vector === undefined && <div className="muted">{t("setup.steps.components.unknown")}</div>}
      {vector !== undefined && (
        <div className="setup-component">
          <div className="setup-line">
            <span>{vector.title}</span>
            <span className={vector.state === "installed" ? "chip chip-ok" : "chip"}>{componentStateText(vector.state)}</span>
            {vector.size > 0 && <span className="muted">{sizeLabel(vector.size)}</span>}
          </div>
          {vector.summary && <div className="muted">{vector.summary}</div>}
          {vector.cannotInstall !== undefined && <div className="setup-note">{vector.cannotInstall}</div>}
          {installable && (
            <div className="setup-actions">
              <button type="button" className="btn primary small" disabled={busy} onClick={() => run(vector.state === "paused" || vector.state === "failed" ? "resume" : vector.state === "update" ? "update" : "install")}>
                {componentBusy(vector.state) ? t("setup.steps.components.working") : t("setup.steps.components.install")}
              </button>
            </div>
          )}
        </div>
      )}
      {failed !== undefined && vector !== undefined && (
        <div className="field-error" role="alert">
          {failed}
        </div>
      )}
      <div>
        <button type="button" className="link" onClick={() => navigate({ tab: "more", page: "components" })}>
          {t("setup.steps.components.go")}
        </button>
      </div>
    </>
  );
}

/** 手机配对（第④步）：配对没配对过看守护进程给的那一步满不满足，怎么做写在说明里，入口去设置 · 已配对设备 */
function PhoneStep({ step, navigate }: { step: SetupStepView; navigate: Navigate }) {
  return (
    <>
      <div className="setup-line">
        <span className="setup-line-key">{t("setup.steps.phone.title")}</span>
        <span className={`chip ${step.ready ? "chip-ok" : ""}`}>{t(step.ready ? "setup.steps.phone.ready" : "setup.steps.phone.notReady")}</span>
      </div>
      <p className="setup-note">{t("setup.steps.phone.sub")}</p>
      <p className="setup-note">{t("setup.steps.phone.how")}</p>
      <div>
        <button type="button" className="link" onClick={() => navigate({ tab: "more", page: "devices" })}>
          {t("setup.steps.phone.go")}
        </button>
      </div>
    </>
  );
}

/** 安全默认值（第⑤步）：关注类别上面那两个开关（设置里同一块），看完点"看过了"才算做完 */
function SafetyStep() {
  return (
    <>
      <p className="setup-note">{t("setup.steps.safety.sub")}</p>
      <SafetySwitches />
    </>
  );
}

/** 一屏的正文（按步分）：第①②④⑤步不要 view 里别的东西，第③步自己去取组件 */
function StepBody({ id, step, navigate }: { id: SetupStepId; step: SetupStepView; navigate: Navigate }) {
  switch (id) {
    case "language":
      return <LanguageStep navigate={navigate} />;
    case "model":
      return <ModelStep navigate={navigate} />;
    case "components":
      return <ComponentsStep navigate={navigate} />;
    case "phone":
      return <PhoneStep step={step} navigate={navigate} />;
    case "safety":
      return <SafetyStep />;
  }
  return null;
}

/** 外网访问（最后一屏）：三种方式的地址，只说明、不自动配置 */
export function SetupExternal() {
  return (
    <Section title={t("setup.external.title")}>
      <p className="setup-note">{t("setup.external.intro", { brand: t("shell.brand") })}</p>
      <p className="setup-note setup-warn">{t("setup.external.port")}</p>
      {(["tailscale", "headscale", "vps"] as const).map((way) => (
        <div key={way} className="setup-way" data-way={way}>
          <b>{t(`setup.external.${way}.title`)}</b>
          <p className="setup-note">{t(`setup.external.${way}.sub`)}</p>
          <code className="setup-address">{t(`setup.external.${way}.address`)}</code>
        </div>
      ))}
      <p className="setup-note">{t("setup.external.guide")}</p>
    </Section>
  );
}

/**
 * 向导本体：取状态、现在哪一屏、点了哪个步骤、打标记。演示页里 useSetup 给的是假状态，一样能点着走。
 * 一屏只显示一步：上面是那一排步骤，中间是这一步，底下是"以后再说""这一步就这样"
 */
export function SetupWizard({ navigate }: { navigate: Navigate }) {
  const { view, error, mark } = useSetup();
  const name = useAssistantName();
  const toast = useToast();
  const [at, setAt] = useState<SetupStepId | "external" | undefined>();
  const [busy, setBusy] = useState(false);

  if (view === undefined) return <div className="muted">{error !== undefined ? t("setup.loadFailed", { reason: error }) : t("setup.loading")}</div>;

  const screen = setupScreenOf(view, at);
  const step = screen.kind === "step" ? setupStep(view, screen.id) : undefined;
  const markStep = (id: SetupStepId, choice: "skip" | "done") => {
    const skip = choice === "skip";
    setBusy(true);
    void mark(id, skip)
      .then((next) => {
        if (next === undefined) return;
        // 接着显示它的下一步；后面都做完了回到"第一个还没做完的"，五步全做完就是"设置完了"
        setAt(setupStepAfter(next, id)?.id);
        toast(t(skip ? "setup.mark.skipped" : "setup.mark.done"));
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="setup-page">
      <div className="setup-intro muted">{t("setup.sub", { brand: t("shell.brand") })}</div>
      <div className="setup-progress muted">{t("setup.progress", { done: setupDoneCount(view), total: SETUP_STEPS.length })}</div>
      <SetupRail view={view} screen={screen} onPick={setAt} />
      {screen.kind === "done" && <SetupDone name={name} onFinish={() => navigate({ tab: "secretary" })} onExternal={() => setAt("external")} />}
      {screen.kind === "external" && (
        <>
          <SetupExternal />
          <div className="setup-actions">
            <button type="button" className="btn ghost" onClick={() => setAt(undefined)}>
              {t("setup.external.back")}
            </button>
          </div>
        </>
      )}
      {step !== undefined && (
        <>
          <Section title={stepTitle(step.id)}>
            <div className="setup-step-sub muted">{t(`setup.steps.${step.id}.sub`)}</div>
            <StepBody id={step.id} step={step} navigate={navigate} />
          </Section>
          {error !== undefined && (
            <div className="field-error" role="alert">
              {t("setup.failed", { reason: error })}
            </div>
          )}
          <SetupActions step={step} busy={busy} onMark={(choice) => markStep(step.id, choice)} />
        </>
      )}
    </div>
  );
}

/** 设置 · 设置向导这一页（#/more/setup）：标题栏上有它自己的"先不弄了"（任何时候都能出去接着用） */
export function SetupPage({ title, onBack, navigate }: { title: string; onBack: (() => void) | undefined; navigate: Navigate }) {
  return (
    <div className="chat-col">
      <TopBar title={title} onBack={onBack}>
        <button type="button" className="btn ghost small" onClick={() => navigate({ tab: "secretary" })}>
          {t("setup.exit")}
        </button>
      </TopBar>
      <div className="scroll page-pad">
        <SetupWizard navigate={navigate} />
      </div>
    </div>
  );
}

/**
 * 首页（会话页）顶上那条引导条（319 号票）：还没把五步走完时在顶上提示一句，
 * 点了去设置 · 设置向导，右上的 × 关掉、记在这台设备上（app/setup.ts 的 SETUP_BANNER_KEY），以后不再出现。
 * 由 App.tsx 画（演示页不画）。取不到状态（守护进程没连上）时什么都不显示
 */
export function SetupBanner() {
  const { view, error } = useSetup();
  const dismissed = useSetupBannerDismissed();
  if (dismissed || view === undefined || view.complete || error !== undefined) return null;
  return (
    <div className="setup-banner" role="status">
      <a className="link setup-banner-text" href={toHash({ tab: "more", page: "setup" })}>
        <T k="setup.banner.text" params={{ brand: t("shell.brand") }} />
      </a>
      <button type="button" className="icon-btn setup-banner-close" aria-label={t("setup.banner.close")} onClick={() => pageSetupBanner().dismiss()}>
        ×
      </button>
    </div>
  );
}
