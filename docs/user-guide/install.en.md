[中文](install.md) | **English**

# Install, update and uninstall

This chapter covers installing ergo on your Windows PC, starting and stopping it, starting automatically, updating, rolling back and uninstalling. By the end you can get ergo running by yourself and know where to look when something goes wrong. Next, see [Getting started](getting-started.en.md); to learn what ergo is first, see [What is ergo](README.en.md).

- [Before you install](#before-you-install)
- [One-line install (recommended)](#one-line-install-recommended)
- [Install with npm](#install-with-npm-if-you-already-have-node-22)
- [Install from source](#install-from-source)
- [Starting and stopping](#starting-and-stopping)
- [Starting automatically](#starting-automatically)
- [After installing](#after-installing)
- [Update](#update)
- [Roll back](#roll-back)
- [Stop](#stop)
- [Uninstall](#uninstall)
- [Troubleshooting](#troubleshooting)

## Before you install

**What you need:**

- **A Windows 10 / 11 PC.** Only Windows is supported for now.
- **An API key for a large model:** currently [DeepSeek](https://platform.deepseek.com/); you can switch to another OpenAI-compatible provider (see [Models](settings.en.md#models)). ergo starts without a key so you can look around; it reminds you when you talk to it.
- **Disk:** a few hundred MB for the program. The embedding model for semantic search is about 560 MB and the speech recognition model about 1 GB; both are optional.

You don't need to install Node first: the one-line install brings its own.

**Optional** (ergo works without them; the matching features stay off)

| Install | Gives you | See |
|---|---|---|
| Git for Windows | Agents can run bash commands (used a lot in tasks); install from source | [Install from source](#install-from-source) |
| Speech recognition (install it in **Settings · Components**) | Push-to-talk, recognized locally | [Voice](voice.en.md) |
| Speech synthesis (installed under **Settings · Components**) | ergo answers with voice | [Voice](voice.en.md) |
| Chrome or Edge | Agents can search the web and read pages | [Settings](settings.en.md#browsing--form-filling) |
| Tailscale, or a VPS | Use ergo from your phone or tablet away from home | [On your phone](mobile.en.md) |
| Claude Code, signed in on this PC | Project and task owners can work through your own Claude Code subscription | [Claude Code](claude-code.en.md) |
| An Android phone | The native Android app: [download](https://github.com/catmaniii/ergo/raw/main/downloads/ergo-android-debug.apk) and install it | [On your phone](mobile.en.md#android-app) |
| A HarmonyOS phone, DevEco Studio and a Huawei account | The native HarmonyOS app, signed with your own account. The [unsigned package](https://github.com/catmaniii/ergo/raw/main/downloads/ergo-harmony-unsigned.hap) installs directly only on the emulator | [On your phone](mobile.en.md#harmonyos-app) |

## One-line install (recommended)

You don't need Node beforehand, and you don't need administrator rights.

**Step 1: open PowerShell.** Press the Windows key, type `powershell`, press Enter. A normal window is fine; don't **Run as administrator**.

**Step 2: paste this line and press Enter.**

```powershell
irm https://github.com/catmaniii/ergo/releases/latest/download/install.ps1 | iex
```

The package is about 150 MB, and the window shows download progress. The script does these things in order:

1. Finds the latest version (whichever of GitHub Releases and npmmirror answers faster) and downloads the package. It bundles Node, so there's no `npm` and no build.
2. Verifies the signature and the file's sha256.
3. Unpacks to `%LOCALAPPDATA%\Programs\ergo\versions\<version>` and writes `current`, one line of text pointing at the version in use.
4. Adds `bin` to your user PATH.
5. Sets the service manager to start automatically, then starts ergo (see [Starting automatically](#starting-automatically)).

Your data lives in `%USERPROFILE%\.ergo`, separate from the program. Updates and reinstalls don't touch it.

**Step 3: read the last few lines in the window.** When everything worked, they say:

```text
Version: <version>
Install folder: C:\Users\you\AppData\Local\Programs\ergo
Version in use (current): <version>
Autostart: on
Next: ergo open opens the web page; follow the setup wizard there.
Done. Use ergo start / stop / status / update / uninstall from now on; ergo help lists every command. Your data lives in ~/.ergo and is never touched by updates or uninstalling.
```

The install has only failed if downloading, verifying, unpacking or writing `current` fails, and then the version in use stays as it was. If a later step doesn't work (say, registering the startup task was blocked), that isn't an install failure: the window says which step didn't work and how to redo it, and everything else carries on.

**Step 4: check that ergo is running.** Open a new PowerShell window and run `ergo status`. You should see:

```text
Version: <version> (release package)
Installed at: C:\Users\you\AppData\Local\Programs\ergo
Data: C:\Users\you\.ergo
Service manager: running (port 7420)
ergo: RUNNING, http://127.0.0.1:8810/ (pid 12345)
```

**Step 5: open the page and go through the setup wizard.** Run `ergo open`, or open <http://127.0.0.1:8810/> in a browser. For the wizard, see [After installing](#after-installing) below.

### Install options

`irm … | iex` can't take parameters. To pass some, fetch the script first:

```powershell
& ([scriptblock]::Create((irm https://github.com/catmaniii/ergo/releases/latest/download/install.ps1))) -FromSource
```

| Parameter | What it does |
|---|---|
| `-FromSource` | Download the source package and install from it instead; `-Ref <tag or branch>` picks the version |
| `-NodeVersion <version>` | Use a specific Node version (only tested ones are allowed) |
| `-UseSystemNode` | Use the Node already on the machine instead of the bundled one |
| `-Mirror cn` | Force npmmirror (usable only once the npm package is published; for now it falls back to GitHub) |
| `-NoPath` | Don't change PATH |
| `-NoAutostart` | Don't set up starting automatically |
| `-NoStart` | Don't start ergo after installing |

With `irm … | iex` you can also use environment variables: `$env:ERGO_INSTALL_NO_AUTOSTART = 1`, `$env:ERGO_INSTALL_NO_START = 1`.

## Starting and stopping

ergo is two processes: the **service manager** starts other services and watches over them; the **ergo daemon** is ergo itself, hosted by the service manager.

After installing, ergo is already running, and it comes back by itself after a restart, so **you normally don't start it by hand**. When you need to:

| What you want | Command |
|---|---|
| See whether it's running, which version, where it's installed | `ergo status` |
| Start (starts the service manager first if needed) | `ergo start` |
| Open the page | `ergo open` |
| Stop now | `ergo stop` |
| Stop once the task in hand is finished | `ergo svc stop ergo-daemon --when-idle` |
| Restart | `ergo restart` |
| Restart once the task in hand is finished | `ergo svc restart ergo-daemon --when-idle` |
| Read the logs (`-f` keeps following, Ctrl+C quits) | `ergo logs`, `ergo logs -f` |
| See every command | `ergo help` |

You can also use the service manager's page: open <http://127.0.0.1:7420/>. Each service has a card where you can start and stop it, watch live logs and switch starting at login on or off.

If ergo is killed or crashes, the service manager brings it back. After a restart, work in progress carries on by the usual rules; operations it can't tell were finished are handed to you to confirm, not quietly redone.

What `ergo status` means:

| It says | Meaning | What to do |
|---|---|---|
| `Service manager: not running` | The service manager isn't up | `ergo start` |
| `ergo: not registered yet` | Installed with `-NoStart` and never started | `ergo start` |
| `ergo: STOPPED` | It was stopped | `ergo start` |
| `ergo: FAILED — reason` | It didn't start | Deal with the reason, check `ergo logs`, then `ergo start` |

### Have ergo switch services for you

**What it is:** No command line needed. Tell ergo, and it checks status, reads logs and starts or stops services in the service manager for you.

Things you can just say:

- What's in the service manager? Is speech synthesis still running?
- Stop audiocpp for now; start it again; restart it
- Why won't comfyui start? Look at its logs
- Add the drawing service to autostart
- Restart yourself, I just changed the config

| What you ask for | What it does |
|---|---|
| Check status, read logs; start, stop (services that have their own way to stop), restart, stop when idle, add to autostart, start a scenario | Does it as soon as you say so; the tool call in the chat says what was stopped and how things are now |
| Force stop (the only way to stop a service with no way to stop, cutting off whatever it's doing), force restart, remove from autostart, stop a scenario, remove a project service registered by ergo, deal with a stray process holding a port, open or close public or tailnet access | Shows an approval card and only does it once you click "Approve once". Same with chat approvals off |
| Restart ergo itself | Shows an approval card. Once approved it doesn't restart straight away: it waits until its tasks and whatever it's doing are finished and it has finished this reply, then exits and the service manager brings it back. The conversation carries on afterwards |
| Stop ergo itself or restart it without waiting until idle, stop its tunnel to the internet or a service it depends on | Won't do it, and tells you which one and why. If it really has to be done, do it yourself on the service manager's web page |

Good to know:

- **The real safeguard is in the service manager.** ergo gives orders with the identity the service manager gave it, and the service manager works out from that identity what ergo depends on; however it's asked, the service manager won't stop those.
- **To protect one more service** (speech recognition, say), add a line `lifeline: true` to its entry; then nobody can stop it this way.
- **If the service manager is too old**, ergo says plainly that the service manager needs updating first, and leaves everything as it is.
- **Not done here:** setting up public access (creating a tunnel), changing the service manager's password and reloading entries are done on the service manager's web page.

## Starting automatically

There are two layers, and **both must be on for ergo to come back after a restart**. The one-line install turns both on, so there's nothing to set up. The rest of this section is for checking or changing them.

| | Layer 1: the service manager starts | Layer 2: the service manager starts ergo |
|---|---|---|
| What it does | When you log in to Windows, the scheduled task `LocalServiceManager` starts the service manager in the background, with no window | Once up, the service manager starts the services on its startup list |
| Turned on by | The install script | The first `ergo start` (the install script runs one for you) |
| Check it | `Get-ScheduledTask -TaskName LocalServiceManager` | `ergo svc autostart` (lists them) |
| Turn on | `ergo svc install-autostart` | `ergo svc autostart ergo-daemon on` |
| Turn off | `ergo svc uninstall-autostart` | `ergo svc autostart ergo-daemon off` |
| On a page | The **Start at boot** switch in the setup wizard's Capabilities step | The switch on the card at <http://127.0.0.1:7420/> |

**To check it works:** restart the computer, log in to Windows, wait a minute or two, then open PowerShell and run `ergo status`.

**Good to know:**

- **It's at login, not at power-on.** If the computer is on but sitting at the login screen, ergo won't be up. For an unattended home machine you'd need Windows to log in automatically, which is your call to make and set up.
- **Other services work the same way.** To have a voice service start too, run `ergo svc autostart <service> on` or use the switch on its card. `ergo svc status` shows the service names.
- **Off stays off.** Once ergo is off the list, `ergo start` won't put it back. Once layer 1 is removed, `ergo start` and `ergo update` won't add it back; rerunning the install script will (add `-NoAutostart` if you don't want that).
- **Updates and rollbacks take care of themselves.** `ergo update`, `ergo rollback` and `ergo start` check the task, and if it points at another version of this install they repoint it at the one in use.
- **If this computer already has a task with that name pointing elsewhere** (say, a service manager you installed from source), the install script, `ergo start` and `ergo uninstall` leave it alone. Run `ergo svc install-autostart` once to switch it to this install.
- **Installed with `-NoStart`:** ergo only comes back after a restart once you've run `ergo start`.
- **Installed from source:** replace `ergo svc` above with `node bin\lsm.mjs` run in `packages\supervisor`; see steps 3 and 5 of [Install from source](#install-from-source).

## Install with npm (if you already have Node 22)

```powershell
npm i -g ergo-ai
ergo start
```

The command is still called `ergo`. The npm package (`ergo-ai`) isn't published yet, so this section doesn't work yet; once it is, after installing, open <http://127.0.0.1:8810/> and follow the wizard.

## Install from source

This section is only for changing the code or tracking the latest code. To just use ergo, the one-line install above is all you need.

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

Open <http://127.0.0.1:7420/>; if you see the service manager's page, it is running. Below, `lsm` means running `node bin\lsm.mjs` inside `D:\apps\ergo\packages\supervisor`. More (profiles, a password for its web UI, the sentinel…) is in its [README](../../packages/supervisor/README.md) (Chinese).

> With the one-line install, `ergo start / stop / status / logs` manage ergo itself and `ergo svc <subcommand>` passes through to the supervisor (`ergo svc status` = `lsm status`).

**Step 4: put your API key in place**

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.ergo\secrets" | Out-Null
Set-Content -NoNewline -Encoding ascii "$env:USERPROFILE\.ergo\secrets\deepseek-api-key.txt" "sk-your-key"
```

- The file holds only the key. The supervisor reads it and hands it to the daemon; no agent can read the `secrets` area of the data directory.
- **Never put the key in the repository** or in the supervisor's registry.
- You can skip the command line: once ergo's web page is open, enter the key in the **setup wizard**'s **Model key** step, or under **Settings · Models**, and click **Save key**. It is written to the same file (`secrets\deepseek-api-key.txt`, with the folder and file created at the tightest permissions), and the next new session can use it — no restart needed; change it in the same place later. Putting the file in place by hand remains the fallback, for when the page won't open or you want a different data directory.
- To use another vendor's model (a custom OpenAI-compatible provider), its key lives in `secrets\custom-model-api-key.txt` and the environment variable is `CUSTOM_MODEL_API_KEY`; how to fill it in is in [Settings · Models](settings.en.md#models).

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

   Also: without a TTS service, delete the `dependsOn:` block (a soft dependency; removing it does not affect startup); if you changed the local port ([config file](../architecture/README.en.md#data-directory-and-config)), change both `8810`s in the entry; leave the commented-out `exposure:` block at the end alone for now ([Option 3](../architecture/deployment.en.md#option-3-vps--ssh-reverse-tunnel--nginx-public)).

3. Validate, start, enable autostart:

   ```powershell
   cd D:\apps\ergo\packages\supervisor
   node bin\lsm.mjs validate               # reports exactly which field is wrong
   node bin\lsm.mjs reload                 # make the running supervisor re-read the registry
   node bin\lsm.mjs start ergo-daemon
   node bin\lsm.mjs status                 # wait for ergo-daemon to be RUNNING, tier linked
   node bin\lsm.mjs autostart ergo-daemon on
   ```

- Once linked, the daemon reports its own health and whether it is busy: while a task is executing it shows **busy**, and **stop when idle** waits for it.
- The daemon's output is in `logs\ergo-daemon.out.log` under the supervisor's data directory, and live in the supervisor's web UI.
- If it is killed or crashes, the supervisor restarts it with backoff; work in progress resumes by its rules, and any operation that may or may not have completed is handed to you to confirm instead of being silently redone.

### Updating from source

```powershell
cd D:\apps\ergo
git pull
npm ci                  # when dependencies changed
npm run build:web
cd packages\supervisor
node bin\lsm.mjs restart ergo-daemon --when-idle   # restart once the task at hand is done
```

If only the web pages changed, the daemon doesn't need a restart.

## After installing

1. **Run the wizard**: open <http://127.0.0.1:8810/> (or `ergo open`) and go through the five steps of the **setup wizard**: language / how to address you / assistant name, model key (click test after filling it in), capabilities (tick which plugins and components you want: the embedding model and memory by default, voice off; models are downloaded here in the web page, not in the installer; this step also has the start-at-boot switch), pairing a phone by QR code, safe defaults, plus a screen on outside access. Any step can wait; re-enter any time from the top of **More · Settings**. See [Getting started](getting-started.en.md).
2. **Try it**: say "remind me to drink water in two minutes".
3. **Everyday commands**: `ergo start`, `ergo stop`, `ergo restart`, `ergo status`, `ergo logs`; for backups, `ergo backup` and `ergo restore` ([Backup](settings.en.md#backup)).
4. **When something's wrong**: check **More · Settings · Data & devices → Checkup** first; each item says how to fix it. Then see [Troubleshooting](#troubleshooting).

## Update

Your data (`%USERPROFILE%\.ergo`) is separate from the program, and updating leaves it alone. See [CHANGELOG](../../CHANGELOG.md) for what changed in each version.

### One-line installs

```powershell
ergo update --check   # only check whether there's a new version
ergo update           # update
ergo version          # see which version is running
```

`ergo update` looks up the latest version, downloads it into a new directory and verifies the signature, waits until ergo is idle (a running task isn't interrupted), switches over and restarts ergo with the autostart task pointing at the new version, and keeps the old version for rolling back. If ergo stays busy too long it gives up and the version in use doesn't change; just run it again later.

Options: `--version <version>` picks a version, `--mirror cn` tries npmmirror first (useful only once the npm package is published; for now it falls back to GitHub), `--from <url>` uses another release address.

A supervisor started by the autostart task keeps running the old version's program after an update (ergo itself is on the new version, so nothing breaks) and changes at the next login; the old version's folder it occupies can't be deleted until then, and `ergo update` says it will remove it next time.

### Other kinds of install

| How it was installed | How to update |
|---|---|
| `install.ps1 -FromSource` | `ergo update` (pulls new code, builds into a new directory, then switches) |
| Your own `git clone` | See [Updating from source](#updating-from-source) |
| npm (not published yet) | `npm i -g ergo-ai@latest` |
| Scoop, winget | `scoop update ergo`, `winget upgrade`; `ergo update` tells you the same |

### On your phone

For a new phone: on your computer, open **More · Settings · Device pairing**, choose **Show pairing code**, and tap **Scan to connect** in the ergo app on your phone (if it can't connect, the app says why).

Open pages (including a HarmonyOS app left open) offer to refresh within seconds, and refreshing gets you the new version. The app itself usually doesn't need reinstalling; its native parts and the script for giving commands on web pages are packaged with the app, so it only needs reinstalling when those change, and the CHANGELOG says so. On Android, download the new APK and install it over the old one; on HarmonyOS, build or sign it again and reinstall. See [Install the app](mobile.en.md#install-the-app).

### When an update goes wrong

If the switch fails, the version in use doesn't change and ergo starts as usual. Common cases are in [Troubleshooting](#troubleshooting).

## Roll back

```powershell
ergo rollback    # back to the previous version
```

Rolling back only changes the program, not your data. If the newer version changed a data format, the older one may not be able to read it, so check the [CHANGELOG](../../CHANGELOG.md) first. Which version is in use is decided by `current` (a one-line text file) in the install directory.

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

## Troubleshooting

**Run a checkup first**: **More · Settings · Data & devices → Checkup** runs eight checks — ports, Node, pi, the service manager, the model key, components, disk, outside access — and gives the fact it found plus how to fix each one; **Run again** is in the top right. Everything it looks at is local: no network (other than probing ergo's own ports), no model calls, no settings changed.

**Logs**: the daemon's output is in `logs\ergo-daemon.out.log` under the supervisor's data directory, and live in the supervisor's web UI; ergo's own health: <http://127.0.0.1:8810/healthz>.

| Symptom | Likely cause | Fix |
|---|---|---|
| The daemon won't start; the first log line says "Windows only" or the Node version is wrong | Wrong OS or Node | Use Windows 10 / 11 and Node 22 (≥ 22.19); check that `<专用 Node 路径>` in the entry points to it |
| Won't start: port in use | 8810 / 8811 taken by another program (name and PID are in the log; if they can't be found, the log says someone holds the port but it can't tell who) | Close it, or change `ports` (and both 8810s in the entry) |
| Won't start: another instance uses the same data directory | One was started by hand, or an old one didn't exit | Stop it (supervisor web UI or Task Manager), then let the supervisor start ergo |
| The page shows 503 and says `npm run build:web` | The web UI isn't built | Run `npm run build:web` in the ergo directory |
| The page only says "This page has to be opened through ergo" | You double-clicked `index.html` in the install folder | Run `ergo start`, then open <http://127.0.0.1:8810> in your browser |
| It says "no model configured" or every reply errors | Key missing or wrong, or out of credit | Enter a new key under **Settings · Models** (or check `secrets\deepseek-api-key.txt`, just the key), then run the connection test |
| Commands in tasks keep failing: Git Bash not found | Git for Windows missing, or WSL's `bash` comes first on PATH | Install Git for Windows; `where bash` should list `C:\Program Files\Git\bin\bash.exe` first |
| Push-to-talk does nothing / recognition unavailable | Recognition model not installed, speech service not running; with faster-whisper: Python path not set, faster-whisper missing, GPU unavailable | See the status in **Settings · Voice**; set up per [Voice](voice.en.md) |
| Voice replies are text only | TTS service not running, or `voice.speech.model` is still the placeholder | See [Voice](voice.en.md); the note in the chat says why |
| Memory search misses things with similar meaning | Embedding model not installed | Install under **Settings · Components**, or `npm run download-model` |
| The phone can't open ergo or stays on the pairing page | Outside access not set up, or the request expired / was rate-limited | Make sure 8811 is what's exposed; approve the request in **Inbox** on the PC within 5 minutes; after repeated failures wait 10 minutes |
| The phone says it can't connect after scanning | The phone can't reach that address | Follow the hints on the screen: is Tailscale on for the phone and on the same tailnet; are ergo and the service manager running on the computer; is your VPS, tunnel or reverse proxy running |
| The phone says **this device has been revoked** | It was revoked under Device pairing | Tap **Request pairing** to apply again |
| The supervisor shows ergo yellow (degraded) | An enabled plugin failed to load | See `reasons` in `/healthz`, or the plugin's note in **Settings · Plugins** |
| Every backup says it wasn't copied to the sync folder | `backup.syncDir` is still the example placeholder, or the folder is missing | Pick another folder in **Settings · Backup**, or use **Clear** |
| Web tools say no browser was found | No Chrome / Edge, or installed somewhere unusual | Set its exe path in `web.browserPath` |
| Install or update won't go through: the antivirus says **unknown publisher**, kills the process, or the installed files vanish later | Security software such as 360 blocks programs it does not recognise (`bin\ergo.exe` or the whole install folder) | Add `%LOCALAPPDATA%\Programs\ergo` to the security software's trusted list and install again; if the command still runs, use `bin\ergo.cmd` (the same command as `ergo.exe`); or install from npm (`npm i -g ergo-ai`, needs Node 22). Your data is in `%USERPROFILE%\.ergo`; reinstalling leaves it alone |
| `ergo update` says it could not switch, or `ergo version` still shows the old version | The `current` file names a version that is not installed properly under `versions\` (half copied, edited by hand) | Check what `%LOCALAPPDATA%\Programs\ergo\current` says, whether that folder exists under `versions\` and has `ergo.json` in it; if not, run `ergo update` again, or install again (your data is untouched) |

**Reporting a problem**: [open an issue](https://github.com/catmaniii/ergo/issues/new/choose) on GitHub and fill in the template: ergo version (**Settings · About ergo**), Node version (`node -v`), pi version (`overrides` in the root `package.json`) and how you installed — the version, Node and pi are also on the checkup page at a glance. Please don't report security issues publicly; see [SECURITY.md](../../SECURITY.md).

