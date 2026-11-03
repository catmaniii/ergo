package com.catmaniii.ergo.update

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.CookieManager
import androidx.core.content.IntentCompat
import com.catmaniii.ergo.MainActivity
import com.catmaniii.ergo.R
import com.catmaniii.ergo.common.AppTexts
import com.catmaniii.ergo.common.TAG
import com.catmaniii.ergo.common.t
import com.catmaniii.ergo.notify.NOTIFY_CHANNEL_ID
import com.catmaniii.ergo.notify.ensureNotifyChannel
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

/** 页面交来的：要装的安装包（二狗带的那一个，GET /api/app-update 给的） */
class UpdateRequest(val url: String, val sha256: String, val version: String, val code: Long, val size: Long)

/** MainActivity 给的：系统界面要由前台的 Activity 起 */
interface UpdateHost {
    /** "安装未知应用"授权了没有 */
    fun canInstall(): Boolean
    /** 带用户去系统设置里这个 App 的"安装未知应用"那一页 */
    fun openInstallSettings()
    /** 起系统的安装确认框（PackageInstaller 给的） */
    fun startConfirm(intent: Intent)
    /** 进度推给网页（window.__ergoAppUpdate） */
    fun push(json: String)
}

/**
 * 在 App 里更新 App（票 399）：网页点"更新"后调原生桥的 installAppUpdate。
 * 1. 下到 App 自己的缓存目录：只认配好的二狗来源，带上设备凭证 cookie（不跟重定向），一路推下载的百分比；
 * 2. 核 SHA-256（页面给的、二狗算的）；再用 getPackageArchiveInfo 核包名一样、versionCode 比装着的高、签名证书和装着的一样。任一不对就不装，回原因；
 * 3. 没有"安装未知应用"的授权时先带用户去系统那一页（只第一次：授权了以后一直在），回到 App（onResume）接着装；
 * 4. 用 PackageInstaller 会话装：安卓 12 起设 USER_ACTION_NOT_REQUIRED，系统允许就不弹确认（App 更新自己，要声明
 *    UPDATE_PACKAGES_WITHOUT_USER_ACTION），不允许就弹系统确认框（PENDING_USER_ACTION），点一下装好；
 * 5. 装的时候系统会关掉 App。装好后 UpdatedReceiver 收到 MY_PACKAGE_REPLACED：试着把 App 再打开（安卓 10 起后台起界面多半被系统拦下），
 *    同时在通知栏放一条"二狗 App 已更新到 x.y.z，点这里打开"（App 打开时收掉）。
 * 装完、失败都把临时文件删掉。结果码经 InstallStatusReceiver 回到这里（AppUpdates.active）。
 */
class AppUpdater(private val context: Context, private val serverOrigin: () -> String, private val host: UpdateHost) {
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val dir = File(context.cacheDir, "app-update")

    /** 这一次更新：页面等着的回信、下好的文件 */
    private class Run(val request: UpdateRequest, val reply: (String) -> Unit) {
        var file: File? = null
        /** 去系统设置里授权了，等回到 App */
        var awaitingPermission = false
        var sessionId: Int? = null
        /** 核过的安装包的 versionCode（装好后认的就是它） */
        var archiveCode: Long = 0
    }

    private var run: Run? = null

    /** 网页调的：json 是 { url, sha256, version, code, size } */
    fun install(json: String, reply: (String) -> Unit) {
        if (run != null) {
            reply(failed(UpdateFailure.BUSY))
            return
        }
        val request = try {
            val o = JSONObject(json)
            UpdateRequest(o.getString("url"), o.getString("sha256"), o.optString("version"), o.optLong("code"), o.optLong("size"))
        } catch (e: Exception) {
            Log.w(TAG, "app update: bad request", e)
            reply(failed(UpdateFailure.FAILED, "bad request"))
            return
        }
        if (!updateUrlAllowed(request.url, serverOrigin())) {
            Log.w(TAG, "app update refused: not from the configured origin")
            reply(failed(UpdateFailure.PACKAGE))
            return
        }
        val current = Run(request, reply)
        run = current
        AppUpdates.active = this
        push(JSONObject().put("state", "downloading").put("percent", 0))
        io.execute { prepare(current) }
    }

    /** 下载、核对（后台线程）；能装就回主线程接着走 */
    private fun prepare(current: Run) {
        dir.deleteRecursively()
        dir.mkdirs()
        val file = File(dir, "ergo-update.apk")
        current.file = file
        val problem = try {
            if (current.request.size > 0 && dir.usableSpace < current.request.size * 3) {
                UpdateFailure.STORAGE
            } else {
                download(current.request, file)
                if (!sameSha256(current.request.sha256, sha256Of(file))) {
                    UpdateFailure.CHECKSUM
                } else {
                    val archive = archiveFacts(file)
                    current.archiveCode = archive?.versionCode ?: 0
                    archiveProblem(archive, installedFacts())
                }
            }
        } catch (e: IOException) {
            Log.w(TAG, "app update download failed: ${e.javaClass.simpleName} ${e.message}")
            if (isNoSpace(e.message)) UpdateFailure.STORAGE else UpdateFailure.NETWORK
        } catch (e: Exception) {
            Log.w(TAG, "app update check failed", e)
            UpdateFailure.FAILED
        }
        main.post {
            if (run !== current) return@post
            if (problem != null) finish(failed(problem)) else readyToInstall(current)
        }
    }

    /** 自己发请求下载：只连配好的二狗来源，带设备凭证，不跟重定向（凭证不会被带到别处） */
    private fun download(request: UpdateRequest, file: File) {
        val connection = URL(request.url).openConnection() as HttpURLConnection
        connection.instanceFollowRedirects = false
        connection.connectTimeout = 30_000
        connection.readTimeout = 60_000
        CookieManager.getInstance().getCookie(request.url)?.let { connection.setRequestProperty("Cookie", it) }
        try {
            val code = connection.responseCode
            if (code != 200) throw IOException("HTTP $code")
            val total = connection.contentLengthLong.takeIf { it > 0 } ?: request.size
            var done = 0L
            var told = 0
            connection.inputStream.use { input ->
                FileOutputStream(file).use { out ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        out.write(buffer, 0, n)
                        done += n
                        val percent = percentOf(done, total)
                        if (percent != null && percent != told) {
                            told = percent
                            main.post { if (run?.request === request) push(JSONObject().put("state", "downloading").put("percent", percent)) }
                        }
                    }
                    out.fd.sync()
                }
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun sha256Of(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        return hexOf(digest.digest())
    }

    @Suppress("DEPRECATION")
    private fun signingFlags(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES or PackageManager.GET_SIGNATURES else PackageManager.GET_SIGNATURES

    /** 下下来的安装包是什么；读不出来是 null */
    private fun archiveFacts(file: File): PackageFacts? {
        val info = context.packageManager.getPackageArchiveInfo(file.path, signingFlags()) ?: return null
        return factsOf(info)
    }

    /** 装着的这个 App */
    private fun installedFacts(): PackageFacts = factsOf(context.packageManager.getPackageInfo(context.packageName, signingFlags()))

    @Suppress("DEPRECATION")
    private fun factsOf(info: PackageInfo): PackageFacts {
        val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
        val signing = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.signingInfo?.apkContentsSigners else null
        val certs = signing?.takeIf { it.isNotEmpty() } ?: info.signatures ?: emptyArray()
        return PackageFacts(info.packageName ?: "", code, certs.map { certDigest(it.toByteArray()) }.toSet())
    }

    /** 下好了、核过了：没授权先去系统设置（回来 onResume 接着装），授权了直接装 */
    private fun readyToInstall(current: Run) {
        if (host.canInstall()) {
            commit(current)
            return
        }
        current.awaitingPermission = true
        push(JSONObject().put("state", "authorizing"))
        try {
            host.openInstallSettings()
        } catch (e: Exception) {
            Log.w(TAG, "open install settings failed", e)
            finish(failed(UpdateFailure.PERMISSION))
        }
    }

    /** 回到 App（MainActivity.onResume）：刚从系统设置回来的，授权了接着装，没授权就算了 */
    fun resumed() {
        val current = run ?: return
        if (!current.awaitingPermission) return
        current.awaitingPermission = false
        if (host.canInstall()) commit(current) else finish(failed(UpdateFailure.PERMISSION))
    }

    /** 交给系统装 */
    private fun commit(current: Run) {
        val file = current.file ?: return finish(failed(UpdateFailure.FAILED))
        push(JSONObject().put("state", "installing"))
        io.execute {
            val installer = context.packageManager.packageInstaller
            var sessionId: Int? = null
            val problem = try {
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                    setAppPackageName(context.packageName)
                    setSize(file.length())
                    setInstallReason(PackageManager.INSTALL_REASON_USER)
                    // 安卓 12 起：更新自己、系统允许时不弹确认；不允许系统照样弹（PENDING_USER_ACTION）
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                }
                val id = installer.createSession(params)
                sessionId = id
                installer.openSession(id).use { session ->
                    session.openWrite("ergo.apk", 0, file.length()).use { out ->
                        file.inputStream().use { it.copyTo(out) }
                        session.fsync(out)
                    }
                    // 装完要关掉 App：装好后由 UpdatedReceiver 再打开（只认这一次更新）
                    UpdatedReceiver.expect(context, current.archiveCode)
                    val intent = Intent(context, InstallStatusReceiver::class.java).setAction(InstallStatusReceiver.ACTION).setPackage(context.packageName)
                    val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
                    session.commit(PendingIntent.getBroadcast(context, id, intent, flags).intentSender)
                }
                null
            } catch (e: IOException) {
                Log.w(TAG, "app update session failed: ${e.message}")
                sessionId?.let { runCatching { installer.abandonSession(it) } }
                if (isNoSpace(e.message)) UpdateFailure.STORAGE else UpdateFailure.FAILED
            } catch (e: Exception) {
                Log.w(TAG, "app update session failed", e)
                sessionId?.let { runCatching { installer.abandonSession(it) } }
                UpdateFailure.FAILED
            }
            main.post {
                if (run !== current) return@post
                current.sessionId = sessionId
                if (problem != null) {
                    UpdatedReceiver.expect(context, 0)
                    finish(failed(problem))
                }
            }
        }
    }

    /** 系统回的结果（InstallStatusReceiver 交来，主线程） */
    fun status(status: Int, message: String?, confirm: Intent?) {
        val current = run ?: return
        when (status) {
            InstallStatus.PENDING_USER_ACTION -> {
                if (confirm == null) {
                    finish(failed(UpdateFailure.FAILED, message))
                    return
                }
                push(JSONObject().put("state", "confirming"))
                try {
                    host.startConfirm(confirm)
                } catch (e: Exception) {
                    Log.w(TAG, "start install confirm failed", e)
                    current.sessionId?.let { runCatching { context.packageManager.packageInstaller.abandonSession(it) } }
                    finish(failed(UpdateFailure.FAILED, message))
                }
            }
            InstallStatus.SUCCESS -> finish(JSONObject().put("state", "installed").toString())
            else -> {
                Log.w(TAG, "app update install failed: status $status, $message")
                UpdatedReceiver.expect(context, 0)
                finish(failed(failureOfStatus(status), message))
            }
        }
    }

    private fun push(json: JSONObject) = host.push(json.toString())

    /** 这一次结束：删临时文件、回页面 */
    private fun finish(result: String) {
        val current = run ?: return
        run = null
        if (AppUpdates.active === this) AppUpdates.active = null
        io.execute { dir.deleteRecursively() }
        current.reply(result)
    }

    private fun failed(reason: String, detail: String? = null): String {
        val o = JSONObject().put("state", "failed").put("reason", reason)
        if (!detail.isNullOrBlank()) o.put("detail", detail.take(200))
        return o.toString()
    }

    /** App 退出：在等的回信没人要了，临时文件删掉 */
    fun close() {
        run = null
        if (AppUpdates.active === this) AppUpdates.active = null
        io.execute { dir.deleteRecursively() }
        io.shutdown()
    }
}

/** 正在更新的那个（结果码从系统的广播回来，找它） */
object AppUpdates {
    @Volatile
    var active: AppUpdater? = null
}

/** PackageInstaller 的结果码：会话 commit 时给的 PendingIntent（显式、不导出），只有系统代这个 App 发过来 */
class InstallStatusReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, InstallStatus.FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        val confirm = if (status == InstallStatus.PENDING_USER_ACTION) IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java) else null
        val updater = AppUpdates.active
        if (updater != null) {
            updater.status(status, message, confirm)
        } else {
            // 页面那头已经没了（App 被重建过）：要确认的照样弹出来，别的只记日志
            Log.i(TAG, "app update status $status without a waiting page: $message")
            if (confirm != null) {
                try {
                    context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (e: Exception) {
                    Log.w(TAG, "start install confirm failed", e)
                }
            }
        }
    }

    companion object {
        const val ACTION = "com.catmaniii.ergo.APP_UPDATE_STATUS"
    }
}

/**
 * 装好了（系统发给新版的 MY_PACKAGE_REPLACED）：是 App 里点"更新"装的这一版，就试着把 App 再打开，
 * 再在通知栏放一条"二狗 App 已更新到 x.y.z，点这里打开"：安卓 10 起系统不许后台起界面（模拟器上的安卓 16 实测被拦），
 * 打开得了的 MainActivity 一起来就把这条收掉（clearReopenNotice）。别的方式装的（adb、文件管理里点开）不管
 */
class UpdatedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val expected = prefs.getLong(KEY_EXPECTED, 0)
        prefs.edit().remove(KEY_EXPECTED).apply()
        if (expected <= 0) return
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        @Suppress("DEPRECATION")
        val now = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
        if (now != expected) return
        Log.i(TAG, "app updated to $now: reopening")
        AppTexts.load(context)
        noticeReopen(context, info.versionName ?: "")
        try {
            context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            Log.w(TAG, "reopen after update failed", e)
        }
    }

    /** 通知栏里"二狗 App 已更新到 x.y.z，点这里打开"；没给通知权限、通知关着就算了 */
    private fun noticeReopen(context: Context, version: String) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            if (!manager.areNotificationsEnabled()) return
            ensureNotifyChannel(manager)
            val open = PendingIntent.getActivity(context, REOPEN_NOTICE, Intent(context, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val notification = Notification.Builder(context, NOTIFY_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(t("harmony.android.updatedTitle", mapOf("version" to version)))
                .setContentText(t("harmony.android.updatedBody"))
                .setContentIntent(open)
                .setAutoCancel(true)
                .setShowWhen(true)
                .build()
            manager.notify(REOPEN_NOTICE, notification)
        } catch (e: Exception) {
            Log.w(TAG, "notice after update failed", e)
        }
    }

    companion object {
        private const val PREFS = "ergo_app_update"
        private const val KEY_EXPECTED = "expected_version_code"
        /** 通知栏里"点这里打开"那一条的编号 */
        private const val REOPEN_NOTICE = 3_990_001

        /** 要装的是哪个 versionCode（0 是没有在装的） */
        fun expect(context: Context, code: Long) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong(KEY_EXPECTED, code).commit()
        }

        /** App 打开了：收掉"点这里打开"那一条 */
        fun clearReopenNotice(context: Context) {
            try {
                context.getSystemService(NotificationManager::class.java)?.cancel(REOPEN_NOTICE)
            } catch (e: Exception) {
                Log.w(TAG, "clear notice after update failed", e)
            }
        }
    }
}
