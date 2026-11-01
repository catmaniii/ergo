# 0040 安卓 App 的原生桥不用 addJavascriptInterface，改走按来源开放的消息通道

日期：2026-11-01
状态：已采纳

## 背景

安卓 App 照鸿蒙的路子做（[ADR-0022](0022-harmony-app-native-shell-loads-daemon-page.md)）：Kotlin 原生壳加系统 WebView，加载守护进程提供的网页。网页按鸿蒙的样子调 `window.ergoNative`，这个对象能换地址、录音、发通知、操作内置浏览器，外部网页绝不能碰到。

鸿蒙的 `javaScriptProxy` 带来源白名单，每次调用还核对来源。安卓最顺手的对应物 `addJavascriptInterface` 没有这些：

- 对象挂在 WebView 上，WebView 里**所有页面和所有框架**都看得见，包括跳到外部网址之后、跨来源的 iframe；
- 调用时原生拿不到是哪个框架、哪个来源调的；`WebView.getUrl()` 只是当时主框架的地址，和调用方不是一回事。

内置浏览器要开任意外部网页，主界面的二狗网页里也可能有跨来源的 iframe，这两条都不能接受。

## 决定

**原生桥走 `WebViewCompat.addWebMessageListener` + `addDocumentStartJavaScript`，两者都只注册给配好的二狗来源。仓库里不许调 `addJavascriptInterface`（`frontend/test/android.test.ts` 查）。**

- 通道 `__ergoChannel` 和垫片脚本（`assets/ergo-native-shim.js`）只注入配好的来源。外部网页、别的来源的 iframe 里两样都没有：不是调了被拒，是根本没有这些对象。
- 原生收到每条消息再核对两件事：来源等于配好的来源、发信的是主框架。同来源的 iframe 也有通道，靠这条拒掉（鸿蒙同样只认主框架）。
- 回信走 `JavaScriptReplyProxy`，只送回发信的框架。
- 换二狗地址时整个 WebView 重建（注册的白名单改不了）。
- WebView 太旧、不支持这两个能力时**报错，不退回 `addJavascriptInterface`**。安全设计不留降级路径。

网页这边不动：它按鸿蒙的样子同步调 `ergoNative`，这个方案是异步的，垫片把方法分成三类接上。

- mirror：要同步回值的（版本号、底部避让、通知状态），读 App 推到垫片里的那份；
- fire：不要结果的，发出去就回；
- promise：要结果的，回 `Promise<string>`。

内置浏览器是另一个 WebView，不挂这个通道。它只有页面桥（`__ergoPageChannel`，对所有来源开放）：主框架每句话带 App 发的口令，错口令、iframe 发来的都拒；原生调页面桥的方法时也带口令。这样外部网页能碰到的只有页面桥那几样，而那几样从网页发出来的只是"用户点了框"这类消息，拿不到凭证、别的页面的内容和本机文件。

## 后果

- **外部网页碰不到 `ergoNative`，能在真的 WebView 里证明**：`frontend/android/e2e/browser.ts` 在模拟器上查外部网页主框架、它的 iframe、内置浏览器开二狗地址、主界面塞进去的跨来源 iframe，都没有这些对象；同来源 iframe 经通道发话被拒。
- 最低版本的 WebView 有要求：要支持 `WEB_MESSAGE_LISTENER` 和 `DOCUMENT_START_SCRIPT`。安卓 8 上系统 WebView 太旧时 App 显示"请更新"的提示，而不是能用但不安全。
- 垫片的同步值是镜像，可能比原生慢一拍（通知开关刚在系统设置里改过）。网页本来就会在回到前台时重新取，影响不大。
- 比鸿蒙多一层垫片要维护，方法表由契约测试和网页、鸿蒙两边核对。
- 下载也不交给 WebView：`WebDownloads` 自己发请求，不自动跟重定向、每跳重算 cookie，外部网页发起的、指向二狗地址的下载不带凭证。
