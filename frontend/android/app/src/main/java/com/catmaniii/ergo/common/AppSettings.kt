package com.catmaniii.ergo.common

import android.content.Context

/**
 * App 自己的设置（对应鸿蒙 common/AppSettings.ets，第一版没有手机数据源那几项）。存在应用沙箱，不进备份（AndroidManifest 的 allowBackup=false）。
 */
class AppSettings(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun serverUrl(): String = prefs.getString(KEY_SERVER, "") ?: ""
    fun setServerUrl(href: String) = put(KEY_SERVER, href)

    fun colorMode(): String = prefs.getString(KEY_COLOR_MODE, "") ?: ""
    fun setColorMode(mode: String) = put(KEY_COLOR_MODE, mode)

    fun notifyAsked(): Boolean = prefs.getString(KEY_NOTIFY_ASKED, "") == "1"
    fun setNotifyAsked() = put(KEY_NOTIFY_ASKED, "1")
    /** Debug 工具集的"重置首次提示"：当作没问过用户 */
    fun clearNotifyAsked() = put(KEY_NOTIFY_ASKED, "")

    fun appTexts(): String = prefs.getString(KEY_APP_TEXTS, "") ?: ""
    fun setAppTexts(json: String) = put(KEY_APP_TEXTS, json)

    /** 要过麦克风权限没有：系统不告诉"用户拒绝并不再询问"，靠它和 shouldShowRequestPermissionRationale 一起判断 */
    fun microphoneAsked(): Boolean = prefs.getString(KEY_MICROPHONE_ASKED, "") == "1"
    fun setMicrophoneAsked() = put(KEY_MICROPHONE_ASKED, "1")

    private fun put(key: String, value: String) {
        prefs.edit().putString(key, value).apply()
    }

    private companion object {
        const val PREFS_NAME = "ergo_app"
        /** 用户配好的二狗地址 */
        const val KEY_SERVER = "server_url"
        /** 网页设置里选的外观：system / light / dark；开场先按它定深浅色，不等网页 */
        const val KEY_COLOR_MODE = "color_mode"
        /** 向用户要过通知授权没有：要过就是 '1'，用户拒了不再问 */
        const val KEY_NOTIFY_ASKED = "notify_asked"
        /** 上次二狗的网页交来的 App 原生的字：{ language, texts } 的 JSON */
        const val KEY_APP_TEXTS = "app_texts"
        const val KEY_MICROPHONE_ASKED = "microphone_asked"
    }
}
