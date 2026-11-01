package com.catmaniii.ergo.ui

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color

/**
 * 原生画的部分和鸿蒙 App 对照的值都在这里（用户 2026-10-31 要求两边看起来是同一个产品）。改一边时照注释里的文件改另一边。
 * 单位：字号 sp（鸿蒙 fp），长度 dp（鸿蒙 vp），两边换算一样。
 *
 * 颜色的来历：
 * - 启动画面：鸿蒙工程 resources/{base,dark}/element/color.json 的 start_window_background；
 * - sys.color.ohos_id_color_*：鸿蒙的系统主题色（pages/Index.ets 用的），这里抄的是 OpenHarmony 系统资源的默认值。
 *   2026-11-01 拿 Pura 90 模拟器截图量过：浅色背景实际是 #FFFFFF（OpenHarmony 的默认值 #F1F3F5 不对，已改）；输入框、普通按钮的底色 #F3F3F3、
 *   主按钮 #0A58F6 对得上。深色没有量过。
 */
object ErgoTheme {
    class Palette(
        /** sys.color.ohos_id_color_background：地址页、出错页、"这不是二狗？"那一条、WebView 画出来之前的底色、状态栏那一截 */
        val background: Int,
        /** ohos_id_color_text_primary */
        val textPrimary: Int,
        /** ohos_id_color_text_secondary */
        val textSecondary: Int,
        /** ohos_id_color_text_tertiary：输入框的占位字 */
        val textTertiary: Int,
        /** ohos_id_color_warning：地址填错的提示 */
        val warning: Int,
        /** ohos_id_color_emphasize：主按钮的底色、光标 */
        val emphasize: Int,
        /** ohos_id_color_foreground_contrary：主按钮的字 */
        val onEmphasize: Int,
        /** ButtonStyleMode.NORMAL 的底色（ohos_id_color_button_normal） */
        val buttonNormal: Int,
        /** ButtonStyleMode.NORMAL 的字（ohos_id_color_text_primary_activated） */
        val buttonNormalText: Int,
        /** TextInput 的底色 */
        val inputFill: Int,
        /** 轻提示（showToast）的底色和字 */
        val toastFill: Int,
        val toastText: Int,
    )

    val LIGHT = Palette(
        background = Color.parseColor("#FFFFFF"),
        textPrimary = Color.parseColor("#E5000000"),
        textSecondary = Color.parseColor("#99000000"),
        textTertiary = Color.parseColor("#66000000"),
        warning = Color.parseColor("#E84026"),
        emphasize = Color.parseColor("#0A59F7"),
        onEmphasize = Color.parseColor("#FFFFFF"),
        buttonNormal = Color.parseColor("#0C000000"),
        buttonNormalText = Color.parseColor("#0A59F7"),
        inputFill = Color.parseColor("#0C000000"),
        toastFill = Color.parseColor("#F2FFFFFF"),
        toastText = Color.parseColor("#E5000000"),
    )

    val DARK = Palette(
        background = Color.parseColor("#000000"),
        textPrimary = Color.parseColor("#E5FFFFFF"),
        textSecondary = Color.parseColor("#99FFFFFF"),
        textTertiary = Color.parseColor("#66FFFFFF"),
        warning = Color.parseColor("#D94838"),
        emphasize = Color.parseColor("#317AF7"),
        onEmphasize = Color.parseColor("#FFFFFF"),
        buttonNormal = Color.parseColor("#19FFFFFF"),
        buttonNormalText = Color.parseColor("#317AF7"),
        inputFill = Color.parseColor("#19FFFFFF"),
        toastFill = Color.parseColor("#E62E3033"),
        toastText = Color.parseColor("#E5FFFFFF"),
    )

    /** pages/Index.ets 的 AddressPage */
    const val ADDRESS_PADDING_DP = 24
    const val ADDRESS_SPACE_DP = 14
    const val ADDRESS_TITLE_SP = 30f
    const val ADDRESS_HEADING_SP = 17f
    const val ADDRESS_HINT_SP = 14f
    const val ADDRESS_ERROR_SP = 14f
    /** 地址页最上面的"扫码连接"（364 号票）：比普通按钮高，铺满一行 */
    const val SCAN_BUTTON_HEIGHT_DP = 48
    /** 连不上的那一页（364 号票）：提醒检查的那几条 */
    const val CONNECT_CHECK_SP = 14f
    const val CONNECT_CHECK_SPACE_DP = 6

    /** pages/Index.ets 的 ErrorPage */
    const val ERROR_PADDING_DP = 24
    const val ERROR_SPACE_DP = 16
    const val ERROR_TITLE_SP = 22f
    const val ERROR_REASON_SP = 15f
    const val ERROR_ADDRESS_SP = 13f

    /** pages/Index.ets 的 NotErgoBar */
    const val BAR_SPACE_DP = 12
    const val BAR_PADDING_H_DP = 16
    const val BAR_PADDING_V_DP = 10
    const val BAR_TEXT_SP = 15f
    const val BAR_SHADOW_RADIUS_DP = 12f
    val SHADOW_COLOR: Int = Color.parseColor("#33000000")

    /** Row({ space: 12 })：地址页、出错页的按钮之间 */
    const val BUTTON_ROW_SPACE_DP = 12

    /** ArkUI 的 Button 默认：胶囊形，高 40，字 16 Medium，左右留 16 */
    const val BUTTON_HEIGHT_DP = 40
    const val BUTTON_TEXT_SP = 16f
    const val BUTTON_PADDING_H_DP = 16
    const val BUTTON_FONT_WEIGHT = 500

    /** ArkUI 的 TextInput 默认：胶囊形，高 40，字 16，左右留 16 */
    const val INPUT_HEIGHT_DP = 40
    const val INPUT_TEXT_SP = 16f
    const val INPUT_PADDING_H_DP = 16

    /** promptAction.showToast：在底部上方 80，字 14，停 2500 毫秒（Index.ets 的 duration） */
    const val TOAST_BOTTOM_DP = 80
    const val TOAST_TEXT_SP = 14f
    const val TOAST_PADDING_H_DP = 16
    const val TOAST_PADDING_V_DP = 8
    const val TOAST_RADIUS_DP = 20f
    const val TOAST_DURATION_MS = 2500L

    /** 权限说明：鸿蒙的系统授权框里有 reason 这一句，安卓的框写不了字，自己写在上方（ui/NativePages.kt 的 PermissionNote） */
    const val PERMISSION_NOTE_MARGIN_DP = 12
    const val PERMISSION_NOTE_PADDING_V_DP = 12

    /** pages/Index.ets 的 SidePage：滑进滑出的时长、阴影（radius 16、color #33000000、offsetX -2） */
    const val SIDE_OPEN_MS = 220L
    const val SIDE_CLOSE_MS = 200L
    const val SIDE_SHADOW_RADIUS_DP = 16f
    const val SIDE_SHADOW_OFFSET_DP = -2f

    /** 现在算不算深色：网页设置里选了就照它，没选（跟随系统）看系统 */
    fun isDark(context: Context, mode: String): Boolean = when (mode) {
        "dark" -> true
        "light" -> false
        else -> (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    }

    fun palette(dark: Boolean): Palette = if (dark) DARK else LIGHT
}
