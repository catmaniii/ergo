package com.catmaniii.ergo.notify

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.util.Log
import com.catmaniii.ergo.MainActivity
import com.catmaniii.ergo.R
import com.catmaniii.ergo.common.AppSettings
import com.catmaniii.ergo.common.TAG
import com.catmaniii.ergo.common.t
import org.json.JSONObject

/** 点开通知栏里的一条拉起 App 时 Intent 里带的：通知的 id、点了之后网页要去的页面地址（和鸿蒙的 want 参数同名） */
private const val EXTRA_NOTICE_ID = "ergoNoticeId"
private const val EXTRA_NOTICE_ROUTE = "ergoNoticeRoute"
/** 标题、正文最多多少字：网页那边已经截过，这里兜底 */
private const val TITLE_MAX = 60
private const val BODY_MAX = 200
/** 通知的 id、页面地址最长多少 */
private const val ID_MAX = 200
private const val ROUTE_MAX = 512
/** 渠道（对应鸿蒙的 SlotType.SERVICE_INFORMATION：横幅、响铃、锁屏可见） */
private const val CHANNEL_ID = "ergo_service"

/** 网页的页面地址（#/ 开头）：只认这种，别的应用拉起 App 时带来的别的东西不认 */
fun isNoticeRoute(route: String): Boolean = route.startsWith("#/") && route.length <= ROUTE_MAX

fun isNoticeId(id: String): Boolean = id.isNotEmpty() && id.length <= ID_MAX

private fun clip(text: String, max: Int): String {
    val trimmed = text.trim()
    return if (trimmed.length <= max) trimmed else "${trimmed.substring(0, max - 1)}…"
}

/**
 * 通知的编号（notify 的 id、PendingIntent 的 requestCode）：由网页给的 id 算出来，同一件事同一个编号——再发一次换掉通知栏里那一条，不出第二条；
 * 不同的事 PendingIntent 各是各的。和鸿蒙的 numberOf 同一个算法
 */
fun noticeNumber(id: String): Int {
    var hash = 0
    for (ch in id) hash = hash * 31 + ch.code
    return hash and 0x7fffffff
}

/**
 * 用户点开的那一条（对应鸿蒙的 NotifyTaps）：Activity 在 onCreate（App 没在跑）、onNewIntent（App 在跑）里从 Intent 取出来记下，
 * 等网页来取（取一次就清掉）。只记最新的一条（连着点了两条，去后点的那一条）。App 的入口谁都能拉起，所以只认页面地址，网页那边再核对一次
 */
class NotifyTaps(private val changed: (String) -> Unit) {
    var pending = ""
        private set

    /** 从拉起 App 的 Intent 里取；不是点通知拉起来的（桌面图标）什么都不做 */
    fun fromIntent(intent: Intent?) {
        val id = intent?.getStringExtra(EXTRA_NOTICE_ID) ?: return
        val route = intent.getStringExtra(EXTRA_NOTICE_ROUTE) ?: return
        if (!isNoticeId(id) || !isNoticeRoute(route)) return
        pending = JSONObject().put("id", id).put("route", route).toString()
        Log.i(TAG, "notification opened: $id")
        changed(pending)
    }

    /** 网页取走了（垫片带上取走的是哪一条：取的时候又记下了新的，新的不能被这一下清掉） */
    fun taken(value: String) {
        if (pending == value) pending = ""
    }
}

/** 要通知权限（MainActivity 实现：系统的授权框） */
interface NotifyPermission {
    fun request(done: () -> Unit)
    fun openSettings()
}

/**
 * 系统通知（对应鸿蒙 notify/NativeNotify.ets）：本地通知，App 自己往通知栏发，不经任何推送服务（不接 FCM，不做常驻前台服务）。
 * App 的进程要活着才发得出；被系统杀掉后发不出，手册写明。
 * - 授权：第一次向用户要（安卓 13 起才有授权框），记下问过了，用户拒了不再问；设置里点"去打开"而拒过的，拉起系统的通知设置；
 * - 发：网页每条提醒都交过来，App 在前台时不发（页面顶上已经有了），在后台时发一条，编号由 id 算出来，同一件事只出一条、换掉时不再响；
 * - 点：通知带一个 PendingIntent 拉起 MainActivity（带着 id 和页面地址），地址交回网页，通知随即收掉；
 * - Debug 工具集：force 为真时前台也发；state 带 App 现在算不算前台；resetAsked 清掉"问过了"。
 */
class NativeNotify(
    private val context: Context,
    private val settings: AppSettings,
    private val permission: NotifyPermission,
    /** 状态变了（写进原生桥的镜像值：网页同步调 notifyState 时读它） */
    private val stateChanged: (String) -> Unit,
) {
    /** App 在不在前台（MainActivity 的 onStart / onStop） */
    private var foreground = true
    private val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    fun setForeground(flag: Boolean) {
        foreground = flag
        stateChanged(state())
    }

    /** {"enabled", "asked", "foreground"} */
    fun state(): String = JSONObject().put("enabled", enabled()).put("asked", settings.notifyAsked()).put("foreground", foreground).toString()

    /** 清掉"问过用户了"（Debug 工具集的重置首次提示） */
    fun resetAsked() {
        settings.clearNotifyAsked()
        Log.i(TAG, "notification asked mark cleared")
        stateChanged(state())
    }

    /** 开着就什么都不做；没问过就向用户要（只此一次）；问过了、用户拒了：userAction 为真（设置里点"去打开"）时拉起系统的通知设置。都回做完之后的 state() */
    fun prepare(userAction: Boolean, reply: (String) -> Unit) {
        if (enabled()) {
            reply(state())
            return
        }
        if (!settings.notifyAsked()) {
            // 先记下问过了：用户拒了不再问
            settings.setNotifyAsked()
            // 系统框弹着的时候网页也可能来看状态（回到可见时），这时已经算问过了
            stateChanged(state())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                permission.request {
                    stateChanged(state())
                    reply(state())
                }
                return
            }
        } else if (userAction) {
            permission.openSettings()
        }
        stateChanged(state())
        reply(state())
    }

    /** 发一条：标题、正文，点了之后网页要去的页面地址；App 在前台时不发，force 为真时照发。回 {"result": "published" | "foreground" | "disabled" | "failed", "number"?, "message"?} */
    fun show(id: String, title: String, body: String, route: String, force: Boolean): String {
        if (!isNoticeId(id) || !isNoticeRoute(route)) {
            Log.w(TAG, "notification refused: bad arguments")
            return shown("failed", message = "bad arguments")
        }
        if (foreground && !force) {
            Log.i(TAG, "notification $id not published: app in foreground")
            return shown("foreground")
        }
        if (!enabled()) return shown("disabled")
        return try {
            ensureChannel()
            val channel = manager.getNotificationChannel(CHANNEL_ID)
            if (channel != null && channel.importance == NotificationManager.IMPORTANCE_NONE) return shown("disabled")
            val code = noticeNumber(id)
            val open = Intent(context, MainActivity::class.java)
                .setAction(Intent.ACTION_VIEW)
                .putExtra(EXTRA_NOTICE_ID, id)
                .putExtra(EXTRA_NOTICE_ROUTE, route)
            val pending = PendingIntent.getActivity(context, code, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val shortTitle = clip(title, TITLE_MAX)
            val shortBody = clip(body, BODY_MAX)
            val notification = Notification.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(shortTitle.ifEmpty { t("harmony.notify.emptyTitle") })
                .setContentText(shortBody.ifEmpty { t("harmony.notify.emptyBody") })
                .setContentIntent(pending)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setShowWhen(true)
                .build()
            manager.notify(code, notification)
            Log.i(TAG, "notification $id published as $code")
            shown("published", code)
        } catch (e: Exception) {
            Log.e(TAG, "publish notification $id failed", e)
            shown("failed", message = e.message ?: e.javaClass.simpleName)
        }
    }

    private fun shown(result: String, number: Int? = null, message: String? = null): String {
        val json = JSONObject().put("result", result)
        if (number != null) json.put("number", number)
        if (message != null) json.put("message", message)
        return json.toString()
    }

    /** 渠道的名字跟着 App 现在的语言；已经建了的再建一次只是改名字，用户改过的设置不动 */
    private fun ensureChannel() {
        val channel = NotificationChannel(CHANNEL_ID, t("harmony.android.notifyChannel"), NotificationManager.IMPORTANCE_HIGH)
        channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        manager.createNotificationChannel(channel)
    }

    /** 系统设置里这个应用的通知开没开 */
    private fun enabled(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        return manager.areNotificationsEnabled()
    }
}

/** 这个 App 的通知设置页 */
fun appNotificationSettings(context: Context): Intent =
    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
