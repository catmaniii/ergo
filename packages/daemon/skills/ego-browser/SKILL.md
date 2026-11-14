---
name: ego-browser
description: 要在网页上做事时用：打开网站、点按钮、填表、截图、抓页面上的数据、下载文件，尤其是要用用户已经登录的网站（他自己的账号、后台、评论区）。用的是用户电脑上的 ego 浏览器（ego lite），在 bash 里跑 ego-browser 命令；要登录、过验证码时把那一页交给用户。
---

# ego 浏览器

ego lite 是用户电脑上的浏览器，人和 agent 共用：你操作的就是用户自己的浏览器，用的是他在里面登录好的网站。

## 先做这一步

1. 在 bash 里跑 `ego-browser skill`，照它打印的用法做。用法和装的 ego lite 版本配套，以它为准。输出的最后一行是 `[ego-browser:skill] end of guide`，没看到就是被截断了：重定向到文件，再分段读。
2. 找不到命令（`command not found`）：这台电脑没装 ego lite，或者装了还没走完首次引导。告诉用户去 https://lite.ego.app/ 装 ego lite、打开它走完首次引导，好了回你一句，然后再试一次。二狗每次拉起 agent 都会重新找这个命令。
3. ego lite 没开着：不用先查、也不用自己去开。你跑 `ego-browser` 时二狗会像用户自己打开那样替他打开（输出里有一行 `[二狗] ego lite 没开着，二狗已经替用户打开了…`），等它好了再接着跑你的命令。打不开时命令不会往下跑，`[二狗]` 那一行写着原因：照着请用户自己打开 ego lite，好了再跑一次。

## 二狗这边的规矩

- 就用 `ego-browser` 这个命令名，不要改用 ego 安装目录里那个 ego-browser.exe 的完整路径：二狗替用户打开 ego lite 靠的是 PATH 上的这一个。
- 一个目标只用一个 TaskSpace，接着做同一件事时回到它；做完了 `finish`。
- 要登录、过验证码、两步验证时：`task.handOff()`，这一轮就停在这里，在对话里告诉用户"去电脑上的 ego 里操作，好了回我一句"。不猜密码，不绕过验证。用户回了之后接着同一个 TaskSpace。
- 不碰付款：下单、支付、转账到了那一步就停下，交给用户。
- 不清 cookie、缓存和存储。真要清，先读 ego 自带的说明 `ego-skills/ego-browser/references/clearing-state.md`（在 ego lite 的版本目录里，Windows 上是 `~/.local/share/ego/active_version_dir/` 下面），并且先问用户。

## 实测过的坑

- 页面里请求另一个子域名的接口，要带 `credentials: "include"`。比如在 www.bilibili.com 的页面里请求 api.bilibili.com，不带就被当成没登录。
- PowerShell 里不要用 `-e` 传多行脚本，改成写一个 .mjs 文件，照 `ego-browser skill` 里 PowerShell 那一段跑。Git Bash 里用 heredoc。
