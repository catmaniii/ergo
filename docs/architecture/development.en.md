[中文](development.md) | **English**

# Development

Setting up, running commands and tests, submitting changes. For how the system is built see [System architecture](README.en.md); for plugins see the [plugin guide](plugin-development.md) (in Chinese).

If an AI coding assistant is doing the work, have it read `AGENTS.md` and then follow `.claude/skills/ergo-dev/SKILL.md` (for plugins, `.claude/skills/ergo-plugin/SKILL.md`).

How to submit changes: [CONTRIBUTING](../../CONTRIBUTING.md). Each section below covers one thing:

- [Prerequisites](#prerequisites)
- [Running from source](#running-from-source)
- [Common commands](#common-commands)
- [Phone apps](#phone-apps)
- [Coding conventions](#coding-conventions)
- [Testing](#testing)
- [Upgrading pi](#upgrading-pi)
- [Docs, CHANGELOG, decision records](#docs-changelog-decision-records)

## Prerequisites

- **Windows 10 / 11.** Job objects, directory junctions, Windows Sandbox and scheduled tasks exist only on Windows; tests relying on them are skipped elsewhere, and the daemon refuses to start elsewhere.
- **Node 22** (≥ 22.19). **The Node major version follows pi** ([ADR-0031](adr/0031-node-version-follows-pi.md)): whatever major version pi's CI and installer use is what ergo packages, runs and tests on; when pi upgrades we follow, otherwise we stay. Sources are TypeScript run directly via Node's type stripping; the daemon has no build step.
- **Git for Windows (Git Bash)**: pi's `bash` tool and a number of integration tests need it. `where bash` should list `C:\Program Files\Git\bin\bash.exe` first; if only `C:\Windows\System32\bash.exe` (the WSL stub) is found, prepend Git's bin to PATH, in PowerShell: `$env:PATH = "C:\Program Files\Git\bin;" + $env:PATH`. Without Git Bash, bash-dependent tests are explicitly skipped or say so in their timeout error; that doesn't mean a feature is broken.
- **Dependency install scripts**: `allowScripts` in the root `package.json` marks the existing ones (esbuild, koffi, onnxruntime-node, protobufjs, @google/genai) as not run — their native files ship prebuilt. When adding a dependency with an install script, decide whether it must run and record it. npm 10 (bundled with Node 22) ignores this field and runs them anyway.
- **Don't start long-running services directly on a dev machine**: ergo's services are registered with and started by the service manager (see [Install from source](../user-guide/install.en.md#install-from-source)). Daemons and child processes started by tests belong to the tests and are torn down with them.

## Running from source

The steps for installing and updating from source are in [Install, update and uninstall](../user-guide/install.en.md#install-from-source).

### Backup and restore

Installed builds use `ergo backup` and `ergo restore`; for how, see [Backup](../user-guide/settings.en.md#backup). Running from source there is no `ergo` command:

```powershell
npm run backup                   # back up now; add -- --scheduled when a timer calls it
# in packages\supervisor: stop the daemon first
node bin\lsm.mjs stop ergo-daemon
# in the ergo directory: the data directory must match the one in the service manager's entry
$env:ERGO_DATA_DIR = "$env:USERPROFILE\.ergo"
D:\apps\node22\node.exe packages\daemon\src\restore.ts --list                   # list the snapshots
D:\apps\node22\node.exe packages\daemon\src\restore.ts 2026-10-15               # restore a given day
D:\apps\node22\node.exe packages\daemon\src\restore.ts 2026-10-15 --from sync   # this machine's copy is broken: restore from the extra copy in the sync folder
# back in packages\supervisor: start it again
node bin\lsm.mjs start ergo-daemon
```

If the data directory isn't the default (you set `ERGO_DATA_DIR`), set this variable in the same window before using `ergo` commands too. The restore command refuses to run while the daemon is up.

### Claude Code integration

The Agent SDK (`@anthropic-ai/claude-agent-sdk`) is under Anthropic's own license, and ergo treats it only as an optional dependency. Running from source, run `npm install --no-save @anthropic-ai/claude-agent-sdk@<version>` in the ergo directory (the version is in `optionalDependencies` in `packages/daemon/package.json`), then click "Turn on" in Settings · Plugins.

## Common commands

From the repository root:

| What | Command |
|---|---|
| Install dependencies | `npm ci` |
| Run this after every change: the fast lane (all unit tests except the main slice and contract tests, plus web state / UI / build checks) | `npm run test:fast` (~2 minutes) |
| The main slice (real daemon and agent child processes) plus opening every page in a real browser | `npm run test:integration` (10+ minutes) |
| Everything (fast lane + main slice + pi contract tests) | `npm test` (~35 minutes; on Windows consider `$env:ERGO_TEST_WORKERS=2`) |
| pi contract tests (only when upgrading pi or changing `agent-host/`, `runtime/`, prompt assembly) | `npm run test:contract` |
| Service manager tests (`node --test`, not vitest) | `npm run test:supervisor` |
| One package, one file, by name | `npm test -w @ergo/daemon`; `npx vitest run packages/daemon/test/agent-process.test.ts`; `npx vitest run --project daemon -t "中止"` |
| Type check | `npm run typecheck` |
| Lint | `npm run lint` (oxlint, configured in `.oxlintrc.json`) |
| The full pre-merge set | `npm run check` (typecheck + lint + all tests + service manager) |
| i18n check | `npm run i18n:check` ([Internationalization](README.en.md#internationalization)) |
| Build the web UI | `npm run build:web` (a single file, `packages/web/dist/index.html`) |
| Build the online demo | `npm run build:demo` (into `packages/web/dist-demo/`, [Where pages come from](README.en.md#where-pages-come-from-prototype-and-online-demo)) |
| Open the real page after deploying | `npm run smoke:page` (headless Chrome on `http://127.0.0.1:8810/`; `-- <url>` for another address) |
| Build the HarmonyOS app | `npm run build:harmony` ([Phone apps](#phone-apps)) |
| Build the Android app | `npm run build:android` ([Android app](#android-app)) |
| Download the embedding model | `npm run download-model` |
| Back up now | `npm run backup` (installed builds have no `npm run`: `ergo backup`) |
| Restore from a snapshot | `node packages/daemon/src/restore.ts <date>` (installed builds: `ergo restore <date>`; stop the daemon first either way) |
| Deploy the VPS nginx site for the public entry | `npm run deploy:nginx` (`-- --print` only prints) |
| Check a project service's pages against the prefix convention | `npm run check:app-prefix -- <service url> --name <app name>` ([Proxying local service pages](README.en.md#proxying-local-service-pages)) |
| Check an operations manifest or plan without starting ergo | `npm run check:ops -- <ops.json or plan.json> [--url <service url>] [--workdir <project workdir>]` (http operations are only called with `--url`; exit 0 passed, 1 failed, 2 bad usage) |

## Phone apps

HarmonyOS comes first; for Android see [Android app](#android-app).

`frontend/harmony/` is a DevEco project (stage model, `entry` module): a native shell whose ArkWeb loads the ergo address the user configured, serving the same web UI as the daemon (why the web UI isn't bundled into the app: [ADR-0022](adr/0022-harmony-app-native-shell-loads-daemon-page.md)). The native bridge `window.ergoNative` is exposed only to the configured origin's main frame; external pages in Browse never get it.

### Build

```powershell
npm run build:harmony                       # WebView debugging off by default
npm run build:harmony -- --webview-debug    # WebView debugging on (install this build only while debugging)
```

- Uses DevEco Studio's bundled tools (`DEVECO_HOME`, or the default install location); the project has no ohpm dependencies and needs no network. Before building, the page bridge is bundled into `rawfile/page-bridge.js` and the built-in `harmony.json` texts into `rawfile/harmony-texts.json` (both generated, not committed).
- Output: the signed `frontend/harmony/entry/build/default/outputs/default/entry-default-signed.hap`; without local signing only an unsigned package in the same folder, and the script explains how to sign.
- Depends on a local DevEco install, so it's not part of `npm run check`.

### Signing (once)

Signing material (certificates, profiles, keystore, encrypted passwords) stays local and never enters the repository: run `npm run build:harmony` once to generate the local `frontend/harmony/build-profile.json5` (ignored) → enable developer mode and USB debugging on the phone and connect it → open `frontend/harmony` in DevEco, File → Project Structure → Project → Signing Configs, sign in with a Huawei account, tick Automatically generate signature → build again. The repository holds only an unsigned template `build-profile.template.json5`; `frontend/test/harmony.test.ts` checks that no signing material is committed.

### Install, launch, debug

```powershell
hdc list targets
hdc -t <device> install -r frontend/harmony/entry/build/default/outputs/default/entry-default-signed.hap
hdc -t <device> shell aa start -a EntryAbility -b com.catmaniii.ergo
hdc -t <device> hilog | findstr ErgoApp            # app and web page logs
```

To debug the page inside ArkWeb: install a `--webview-debug` build, `hdc -t <device> fport tcp:9222 localabstract:webview_devtools_remote_<app pid>`, then use Chrome's `chrome://inspect`. To reach the PC's daemon from the device via `http://127.0.0.1`, first `hdc rport tcp:<port> tcp:<port>`; note that forwarding the local port (8810) makes the daemon trust the app as local — only do this while debugging.

### Native recording

Push-to-talk in the app uses HarmonyOS's AudioCapturer: entering voice mode creates the capturer and leaves it PREPARED (not capturing, not holding the microphone, not blocking the keyboard's voice input); pressing calls `start`, releasing calls `stop` (the next take just calls `start` again); going to the background or leaving voice mode calls `release`. The format is 16 kHz mono 16-bit PCM; the web side adds a WAV header and uploads it as usual. The source is `SOURCE_TYPE_MIC`: the only source that coexists with the keyboard's speech recognition (`VOICE_RECOGNITION`) in both directions on every system version. Implementation: `frontend/harmony/entry/src/main/ets/voice/NativeVoice.ets`; web side `packages/web/src/app/native-voice.ts` and `voice-native-recorder.ts`.

### Android app

`frontend/android/` is a Gradle project: a Kotlin native shell with the system WebView, and the web UI isn't bundled here either. It has the same method table as HarmonyOS minus phone data sources (`phone*`); natively drawn parts take their values from HarmonyOS, gathered in `ui/ErgoTheme.kt`. See `frontend/android/README.md` for details.

```powershell
npm run build:android                       # debug build, WebView debugging off by default
npm run build:android -- --webview-debug    # WebView debugging on (install this build only while debugging)
npm run build:android -- --release          # release build; needs a local frontend/android/keystore.properties
```

It needs the Android SDK (`ANDROID_HOME`, or the default location) and JDK 17 or later, and the first build fetches the build plugin and AndroidX libraries from their official sources, so it isn't part of `npm run check`; the static checks in `frontend/test/android.test.ts` are. Before building, the page bridge is bundled into `assets/page-bridge.js` and the bundled languages are collected into `assets/harmony-texts.json` (both generated, not committed).

**On a real device**:

```powershell
adb devices
adb -s <device id> install -r frontend/android/app/build/outputs/apk/debug/app-debug.apk
adb -s <device id> shell am start -n com.catmaniii.ergo/.MainActivity
adb -s <device id> logcat -s ErgoApp               # app and web UI logs
```

To debug pages in the WebView, install the `--webview-debug` build and use Chrome's `chrome://inspect`. To reach a daemon on your PC from the device at `http://127.0.0.1`, first run `adb -s <device id> reverse tcp:<port> tcp:<port>`; as on HarmonyOS, forwarding the local port (8810) makes the daemon treat the app as local and trust it, so do this only while debugging.

**The native bridge's security design differs from HarmonyOS** ([ADR-0040](adr/0040-android-app-native-bridge-without-javascript-interface.md)): Android's `addJavascriptInterface` is visible to every page and frame in the WebView, so it can't be used. `ergoNative` goes through `addWebMessageListener` and `addDocumentStartJavaScript`, both registered only for the configured ergo origin, and each message is checked again for origin and main frame. The shim `assets/ergo-native-shim.js` serves the methods the web UI calls synchronously. The built-in browser is a separate WebView with only the page bridge, and every message carries a nonce issued by the app.

**Integration runs**: `frontend/android/e2e/` runs on an emulator against a temporary daemon. It isn't part of `npm run check`, every adb command carries a serial, and a serial not starting with `emulator-` is an error. `e2e/browser.ts` holds the proof that external pages can't reach `ergoNative`; run it when you change the native bridge or the page bridge.

**Scan to connect** (the same on HarmonyOS and Android): "Scan to connect" sits at the top of the address page. The scanned text goes through `checkServerAddress`, then `GET <origin>/api/access` confirms within about 10 seconds that what answered is ergo (no cookies, no redirects). If it can't connect, the app doesn't open the pairing page. The judging is in `common/ConnectCheck.*` (no network), and both apps and the protocol package are checked against the same examples in `frontend/test/connect-vectors.tsv`. Android uses Camera2 with ZXing's core package and asks for the camera only when the button is tapped; HarmonyOS uses the system ScanKit screen and needs no camera permission. Emulators have no camera that can point at a screen, so `--webview-debug` builds accept two test entries (`ergoTestScanText`, `ergoTestScanImage`); release builds don't. Integration runs: `frontend/android/e2e/scan.ts`, `frontend/harmony/e2e/scan.ts`; for Android's camera frames through ZXing, `frontend/android/e2e/scan-camera.ts` (the virtual scene camera facing a QR poster on the wall).

**Native recording** uses `AudioRecord`: created without capturing when voice mode starts, `startRecording` on press, `stop` on release, `release` when the app goes to the background or leaves voice mode. The format matches HarmonyOS (16 kHz, mono, 16-bit PCM) and the web side is unchanged. The source is `MIC`.

**System notifications** are local ones with no FCM and no foreground service: they only go out while the process is alive, and nothing arrives after the system kills it. The other rules match HarmonyOS: ask for permission the first time, don't post while in the foreground, one notification per item, and tapping returns to the matching page.

## Coding conventions

- **Type-stripping limits** (the daemon and protocol run `.ts` directly; the web is bundled by Vite but follows the same rules): relative imports carry the `.ts` extension; only erasable syntax (no `enum`, `namespace`, constructor parameter properties); type-only imports use `import type`. `erasableSyntaxOnly` and `verbatimModuleSyntax` in `tsconfig.base.json` enforce this.
- **The pi boundary**: `@earendil-works/*` may only be imported inside `packages/daemon/src/runtime/agent-child/`; nothing may re-export pi's exports; nothing outside `agent-child/` may import from it (`test/pi-boundary.test.ts`).
- **The project-system boundary**: outside the project-system directories, import only the entry `projects/api.ts` (the operations layer's is `project-ops/api.ts`); if you need something new, add a small caller-shaped interface to the entry (`test/projects/boundary.test.ts`). Same for plugins: the kernel imports only a plugin's `api.ts`.
- **Personal data and secrets never enter the repository**: the data directory comes from config, and tests always use temporary directories. Never read or print real data under the user's `.ergo`, `.ssh` and so on.
- **Write a temporary file, then rename — always through `util/atomic-file.ts`** (`writeFileAtomic`, `renameRetrying` and async variants): on Windows, renaming over a file another process has open fails (even if it's only reading), and these helpers retry; never `fs.renameSync` a freshly written temp file directly.
- **User-facing text goes through `t()`** ([Internationalization](README.en.md#internationalization)); model-facing text and logs are annotated `@i18n-ignore`.
- **An owner is a maintainer in code**: the UI, prompts and docs say owner; code identifiers, event types, API fields, channel names and language file keys say `maintainer`.
- **Identifiers in English, comments in Chinese**; domain concepts use the words in `CONTEXT.md`. Exception: placeholder names in system-prompt files are Chinese (`{{拉回次数}}`, `{{#立项书已确认}}`, and the matching keys in code) — those files are shown to and edited by users, who type these names in the settings editor.
- **Each threshold's default is defined once, in its own module**; config only lists what changes.
- **Styles use only `var(--token)`**, never hard-coded colors, radii or shadows ([Visual styles](README.en.md#visual-styles)).
- Dependencies are pinned to exact versions, and `package-lock.json` is committed with them.

## Testing

### Lanes

| Lane | Runs | When |
|---|---|---|
| `npm run test:fast` | Everything in the daemon except the main slice (`test/main`) and contract tests (`test/contract`), plus protocol, web state / UI / build checks, memory, and the HarmonyOS checks | After every change (~2 minutes) |
| `npm run test:integration` | The main slice (real daemon and agent child processes) plus `page-opens` (build once, open every page in real Chrome) | When touching the daemon's main paths, composition root or assembly, or before merging |
| `npm test` | Everything = fast lane + main slice + pi contract tests | Before a release (GitHub Actions runs it on tags) |

`npm run test:contract` (pi contract tests) launches a child process per test case and is only needed when upgrading pi or changing `agent-host/`, `runtime/` or prompt assembly. The service manager's tests use `node --test`; run them with `npm run test:supervisor`. The two lanes' vitest configs are `vitest.fast.config.ts` and `vitest.integration.config.ts` at the root; the full run uses the root `vitest.config.ts`. When changing a package's `setupFiles` / `include`, update all of them.

### Test harness

- **The owner speaks first after a kickoff**: in production, tapping "Start project" wakes the owner (`kickoffFromCard` in `projects.ts`); `startTestDaemon` keeps this off by default (`kickoffOpening`) so faux model scripts don't gain a turn. Tests that need it pass `true`.
- **Main slice** (`packages/daemon/test/main/`): `startTestDaemon(options)` starts a real daemon (temporary data directory, system-chosen free ports, **never 8810 or 8811**); the secretary, owners, reviewers and sub-agents talk to pi's faux provider following scripts, and child processes are really launched; `TestFrontend` plays the frontend over WebSocket and HTTP and waits for events per channel. Time is advanced with `ManualClock`, never waited out.
- **Guard slice** (`packages/daemon/test/guard/`): calls the judging function only, no processes; scenario files `scenarios/*.guard.json` run one by one.
- **pi contract tests** (`packages/daemon/test/contract/`): verify only the pi behavior ergo depends on.
- **Web**: the state layer is tested by replaying recorded event streams (`recordings/`, recorded live by the main slice: `ERGO_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/recordings.test.ts`); pages by `page-opens.test.ts`, which opens the prototype in real Chrome (skipped if there's no Chrome).
- **Plugins**: the fake kernel `startPluginKernel` in `test/helpers/plugin-kernel.ts` (see the plugin guide).
- **Secret-looking test samples** are assembled at runtime (`test/helpers/fake-secrets.ts`); the repository contains no strings that look like real keys.

### No real data, no network

- Tests always use temporary directories and never touch `~/.ergo` or a running daemon.
- Every vitest project loads the root `vitest.setup-no-network.mjs`: **any global `fetch` to a non-loopback address throws**. It only covers `fetch`; direct `net` and `tls` connections get through, so watch those yourself. To test networking, use local fakes (fake TTS, fake MCP, a fake model catalog…). No test spends tokens.
- **The scheduled task `LocalServiceManager` has a fixed name, and a development machine has a real one**: tests swap it for a JSON file with `ERGO_AUTOSTART_TASK_FILE` (`cli/autostart.ts`; the installer honours it too). `ergo` starts lsm through one entry only, `runLsm`; under vitest without that variable, `install-autostart` and `uninstall-autostart` are refused there and lsm isn't started. `cli.test.ts` and `install-script.test.ts` compare the real task's full definition (read-only) when they finish. The installer's tests use a fake `ergo.cmd`.

### Windows notes

- Parallelism: set `ERGO_TEST_WORKERS` to a number (default is half the cores); use 2 when several suites run at once.
- Advancing the clock past 03:00 wakes the memory curator in the background: `startTestDaemon` disables the memory plugin by default when given a `clock`; tests about memory pass `memoryPlugin: true`.
- Don't poll a file while the product is replacing it by rename (EPERM / ENOENT on Windows): wait for the product's "done" signal and then read.
- Timeouts may be relaxed for slowness; assertions are never weakened.

## Upgrading pi

1. `npm view @earendil-works/pi-coding-agent dist-tags` for the latest stable version; read the Breaking Changes in each package's CHANGELOG.
2. Change all `@earendil-works/*` together, pinned to exact versions: `dependencies` in `packages/daemon/package.json` and `overrides` in the root `package.json` (add any new `@earendil-works/*` package the new pi depends on).
3. `npm install`, and confirm with `npm ls --all` that all earendil packages are the same version.
4. `npm run typecheck` → `npm run test:contract` → `npm test`. The only extension loaded into pi in the child is the generic bridge (`runtime/agent-child/bridge.ts`); check the CHANGELOG for changes to the events it uses and the APIs used by `agent-child/tool-order.ts`.
5. **Check pi's Node major version** ([ADR-0031](adr/0031-node-version-follows-pi.md)): look at `node-version` in pi's `.github/workflows/ci.yml` and `latest-v<major>.x` in its installer; if they changed, follow (`engines`, CI, installer) and run everything.

## Docs, CHANGELOG, decision records

- **When behavior changes, update the docs in the same commit**: user-visible changes go into the [user guide](../user-guide/README.en.md) (chapters that have an English version in both languages); modules, protocols and conventions into [this layer](README.en.md) (both languages); plugins into the plugin guide (tests check its excerpts and names); new terms into [CONTEXT.md](../../CONTEXT.md).
- **CHANGELOG**: one section per version, describing changes users can notice.
- **Decision records** (`docs/architecture/adr/`): write an ADR for decisions that are hard to reverse, surprising, or chosen among alternatives — next number, with context, decision and consequences.
- **Memory system** docs (`docs/architecture/memory-system.md`) are checked against the code (interface tables, tool tables, paths) by `packages/memory/test/architecture-doc.test.ts`.
- **Third-party licenses**: dependencies are mostly MIT / Apache-2.0 / BSD / ISC; sharp's bundled libvips is LGPL-3.0; fonts are SIL OFL 1.1 (their licenses are copied into `dist/fonts/` with the fonts); lightningcss is MPL-2.0 but is only used to build the web UI and is not in the release package. The full list is generated by the build scripts (`packages/daemon/build/`; `npm run release` from the repository root builds into `dist/release`) into the package root: `THIRD_PARTY_NOTICES.txt` (full texts) and `third-party-licenses.json` (name, version, license, origin). Claude Code's Agent SDK (`@anthropic-ai/claude-agent-sdk`) is under Anthropic's own license, is an optional dependency, and is not redistributed with the package.
