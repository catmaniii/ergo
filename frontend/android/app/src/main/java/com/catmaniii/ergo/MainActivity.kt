package com.catmaniii.ergo

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.UiModeManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.animation.AccelerateInterpolator
import android.view.animation.DecelerateInterpolator
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.window.OnBackInvokedDispatcher
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.catmaniii.ergo.bridge.BridgeCall
import com.catmaniii.ergo.bridge.BridgeChannel
import com.catmaniii.ergo.bridge.BridgeHost
import com.catmaniii.ergo.bridge.MAIN_METHODS
import com.catmaniii.ergo.bridge.SIDE_METHODS
import com.catmaniii.ergo.bridge.NativeBridge
import com.catmaniii.ergo.bridge.webViewSupportsBridge
import com.catmaniii.ergo.browser.BrowserFrame
import com.catmaniii.ergo.browser.BrowserTools
import com.catmaniii.ergo.browser.FileDocs
import com.catmaniii.ergo.browser.FilePicker
import com.catmaniii.ergo.browser.InAppBrowser
import com.catmaniii.ergo.browser.PageControl
import com.catmaniii.ergo.browser.parseFrame
import com.catmaniii.ergo.browser.parseSideLayout
import com.catmaniii.ergo.browser.sideUrlOf
import com.catmaniii.ergo.common.AppSettings
import com.catmaniii.ergo.common.AppTexts
import com.catmaniii.ergo.common.ServerAddress
import com.catmaniii.ergo.common.TAG
import com.catmaniii.ergo.common.checkServerAddress
import com.catmaniii.ergo.common.isWebUrl
import com.catmaniii.ergo.common.originOf
import com.catmaniii.ergo.common.t
import com.catmaniii.ergo.download.DownloadRequest
import com.catmaniii.ergo.download.SavePicker
import com.catmaniii.ergo.download.WebDownloads
import com.catmaniii.ergo.notify.NativeNotify
import com.catmaniii.ergo.notify.NotifyPermission
import com.catmaniii.ergo.notify.NotifyTaps
import com.catmaniii.ergo.notify.appNotificationSettings
import com.catmaniii.ergo.ui.AddressPage
import com.catmaniii.ergo.ui.ErgoTheme
import com.catmaniii.ergo.ui.ErrorPage
import com.catmaniii.ergo.ui.NotErgoBar
import com.catmaniii.ergo.ui.PermissionNote
import com.catmaniii.ergo.ui.ShadowView
import com.catmaniii.ergo.ui.dp
import com.catmaniii.ergo.ui.ToastHost
import com.catmaniii.ergo.voice.MicrophoneAccess
import com.catmaniii.ergo.voice.NativeVoice
import org.json.JSONObject

/** 留在 WebView 里自己处理的非 http(s) 链接；别的（mailto:、tel:、sms:、geo:、别的 App 的链接）交给系统 */
private val IN_PAGE_SCHEMES = setOf("about", "blob", "data", "javascript")
/** 页面加载完这么久网页还没调过原生桥，就不是二狗的网页（地址填成了别的网站）：提示"这不是二狗？换地址" */
private const val NOT_ERGO_AFTER_MS = 8000L

/** 系统的图库选择器一次最多选几张（和鸿蒙的 pickBySystem 一样） */
private const val PICK_IMAGES_MAX = 50

private fun schemeOf(url: String): String {
    val colon = url.indexOf(':')
    return if (colon > 0) url.substring(0, colon).lowercase() else ""
}

/**
 * 二狗的安卓 App（349 号票）：原生壳，对应鸿蒙的 pages/Index.ets 和 entryability/EntryAbility.ets。
 * 第一次打开先填二狗的地址（存在应用本地）；之后 WebView 加载这个地址，网页照常由守护进程提供，App 和手机浏览器一样是一台要配对的设备。
 * 网页不打包进 APK：二狗的网页要带设备凭证（__Host- cookie），Origin 要和 Host 一致，见 docs/adr/0022。
 */
class MainActivity : Activity() {
    private lateinit var settings: AppSettings
    private lateinit var root: FrameLayout
    /** 盖在状态栏下面的那一层：主界面的 WebView、内置浏览器、侧边栏都摆在里面，坐标和网页报的一致 */
    private lateinit var content: FrameLayout
    private lateinit var addressPage: AddressPage
    private lateinit var errorPage: ErrorPage
    private lateinit var notErgoBar: NotErgoBar
    private lateinit var toast: ToastHost
    private lateinit var permissionNote: PermissionNote
    private val handler = Handler(Looper.getMainLooper())

    /** 当前加载的地址；没配过是 null */
    private var server: ServerAddress? = null
    private var mainWeb: WebView? = null
    private var channel: BridgeChannel? = null
    private var bridge: NativeBridge? = null
    /** 显示地址页：第一次打开，或者网页设置里点了"换地址"、出错页上点了"改地址" */
    private var editing = false
    /** 网页打不开的原因；空串是没出错 */
    private var loadError = ""
    private var notErgo = false
    private var contacted = false
    private val notErgoCheck = Runnable {
        if (!contacted && loadError.isEmpty()) {
            Log.w(TAG, "page never called the bridge: not an ergo page?")
            notErgo = true
            renderPages()
        }
    }
    /** 底部避让区（105 号票）：页面延伸到了手势条底下，这一截多高（物理像素）；还没量到是 -1 */
    private var bottomInsetPx = -1

    private val bridgeHost = object : BridgeHost {
        override fun editServer() = startEditing()
        override fun colorModeChanged(mode: String) {
            settings.setColorMode(mode)
            applyColorMode(mode)
        }

        override fun notifyTaken(value: String) {
            notifyTaps.taken(value)
            channel?.refreshScript()
        }

        override fun notifyResetAsked() = nativeNotify.resetAsked()
        override fun notifyPrepare(userAction: Boolean, reply: (String) -> Unit) = nativeNotify.prepare(userAction, reply)
        override fun notifyShow(id: String, title: String, body: String, route: String, force: Boolean, reply: (String) -> Unit) =
            reply(nativeNotify.show(id, title, body, route, force))

        override fun browserAttach() = browser.attach()
        override fun browserLayout(json: String) = layoutBrowser(json)
        override fun browserLoad(url: String) {
            browser.load(url)
        }
        override fun browserNav(action: String) {
            if (action != "outside") {
                browser.nav(action)
            } else {
                browser.currentUrl().takeIf { it.isNotEmpty() }?.let { openOutside(it) }
            }
        }
        override fun browserSide(json: String) = layoutSide(json)
        override fun sideAction(action: String) = this@MainActivity.sideAction(action)
        override fun browserPage(op: String, args: String, reply: (String) -> Unit) = pageControl.run(op, args, reply)
        override fun browserFileChunk(id: String, base64: String, reply: (String) -> Unit) = pageControl.writeChunk(id, base64, reply)
        override fun browserFiles(json: String, reply: (String) -> Unit) = pageControl.deliver(json, reply)
        override fun browserChooser(choice: String, reply: (String) -> Unit) = pageControl.choose(choice, reply)
        override fun browserDiscard(json: String, reply: (String) -> Unit) = reply(pageControl.discard(json))
        override fun browserDoc(op: String, id: String, reply: (String) -> Unit) = fileDocs.run(op, id, reply)
        override fun browserTool(op: String, json: String, reply: (String) -> Unit) = browserTools.run(op, json, reply)
    }

    /** 系统通知（110 号票）：整个 App 一份，换地址不重建；记着 App 在不在前台（在前台不发，页面顶上已经有了） */
    private val nativeNotify: NativeNotify by lazy {
        NativeNotify(this, settings, object : NotifyPermission {
            override fun request(done: () -> Unit) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    requestPermission(Manifest.permission.POST_NOTIFICATIONS) { done() }
                } else {
                    done()
                }
            }

            override fun openSettings() {
                try {
                    startActivity(appNotificationSettings(this@MainActivity))
                } catch (e: Exception) {
                    Log.w(TAG, "open notification settings failed", e)
                }
            }
        }) { channel?.setMirror("notify", it) }
    }
    /**
     * 用户点开的那一条：记下来，写进镜像值，垫片再叫网页来取（window.__ergoNotifyOpen）。
     * 开场值是注入脚本时写死的，这条只能取一次，所以记下、取走都要重新注入：不然页面一刷新，又跳回那一页
     */
    private val notifyTaps = NotifyTaps {
        channel?.setMirror("open", it)
        channel?.refreshScript()
    }

    /** 系统的选文件、保存文件界面（页面桥、下载用）：结果经 onActivityResult 回来 */
    private val resultWaiters = HashMap<Int, (Int, Intent?) -> Unit>()
    private var nextActivityRequest = 1

    private fun startForResult(intent: Intent, done: (Int, Intent?) -> Unit) {
        val code = nextActivityRequest++
        resultWaiters[code] = done
        try {
            startActivityForResult(intent, code)
        } catch (e: Exception) {
            Log.e(TAG, "start system picker failed", e)
            resultWaiters.remove(code)
            done(RESULT_CANCELED, null)
        }
    }

    @Deprecated("Activity result API needs AndroidX Activity, not worth a dependency here")
    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        resultWaiters.remove(requestCode)?.invoke(resultCode, data)
    }

    /** 拦下的选文件对话框上"自己选"（对应 PageControl.ets 的 pickBySystem） */
    private val filePicker = object : FilePicker {
        override fun pick(images: Boolean, accept: List<String>, multiple: Boolean, done: (List<Uri>) -> Unit) {
            val intent = if (images && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                Intent(MediaStore.ACTION_PICK_IMAGES).apply { if (multiple) putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, PICK_IMAGES_MAX) }
            } else {
                val mimes = accept.filter { it.contains('/') }
                Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).apply {
                    type = if (images) "image/*" else "*/*"
                    if (!images && mimes.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, mimes.toTypedArray())
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
                }
            }
            startForResult(intent) { result, data ->
                val uris = ArrayList<Uri>()
                if (result == RESULT_OK && data != null) {
                    val clip = data.clipData
                    if (clip != null) for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri) else data.data?.let { uris.add(it) }
                }
                done(uris)
            }
        }
    }

    /** 下完弹系统的"保存到"（对应 WebDownloads.ets 的 DocumentViewPicker.save） */
    private val savePicker = object : SavePicker {
        override fun save(name: String, mime: String, done: (Uri?) -> Unit) {
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE, name)
            startForResult(intent) { result, data ->
                val uri = if (result == RESULT_OK) data?.data else null
                // 留住读权限：下载记录里以后还要能打开它
                if (uri != null) {
                    try {
                        contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    } catch (e: SecurityException) {
                        Log.w(TAG, "keep read permission of a saved file failed", e)
                    }
                }
                done(uri)
            }
        }
    }

    /**
     * 原生的内置浏览器（134 号票，网页的"浏览"页签）：另一个 WebView，叠在二狗的网页上面盖住"浏览"页签的内容区；整个 App 一份，
     * 换地址、主页面重新加载都不重建。绝不挂二狗的原生桥
     */
    private val browser = InAppBrowser({ pushBrowser(it) }, { channel?.setMirror("browser", it) }, { createBrowserWeb() })
    /** 浏览器摆在哪、显不显示（网页报的内容区） */
    private var browserFrame = BrowserFrame(false, 0, 0, 0, 0)
    /**
     * 浏览侧边栏（147 号票）：另一个 WebView，加载二狗网页的侧边栏模式，盖在原生网页上面；第一次展开时才建，之后留着（收起只是藏起来），换地址时拆掉。
     * 自己一份通道和原生桥（只开 SIDE_METHODS）、自己一份原生录音器
     */
    private var sideWeb: WebView? = null
    private var sideShadow: ShadowView? = null
    private var sideChannel: BridgeChannel? = null
    private var sideBridge: NativeBridge? = null
    /** "浏览"页报的交给侧边栏网页的样子（JSON），侧边栏的网页起来了、变了就推过去 */
    private var sideView = ""
    private var sideFrame = BrowserFrame(false, 0, 0, 0, 0)
    /** 显示着（滑出去的过程中还显示着） */
    private var sideVisible = false
    /** 页面桥：注入浏览器里每个网页的脚本（认框、悬浮按钮、填字、塞文件）、它报的话转给二狗的网页、拦下网页弹出的选文件对话框 */
    private val pageControl: PageControl by lazy { PageControl(this, { pushBrowser(it) }, { browser.attached }, filePicker) }
    /** "浏览"的 ⋮ 菜单用到的原生能力（165 号票） */
    private val browserTools: BrowserTools by lazy { BrowserTools(this, { browser.web }, { pushBrowser(it) }, { server }, { browser.currentUrl() }) }
    /** 浏览器里能渲染的文件（160 号票） */
    private val fileDocs: FileDocs by lazy {
        FileDocs(this, { browser.web }, { pushBrowser(it) }, { file, name, keep -> browserDownloads.saveFile(file, name, keep) }, { url -> forceBrowserDownload(url) }, { openOutside(it) })
    }
    /** 网页里的下载（96 号票）：下到缓存，下完弹"保存到" */
    private val mainDownloads: WebDownloads by lazy { WebDownloads(this, { showToast(it) }, savePicker, { server?.origin ?: "" }) }
    /** 浏览器里的下载：可能是能渲染的文本的先问 fileDocs 拦不拦（160 号票）；存好了的记进下载记录（165 号票） */
    private val browserDownloads: WebDownloads by lazy {
        WebDownloads(this, { showToast(it) }, savePicker, { server?.origin ?: "" }, fileDocs, { name, uri, size, mime -> browserTools.record(name, uri, size, mime) }, { url, done -> pageControl.readBlob(url, done) })
    }

    /** 等系统权限框的结果：请求码 → 回调 */
    private val permissionWaiters = HashMap<Int, (Boolean) -> Unit>()
    private var nextPermissionRequest = 1

    /** 麦克风权限（对应 NativeVoice.ets 的 ensurePermission） */
    private val microphone = object : MicrophoneAccess {
        override fun granted() = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

        override fun request(userAction: Boolean, done: (Boolean) -> Unit) {
            // 要过、系统又说不用解释了：用户选了"拒绝且不再询问"，系统不再弹框。这时只有按下（用户自己的动作）才带他去系统设置
            if (settings.microphoneAsked() && !shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)) {
                if (userAction) openAppSettings()
                done(false)
                return
            }
            settings.setMicrophoneAsked()
            permissionNote.show(t("harmony.android.microphoneReason"))
            requestPermission(Manifest.permission.RECORD_AUDIO) { granted ->
                permissionNote.hide()
                done(granted)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = AppSettings(this)
        AppTexts.load(this)
        // WebView 调试默认关：开着的话，接上 USB 的人能用 adb 取到设备凭证 cookie。只有构建时显式要了才开
        WebView.setWebContentsDebuggingEnabled(BuildConfig.WEBVIEW_DEBUG)
        applyColorMode(settings.colorMode())
        buildViews()
        watchBack()
        AppTexts.listen { renderTexts() }
        // App 没在跑、点开通知栏里的一条拉起来的：记下那一条，网页开场来取
        notifyTaps.fromIntent(intent)
        val saved = checkServerAddress(settings.serverUrl()).address
        if (saved != null) openServer(saved) else startEditing()
    }

    override fun onDestroy() {
        handler.removeCallbacks(notErgoCheck)
        AppTexts.listen(null)
        bridge?.close()
        sideBridge?.close()
        mainWeb?.destroy()
        sideWeb?.destroy()
        super.onDestroy()
    }

    override fun onPause() {
        super.onPause()
        // 设备凭证在 cookie 里：离开前台就落盘（onStop 可能来不及，WebView 自己大约 30 秒才写一次），App 被系统杀掉也不用重新配对
        CookieManager.getInstance().flush()
    }

    /** App 在跑（前台、后台）时点开通知栏里的一条：launchMode 是 singleTask，系统把它拉到前台、走这里 */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        notifyTaps.fromIntent(intent)
    }

    /** App 回到前台：系统通知不再往通知栏发；用户可能刚在系统设置里开关过通知 */
    override fun onStart() {
        super.onStart()
        nativeNotify.setForeground(true)
    }

    /** App 切到后台：放掉原生录音器（后台不录；网页的 visibilitychange 不一定先到）。回到前台由网页重新要。之后来的提醒发到系统通知栏 */
    override fun onStop() {
        super.onStop()
        nativeNotify.setForeground(false)
        bridge?.releaseVoice("background")
        sideBridge?.releaseVoice("background")
    }

    private fun requestPermission(permission: String, done: (Boolean) -> Unit) {
        val code = nextPermissionRequest++
        permissionWaiters[code] = done
        requestPermissions(arrayOf(permission), code)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        permissionWaiters.remove(requestCode)?.invoke(grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED)
    }

    /** 这个 App 在系统设置里的那一页 */
    private fun openAppSettings() {
        try {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
        } catch (e: Exception) {
            Log.w(TAG, "open app settings failed", e)
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // 跟随系统时系统切了深浅色
        renderColors()
    }

    private fun buildViews() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isNavigationBarContrastEnforced = false
            window.isStatusBarContrastEnforced = false
        }
        root = FrameLayout(this)
        content = FrameLayout(this).apply { clipChildren = false }
        root.addView(content, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        errorPage = ErrorPage(this, { retry() }, { startEditing() })
        notErgoBar = NotErgoBar(this, { startEditing() }, {
            notErgo = false
            renderPages()
        })
        addressPage = AddressPage(this, { saveDraft(it) }, {
            editing = false
            hideKeyboard()
            renderPages()
        }, { addressPage.setError("") })
        toast = ToastHost(this)
        permissionNote = PermissionNote(this)
        content.addView(errorPage.view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        content.addView(notErgoBar.view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        content.addView(addressPage.view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        content.addView(toast.view, toast.layoutParams())
        content.addView(permissionNote.view, permissionNote.layoutParams())
        setContentView(root)
        watchInsets()
        renderColors()
        renderPages()
    }

    /**
     * 量窗口避让（对应 Index.ets 的 watchBottomInset 和 expandSafeArea）：顶部状态栏、两边让开；底部 WebView 延伸到手势条（三键导航条）底下，
     * 这一截多高告诉网页（safeArea、__ergoInsets），由网页让开一小截。键盘弹起时整层变矮（对应 ArkWeb 的 RESIZE_CONTENT）
     */
    private fun watchInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            content.setPadding(bars.left, bars.top, bars.right, ime.bottom)
            val bottom = maxOf(bars.bottom, 0)
            if (bottom != bottomInsetPx) {
                bottomInsetPx = bottom
                Log.i(TAG, "bottom avoid area: $bottom px")
                pushInsets()
            }
            // 地址页、"这不是二狗？"的内容留在避让区之上（键盘弹起时键盘已经把它们顶上去了）
            val overlap = if (ime.bottom > 0) 0 else bottom
            notErgoBar.setBottomInset(overlap)
            addressPage.setBottomInset(overlap)
            errorPage.setBottomInset(overlap)
            insets
        }
    }

    /** 底部避让区推给网页（调网页登记的 window.__ergoInsets(json)） */
    private fun pushInsets() {
        val target = channel ?: return
        val json = safeAreaJson()
        target.setMirror("safeArea", json)
        if (json.isNotEmpty()) target.callPage("__ergoInsets", json)
    }

    private fun safeAreaJson(): String = if (bottomInsetPx < 0) "" else JSONObject().put("bottom", bottomInsetPx).toString()

    /** 写进垫片、新页面起来时推的值 */
    private fun mirrorValues(): JSONObject = JSONObject()
        .put("safeArea", safeAreaJson())
        .put("browser", browser.stateJson())
        .put("notify", nativeNotify.state())
        .put("open", notifyTaps.pending)

    /**
     * 外观（对应 AppSettings 的 colorModeOf、EntryAbility 的 setColorMode）：安卓 12 起交给系统（连 WebView 的 prefers-color-scheme 一起变），
     * 更早的系统只有原生的部分跟着变（网页选了深色、浅色时自己画，不看 prefers-color-scheme）
     */
    private fun applyColorMode(mode: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val manager = getSystemService(Context.UI_MODE_SERVICE) as UiModeManager
            manager.setApplicationNightMode(
                when (mode) {
                    "dark" -> UiModeManager.MODE_NIGHT_YES
                    "light" -> UiModeManager.MODE_NIGHT_NO
                    else -> UiModeManager.MODE_NIGHT_AUTO
                },
            )
        }
        if (::root.isInitialized) renderColors()
    }

    private fun isDark(): Boolean = ErgoTheme.isDark(this, settings.colorMode())

    /** 深浅色变了：底色、状态栏的字跟着变（鸿蒙的 ConfigurationConstant.ColorMode 系统自己管） */
    private fun renderColors() {
        val dark = isDark()
        val palette = ErgoTheme.palette(dark)
        root.setBackgroundColor(palette.background)
        WindowInsetsControllerCompat(window, root).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
        mainWeb?.setBackgroundColor(palette.background)
        browser.web?.setBackgroundColor(palette.background)
        sideWeb?.setBackgroundColor(palette.background)
        sideShadow?.setFill(palette.background)
        addressPage.refresh(palette)
        errorPage.refresh(palette)
        notErgoBar.refresh(palette)
        toast.refresh(palette)
        permissionNote.refresh(palette)
    }

    /** App 原生的字换了（175 号票）：几页重画 */
    private fun renderTexts() {
        renderColors()
    }

    /** 哪一页盖在最上面（对应 Index.ets 的 build()） */
    private fun renderPages() {
        val hasServer = server != null
        errorPage.view.visibility = if (hasServer && loadError.isNotEmpty() && !editing) View.VISIBLE else View.GONE
        notErgoBar.view.visibility = if (hasServer && notErgo && loadError.isEmpty() && !editing) View.VISIBLE else View.GONE
        addressPage.view.visibility = if (editing) View.VISIBLE else View.GONE
        // 藏起来时 WebView 留着，切回来页面原样还在（鸿蒙 Visibility.Hidden）
        browser.web?.visibility = if (browserShown()) View.VISIBLE else View.INVISIBLE
        val side = if (sideShown()) View.VISIBLE else View.INVISIBLE
        sideWeb?.visibility = side
        sideShadow?.visibility = side
        if (loadError.isNotEmpty()) errorPage.show(loadError, server?.href ?: "")
    }

    /** 系统返回：安卓 13 起走 OnBackInvokedCallback（targetSdk 36 上 onBackPressed 不再被调），老系统走 onBackPressed */
    private fun watchBack() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { handleBack() }
        }
    }

    @Deprecated("Back key on Android 12 and older")
    @Suppress("DEPRECATION")
    @SuppressLint("GestureBackNavigation")
    override fun onBackPressed() {
        handleBack()
    }

    /** 对应 Index.ets 的 onBackPress：地址页先回到网页；网页报过还能在内部返回就交给网页；否则退到后台（进程留着，后台还能发通知） */
    private fun handleBack() {
        if (editing) {
            if (server != null) {
                editing = false
                hideKeyboard()
                renderPages()
                return
            }
            moveTaskToBack(true)
            return
        }
        // 浏览侧边栏开着：它盖在最上面，先收起它（由二狗的网页收，它再报藏起来）
        if (sideShown()) {
            pushBrowser(sideForward("close"))
            return
        }
        // "浏览"页签开着：悬浮按钮旁边的气泡、挑图片窗口开着先收起它，再是查找栏，再是浏览器里的网页还有历史先退一页，退到头才照二狗别的页签的规矩
        if (browserShown() && (pageControl.closeBubble() || browserTools.closeFind() || browser.backGesture())) return
        if (server != null && loadError.isEmpty() && bridge?.canGoBack == true) {
            channel?.callPage("__ergoBack")
            return
        }
        moveTaskToBack(true)
    }

    private fun hideKeyboard() {
        (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(root.windowToken, 0)
    }

    /** 换地址：WebView 连同原生桥整个重建（原生桥的白名单是注册时定的） */
    private fun openServer(address: ServerAddress) {
        // 换地址：旧网页的原生录音器先放掉
        bridge?.releaseVoice("server-changed")
        sideBridge?.releaseVoice("server-changed")
        bridge?.close()
        closeSide()
        server = address
        handler.removeCallbacks(notErgoCheck)
        notErgo = false
        contacted = false
        loadError = ""
        mainWeb?.let {
            content.removeView(it)
            it.destroy()
        }
        mainWeb = null
        channel = null
        bridge = null
        if (!webViewSupportsBridge()) {
            // 系统的 WebView 太旧，没有带来源白名单的接口：不退回 addJavascriptInterface（外部网页会碰到原生桥），告诉用户升级
            loadError = t("harmony.android.webViewTooOld")
            renderPages()
            return
        }
        val web = createMainWeb()
        mainWeb = web
        // 往网页推走通道的回信：只送回发信的那个框架，页面跳走了就丢掉（鸿蒙要先核对主框架的来源，这里不用）
        val voice = NativeVoice(this, microphone) { json -> channel?.callPage("__ergoVoice", json) }
        val nativeBridge = NativeBridge(bridgeHost, voice)
        bridge = nativeBridge
        val bridgeChannel = BridgeChannel(web, address.origin, MAIN_METHODS, false, BuildConfig.VERSION_NAME, { mirrorValues() }, { call: BridgeCall ->
            nativeBridge.handle(call)
        }, {
            contacted = true
            notErgo = false
            renderPages()
        })
        channel = bridgeChannel
        try {
            bridgeChannel.install()
        } catch (e: IllegalArgumentException) {
            Log.e(TAG, "bridge origin rejected: ${address.origin}", e)
            loadError = t("harmony.address.malformed")
            renderPages()
            return
        }
        content.addView(web, 0, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        renderColors()
        renderPages()
        web.loadUrl(address.href)
    }

    /** 主界面的 WebView（对应 Index.ets 的 WebPage）：不开文件访问、不开混合内容、不给定位，证书错误不放行 */
    @SuppressLint("SetJavaScriptEnabled")
    private fun createMainWeb(): WebView = WebView(this).apply {
        applySafeSettings(this)
        CookieManager.getInstance().setAcceptCookie(true)
        webViewClient = MainClient()
        webChromeClient = MainChrome()
        setDownloadListener(downloadListener(this) { mainDownloads })
    }

    private fun applySafeSettings(web: WebView) {
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setGeolocationEnabled(false)
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
        }
        // 不把网页强制反色：深色由网页自己画（鸿蒙 forceDarkAccess(false)）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) web.isForceDarkAllowed = false
        web.overScrollMode = View.OVER_SCROLL_NEVER
    }

    private inner class MainClient : WebViewClient() {
        /**
         * 主页面要去的地方（对应 Index.ets 的 interceptLoad）：配好的来源留在 App 里；mailto:、tel: 这类交给系统，不落到出错页；
         * 别的网站交给系统浏览器；地址本身跳到别的来源时提示去改地址。App 里只显示配好的那个来源
         */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val address = server
            if (address == null || !request.isForMainFrame) return false
            val target = request.url.toString()
            val scheme = schemeOf(target)
            if (scheme.isEmpty() || scheme in IN_PAGE_SCHEMES) return false
            if (scheme != "http" && scheme != "https") {
                openOutside(target)
                return true
            }
            if (originOf(target) == address.origin) return false
            if (request.isRedirect) {
                loadError = t("harmony.index.redirected", mapOf("url" to target))
                renderPages()
                return true
            }
            // 网页有"浏览"页签就在原生浏览器里打开、让网页切过去
            if (browser.attached && browser.load(target)) {
                browser.pushOpened(target)
                return true
            }
            openOutside(target)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            handler.removeCallbacks(notErgoCheck)
            // 页面重新加载、跳走：上一个页面备好的原生录音器放掉（新页面进语音模式时再要）；先告诉旧页面，再丢掉它的回信通道
            bridge?.releaseVoice("reload")
            // 新页面要重新说它有没有"浏览"页签、能不能渲染文件；浏览器先藏起来（新页面开到"浏览"会再报内容区）；没人管的气泡收起；查找栏是关着的
            browser.attached = false
            fileDocs.enabled = false
            browserFrame = BrowserFrame(false, 0, 0, 0, 0)
            pageControl.hostPageBegin()
            browserTools.findOpen = false
            // 浏览侧边栏也先藏起来（新页面开到"浏览"会再报）
            sideVisible = false
            sideFrame = BrowserFrame(false, 0, 0, 0, 0)
            renderPages()
        }

        override fun onPageFinished(view: WebView, url: String?) {
            // 配对领到的凭证别等到切后台才落盘
            CookieManager.getInstance().flush()
            // 过一阵网页还没调过原生桥（二狗的网页一打开就会问 App 的版本号），就提示"这不是二狗？"
            handler.removeCallbacks(notErgoCheck)
            handler.postDelayed(notErgoCheck, NOT_ERGO_AFTER_MS)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame && error.errorCode != ERROR_UNSUPPORTED_SCHEME) {
                loadError = t("harmony.index.cantConnect", mapOf("error" to error.description.toString()))
                renderPages()
            }
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.isForMainFrame && response.statusCode >= 400) {
                loadError = t("harmony.index.httpError", mapOf("code" to response.statusCode.toString()))
                renderPages()
            }
        }

        /** 证书错误绝不放行：取消这次加载，落到出错页 */
        @SuppressLint("WebViewClientOnReceivedSslError")
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel()
            if (originOf(error.url) == server?.origin) {
                loadError = t("harmony.index.cantConnect", mapOf("error" to "SSL ${error.primaryError}"))
                renderPages()
            }
        }
    }

    private inner class MainChrome : WebChromeClient() {
        /** 网页要麦克风（getUserMedia）：网页在 App 里走原生录音，这里一律不给（Index.ets 的 onPermissionRequest 是留给旧版网页的，安卓没有旧版网页） */
        override fun onPermissionRequest(request: PermissionRequest) {
            Log.w(TAG, "deny web permission ${request.resources.joinToString()} for ${request.origin}")
            request.deny()
        }

        override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) {
            callback.invoke(origin, false, false)
        }
    }

    /** 往二狗的网页推（window.__ergoBrowser）：网页还没 attach（还没加载好）就不推 */
    private fun pushBrowser(json: String) {
        if (browser.attached) channel?.callPage("__ergoBrowser", json)
    }

    /** 浏览器现在显示着（"浏览"页签开着、没被地址页和出错页盖住） */
    private fun browserShown(): Boolean = browser.web != null && browserFrame.visible && !editing && loadError.isEmpty()

    /** 网页报的内容区（CSS 像素）换成物理像素摆浏览器 */
    private fun layoutBrowser(json: String) {
        val frame = parseFrame(json)
        if (frame == null) {
            Log.w(TAG, "browser layout ignored")
            return
        }
        browserFrame = frame
        browser.web?.layoutParams = FrameLayout.LayoutParams(maxOf(frame.width, 1), maxOf(frame.height, 1)).apply {
            leftMargin = frame.x
            topMargin = frame.y
        }
        renderPages()
    }

    private fun sideForward(action: String): String = JSONObject().put("type", "side").put("action", action).toString()

    /** 浏览侧边栏现在显示着 */
    private fun sideShown(): Boolean = sideWeb != null && sideVisible && !editing && loadError.isEmpty()

    /**
     * 网页报的侧边栏（CSS 像素）摆侧边栏的 WebView，交给侧边栏网页的样子转过去；第一次要显示时才建。
     * 显示、藏起来时从右边滑进滑出（藏起来等滑完再藏）。时长、曲线照 Index.ets 的 layoutSide
     */
    private fun layoutSide(json: String) {
        val layout = parseSideLayout(json)
        if (layout == null) {
            Log.w(TAG, "side layout ignored")
            return
        }
        val frame = layout.frame
        sideView = layout.view
        if (frame.visible && sideWeb == null) createSide()
        val web = sideWeb
        val opening = frame.visible && !sideVisible
        val closing = !frame.visible && sideVisible
        // 滑出去时照原来的位置大小（藏起来时报的可能是空的）
        sideFrame = if (closing) BrowserFrame(false, sideFrame.x, sideFrame.y, sideFrame.width, sideFrame.height) else frame
        if (web != null && !closing && frame.width > 0) placeSide(frame)
        val moving = listOfNotNull(web, sideShadow)
        when {
            opening -> {
                sideVisible = true
                moving.forEach {
                    it.translationX = frame.width.toFloat()
                    it.animate().translationX(0f).setDuration(ErgoTheme.SIDE_OPEN_MS).setInterpolator(DecelerateInterpolator()).withEndAction(null).start()
                }
            }
            closing -> {
                // 收起了：侧边栏里正在录的、备好的录音器放掉（展开后网页再要）
                sideBridge?.releaseVoice("hidden")
                val width = sideFrame.width.toFloat()
                moving.forEach { it.animate().translationX(width).setDuration(ErgoTheme.SIDE_CLOSE_MS).setInterpolator(AccelerateInterpolator()).start() }
                handler.postDelayed({
                    if (!sideFrame.visible) {
                        sideVisible = false
                        renderPages()
                    }
                }, ErgoTheme.SIDE_CLOSE_MS)
            }
        }
        renderPages()
        pushSide()
    }

    /** 摆侧边栏：阴影比它多出左边那一截 */
    private fun placeSide(frame: BrowserFrame) {
        sideWeb?.layoutParams = FrameLayout.LayoutParams(frame.width, frame.height).apply {
            leftMargin = frame.x
            topMargin = frame.y
        }
        val inset = dp(sideShadowInsetDp())
        sideShadow?.layoutParams = FrameLayout.LayoutParams(frame.width + inset, frame.height).apply {
            leftMargin = frame.x - inset
            topMargin = frame.y
        }
    }

    private fun sideShadowInsetDp(): Int = (ErgoTheme.SIDE_SHADOW_RADIUS_DP - ErgoTheme.SIDE_SHADOW_OFFSET_DP).toInt()

    /**
     * 浏览侧边栏的 WebView（对应 Index.ets 的 SidePage）：二狗自己的网页，挂一小份原生桥（版本号、日志、录音）和 window.ergoSide，都只认配好的来源；
     * 键盘照主界面的 WebView；里面点的外部网页链接改到内置浏览器里打开
     */
    private fun createSide() {
        val address = server ?: return
        val web = WebView(this)
        applySafeSettings(web)
        web.setBackgroundColor(ErgoTheme.palette(isDark()).background)
        web.webViewClient = SideClient()
        web.webChromeClient = MainChrome()
        val voice = NativeVoice(this, microphone) { json -> sideChannel?.callPage("__ergoVoice", json) }
        val nativeBridge = NativeBridge(bridgeHost, voice)
        sideBridge = nativeBridge
        val sideBridgeChannel = BridgeChannel(web, address.origin, SIDE_METHODS, true, BuildConfig.VERSION_NAME, { JSONObject() }, { call: BridgeCall ->
            nativeBridge.handle(call)
        }, {})
        sideChannel = sideBridgeChannel
        sideBridgeChannel.install()
        sideWeb = web
        val shadow = ShadowView(this, ErgoTheme.SIDE_SHADOW_RADIUS_DP, ErgoTheme.SIDE_SHADOW_OFFSET_DP, dp(sideShadowInsetDp()), 0)
        shadow.setFill(ErgoTheme.palette(isDark()).background)
        sideShadow = shadow
        // 盖在内置浏览器上面、出错页下面
        val at = content.indexOfChild(errorPage.view)
        content.addView(shadow, at)
        content.addView(web, at + 1)
        web.loadUrl(sideUrlOf(address.href))
    }

    /** 浏览侧边栏跟着二狗的地址：换地址时拆掉，下次展开再按新地址建 */
    private fun closeSide() {
        sideBridge?.close()
        sideBridge = null
        sideChannel = null
        sideWeb?.let {
            content.removeView(it)
            it.destroy()
        }
        sideWeb = null
        sideShadow?.let { content.removeView(it) }
        sideShadow = null
        sideVisible = false
        sideFrame = BrowserFrame(false, 0, 0, 0, 0)
        sideView = ""
    }

    /** 交给侧边栏网页的样子推过去（window.__ergoSide） */
    private fun pushSide() {
        if (sideView.isNotEmpty()) sideChannel?.callPage("__ergoSide", sideView)
    }

    /** 侧边栏的网页调的（window.ergoSide）：起来了就推一次样子；收起、取消选中转给二狗的网页 */
    private fun sideAction(action: String) {
        when (action) {
            "ready" -> pushSide()
            "close", "clearSelection" -> pushBrowser(sideForward(action))
        }
    }

    private inner class SideClient : WebViewClient() {
        /**
         * 侧边栏的网页要去的地方（对应 Index.ets 的 sideIntercept）：二狗自己的留在侧边栏里；about:、blob:、data:、javascript: 留着；外部网页改到内置浏览器里打开
         * （告诉二狗的网页，窄屏上收起侧边栏让用户看到网页）；别的（tel:、mailto:）交给系统（只认用户点出来的）
         */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val target = request.url.toString()
            val address = server
            if (address != null && originOf(target) == address.origin) return false
            val scheme = schemeOf(target)
            if (scheme.isEmpty() || scheme in IN_PAGE_SCHEMES) return false
            if (isWebUrl(target)) {
                if (request.isForMainFrame) {
                    browser.load(target)
                    pushBrowser(sideForward("link"))
                }
                return true
            }
            if (request.isForMainFrame && request.hasGesture()) openOutside(target)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            // 侧边栏的网页重新加载：备好的原生录音器放掉（新页面要时再备）
            sideBridge?.releaseVoice("reload")
        }

        override fun onPageFinished(view: WebView, url: String?) = pushSide()

        /** 证书错误绝不放行 */
        @SuppressLint("WebViewClientOnReceivedSslError")
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel()
        }
    }

    /**
     * 原生的内置浏览器的 WebView（对应 Index.ets 的 BrowserPage）：位置大小照网页报的摆。不挂二狗的原生桥，外部网页拿不到二狗的任何原生能力；
     * 只注入页面桥和它报话的通道；不给定位、摄像头、麦克风
     */
    private fun createBrowserWeb(): WebView {
        val web = WebView(this)
        applySafeSettings(web)
        web.settings.apply {
            // 和手机浏览器一样按网页的 viewport 排版、能双指缩放（鸿蒙的 Web 默认这样）
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
        }
        web.setBackgroundColor(ErgoTheme.palette(isDark()).background)
        web.visibility = View.INVISIBLE
        web.webViewClient = BrowserClient()
        web.webChromeClient = BrowserChrome()
        web.setFindListener { active, total, done -> browserTools.searchResult(active, total, done) }
        web.setDownloadListener(downloadListener(web) { browserDownloads })
        pageControl.install(web)
        content.addView(web, 1, FrameLayout.LayoutParams(maxOf(browserFrame.width, 1), maxOf(browserFrame.height, 1)).apply {
            leftMargin = browserFrame.x
            topMargin = browserFrame.y
        })
        return web
    }

    /** WebView 不自己下载：交给 WebDownloads。initiator 是发起下载的那一页，算二狗的凭证带不带 */
    private fun downloadListener(web: WebView, downloads: () -> WebDownloads) = DownloadListener { url, userAgent, contentDisposition, mimetype, contentLength ->
        downloads().begin(DownloadRequest(url, userAgent, contentDisposition, mimetype, contentLength, web.url ?: ""))
    }

    /** 能渲染的文件点了"下载"：页面上的再下载一次（这次不拦） */
    private fun forceBrowserDownload(url: String) {
        val web = browser.web ?: return
        browserDownloads.begin(DownloadRequest(url, web.settings.userAgentString, null, null, -1, web.url ?: ""))
    }

    private inner class BrowserClient : WebViewClient() {
        /**
         * 浏览器里的网页要去的地方（对应 Index.ets 的 browserIntercept）：http、https 留在浏览器里；about:、blob:、data:、javascript: 留在页面里；
         * 别的（tel:、mailto:、App 跳转）交给系统（只认主框架的、用户点出来的，网页自己偷偷跳的不拉起别的应用）
         */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val target = request.url.toString()
            val scheme = schemeOf(target)
            if (scheme == "http" || scheme == "https") {
                // 按网站记住的桌面版：换了浏览器标识要重新发起这次跳转，新标识才生效
                if (request.isForMainFrame && browserTools.applyUserAgent(target)) {
                    view.loadUrl(target)
                    return true
                }
                return false
            }
            if (scheme.isEmpty() || scheme in IN_PAGE_SCHEMES) return false
            if (request.isForMainFrame && request.hasGesture()) {
                openOutside(target)
            } else {
                Log.i(TAG, "browser blocked a $scheme link without a user gesture")
            }
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            pageControl.browserPageBegin()
            browser.pageBegin(url)
            fileDocs.pageBegin()
            // 按网站记住的文字大小（165 号票）
            browserTools.pageBegin(url)
        }

        override fun onPageFinished(view: WebView, url: String?) {
            browser.pageEnd(url)
            // 能渲染的文件（160 号票）：问这一页的类型报给网页
            fileDocs.pageEnd(url)
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            browser.historyChanged(url)
        }

        /** 证书错误绝不放行：WebView 显示打不开 */
        @SuppressLint("WebViewClientOnReceivedSslError")
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel()
        }
    }

    private inner class BrowserChrome : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) = browser.progressChanged(newProgress)

        override fun onReceivedTitle(view: WebView, title: String?) = browser.titleReceived(title)

        /** 外部网页要定位、摄像头、麦克风：一律不给 */
        override fun onPermissionRequest(request: PermissionRequest) {
            Log.i(TAG, "browser denied web permission for ${request.origin}")
            request.deny()
        }

        override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) {
            callback.invoke(origin, false, false)
        }

        /** 网页弹出的选文件对话框由页面桥那边接管（问"让二狗选 / 自己选"） */
        override fun onShowFileChooser(webView: WebView, filePathCallback: ValueCallback<Array<Uri>>, fileChooserParams: FileChooserParams): Boolean =
            pageControl.intercept(filePathCallback, fileChooserParams)
    }

    /** 交给系统：tel: 拉起拨号界面，别的（mailto:、sms:、别的 App 的链接）按链接找能打开它的应用 */
    private fun openOutside(target: String) {
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(target)).addCategory(Intent.CATEGORY_BROWSABLE)
            startActivity(intent)
        } catch (e: Exception) {
            Log.w(TAG, "open outside failed", e)
        }
    }

    private fun startEditing() {
        notErgo = false
        editing = true
        addressPage.show(server?.href ?: "", server != null)
        renderPages()
    }

    private fun saveDraft(draft: String) {
        val checked = checkServerAddress(draft)
        val address = checked.address
        if (address == null) {
            addressPage.setError(t(checked.errorKey))
            return
        }
        settings.setServerUrl(address.href)
        editing = false
        hideKeyboard()
        if (server?.href == address.href && loadError.isEmpty()) {
            renderPages()
            return
        }
        openServer(address)
    }

    private fun retry() {
        val address = server ?: return
        loadError = ""
        renderPages()
        val web = mainWeb
        if (web == null) openServer(address) else web.loadUrl(address.href)
    }

    /** MainActivity 外面的代码弹轻提示（下载的提示） */
    fun showToast(text: String) {
        // 只记有过提示，不记内容（里面可能有文件名）
        Log.i(TAG, "toast shown")
        toast.show(text)
    }

    /** 给 ViewGroup 的避让用：内容区多高（后面几个阶段摆内置浏览器用） */
    val contentLayer: ViewGroup get() = content
}
