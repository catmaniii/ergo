[中文](install.md) | **English**

# Install, update and uninstall

ergo runs on Windows 10 / 11 only. What the two processes are and what to prepare: [User Guide section 1](user-guide.en.md#1-before-you-install). For access from outside, see [Deployment and outside access](deployment.en.md).

- [One-line install (recommended)](#one-line-install-recommended)
- [Install with npm](#install-with-npm-if-you-already-have-node-22)
- [Install from source](#install-from-source)
- [After installing](#after-installing)
- [Update](#update)
- [Roll back](#roll-back)
- [Stop](#stop)
- [Uninstall](#uninstall)

## One-line install (recommended)

In PowerShell:

```powershell
irm https://github.com/catmaniii/ergo/releases/latest/download/install.ps1 | iex
```

It finds the latest version (whichever of GitHub Releases and npmmirror answers faster) → downloads the prebuilt package (with Node; no `npm`, no build; the window shows percent, downloaded / total and speed, or just downloaded and speed when the server doesn't give a size) → verifies the signature and each file's sha256 → extracts it to `%LOCALAPPDATA%\Programs\ergo\versions\<version>`, writing `current` (a one-line text file naming the one in use) → adds `bin` to your user PATH (no admin rights) → sets the supervisor to start at login → starts ergo, and finally reports the version, the install folder, the version in use, the autostart state and what to do next. Then open <http://127.0.0.1:8810/> in a browser (or run `ergo open`) and follow the wizard (see [Section 3](user-guide.en.md#3-first-run)). Your data lives in `%USERPROFILE%\.ergo`, separate from the program; upgrades and reinstalls never touch it.

`irm … | iex` cannot pass parameters; to pass one, fetch the script and run it:

```powershell
& ([scriptblock]::Create((irm https://github.com/catmaniii/ergo/releases/latest/download/install.ps1))) -FromSource
```

The options: `-FromSource` (skip the package, fetch the source package and build it; `-Ref <tag or branch>` picks the version), `-NodeVersion <version>` (only allow a tested Node), `-UseSystemNode` (use the Node already on the machine instead of the bundled one), `-Mirror cn` (force npmmirror, faster in mainland China), `-NoPath` (don't change PATH), `-NoAutostart` (don't set up autostart), `-NoStart` (don't start ergo after installing; the older name `-NoOnboard` still works). With `irm … | iex` you can use environment variables instead: `$env:ERGO_INSTALL_NO_AUTOSTART = 1`, `$env:ERGO_INSTALL_NO_START = 1`.

Only a failure while downloading, verifying, extracting or writing `current` means the install failed (the version in use is unchanged). A later step that doesn't work out (say, registering autostart is blocked) doesn't fail the install: the script says which step didn't work and how to redo it, and the rest goes on.

**ergo comes back after a restart by itself**: the installer sets the supervisor to start at login (the scheduled task `LocalServiceManager`: starts in the background when you log in to Windows, no window), and the first `ergo start` puts ergo on its autostart list (`registry/autostart.yaml` in its data directory).

- **Which services come up at login** is decided in the supervisor: the switch on a service's card in its web page <http://127.0.0.1:7420/>, or `ergo svc autostart <service> on|off`. Turn ergo off and it stays off; `ergo start` won't turn it back on.
- **No autostart**: `ergo svc uninstall-autostart`; to get it back: `ergo svc install-autostart`. Once removed, `ergo start` and `ergo update` won't add it back; running the installer again will (add `-NoAutostart` if you don't want that).
- **Updates and rollbacks**: `ergo update`, `ergo rollback` and `ergo start` check the task, and if it points at another version of this install they point it at the one in use.
- **A task of the same name already points elsewhere** (say, a supervisor you installed from source): the installer, `ergo start` and `ergo uninstall` leave it alone. To replace it with this install, run `ergo svc install-autostart` once.
- **Installed with `-NoStart`**: a restart brings ergo up only after you have run `ergo start` once. Until then the supervisor does come up at login, but ergo isn't registered and the list isn't written; and on its very first start it has no record of a previous login session, so it treats the start as "not a boot" and starts no services (better to skip autostart once than to mistake an ordinary restart for a boot).

## Install with npm (if you already have Node 22)

```powershell
npm i -g ergo-ai
ergo start
```

The command is still called `ergo`. The npm package (`ergo-ai`) isn't published yet, so this section doesn't work yet; once it is, after installing, open <http://127.0.0.1:8810/> and follow the wizard.

## Install from source

These example paths are used below; substitute your own:

| Example path | What it is |
|---|---|
| `D:\apps\node22\node.exe` | A copy of Node.js dedicated to ergo |
| `D:\apps\ergo` | ergo's code (the supervisor lives in its `packages\supervisor`) |
| `%LOCALAPPDATA%\ergo\supervisor` | The supervisor's data directory (service list, ledger, logs, its own secrets) |
| `%USERPROFILE%\.ergo` | ergo's data directory (created on first start) |

**Step 1: Node and Git**

- Install [Git for Windows](https://git-scm.com/).
- Download the Node 22 Windows zip from [nodejs.org](https://nodejs.org/) and unpack it to a fixed folder (e.g. `D:\apps\node22\`). Keep **a dedicated copy** for ergo, so PATH changes or other programs' upgrades never affect it. Make sure the `node` / `npm` you use below is this one (`node -v` should print v22.x).

**Step 2: get the code, install dependencies, build the web UI**

```powershell
cd D:\apps
git clone https://github.com/catmaniii/ergo.git
cd ergo
npm ci                  # install exactly what package-lock.json says
npm run build:web       # build the web UI into packages\web\dist\index.html
```

- Use a normal checkout, not a git worktree.
- The daemon runs its TypeScript sources directly (Node's type stripping); only the web UI needs a build.

**Step 3: start the supervisor**

```powershell
cd D:\apps\ergo\packages\supervisor
$data = "$env:LOCALAPPDATA\ergo\supervisor"
New-Item -ItemType Directory -Force $data | Out-Null
Copy-Item -Recurse examples\registry "$data\registry"
notepad "$data\registry\manager.yaml"    # set projectRoots to the folder where you keep code
node bin\lsm.mjs validate               # validates the registry only; touches no process
node bin\lsm.mjs install-autostart      # start the supervisor in the background at Windows login (no window)
Start-ScheduledTask -TaskName LocalServiceManager   # start it now (or sign out and back in)
```

Open <http://127.0.0.1:7420/>; if you see the supervisor's page, it is running. Below, `lsm` means running `node bin\lsm.mjs` inside `D:\apps\ergo\packages\supervisor`. More (profiles, a password for its web UI, the sentinel…) is in its [README](../packages/supervisor/README.md) (Chinese).

> With the one-line install, `ergo start / stop / status / logs` manage ergo itself and `ergo svc <subcommand>` passes through to the supervisor (`ergo svc status` = `lsm status`).

**Step 4: put your API key in place**

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.ergo\secrets" | Out-Null
Set-Content -NoNewline -Encoding ascii "$env:USERPROFILE\.ergo\secrets\deepseek-api-key.txt" "sk-your-key"
```

- The file holds only the key. The supervisor reads it and hands it to the daemon; no agent can read the `secrets` area of the data directory.
- **Never put the key in the repository** or in the supervisor's registry.
- You can skip the command line: once ergo's web page is open, enter the key in the **setup wizard**'s "Model Key" step, or under **Settings · Models**, and click "Save key". It is written to the same file (`secrets\deepseek-api-key.txt`, with the folder and file created at the tightest permissions), and the next new session can use it — no restart needed; change it in the same place later. Putting the file in place by hand remains the fallback, for when the page won't open or you want a different data directory.
- To use another vendor's model (a custom OpenAI-compatible provider), its key lives in `secrets\custom-model-api-key.txt` and the environment variable is `CUSTOM_MODEL_API_KEY`; how to fill it in is in [5.5](user-guide.en.md#55-models).

**Step 5: register the daemon with the supervisor**

1. Copy the example entry:

   ```powershell
   copy D:\apps\ergo\deploy\lsm\ergo-daemon.example.yaml "$env:LOCALAPPDATA\ergo\supervisor\registry\services\ergo-daemon.yaml"
   ```

2. Open the copy in a text editor and replace the three placeholders; no `<…>` should remain:

   | Placeholder | Replace with | Example |
   |---|---|---|
   | `<仓库路径>` (repository path) | ergo's code directory | `D:\apps\ergo` |
   | `<专用 Node 路径>` (dedicated Node path) | `node.exe` of the Node from step 1 | `D:\apps\node22\node.exe` |
   | `<用户主目录>` (home directory) | your user directory (the data directory is `.ergo` under it) | `C:\Users\you` |

   Also: without a TTS service, delete the `dependsOn:` block (a soft dependency; removing it does not affect startup); if you changed the local port ([5.2](user-guide.en.md#52-config-file-ergojson)), change both `8810`s in the entry; leave the commented-out `exposure:` block at the end alone for now ([6.3](deployment.en.md#option-3-vps--ssh-reverse-tunnel--nginx-public)).

3. Validate, start, enable autostart:

   ```powershell
   cd D:\apps\ergo\packages\supervisor
   node bin\lsm.mjs validate               # reports exactly which field is wrong
   node bin\lsm.mjs reload                 # make the running supervisor re-read the registry
   node bin\lsm.mjs start ergo-daemon
   node bin\lsm.mjs status                 # wait for ergo-daemon to be RUNNING, tier linked
   node bin\lsm.mjs autostart ergo-daemon on
   ```

- Once linked, the daemon reports its own health and whether it is busy: while a task is executing it shows "busy", and "stop when idle" waits for it.
- The daemon's output is in `logs\ergo-daemon.out.log` under the supervisor's data directory, and live in the supervisor's web UI.
- If it is killed or crashes, the supervisor restarts it with backoff; work in progress resumes by its rules, and any operation that may or may not have completed is handed to you to confirm instead of being silently redone.

## After installing

1. **Run the wizard**: open <http://127.0.0.1:8810/> (or `ergo open`) and go through the five steps of the **setup wizard**: language / how to address you / assistant name, model key (click test after filling it in), capabilities (tick which plugins and components you want: the embedding model and memory by default, voice off; models are downloaded here in the web page, not in the installer; this step also has the start-at-boot switch), pairing a phone by QR code, safe defaults, plus a screen on outside access. Any step can wait; re-enter any time from the top of **More · Settings**. See [First run](user-guide.en.md#3-first-run).
2. **Try it**: say "remind me to drink water in two minutes".
3. **Everyday commands**: `ergo start`, `ergo stop`, `ergo restart`, `ergo status`, `ergo logs`; for backups, `ergo backup` and `ergo restore` ([Backup and restore](user-guide.en.md#9-backup-and-restore)).
4. **When something's wrong**: check **More · Settings · Data & devices → Doctor** first; each item says how to fix it. Then see [Troubleshooting](user-guide.en.md#11-troubleshooting).

## Update

Your data (`%USERPROFILE%\.ergo`) is separate from the program, and updating leaves it alone. See [CHANGELOG](../CHANGELOG.md) for what changed in each version.

### One-line installs

```powershell
ergo update --check   # only check whether there's a new version
ergo update           # update
ergo version          # see which version is running
```

`ergo update` looks up the latest version, downloads it into a new directory and verifies the signature, waits until ergo is idle (a running task isn't interrupted), switches over and restarts ergo with the autostart task pointing at the new version, and keeps the old version for rolling back. If ergo stays busy too long it gives up and the version in use doesn't change; just run it again later.

Options: `--version <version>` picks a version, `--mirror cn` uses npmmirror (faster in China), `--from <url>` uses another release address.

A supervisor started by the autostart task keeps running the old version's program after an update (ergo itself is on the new version, so nothing breaks) and changes at the next login; the old version's folder it occupies can't be deleted until then, and `ergo update` says it will remove it next time.

### Coming from 0.4.0

After switching versions, `ergo update` in 0.4.0 leaves ergo running the old version, and installs from that time have no autostart. So there are two extra steps:

```powershell
ergo update                  # download the new version and switch to it
ergo restart                 # make ergo really change to the new version
ergo svc install-autostart   # add autostart
ergo status                  # check the version
```

`ergo restart` adds ergo to the boot list. If you made your own list earlier and ergo isn't on it, add it with `ergo svc autostart ergo-daemon on`. The supervisor is still the old version's program at this point and changes at the next login. Later updates only need `ergo update`.

### Other kinds of install

| How it was installed | How to update |
|---|---|
| `install.ps1 -FromSource` | `ergo update` (pulls new code, builds into a new directory, then switches) |
| Your own `git clone` | See below |
| npm (not published yet) | `npm i -g ergo-ai@latest` |
| Scoop, winget | `scoop update ergo`, `winget upgrade`; `ergo update` tells you the same |

Your own `git clone`:

```powershell
cd D:\apps\ergo
git pull
npm ci                  # when dependencies changed
npm run build:web
cd packages\supervisor
node bin\lsm.mjs restart ergo-daemon --when-idle   # restart once the task at hand is done
```

If only the web pages changed, the daemon doesn't need a restart.

### On your phone

For a new phone: on your computer, open **More · Settings · Device pairing**, choose "Show pairing code", and tap "Scan to connect" in the Ergo app on your phone (if it can't connect, the app says why).

Open pages (including a HarmonyOS app left open) offer to refresh within seconds, and refreshing gets you the new version. The app itself usually doesn't need reinstalling; its native parts and the script for giving commands on web pages are packaged with the app, so it only needs rebuilding when those change, and the CHANGELOG says so.

### When an update goes wrong

If the switch fails, the version in use doesn't change and ergo starts as usual. Common cases are in [Troubleshooting](user-guide.en.md#11-troubleshooting).

## Roll back

```powershell
ergo rollback    # back to the previous version
```

Rolling back only changes the program, not your data. If the newer version changed a data format, the older one may not be able to read it, so check the [CHANGELOG](../CHANGELOG.md) first. Which version is in use is decided by `current` (a one-line text file) in the install directory.

## Stop

```powershell
ergo svc autostart ergo-daemon off    # don't start ergo at boot
ergo svc stop ergo-daemon --when-idle # stop once the task at hand is done
ergo svc uninstall-autostart          # the supervisor doesn't autostart either
```

With your own `git clone`, use `node bin\lsm.mjs` inside `packages\supervisor` in place of `ergo svc`.

## Uninstall

```powershell
ergo uninstall                # removes PATH entries, the supervisor registration and autostart; asks about your data
ergo uninstall --keep-data    # don't ask, keep the data
ergo uninstall --delete-data  # don't ask, delete the data too
```

Your data is in `%USERPROFILE%\.ergo` and the supervisor's in `%LOCALAPPDATA%\ergo\supervisor`. With your own `git clone`, uninstalling means deleting the code directory and these two; deleting the data is up to you.
