# ergo installer.
#
# One line (PowerShell 5.1+, no admin):
#   irm <release site>/install.ps1 | iex
# With options (iex cannot pass parameters; use a script block or environment variables):
#   & ([scriptblock]::Create((irm <release site>/install.ps1))) -Mirror cn
#   $env:ERGO_MIRROR = 'cn'; irm <release site>/install.ps1 | iex
#   (environment variables: ERGO_INSTALL_DIR, ERGO_MIRROR, ERGO_RELEASE_URL, ERGO_VERSION, ERGO_RELEASE_PUBKEY,
#    ERGO_INSTALL_FROM_SOURCE, ERGO_INSTALL_NO_PATH, ERGO_INSTALL_NO_AUTOSTART, ERGO_INSTALL_NO_START, ERGO_LANGUAGE)
#   powershell -ExecutionPolicy Bypass -File install.ps1 -FromSource -Ref main
#
# What it does (binary install):
#   1. find the release: latest.json on GitHub Releases or npmmirror (whichever answers faster; -Mirror cn|github forces one;
#      -BaseUrl <dir> uses your own: <dir>/latest.json and the files next to it);
#   2. download SHA256SUMS, SHA256SUMS.minisig and ergo-<version>-win-x64.zip;
#   3. verify the minisign signature of SHA256SUMS with the release public key (Ed25519 + BLAKE2b in C#, no extra programs),
#      then the zip's sha256 against SHA256SUMS;
#   4. extract to %LOCALAPPDATA%\Programs\ergo\versions\<version>\, write "current" (a one-line text file naming it),
#      copy ergo.exe / ergo.cmd into ...\ergo\bin and add that folder to the user PATH (no admin);
#   5. make the service manager start at login: "ergo svc install-autostart" (scheduled task LocalServiceManager).
#      -NoAutostart skips it. A task that points outside this install folder (your own service manager) is left alone;
#   6. run "ergo onboard": start ergo and say where to open the setup wizard (it lives in the web UI). -NoStart skips it
#      (-NoOnboard is the older name; ERGO_INSTALL_NO_ONBOARD still works). The first start also puts ergo on the service manager's
#      autostart list, so a -NoStart install does not bring ergo up after a restart until "ergo start" has run once;
#   7. print the version, the install folder, "current", the autostart state and what to do next.
# Steps 1-4 up to writing "current" decide whether the install worked: a failure there stops it with exit code 1 and the version in use
# unchanged. After that the new version is in place: a later step that fails says so and how to redo it, the rest still runs, exit code 0.
# -FromSource [-Ref <tag or branch>]: download the source zip (no git), use the system Node if it is the tested major version or
#   download a portable Node into the install folder (the system one is not touched), npm ci, npm run build, npm run ergo:install.
# Data stays in ~/.ergo (and the service manager's in %LOCALAPPDATA%\ergo\supervisor); installing, updating and uninstalling never touch it.
#
# This file is ASCII only on purpose: "irm | iex" and "powershell -File" on Windows PowerShell 5.1 decode it differently
# (no BOM allowed for iex, ANSI code page for -File). Chinese messages are written as \uXXXX and decoded at run time.
param(
  [string]$Version = '',
  [string]$InstallDir = '',
  [string]$Mirror = '',
  [string]$BaseUrl = '',
  [string]$NodeVersion = '',
  [switch]$UseSystemNode,
  [switch]$FromSource,
  [string]$Ref = '',
  [string]$SourceUrl = '',
  [string]$NodeDistUrl = '',
  [string]$PublicKey = '',
  [switch]$AllowUnsigned,
  [switch]$NoPath,
  [switch]$NoAutostart,
  [switch]$NoStart,
  [switch]$NoOnboard,
  [switch]$NoSwitch,
  [string]$Lang = ''
)

# ---- release constants (npm run release fills the public key into the published copy) ----
$ReleasePublicKey = ''
$GithubRepoUrl = 'https://github.com/catmaniii/ergo'
$NpmPlatformPackage = 'ergo-ai-win32-x64'
$NpmMirrorRegistry = 'https://registry.npmmirror.com'
# Node: the major version follows pi (ADR-0031); only tested versions are allowed
$DefaultNodeVersion = '22.23.4'
$TestedNodeVersions = @('22.23.4')
$MinNodeVersion = '22.19.0'

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ErgoMessages = @{
  notWindows = @('ergo \u73b0\u5728\u53ea\u652f\u6301 64 \u4f4d\u7684 Windows 10 / 11\u3002', 'ergo currently supports 64-bit Windows 10 / 11 only.')
  psTooOld = @('\u8981 PowerShell 5.1 \u6216\u66f4\u65b0\u7684\u7248\u672c\u3002', 'PowerShell 5.1 or newer is required.')
  installing = @('\u5b89\u88c5 ergo \u5230 {0}', 'Installing ergo into {0}')
  probing = @('\u770b\u770b GitHub \u548c npmmirror \u54ea\u4e2a\u5feb\u2026\u2026', 'Checking whether GitHub or npmmirror is faster...')
  source = @('\u4ece {0} \u4e0b\u8f7d', 'Downloading from {0}')
  indexFailed = @('\u4ece {0} \u67e5\u4e0d\u5230\u7248\u672c\uff1a{1}', 'Could not get the version list from {0}: {1}')
  noSource = @('\u54ea\u4e2a\u4e0b\u8f7d\u5730\u5740\u90fd\u4e0d\u884c\uff0c\u6ca1\u88c5\u3002', 'No download source worked; nothing was installed.')
  version = @('\u7248\u672c {0}\uff08\u81ea\u5e26 Node {1}\uff09', 'Version {0} (bundled Node {1})')
  downloading = @('\u4e0b\u8f7d {0}\u2026\u2026', 'Downloading {0}...')
  progress = @('\u5df2\u4e0b\u8f7d {0}%\uff08{1} / {2}\uff0c{3}/s\uff09', 'Downloaded {0}% ({1} / {2}, {3}/s)')
  progressNoTotal = @('\u5df2\u4e0b\u8f7d {0}\uff08{1}/s\uff09', 'Downloaded {0} ({1}/s)')
  downloadShort = @('\u8fde\u63a5\u4e2d\u9014\u65ad\u4e86\uff1a\u53ea\u6536\u5230 {0}\uff0c\u5e94\u8be5\u6709 {1}\u3002', 'The connection dropped: got {0} of {1}.')
  noPublicKey = @('\u8fd9\u4e2a\u5b89\u88c5\u811a\u672c\u91cc\u6ca1\u6709\u53d1\u5e03\u516c\u94a5\uff0c\u9a8c\u4e0d\u4e86\u7b7e\u540d\uff0c\u4e0d\u88c5\uff08\u81ea\u5df1\u642d\u7684\u53d1\u5e03\u5730\u5740\u7528 -PublicKey \u7ed9\u516c\u94a5\uff1b\u6216\u8005\u52a0 -AllowUnsigned\uff0c\u81ea\u5df1\u627f\u62c5\u98ce\u9669\uff09\u3002', 'This installer has no release public key, so the signature cannot be checked; not installing (give -PublicKey for a self-hosted release, or add -AllowUnsigned at your own risk).')
  verifyFailed = @('\u7b7e\u540d\u9a8c\u4e0d\u8fc7\uff0c\u4e0d\u88c5\uff1a{0}', 'Signature check failed; not installing: {0}')
  verified = @('\u7b7e\u540d\u5bf9\uff1a{0}', 'Signature OK: {0}')
  unsigned = @('\u6ca1\u9a8c\u7b7e\u540d\uff08-AllowUnsigned\uff09\uff0c\u53ea\u6838\u5bf9\u4e86\u6821\u9a8c\u503c\u3002', 'Signature not checked (-AllowUnsigned); only the checksum was verified.')
  hashFailed = @('{0} \u7684 sha256 \u548c\u6e05\u5355\u5bf9\u4e0d\u4e0a\uff0c\u4e0d\u88c5\u3002', 'The sha256 of {0} does not match the checksum list; not installing.')
  extracting = @('\u89e3\u5f00\u5230 {0}', 'Extracting to {0}')
  badPackage = @('\u53d1\u5e03\u5305\u4e0d\u5bf9\uff08\u91cc\u9762\u7684\u7248\u672c\u4e0d\u662f {0}\uff09\u3002', 'The package is wrong (it does not contain version {0}).')
  nodeNotTested = @('Node {0} \u6ca1\u6d4b\u8fc7\uff0c\u53ea\u653e\u884c\uff1a{1}', 'Node {0} has not been tested; allowed versions: {1}')
  nodeDownloading = @('\u4e0b\u8f7d Node {0}\u2026\u2026', 'Downloading Node {0}...')
  nodeHashFailed = @('Node {0} \u7684\u6821\u9a8c\u503c\u5bf9\u4e0d\u4e0a\uff0c\u6ca1\u88c5\u3002', 'The checksum of Node {0} does not match; not installed.')
  systemNode = @('\u7528\u7cfb\u7edf\u7684 Node {0}\uff08{1}\uff09\uff1a\u6ca1\u6d4b\u8fc7\u7684\u7248\u672c\u51fa\u4e86\u95ee\u9898\u8981\u81ea\u5df1\u627f\u62c5\u3002', 'Using the system Node {0} ({1}); untested versions are at your own risk.')
  systemNodeMissing = @('PATH \u4e0a\u6ca1\u6709 node\uff0c\u6216\u8005\u7248\u672c\u6bd4 {0} \u65e7\u3002', 'No node on PATH, or it is older than {0}.')
  switched = @('\u5728\u7528\u7684\u7248\u672c\uff1a{0}', 'Active version: {0}')
  command = @('\u547d\u4ee4\uff1a{0}', 'Command: {0}')
  launcherCmd = @('ergo.exe \u8dd1\u4e0d\u8d77\u6765\uff08\u53ef\u80fd\u88ab\u6740\u6bd2\u8f6f\u4ef6\u62e6\u4e86\uff09\uff0c\u6539\u7528 ergo.cmd\u3002', 'ergo.exe does not run (maybe blocked by antivirus software); using ergo.cmd instead.')
  pathAdded = @('\u628a {0} \u52a0\u8fdb\u4e86\u7528\u6237 PATH\uff08\u65b0\u5f00\u7684\u7ec8\u7aef\u91cc\u5c31\u80fd\u7528 ergo\uff09\u3002', 'Added {0} to your user PATH (ergo works in new terminals).')
  pathSkipped = @('\u6ca1\u6539 PATH\uff08-NoPath\uff09\uff1a\u8981\u7528 ergo\uff0c\u628a {0} \u52a0\u8fdb PATH\uff0c\u6216\u8005\u76f4\u63a5\u8fd0\u884c {1}\u3002', 'PATH not changed (-NoPath): add {0} to PATH, or run {1} directly.')
  onboard = @('\u63a5\u7740\u8dd1 ergo onboard\u2026\u2026', 'Running ergo onboard...')
  binFailed = @('ergo \u547d\u4ee4\u6ca1\u653e\u8fdb bin \u76ee\u5f55\uff1a{0}\u3002\u5176\u4f59\u7167\u5e38\uff0c\u8fd9\u6b21\u5148\u7528 {1}\uff1b\u4e4b\u540e\u518d\u8dd1\u4e00\u6b21\u5b89\u88c5\u811a\u672c\u53ef\u4ee5\u91cd\u505a\u3002', 'Could not put the ergo command into the bin folder: {0}. The rest goes on using {1}; run this installer again to redo it.')
  pathFailed = @('\u6ca1\u628a {0} \u52a0\u8fdb\u7528\u6237 PATH\uff1a{1}\u3002\u5176\u4f59\u7167\u5e38\uff1b\u4e4b\u540e\u81ea\u5df1\u52a0\uff0c\u6216\u8005\u518d\u8dd1\u4e00\u6b21\u5b89\u88c5\u811a\u672c\u3002', 'Could not add {0} to your user PATH: {1}. The rest goes on; add it yourself later, or run this installer again.')
  ergoMissing = @('\u627e\u4e0d\u5230 {0}', '{0} not found')
  autostartOn = @('\u5df2\u8bbe\u6210\u5f00\u673a\u81ea\u542f\uff1a\u767b\u5f55 Windows \u65f6\u670d\u52a1\u7ba1\u5bb6\u5728\u540e\u53f0\u8d77\u6765\uff0c\u518d\u7531\u5b83\u62c9\u8d77\u4e8c\u72d7\u3002\u4e0d\u60f3\u8981\u53ef\u4ee5 ergo svc uninstall-autostart\uff08\u53ea\u662f\u4e0d\u60f3\u62c9\u8d77\u4e8c\u72d7\uff1aergo svc autostart ergo-daemon off\uff09\u3002', 'Autostart is on: the service manager starts in the background when you log in to Windows, and brings ergo up. To turn it off: ergo svc uninstall-autostart (to keep the service manager but not start ergo: ergo svc autostart ergo-daemon off).')
  autostartFailed = @('\u5f00\u673a\u81ea\u542f\u6ca1\u8bbe\u6210\uff1a{0}\u3002\u5176\u4f59\u7167\u5e38\uff0c\u53ea\u662f\u91cd\u542f\u7535\u8111\u540e\u8981\u81ea\u5df1 ergo start\uff1b\u4e4b\u540e\u53ef\u4ee5\u91cd\u505a\uff1aergo svc install-autostart\u3002', 'Autostart was not set up: {0}. The rest goes on, but after a restart you have to run ergo start yourself; to redo it: ergo svc install-autostart.')
  autostartElsewhere = @('\u8fd9\u53f0\u7535\u8111\u5df2\u7ecf\u6709\u5f00\u673a\u81ea\u542f\u4efb\u52a1 LocalServiceManager\uff0c\u6307\u7740\u522b\u5904\uff0c\u6ca1\u52a8\u5b83\uff1a{0}\u3002\u8981\u6362\u6210\u8fd9\u4e00\u4efd\uff1aergo svc install-autostart\u3002', 'This computer already has the autostart task LocalServiceManager pointing elsewhere; it was left alone: {0}. To replace it with this install: ergo svc install-autostart.')
  startFailed = @('\u4e8c\u72d7\u6ca1\u8d77\u6765\uff08{0}\uff09\u3002\u5176\u4f59\u7167\u5e38\uff1b\u4e4b\u540e\u53ef\u4ee5\u91cd\u505a\uff1aergo start\uff0c\u770b\u539f\u56e0\uff1aergo logs\u3002', 'ergo did not start ({0}). The rest goes on; to redo it: ergo start. To see why: ergo logs.')
  sumVersion = @('\u7248\u672c\uff1a{0}', 'Version: {0}')
  sumDir = @('\u5b89\u88c5\u76ee\u5f55\uff1a{0}', 'Install folder: {0}')
  sumCurrent = @('\u5728\u7528\u7684\u7248\u672c\uff08current\uff09\uff1a{0}', 'Version in use (current): {0}')
  sumAutostartOn = @('\u5f00\u673a\u81ea\u542f\uff1a\u5f00\u7740', 'Autostart: on')
  sumAutostartSkipped = @('\u5f00\u673a\u81ea\u542f\uff1a\u6ca1\u5f00\uff08-NoAutostart\uff09\uff0c\u60f3\u8981\uff1aergo svc install-autostart', 'Autostart: off (-NoAutostart); to turn it on: ergo svc install-autostart')
  sumAutostartElsewhere = @('\u5f00\u673a\u81ea\u542f\uff1a\u8fd9\u53f0\u7535\u8111\u4e0a\u5df2\u6709\u7684\u4efb\u52a1\u6307\u7740\u522b\u5904\uff0c\u6ca1\u52a8\u5b83', 'Autostart: the task already on this computer points elsewhere; left alone')
  sumAutostartFailed = @('\u5f00\u673a\u81ea\u542f\uff1a\u6ca1\u8bbe\u6210\uff0c\u91cd\u505a\uff1aergo svc install-autostart', 'Autostart: not set up; to redo it: ergo svc install-autostart')
  nextOpen = @('\u4e0b\u4e00\u6b65\uff1aergo open \u6253\u5f00\u7f51\u9875\uff0c\u8d70\u8bbe\u7f6e\u5411\u5bfc\u3002', 'Next: ergo open opens the web page; follow the setup wizard there.')
  nextNotStarted = @('\u4e0b\u4e00\u6b65\uff1aergo start \u628a\u4e8c\u72d7\u8d77\u6765\uff0c\u518d ergo open \u8d70\u8bbe\u7f6e\u5411\u5bfc\u3002\u7b2c\u4e00\u6b21\u88c5\u7684\u8bdd\uff0c\u8dd1\u8fc7\u4e00\u6b21 ergo start \u4e4b\u540e\u91cd\u542f\u7535\u8111\u5b83\u624d\u4f1a\u81ea\u5df1\u8d77\u6765\u3002', 'Next: ergo start brings ergo up, then ergo open and follow the setup wizard. On a first install, a restart brings it up only after ergo start has run once.')
  nextStartFailed = @('\u4e0b\u4e00\u6b65\uff1a\u89e3\u51b3\u4e0a\u9762\u6ca1\u8d77\u6765\u7684\u95ee\u9898\uff0c\u518d ergo start\u3001ergo open \u8d70\u8bbe\u7f6e\u5411\u5bfc\u3002', 'Next: sort out why it did not start (above), then ergo start and ergo open to follow the setup wizard.')
  done = @('\u88c5\u597d\u4e86\u3002\u4e4b\u540e\u7528 ergo start / stop / status / update / uninstall \u7ba1\u5b83\uff0cergo help \u770b\u5168\u90e8\u547d\u4ee4\u3002\u6570\u636e\u5728 ~/.ergo\uff0c\u5347\u7ea7\u3001\u5378\u8f7d\u90fd\u4e0d\u78b0\u3002', 'Done. Use ergo start / stop / status / update / uninstall from now on; ergo help lists every command. Your data lives in ~/.ergo and is never touched by updates or uninstalling.')
  failed = @('\u5b89\u88c5\u5931\u8d25\uff1a{0}', 'Installation failed: {0}')
  srcDownloading = @('\u4e0b\u8f7d\u6e90\u7801\uff08{0}\uff09\u2026\u2026', 'Downloading the source ({0})...')
  srcNode = @('\u6784\u5efa\u7528\u7684 Node\uff1a{0}', 'Node used for building: {0}')
  srcStep = @('{0}\u2026\u2026', '{0}...')
  srcFailed = @('{0} \u5931\u8d25\uff08\u9000\u51fa\u7801 {1}\uff09\u3002', '{0} failed (exit code {1}).')
  noSwitch = @('\u65b0\u7248\u672c\u5728 {0}\uff08\u6ca1\u5207\u8fc7\u53bb\uff1a-NoSwitch\uff09\u3002', 'The new version is in {0} (not switched: -NoSwitch).')
}

function Get-ErgoLang {
  if ($Lang) { return $Lang }
  if ($env:ERGO_LANGUAGE) { return $env:ERGO_LANGUAGE }
  if ((Get-UICulture).Name -like 'zh*') { return 'zh' }
  return 'en'
}
$script:ErgoZh = (Get-ErgoLang) -like 'zh*'

function M([string]$key) {
  $pair = $ErgoMessages[$key]
  if (-not $pair) { return $key }
  $text = if ($script:ErgoZh) { [regex]::Unescape($pair[0]) } else { $pair[1] }
  if ($args.Count -gt 0) { return ($text -f $args) }
  return $text
}

function Say([string]$text) { Write-Host $text }
function Warn([string]$text) { Write-Host $text -ForegroundColor Yellow }

# ---- C#: minisign verification (Ed25519 + BLAKE2b) and .tgz extraction; compiled by Windows' own C# compiler (Add-Type) ----
$ErgoCSharp = @'
// BEGIN ERGO CSHARP
using System;
using System.IO;
using System.IO.Compression;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;

namespace ErgoInstall
{
    public static class Blake2b
    {
        static readonly ulong[] IV = {
            0x6a09e667f3bcc908UL, 0xbb67ae8584caa73bUL, 0x3c6ef372fe94f82bUL, 0xa54ff53a5f1d36f1UL,
            0x510e527fade682d1UL, 0x9b05688c2b3e6c1fUL, 0x1f83d9abfb41bd6bUL, 0x5be0cd19137e2179UL };
        static readonly int[,] Sigma = {
            { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 },
            { 14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3 },
            { 11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4 },
            { 7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8 },
            { 9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13 },
            { 2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9 },
            { 12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11 },
            { 13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10 },
            { 6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5 },
            { 10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0 },
            { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 },
            { 14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3 } };

        static ulong Rot(ulong x, int n) { return (x >> n) | (x << (64 - n)); }

        static void G(ulong[] v, int a, int b, int c, int d, ulong x, ulong y)
        {
            v[a] = v[a] + v[b] + x; v[d] = Rot(v[d] ^ v[a], 32);
            v[c] = v[c] + v[d]; v[b] = Rot(v[b] ^ v[c], 24);
            v[a] = v[a] + v[b] + y; v[d] = Rot(v[d] ^ v[a], 16);
            v[c] = v[c] + v[d]; v[b] = Rot(v[b] ^ v[c], 63);
        }

        static void Compress(ulong[] h, byte[] block, ulong t, bool last)
        {
            ulong[] m = new ulong[16];
            for (int i = 0; i < 16; i++) m[i] = BitConverter.ToUInt64(block, i * 8);
            ulong[] v = new ulong[16];
            for (int i = 0; i < 8; i++) { v[i] = h[i]; v[i + 8] = IV[i]; }
            v[12] ^= t;
            if (last) v[14] = ~v[14];
            for (int r = 0; r < 12; r++)
            {
                G(v, 0, 4, 8, 12, m[Sigma[r, 0]], m[Sigma[r, 1]]);
                G(v, 1, 5, 9, 13, m[Sigma[r, 2]], m[Sigma[r, 3]]);
                G(v, 2, 6, 10, 14, m[Sigma[r, 4]], m[Sigma[r, 5]]);
                G(v, 3, 7, 11, 15, m[Sigma[r, 6]], m[Sigma[r, 7]]);
                G(v, 0, 5, 10, 15, m[Sigma[r, 8]], m[Sigma[r, 9]]);
                G(v, 1, 6, 11, 12, m[Sigma[r, 10]], m[Sigma[r, 11]]);
                G(v, 2, 7, 8, 13, m[Sigma[r, 12]], m[Sigma[r, 13]]);
                G(v, 3, 4, 9, 14, m[Sigma[r, 14]], m[Sigma[r, 15]]);
            }
            for (int i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
        }

        public static byte[] Hash(byte[] data, int outLen)
        {
            ulong[] h = (ulong[])IV.Clone();
            h[0] ^= 0x01010000UL ^ (ulong)outLen;
            int blocks = Math.Max(1, (data.Length + 127) / 128);
            byte[] block = new byte[128];
            for (int i = 0; i < blocks; i++)
            {
                int start = i * 128;
                bool last = i == blocks - 1;
                Array.Clear(block, 0, 128);
                int n = Math.Min(128, data.Length - start);
                if (n > 0) Array.Copy(data, start, block, 0, n);
                Compress(h, block, last ? (ulong)data.Length : (ulong)(start + 128), last);
            }
            byte[] result = new byte[outLen];
            for (int i = 0; i < outLen; i++) result[i] = (byte)(h[i / 8] >> (8 * (i % 8)));
            return result;
        }
    }

    public static class Ed25519
    {
        static readonly BigInteger P = BigInteger.Pow(2, 255) - 19;
        static readonly BigInteger L = BigInteger.Pow(2, 252) + BigInteger.Parse("27742317777372353535851937790883648493");
        static readonly BigInteger D = Mod(-121665 * Inv(121666));
        static readonly BigInteger SqrtM1 = BigInteger.ModPow(2, (P - 1) / 4, P);
        static readonly BigInteger[] Base;

        static Ed25519()
        {
            BigInteger by = Mod(4 * Inv(5));
            BigInteger bx = RecoverX(by, 0);
            Base = new BigInteger[] { bx, by, 1, Mod(bx * by) };
        }

        static BigInteger Mod(BigInteger a) { BigInteger r = BigInteger.Remainder(a, P); return r.Sign < 0 ? r + P : r; }
        static BigInteger Inv(BigInteger x) { return BigInteger.ModPow(Mod(x), P - 2, P); }

        static BigInteger RecoverX(BigInteger y, int sign)
        {
            if (y >= P) return BigInteger.MinusOne;
            BigInteger x2 = Mod((y * y - 1) * Inv(D * y * y + 1));
            if (x2.IsZero) return sign == 1 ? BigInteger.MinusOne : BigInteger.Zero;
            BigInteger x = BigInteger.ModPow(x2, (P + 3) / 8, P);
            if (!Mod(x * x - x2).IsZero) x = Mod(x * SqrtM1);
            if (!Mod(x * x - x2).IsZero) return BigInteger.MinusOne;
            if ((x.IsEven ? 0 : 1) != sign) x = P - x;
            return x;
        }

        static BigInteger[] Add(BigInteger[] a, BigInteger[] b)
        {
            BigInteger ea = Mod((a[1] - a[0]) * (b[1] - b[0]));
            BigInteger eb = Mod((a[1] + a[0]) * (b[1] + b[0]));
            BigInteger ec = Mod(a[3] * 2 * D * b[3]);
            BigInteger ed = Mod(a[2] * 2 * b[2]);
            BigInteger e = eb - ea, f = ed - ec, g = ed + ec, h = eb + ea;
            return new BigInteger[] { Mod(e * f), Mod(g * h), Mod(f * g), Mod(e * h) };
        }

        static BigInteger[] Mul(BigInteger s, BigInteger[] p)
        {
            BigInteger[] q = new BigInteger[] { BigInteger.Zero, BigInteger.One, BigInteger.One, BigInteger.Zero };
            while (s.Sign > 0)
            {
                if (!s.IsEven) q = Add(q, p);
                p = Add(p, p);
                s = s >> 1;
            }
            return q;
        }

        static bool Same(BigInteger[] a, BigInteger[] b)
        {
            return Mod(a[0] * b[2] - b[0] * a[2]).IsZero && Mod(a[1] * b[2] - b[1] * a[2]).IsZero;
        }

        static BigInteger FromLE(byte[] b, int off, int len)
        {
            byte[] t = new byte[len + 1];
            Array.Copy(b, off, t, 0, len);
            return new BigInteger(t);
        }

        static BigInteger[] Decompress(byte[] s, int off)
        {
            byte[] t = new byte[33];
            Array.Copy(s, off, t, 0, 32);
            int sign = t[31] >> 7;
            t[31] &= 0x7f;
            BigInteger y = new BigInteger(t);
            BigInteger x = RecoverX(y, sign);
            if (x.Sign < 0) return null;
            return new BigInteger[] { x, y, BigInteger.One, Mod(x * y) };
        }

        public static bool Verify(byte[] publicKey, byte[] message, byte[] signature)
        {
            if (publicKey.Length != 32 || signature.Length != 64) return false;
            BigInteger[] a = Decompress(publicKey, 0);
            if (a == null) return false;
            BigInteger[] r = Decompress(signature, 0);
            if (r == null) return false;
            BigInteger s = FromLE(signature, 32, 32);
            if (s >= L) return false;
            byte[] input = new byte[64 + message.Length];
            Array.Copy(signature, 0, input, 0, 32);
            Array.Copy(publicKey, 0, input, 32, 32);
            Array.Copy(message, 0, input, 64, message.Length);
            byte[] digest;
            using (SHA512 sha = SHA512.Create()) digest = sha.ComputeHash(input);
            BigInteger k = BigInteger.Remainder(FromLE(digest, 0, 64), L);
            return Same(Mul(s, Base), Add(r, Mul(k, a)));
        }
    }

    public static class Minisign
    {
        static string[] Lines(string text)
        {
            return text.Replace("\r\n", "\n").Trim((char)0xFEFF, '\n', ' ').Split('\n');
        }

        static byte[] PublicKeyBytes(string text)
        {
            string[] lines = Lines(text);
            string line = lines.Length >= 2 && lines[0].StartsWith("untrusted comment:") ? lines[1] : lines[0];
            byte[] raw = Convert.FromBase64String(line.Trim());
            if (raw.Length != 42 || raw[0] != (byte)'E' || raw[1] != (byte)'d') throw new FormatException("not a minisign Ed25519 public key");
            return raw;
        }

        // null when the signature is good, otherwise the reason; trustedComment gets the signed comment
        public static string Verify(string publicKeyText, string signatureText, byte[] message, out string trustedComment)
        {
            trustedComment = null;
            byte[] pk;
            try { pk = PublicKeyBytes(publicKeyText); } catch (Exception e) { return "bad public key: " + e.Message; }
            string[] lines = Lines(signatureText);
            if (lines.Length < 4 || !lines[0].StartsWith("untrusted comment:") || !lines[2].StartsWith("trusted comment: ")) return "bad signature file";
            byte[] sig;
            byte[] global;
            try { sig = Convert.FromBase64String(lines[1].Trim()); global = Convert.FromBase64String(lines[3].Trim()); } catch (FormatException) { return "bad signature file"; }
            if (sig.Length != 74 || global.Length != 64) return "bad signature length";
            bool prehashed = sig[0] == (byte)'E' && sig[1] == (byte)'D';
            bool legacy = sig[0] == (byte)'E' && sig[1] == (byte)'d';
            if (!prehashed && !legacy) return "unknown signature algorithm";
            for (int i = 0; i < 8; i++) if (sig[2 + i] != pk[2 + i]) return "signed by another key";
            byte[] key = new byte[32];
            Array.Copy(pk, 10, key, 0, 32);
            byte[] signature = new byte[64];
            Array.Copy(sig, 10, signature, 0, 64);
            byte[] signedData = prehashed ? Blake2b.Hash(message, 64) : message;
            if (!Ed25519.Verify(key, signedData, signature)) return "signature does not match the content";
            string comment = lines[2].Substring("trusted comment: ".Length);
            byte[] commentBytes = Encoding.UTF8.GetBytes(comment);
            byte[] both = new byte[64 + commentBytes.Length];
            Array.Copy(signature, 0, both, 0, 64);
            Array.Copy(commentBytes, 0, both, 64, commentBytes.Length);
            if (!Ed25519.Verify(key, both, global)) return "trusted comment was modified";
            trustedComment = comment;
            return null;
        }
    }

    public static class Tgz
    {
        static bool ReadFull(Stream s, byte[] buf, int len)
        {
            int done = 0;
            while (done < len)
            {
                int n = s.Read(buf, done, len - done);
                if (n <= 0) return false;
                done += n;
            }
            return true;
        }

        static string Str(byte[] b, int off, int len)
        {
            int end = off;
            while (end < off + len && b[end] != 0) end++;
            return Encoding.UTF8.GetString(b, off, end - off);
        }

        static long Octal(byte[] b, int off, int len)
        {
            string s = Str(b, off, len).Trim(' ', '\0');
            return s.Length == 0 ? 0 : Convert.ToInt64(s, 8);
        }

        static void Skip(Stream s, long n)
        {
            byte[] buf = new byte[8192];
            while (n > 0)
            {
                int k = s.Read(buf, 0, (int)Math.Min(buf.Length, n));
                if (k <= 0) throw new EndOfStreamException("tar ended early");
                n -= k;
            }
        }

        // extract a .tgz (npm tarball) into dest, dropping the first `strip` path parts; unsafe paths throw
        public static int Extract(string file, string dest, int strip)
        {
            int files = 0;
            byte[] header = new byte[512];
            string nextName = null;
            using (FileStream fs = File.OpenRead(file))
            using (GZipStream gz = new GZipStream(fs, CompressionMode.Decompress))
            {
                while (ReadFull(gz, header, 512))
                {
                    bool empty = true;
                    for (int i = 0; i < 512; i++) if (header[i] != 0) { empty = false; break; }
                    if (empty) break;
                    string name = Str(header, 0, 100);
                    string prefix = Str(header, 345, 155);
                    long size = Octal(header, 124, 12);
                    char type = (char)header[156];
                    long padded = (size + 511) / 512 * 512;
                    if (type == 'L' || type == 'x')
                    {
                        byte[] data = new byte[size];
                        if (!ReadFull(gz, data, (int)size)) throw new EndOfStreamException("tar ended early");
                        Skip(gz, padded - size);
                        string text = Encoding.UTF8.GetString(data);
                        if (type == 'L') nextName = text.TrimEnd('\0');
                        else
                        {
                            foreach (string rec in text.Split('\n'))
                            {
                                int eq = rec.IndexOf(" path=");
                                if (eq >= 0) nextName = rec.Substring(eq + 6);
                            }
                        }
                        continue;
                    }
                    if (nextName != null) { name = nextName; nextName = null; }
                    else if (prefix.Length > 0) name = prefix + "/" + name;
                    string[] parts = name.Replace('\\', '/').Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length <= strip) { Skip(gz, padded); continue; }
                    foreach (string p in parts) if (p == ".." || p.Contains(":")) throw new InvalidDataException("unsafe path in archive: " + name);
                    string rel = string.Join("\\", parts, strip, parts.Length - strip);
                    string target = Path.Combine(dest, rel);
                    if (type == '5') { Directory.CreateDirectory(target); Skip(gz, padded); continue; }
                    if (type != '0' && type != '\0') { Skip(gz, padded); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (FileStream o = File.Create(target))
                    {
                        byte[] buf = new byte[81920];
                        long left = size;
                        while (left > 0)
                        {
                            int k = gz.Read(buf, 0, (int)Math.Min(buf.Length, left));
                            if (k <= 0) throw new EndOfStreamException("tar ended early");
                            o.Write(buf, 0, k);
                            left -= k;
                        }
                    }
                    Skip(gz, padded - size);
                    files++;
                }
            }
            return files;
        }
    }
}
// END ERGO CSHARP
'@

function Initialize-ErgoCSharp {
  if (-not ('ErgoInstall.Minisign' -as [type])) {
    Add-Type -TypeDefinition $ErgoCSharp -ReferencedAssemblies System.Numerics -Language CSharp
  }
}

# ---- small helpers ----
function Enable-Tls12 {
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch { }
}

function New-WebClient {
  $wc = New-Object System.Net.WebClient
  $wc.Headers['User-Agent'] = 'ergo-installer'
  $wc.Proxy = [System.Net.WebRequest]::GetSystemWebProxy()
  $wc.Proxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials
  return $wc
}

function Get-Bytes([string]$url) { return (New-WebClient).DownloadData($url) }
function Get-Utf8([string]$url) { return [Text.Encoding]::UTF8.GetString((Get-Bytes $url)) }

function Format-Size([double]$bytes) {
  if ($bytes -ge 1GB) { return '{0:0.00} GB' -f ($bytes / 1GB) }
  if ($bytes -ge 1MB) { return '{0:0.0} MB' -f ($bytes / 1MB) }
  if ($bytes -ge 1KB) { return '{0:0} KB' -f ($bytes / 1KB) }
  return '{0:0} B' -f $bytes
}

function Show-DownloadProgress($state, [long]$got, [double]$bytesPerSecond) {
  $speed = Format-Size $bytesPerSecond
  if ($state.total -gt 0) {
    $percent = [math]::Floor([double]$got * 100 / $state.total)
    $line = '  ' + (M 'progress' $percent (Format-Size $got) (Format-Size $state.total) $speed)
  } else {
    $line = '  ' + (M 'progressNoTotal' (Format-Size $got) $speed)
  }
  if (-not $state.live) { Say $line; return }
  # pad to the longest line so far: a shorter line must not leave the tail of the previous one on screen
  $state.width = [math]::Max($state.width, $line.Length)
  Write-Host -NoNewline ("`r" + $line.PadRight($state.width))
}

# Downloads in chunks so the person can see it moving: percent, done / total and speed (no length from the server: done and speed).
# In a console one line refreshes in place; when the output is redirected it prints a line every 10% (no length: every 10 MB).
# Same WebClient as every other request here: User-Agent, system proxy with default credentials, default timeouts
# (Stream.Read honours the 5-minute read timeout; ReadAsync would not, so a stalled connection freezes the line until then).
# A failed or interrupted download leaves no file behind.
function Save-Url([string]$url, [string]$file) {
  $wc = New-WebClient
  $stream = $null
  $out = $null
  $complete = $false
  $state = @{ live = -not [Console]::IsOutputRedirected; total = [long]0; width = 0 }
  try {
    $stream = $wc.OpenRead($url)
    $length = [long]0
    if ([long]::TryParse([string]$wc.ResponseHeaders['Content-Length'], [ref]$length)) { $state.total = $length }
    $out = [IO.File]::Create($file)
    $buffer = New-Object byte[] 65536
    $stepSize = if ($state.total -gt 0) { [double]$state.total / 10 } else { [double]10MB }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    [long]$got = 0
    [long]$markGot = 0
    [double]$markTime = 0
    [double]$step = 0
    while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $out.Write($buffer, 0, $count)
      $got += $count
      $now = $clock.Elapsed.TotalSeconds
      $nextStep = [math]::Floor($got / $stepSize)
      $due = if ($state.live) { ($now - $markTime) -ge 0.5 } else { $nextStep -gt $step }
      # the very last line comes after the loop, with the average speed of the whole download
      if ($due -and $got -ne $state.total) {
        Show-DownloadProgress $state $got (($got - $markGot) / [math]::Max($now - $markTime, 0.001))
        $markGot = $got
        $markTime = $now
        $step = $nextStep
      }
    }
    # .NET's read just ends when the connection drops early, without an error: the length is the only way to notice
    if ($state.total -gt 0 -and $got -ne $state.total) { throw (M 'downloadShort' (Format-Size $got) (Format-Size $state.total)) }
    Show-DownloadProgress $state $got ($got / [math]::Max($clock.Elapsed.TotalSeconds, 0.001))
    $out.Dispose()
    $complete = $true
  } finally {
    if ($out) { $out.Dispose() }
    if ($stream) { $stream.Dispose() }
    $wc.Dispose()
    if ($out -and -not $complete) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
    # end the refreshing line, so what is printed next (also an error) starts on its own line
    if ($state.width -gt 0) { Write-Host '' }
  }
}

function Get-Sha256([string]$file) {
  # Not Get-FileHash: it lives in an auto-loaded module, and on a bare Windows Server runner that lookup fails
  # ("The term 'Get-FileHash' is not recognized", 2026-10-30). .NET always works.
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($file)
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
}

function Compare-Version([string]$a, [string]$b) {
  $x = [version](($a -replace '^v', '') -replace '-.*$', '')
  $y = [version](($b -replace '^v', '') -replace '-.*$', '')
  return $x.CompareTo($y)
}

function Read-Sums([string]$text) {
  $map = @{}
  foreach ($line in ($text -split "`r?`n")) {
    if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$') { $map[$Matches[2]] = $Matches[1].ToLowerInvariant() }
  }
  return $map
}

# antivirus software scanning a freshly extracted folder can briefly refuse rename operations: retry for a few seconds
function Invoke-Retrying([scriptblock]$action) {
  for ($i = 0; ; $i++) {
    try { & $action; return } catch { if ($i -ge 50) { throw } ; Start-Sleep -Milliseconds 100 }
  }
}

# switching versions: "current" is a one-line text file naming the version directory in use.
# It used to be a directory junction, but creating one after starting through the launcher (PowerShell -> ergo.exe -> node)
# is refused by antivirus software (EPERM); a text file cannot be blocked that way.
# Older installs have a junction there; it is removed first.
function Set-Current([string]$root, [string]$name) {
  $current = Join-Path $root 'current'
  $fresh = "$current.tmp"
  if (Test-Path -LiteralPath $fresh) { Remove-OldCurrent $fresh }
  Remove-OldCurrent $current
  # Write "current" directly and verify it right away. It used to be "write current.tmp, then Rename it into place":
  # when something else holds the file, Rename raises a NON-terminating error, so Invoke-Retrying's catch never
  # sees it and the script keeps going - the install "succeeds" with no "current" at all (CI on Windows Server 2025,
  # 2026-10-30; not reproducible here). Fail loudly instead of pretending the install worked.
  # (ASCII only: this file is read as ANSI by Windows PowerShell 5.1, so no non-ASCII comments.)
  Invoke-Retrying {
    [IO.File]::WriteAllText($current, $name + "`n", (New-Object Text.UTF8Encoding $false))
    if (-not (Test-Path -LiteralPath $current)) { throw "current not written: $current" }
  }
}

# remove "current" itself (or a leftover from a failed switch): junction (older installs) or text file
function Remove-OldCurrent([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $item = Get-Item -LiteralPath $path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { cmd /c rmdir "$path" | Out-Null }
  else { Remove-Item -LiteralPath $path -Force }
}

function Read-InstallState([string]$root) {
  $file = Join-Path $root 'install.json'
  if (Test-Path -LiteralPath $file) { try { return (Get-Content -Raw -LiteralPath $file | ConvertFrom-Json) } catch { } }
  return New-Object psobject -Property @{ format = 1 }
}

function Write-InstallState([string]$root, $state) {
  $json = $state | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText((Join-Path $root 'install.json'), $json + "`n", (New-Object Text.UTF8Encoding $false))
}

function Set-StateField($state, [string]$name, $value) {
  if ($state.PSObject.Properties[$name]) { $state.$name = $value } else { $state | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}

# user PATH in HKCU\Environment, keeping REG_EXPAND_SZ and the %VARS% in it
function Add-UserPath([string]$dir) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  $old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $parts = @($old -split ';' | Where-Object { $_ -ne '' })
  foreach ($p in $parts) { if ($p.TrimEnd('\') -ieq $dir.TrimEnd('\')) { $key.Close(); return $false } }
  $key.SetValue('Path', (($parts + $dir) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
  $key.Close()
  # broadcast "environment changed" so new terminals see it
  [Environment]::SetEnvironmentVariable('ERGO_PATH_BROADCAST', '1', 'User')
  [Environment]::SetEnvironmentVariable('ERGO_PATH_BROADCAST', $null, 'User')
  return $true
}

# ---- release sources ----
function Get-ReleaseSource([string]$id) {
  if ($id -eq 'url') { return @{ id = 'url'; title = $BaseUrl.TrimEnd('/') } }
  if ($id -eq 'npmmirror') { return @{ id = 'npmmirror'; title = 'npmmirror' } }
  return @{ id = 'github'; title = 'GitHub' }
}

function Get-ReleaseIndex($source, [string]$ver) {
  switch ($source.id) {
    'url' {
      $dir = $BaseUrl.TrimEnd('/')
      if ($ver) { $dir = "$dir/$ver" }
      $source.filesBase = $dir
      return (Get-Utf8 "$dir/latest.json" | ConvertFrom-Json)
    }
    'github' {
      $url = if ($ver) { "$GithubRepoUrl/releases/download/v$ver/latest.json" } else { "$GithubRepoUrl/releases/latest/download/latest.json" }
      $index = Get-Utf8 $url | ConvertFrom-Json
      $source.filesBase = "$GithubRepoUrl/releases/download/v$($index.version)"
      return $index
    }
    'npmmirror' {
      $tag = if ($ver) { $ver } else { 'latest' }
      $doc = Get-Utf8 "$NpmMirrorRegistry/$NpmPlatformPackage/$tag" | ConvertFrom-Json
      $source.tarball = $doc.dist.tarball
      $source.integrity = $doc.dist.integrity
      return $doc.ergo
    }
  }
}

function Select-Sources {
  if ($BaseUrl) { return @(Get-ReleaseSource 'url') }
  $gh = Get-ReleaseSource 'github'
  $npm = Get-ReleaseSource 'npmmirror'
  if ($Mirror -eq 'cn') { return @($npm, $gh) }
  if ($Mirror -eq 'github') { return @($gh, $npm) }
  Say (M 'probing')
  $times = @{}
  foreach ($s in @($gh, $npm)) {
    $url = if ($s.id -eq 'github') { "$GithubRepoUrl/releases/latest/download/latest.json" } else { "$NpmMirrorRegistry/$NpmPlatformPackage/latest" }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try { Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 8 | Out-Null; $times[$s.id] = $sw.ElapsedMilliseconds } catch { $times[$s.id] = [int]::MaxValue }
  }
  if ($times['npmmirror'] -lt $times['github']) { return @($npm, $gh) }
  return @($gh, $npm)
}

# download latest.json's files into $dir; returns the zip path
function Save-Release($source, $index, [string]$dir) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  if ($source.id -eq 'npmmirror') {
    $tgz = Join-Path $dir 'package.tgz'
    Say (M 'downloading' $source.tarball)
    Save-Url $source.tarball $tgz
    if ($source.integrity -and $source.integrity.StartsWith('sha512-')) {
      $sha = [Security.Cryptography.SHA512]::Create()
      $stream = [IO.File]::OpenRead($tgz)
      try { $got = 'sha512-' + [Convert]::ToBase64String($sha.ComputeHash($stream)) } finally { $stream.Close() }
      if ($got -ne $source.integrity) { throw (M 'hashFailed' $tgz) }
    }
    [ErgoInstall.Tgz]::Extract($tgz, $dir, 1) | Out-Null
    Remove-Item -LiteralPath $tgz -Force
  } else {
    foreach ($name in @($index.files.sums, $index.files.signature, $index.files.zip)) {
      Say (M 'downloading' $name)
      Save-Url "$($source.filesBase)/$name" (Join-Path $dir $name)
    }
  }
  return (Join-Path $dir $index.files.zip)
}

function Get-PublicKeyText {
  if ($PublicKey) { return $PublicKey }
  if ($env:ERGO_RELEASE_PUBKEY) { return $env:ERGO_RELEASE_PUBKEY }
  return $ReleasePublicKey
}

function Test-Release($index, [string]$dir) {
  $sumsFile = Join-Path $dir $index.files.sums
  $sumsBytes = [IO.File]::ReadAllBytes($sumsFile)
  $key = Get-PublicKeyText
  if ($key) {
    $sig = [IO.File]::ReadAllText((Join-Path $dir $index.files.signature))
    $comment = $null
    $why = [ErgoInstall.Minisign]::Verify($key, $sig, $sumsBytes, [ref]$comment)
    if ($why) { throw (M 'verifyFailed' $why) }
    Say (M 'verified' $comment)
  } elseif ($AllowUnsigned) {
    Warn (M 'unsigned')
  } else {
    throw (M 'noPublicKey')
  }
  $sums = Read-Sums ([Text.Encoding]::UTF8.GetString($sumsBytes))
  $zip = Join-Path $dir $index.files.zip
  if ($sums[$index.files.zip] -ne (Get-Sha256 $zip)) { throw (M 'hashFailed' $index.files.zip) }
}

# ---- Node ----
function Get-NodeDistBase {
  if ($NodeDistUrl) { return $NodeDistUrl.TrimEnd('/') }
  if ($Mirror -eq 'cn') { return 'https://npmmirror.com/mirrors/node' }
  return 'https://nodejs.org/dist'
}

# download the official Node zip (checked against SHASUMS256.txt) and extract it to $dest; returns the folder with node.exe
function Install-PortableNode([string]$ver, [string]$dest) {
  $base = "$(Get-NodeDistBase)/v$ver"
  $name = "node-v$ver-win-x64.zip"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("ergo-node-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    Say (M 'nodeDownloading' $ver)
    $sums = Read-Sums (Get-Utf8 "$base/SHASUMS256.txt")
    $zip = Join-Path $tmp $name
    Save-Url "$base/$name" $zip
    if ($sums[$name] -ne (Get-Sha256 $zip)) { throw (M 'nodeHashFailed' $ver) }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmp)
    $inner = Join-Path $tmp "node-v$ver-win-x64"
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    Move-Item -LiteralPath $inner -Destination $dest
    return $dest
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Get-SystemNode {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { return $null }
  $ver = (& $cmd.Source --version).Trim().TrimStart('v')
  if ((Compare-Version $ver $MinNodeVersion) -lt 0) { return $null }
  return @{ exe = $cmd.Source; version = $ver }
}

# ---- launcher, PATH, onboard ----
function Install-Bin([string]$root, [string]$versionDir) {
  $bin = Join-Path $root 'bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  Copy-Item -LiteralPath (Join-Path $versionDir 'ergo.cmd') -Destination (Join-Path $bin 'ergo.cmd') -Force
  $exe = Join-Path $versionDir 'ergo.exe'
  $binExe = Join-Path $bin 'ergo.exe'
  if (Test-Path -LiteralPath $exe) {
    Copy-Item -LiteralPath $exe -Destination $binExe -Force
    $ok = $false
    try { $out = & $binExe version 2>$null; $ok = ($LASTEXITCODE -eq 0) -and ($out -match 'ergo') } catch { $ok = $false }
    if (-not $ok) {
      Warn (M 'launcherCmd')
      Remove-Item -LiteralPath $binExe -Force -ErrorAction SilentlyContinue
    }
  } elseif (Test-Path -LiteralPath $binExe) {
    Remove-Item -LiteralPath $binExe -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $binExe) { return $binExe }
  return (Join-Path $bin 'ergo.cmd')
}

# run ergo and hand back its exit code and output, here (not as an error) even when it writes to stderr or fails.
# Node writes UTF-8 whatever the console's code page is; PowerShell decodes piped output with OutputEncoding, so set it for the call.
function Invoke-Ergo([string]$ergo, [string[]]$arguments, [bool]$show) {
  if (-not (Test-Path -LiteralPath $ergo)) { return @{ code = -1; text = (M 'ergoMissing' $ergo) } }
  $ErrorActionPreference = 'Continue'
  $saved = $null
  try { $saved = [Console]::OutputEncoding; [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch { }
  try {
    $lines = New-Object Collections.ArrayList
    & $ergo @arguments 2>&1 | ForEach-Object {
      $text = ("$_" -replace "$([char]27)\[[0-9;]*m", '')
      [void]$lines.Add($text)
      if ($show) { Write-Host $text }
    }
    return @{ code = $LASTEXITCODE; text = ($lines -join ' ').Trim() }
  } finally {
    if ($saved) { try { [Console]::OutputEncoding = $saved } catch { } }
  }
}

# what the scheduled task runs now ('' when there is none). ERGO_AUTOSTART_TASK_FILE: a JSON file stands in for the task, the same one
# the ergo command honours; tests use it, because the task's name is fixed and a development machine has a real one.
function Get-AutostartAction {
  if ($env:ERGO_AUTOSTART_TASK_FILE) {
    if (-not (Test-Path -LiteralPath $env:ERGO_AUTOSTART_TASK_FILE)) { return '' }
    return [string](Get-Content -Raw -LiteralPath $env:ERGO_AUTOSTART_TASK_FILE | ConvertFrom-Json).action
  }
  $task = Get-ScheduledTask -TaskName 'LocalServiceManager' -ErrorAction SilentlyContinue
  if (-not $task) { return '' }
  return (@($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)" }) -join ' | ')
}

# returns on / elsewhere / failed. Registering overwrites a task of the same name, so one that is not this install's stays as it is.
function Set-ErgoAutostart([string]$ergo, [string]$root) {
  try {
    $action = Get-AutostartAction
    if ($action -and -not $action.ToLowerInvariant().Contains($root.TrimEnd('\').ToLowerInvariant() + '\')) {
      Warn (M 'autostartElsewhere' $action)
      return 'elsewhere'
    }
    $r = Invoke-Ergo $ergo @('svc', 'install-autostart') $false
    if ($r.code -eq 0) {
      Say (M 'autostartOn')
      return 'on'
    }
    Warn (M 'autostartFailed' $r.text)
  } catch {
    Warn (M 'autostartFailed' $_.Exception.Message)
  }
  return 'failed'
}

# returns up / failed
function Start-ErgoOnboard([string]$ergo) {
  Say (M 'onboard')
  try {
    $r = Invoke-Ergo $ergo @('onboard') $true
    if ($r.code -eq 0) { return 'up' }
    Warn (M 'startFailed' $r.code)
  } catch {
    Warn (M 'startFailed' $_.Exception.Message)
  }
  return 'failed'
}

function Show-InstallSummary([string]$root, [string]$versionDir, [string]$name, [string]$autostart, [string]$started) {
  $shown = $name
  try { $shown = (Get-Content -Raw -LiteralPath (Join-Path $versionDir 'ergo.json') | ConvertFrom-Json).version } catch { }
  Say ''
  Say (M 'sumVersion' $shown)
  Say (M 'sumDir' $root)
  Say (M 'sumCurrent' $name)
  switch ($autostart) {
    'on' { Say (M 'sumAutostartOn') }
    'elsewhere' { Say (M 'sumAutostartElsewhere') }
    'failed' { Warn (M 'sumAutostartFailed') }
    default { Say (M 'sumAutostartSkipped') }
  }
  switch ($started) {
    'up' { Say (M 'nextOpen') }
    'failed' { Say (M 'nextStartFailed') }
    default { Say (M 'nextNotStarted') }
  }
}

# ---- the two install paths ----
function Install-Binary([string]$root) {
  $sources = Select-Sources
  $index = $null
  $source = $null
  $wanted = if ($Version) { $Version } elseif ($env:ERGO_VERSION) { $env:ERGO_VERSION } else { '' }
  foreach ($s in $sources) {
    try { $index = Get-ReleaseIndex $s $wanted.TrimStart('v'); $source = $s; break } catch { Warn (M 'indexFailed' $s.title $_.Exception.Message) }
  }
  if (-not $index) { throw (M 'noSource') }
  Say (M 'source' $source.title)
  Say (M 'version' $index.version $index.node)
  if ($NodeVersion -and ($index.nodeTested -notcontains $NodeVersion)) { throw (M 'nodeNotTested' $NodeVersion ($index.nodeTested -join ', ')) }

  $versions = Join-Path $root 'versions'
  $target = Join-Path $versions $index.version
  if (-not (Test-Path -LiteralPath (Join-Path $target 'ergo.json'))) {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("ergo-install-" + [guid]::NewGuid())
    try {
      $zip = Save-Release $source $index $tmp
      Test-Release $index $tmp
      $partial = "$target.partial"
      if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Recurse -Force }
      New-Item -ItemType Directory -Force -Path $versions | Out-Null
      Say (M 'extracting' $target)
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      [IO.Compression.ZipFile]::ExtractToDirectory($zip, $partial)
      $info = Get-Content -Raw -LiteralPath (Join-Path $partial 'ergo.json') | ConvertFrom-Json
      if ($info.version -ne $index.version) { throw (M 'badPackage' $index.version) }
      $newName = $index.version
      Invoke-Retrying { Rename-Item -LiteralPath $partial -NewName $newName }
    } finally {
      Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  if ($NodeVersion -and $NodeVersion -ne $index.node) {
    Install-PortableNode $NodeVersion (Join-Path $target 'node') | Out-Null
  }
  $state = Read-InstallState $root
  $src = @{}
  if ($BaseUrl) { $src.url = $BaseUrl.TrimEnd('/') }
  if ($Mirror) { $src.mirror = $Mirror }
  Set-StateField $state 'source' $src
  Set-StateField $state 'installedBy' 'install.ps1'
  Write-InstallState $root $state
  return $index.version
}

function Install-FromSource([string]$root) {
  $refName = if ($Ref) { $Ref } else { 'main' }
  $url = if ($SourceUrl) { $SourceUrl } else { "$GithubRepoUrl/archive/$refName.zip" }
  $stamp = Get-Date -Format 'yyyyMMddHHmmss'
  $srcRoot = Join-Path $root 'src'
  $work = Join-Path $srcRoot "$($refName -replace '[^A-Za-z0-9._-]', '_')-$stamp"
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  Say (M 'srcDownloading' $url)
  $zip = Join-Path $work 'source.zip'
  Save-Url $url $zip
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $unpacked = Join-Path $work 'unpacked'
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, $unpacked)
  Remove-Item -LiteralPath $zip -Force
  $top = @(Get-ChildItem -LiteralPath $unpacked -Directory)
  $repo = if ($top.Count -eq 1 -and -not (Test-Path (Join-Path $unpacked 'package.json'))) { $top[0].FullName } else { $unpacked }

  # Node for building: the system one if it is the tested major version, otherwise a portable one in the install folder
  $wantedNode = if ($NodeVersion) { $NodeVersion } else { $DefaultNodeVersion }
  if ($TestedNodeVersions -notcontains $wantedNode) { throw (M 'nodeNotTested' $wantedNode ($TestedNodeVersions -join ', ')) }
  $nodeDir = $null
  $sys = Get-SystemNode
  if ($UseSystemNode -and -not $sys) { throw (M 'systemNodeMissing' $MinNodeVersion) }
  if ($sys -and ($UseSystemNode -or ($sys.version.Split('.')[0] -eq $wantedNode.Split('.')[0] -and -not $NodeVersion))) {
    $nodeDir = Split-Path $sys.exe
    if ($UseSystemNode) { Warn (M 'systemNode' $sys.version $sys.exe) }
  } else {
    $nodeDir = Join-Path (Join-Path $root 'node') "v$wantedNode"
    if (-not (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe'))) { Install-PortableNode $wantedNode $nodeDir | Out-Null }
  }
  Say (M 'srcNode' (Join-Path $nodeDir 'node.exe'))
  $env:Path = "$nodeDir;$env:Path"
  $npm = Join-Path $nodeDir 'npm.cmd'
  $registry = @()
  if ($Mirror -eq 'cn') { $registry = @('--registry=https://registry.npmmirror.com') }
  $steps = @(
    @{ name = 'npm ci'; args = @('ci', '--no-audit', '--no-fund') + $registry },
    @{ name = 'npm run build'; args = @('run', 'build') },
    @{ name = 'npm run ergo:install'; args = @('run', 'ergo:install', '--', '--install-dir', $root, '--no-switch', '--no-path', '--ref', $refName) }
  )
  Push-Location $repo
  try {
    foreach ($step in $steps) {
      Say (M 'srcStep' $step.name)
      & $npm @($step.args) | Out-Host
      if ($LASTEXITCODE -ne 0) { throw (M 'srcFailed' $step.name $LASTEXITCODE) }
    }
  } finally {
    Pop-Location
  }
  # keep this installer next to the install for "ergo update" of source installs
  $self = Join-Path $repo 'packages\daemon\installer\install.ps1'
  if (Test-Path -LiteralPath $self) { Copy-Item -LiteralPath $self -Destination (Join-Path $root 'install.ps1') -Force }
  $built = Get-Content -Raw -LiteralPath (Join-Path $root 'versions\.last-built') -ErrorAction Stop
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  $state = Read-InstallState $root
  Set-StateField $state 'installedBy' 'install.ps1 -FromSource'
  Write-InstallState $root $state
  return $built.Trim()
}

function Install-Ergo {
  if (-not [Environment]::Is64BitOperatingSystem -or $env:OS -ne 'Windows_NT') { throw (M 'notWindows') }
  if ($PSVersionTable.PSVersion.Major -lt 5) { throw (M 'psTooOld') }
  Enable-Tls12
  Initialize-ErgoCSharp
  $root = if ($InstallDir) { $InstallDir } elseif ($env:ERGO_INSTALL_DIR) { $env:ERGO_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\ergo' }
  $root = [IO.Path]::GetFullPath($root)
  if (-not $script:Mirror -and $env:ERGO_MIRROR) { $script:Mirror = $env:ERGO_MIRROR }
  if (-not $script:BaseUrl -and $env:ERGO_RELEASE_URL) { $script:BaseUrl = $env:ERGO_RELEASE_URL }
  # switches can also come from environment variables (irm | iex cannot pass parameters)
  $fromSrc = $FromSource -or [bool]$env:ERGO_INSTALL_FROM_SOURCE
  $noPathSet = $NoPath -or [bool]$env:ERGO_INSTALL_NO_PATH
  $noAutostartSet = $NoAutostart -or [bool]$env:ERGO_INSTALL_NO_AUTOSTART
  $noStartSet = $NoStart -or $NoOnboard -or [bool]$env:ERGO_INSTALL_NO_START -or [bool]$env:ERGO_INSTALL_NO_ONBOARD
  Say (M 'installing' $root)
  New-Item -ItemType Directory -Force -Path $root | Out-Null

  $name = if ($fromSrc) { Install-FromSource $root } else { Install-Binary $root }
  $versionDir = Join-Path (Join-Path $root 'versions') $name

  if ($UseSystemNode -and -not $fromSrc) {
    $sys = Get-SystemNode
    if (-not $sys) { throw (M 'systemNodeMissing' $MinNodeVersion) }
    Warn (M 'systemNode' $sys.version $sys.exe)
    [IO.File]::WriteAllText((Join-Path $versionDir 'node.path'), $sys.exe)
    Remove-Item -LiteralPath (Join-Path $versionDir 'node') -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($NoSwitch) {
    Say (M 'noSwitch' $versionDir)
    return 0
  }
  Set-Current $root $name
  Say (M 'switched' $name)

  # The new version is in place. From here on a step that fails says so and how to redo it; the rest still runs and the install still counts.
  # (A version directory's own ergo.cmd works too, so a failed copy into bin does not stop the steps after it.)
  $ergo = Join-Path $versionDir 'ergo.cmd'
  try {
    $ergo = Install-Bin $root $versionDir
    Say (M 'command' $ergo)
  } catch {
    Warn (M 'binFailed' $_.Exception.Message $ergo)
  }
  $bin = Join-Path $root 'bin'
  if ($noPathSet) {
    Say (M 'pathSkipped' $bin $ergo)
  } else {
    try {
      if (Add-UserPath $bin) { Say (M 'pathAdded' $bin) }
      if (($env:Path -split ';') -notcontains $bin) { $env:Path = "$env:Path;$bin" }
    } catch {
      Warn (M 'pathFailed' $bin $_.Exception.Message)
    }
  }
  $autostart = 'skipped'
  if (-not $noAutostartSet) { $autostart = Set-ErgoAutostart $ergo $root }
  $started = 'skipped'
  if (-not $noStartSet) { $started = Start-ErgoOnboard $ergo }
  Show-InstallSummary $root $versionDir $name $autostart $started
  Say (M 'done')
  return 0
}

$ergoExit = 1
try {
  $ergoExit = Install-Ergo
} catch {
  Write-Host (M 'failed' $_.Exception.Message) -ForegroundColor Red
  $ergoExit = 1
}
# "irm | iex" must not call exit (it would close the user's window); a script file returns the code
if ($PSCommandPath -and $MyInvocation.InvocationName -ne '.') { exit $ergoExit }
