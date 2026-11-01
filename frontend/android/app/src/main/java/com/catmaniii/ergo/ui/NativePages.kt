package com.catmaniii.ergo.ui

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import com.catmaniii.ergo.common.t

/** dp 换成像素 */
fun Context.dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()
fun Context.dpf(value: Float): Float = value * resources.displayMetrics.density

private fun TextView.textSp(sp: Float) = setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)

/** Medium、Bold 这些粗细；老系统没有按数字选粗细的办法，退到系统的 medium */
private fun weighted(weight: Int): Typeface =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) Typeface.create(Typeface.DEFAULT, weight, false)
    else Typeface.create("sans-serif-medium", Typeface.NORMAL)

/** 按钮的样子（ArkUI 的 Button，ButtonStyleMode 的 EMPHASIZED、NORMAL） */
enum class ButtonKind { EMPHASIZED, NORMAL }

/** ArkUI 默认样子的按钮：胶囊形、高 40、字 16 Medium */
class ErgoButton(context: Context, private val kind: ButtonKind) : TextView(context) {
    init {
        gravity = Gravity.CENTER
        textSp(ErgoTheme.BUTTON_TEXT_SP)
        typeface = weighted(ErgoTheme.BUTTON_FONT_WEIGHT)
        minHeight = context.dp(ErgoTheme.BUTTON_HEIGHT_DP)
        includeFontPadding = false
        isAllCaps = false
        isClickable = true
        isFocusable = true
        setPadding(context.dp(ErgoTheme.BUTTON_PADDING_H_DP), 0, context.dp(ErgoTheme.BUTTON_PADDING_H_DP), 0)
    }

    fun applyPalette(palette: ErgoTheme.Palette) {
        val fill = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = context.dp(ErgoTheme.BUTTON_HEIGHT_DP) / 2f
            setColor(if (kind == ButtonKind.EMPHASIZED) palette.emphasize else palette.buttonNormal)
        }
        // 按下时的一层薄灰，和 ArkUI 按钮的按压效果差不多（不要 Material 的扩散波纹感：颜色很淡）
        background = RippleDrawable(ColorStateList.valueOf(0x19000000), fill, null)
        setTextColor(if (kind == ButtonKind.EMPHASIZED) palette.onEmphasize else palette.buttonNormalText)
    }
}

/** 一页原生的界面：换深浅色、换语言时重画 */
interface NativePage {
    val view: View
    fun refresh(palette: ErgoTheme.Palette)
}

private fun Context.space(view: View, topDp: Int): LinearLayout.LayoutParams =
    LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
        topMargin = dp(topDp)
    }

/** 地址页（pages/Index.ets 的 AddressPage）：第一次打开，或者网页设置里点了"换地址"、出错页上点了"改地址" */
class AddressPage(
    private val context: Context,
    private val onSubmit: (String) -> Unit,
    private val onCancel: () -> Unit,
    private val onChange: () -> Unit,
    onScan: () -> Unit,
) : NativePage {
    private val title = TextView(context).apply {
        textSp(ErgoTheme.ADDRESS_TITLE_SP)
        typeface = Typeface.DEFAULT_BOLD
    }
    /** 最上面的大按钮：手填放下面 */
    private val scan = ErgoButton(context, ButtonKind.EMPHASIZED).apply { setOnClickListener { onScan() } }
    private val scanHint = TextView(context).apply { textSp(ErgoTheme.ADDRESS_HINT_SP) }
    private val heading = TextView(context).apply { textSp(ErgoTheme.ADDRESS_HEADING_SP) }
    private val hint = TextView(context).apply { textSp(ErgoTheme.ADDRESS_HINT_SP) }
    val input = EditText(context).apply {
        textSp(ErgoTheme.INPUT_TEXT_SP)
        hint = "https://"
        isSingleLine = true
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        imeOptions = EditorInfo.IME_ACTION_GO or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        setPadding(context.dp(ErgoTheme.INPUT_PADDING_H_DP), 0, context.dp(ErgoTheme.INPUT_PADDING_H_DP), 0)
        setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) {
                onSubmit(text.toString())
                true
            } else {
                false
            }
        }
        addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) = onChange()
        })
    }
    private val error = TextView(context).apply {
        textSp(ErgoTheme.ADDRESS_ERROR_SP)
        visibility = View.GONE
    }
    private val cancel = ErgoButton(context, ButtonKind.NORMAL).apply { setOnClickListener { onCancel() } }
    private val connect = ErgoButton(context, ButtonKind.EMPHASIZED).apply { setOnClickListener { onSubmit(input.text.toString()) } }
    private val column = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_VERTICAL or Gravity.START
    }
    private val scroll = ScrollView(context).apply {
        isFillViewport = true
        // 没碰过屏幕时（键盘、模拟器）系统会给拿到焦点的整页盖一层灰，鸿蒙没有
        defaultFocusHighlightEnabled = false
        isFocusable = false
        addView(column, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
    }
    override val view: View = scroll

    init {
        val pad = context.dp(ErgoTheme.ADDRESS_PADDING_DP)
        val gap = ErgoTheme.ADDRESS_SPACE_DP
        column.setPadding(pad, pad, pad, pad)
        column.addView(title)
        column.addView(
            scan,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, context.dp(ErgoTheme.SCAN_BUTTON_HEIGHT_DP)).apply { topMargin = context.dp(gap) },
        )
        column.addView(scanHint, context.space(scanHint, gap))
        column.addView(heading, context.space(heading, gap * 2))
        column.addView(hint, context.space(hint, gap))
        column.addView(
            input,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, context.dp(ErgoTheme.INPUT_HEIGHT_DP)).apply { topMargin = context.dp(gap) },
        )
        column.addView(error, context.space(error, gap))
        val row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
        row.addView(cancel, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, context.dp(ErgoTheme.BUTTON_HEIGHT_DP)))
        row.addView(
            connect,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, context.dp(ErgoTheme.BUTTON_HEIGHT_DP)).apply {
                marginStart = context.dp(ErgoTheme.BUTTON_ROW_SPACE_DP)
            },
        )
        column.addView(row, context.space(row, gap))
    }

    /** 取消按钮只在已经配过地址时有；错误提示是空串时不占位 */
    fun show(draft: String, hasServer: Boolean) {
        input.setText(draft)
        input.setSelection(draft.length)
        cancel.visibility = if (hasServer) View.VISIBLE else View.GONE
        // 改完要设回去：marginStart 要经 setLayoutParams 才换算成左边距
        connect.layoutParams = (connect.layoutParams as LinearLayout.LayoutParams).apply {
            marginStart = if (hasServer) context.dp(ErgoTheme.BUTTON_ROW_SPACE_DP) else 0
        }
        setError("")
    }

    /** 手势条那一截（像素）：内容留在它上面 */
    fun setBottomInset(px: Int) {
        val pad = context.dp(ErgoTheme.ADDRESS_PADDING_DP)
        column.setPadding(pad, pad, pad, pad + px)
    }

    fun setError(text: String) {
        error.text = text
        error.visibility = if (text.isEmpty()) View.GONE else View.VISIBLE
    }

    override fun refresh(palette: ErgoTheme.Palette) {
        title.text = t("harmony.address.title")
        scan.text = t("harmony.address.scan")
        scanHint.text = t("harmony.address.scanHint")
        heading.text = t("harmony.address.heading")
        hint.text = t("harmony.address.hint")
        cancel.text = t("harmony.address.cancel")
        connect.text = t("harmony.address.connect")
        // 底色铺到手势条底下（expandSafeArea），内容留在它上面
        scroll.background = ColorDrawable(palette.background)
        title.setTextColor(palette.textPrimary)
        scan.applyPalette(palette)
        scanHint.setTextColor(palette.textSecondary)
        heading.setTextColor(palette.textPrimary)
        hint.setTextColor(palette.textSecondary)
        error.setTextColor(palette.warning)
        input.setTextColor(palette.textPrimary)
        input.setHintTextColor(palette.textTertiary)
        input.highlightColor = palette.emphasize and 0x33FFFFFF
        input.background = GradientDrawable().apply {
            cornerRadius = context.dp(ErgoTheme.INPUT_HEIGHT_DP) / 2f
            setColor(palette.inputFill)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            input.textCursorDrawable = GradientDrawable().apply {
                setColor(palette.emphasize)
                setSize(context.dp(2), 1)
            }
        }
        cancel.applyPalette(palette)
        connect.applyPalette(palette)
    }
}

/** 出错页（pages/Index.ets 的 ErrorPage）：网页打不开时的原生页 */
class ErrorPage(private val context: Context, onRetry: () -> Unit, onEdit: () -> Unit) : NativePage {
    private val title = TextView(context).apply {
        textSp(ErgoTheme.ERROR_TITLE_SP)
        typeface = weighted(500)
        gravity = Gravity.CENTER
    }
    private val reason = TextView(context).apply {
        textSp(ErgoTheme.ERROR_REASON_SP)
        gravity = Gravity.CENTER
    }
    private val address = TextView(context).apply {
        textSp(ErgoTheme.ERROR_ADDRESS_SP)
        gravity = Gravity.CENTER
    }
    private val retry = ErgoButton(context, ButtonKind.EMPHASIZED).apply { setOnClickListener { onRetry() } }
    private val edit = ErgoButton(context, ButtonKind.NORMAL).apply { setOnClickListener { onEdit() } }
    private val column = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
    }
    override val view: View = column

    init {
        val pad = context.dp(ErgoTheme.ERROR_PADDING_DP)
        val gap = ErgoTheme.ERROR_SPACE_DP
        column.setPadding(pad, pad, pad, pad)
        column.addView(title)
        column.addView(reason, context.space(reason, gap))
        column.addView(address, context.space(address, gap))
        val row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
        row.addView(retry, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, context.dp(ErgoTheme.BUTTON_HEIGHT_DP)))
        row.addView(
            edit,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, context.dp(ErgoTheme.BUTTON_HEIGHT_DP)).apply {
                marginStart = context.dp(ErgoTheme.BUTTON_ROW_SPACE_DP)
            },
        )
        column.addView(row, context.space(row, gap))
    }

    /** 手势条那一截（像素）：内容留在它上面，底色铺到底下 */
    fun setBottomInset(px: Int) {
        val pad = context.dp(ErgoTheme.ERROR_PADDING_DP)
        column.setPadding(pad, pad, pad, pad + px)
    }

    fun show(message: String, href: String) {
        reason.text = message
        address.text = href
    }

    override fun refresh(palette: ErgoTheme.Palette) {
        title.text = t("harmony.index.cantOpen")
        retry.text = t("harmony.index.retry")
        edit.text = t("harmony.index.editAddress")
        column.background = ColorDrawable(palette.background)
        title.setTextColor(palette.textPrimary)
        reason.setTextColor(palette.textSecondary)
        address.setTextColor(palette.textSecondary)
        retry.applyPalette(palette)
        edit.applyPalette(palette)
    }
}

/**
 * 扫码之后测连接的那一页（pages/Index.ets 的 ConnectPage）：正在连、连不上（原因、提醒检查什么、重试和重新扫码）。
 * 连得上就直接进配对页，这一页只是一闪
 */
class ConnectPage(private val context: Context, onRetry: () -> Unit, onRescan: () -> Unit, onBack: () -> Unit) : NativePage {
    private val title = TextView(context).apply {
        textSp(ErgoTheme.ERROR_TITLE_SP)
        typeface = weighted(500)
        gravity = Gravity.CENTER
    }
    private val spinner = ProgressBar(context)
    private val reason = TextView(context).apply {
        textSp(ErgoTheme.ERROR_REASON_SP)
        gravity = Gravity.CENTER
    }
    private val address = TextView(context).apply {
        textSp(ErgoTheme.ERROR_ADDRESS_SP)
        gravity = Gravity.CENTER
    }
    private val checkTitle = TextView(context).apply { textSp(ErgoTheme.CONNECT_CHECK_SP) }
    private val checks = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private val retry = ErgoButton(context, ButtonKind.EMPHASIZED).apply { setOnClickListener { onRetry() } }
    private val rescan = ErgoButton(context, ButtonKind.NORMAL).apply { setOnClickListener { onRescan() } }
    private val back = ErgoButton(context, ButtonKind.NORMAL).apply { setOnClickListener { onBack() } }
    private val row = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_HORIZONTAL
    }
    private val column = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
    }
    private val scroll = ScrollView(context).apply {
        isFillViewport = true
        defaultFocusHighlightEnabled = false
        isFocusable = false
        addView(column, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
    }
    private var checkKeys: List<String> = emptyList()
    private var palette: ErgoTheme.Palette? = null
    override val view: View = scroll

    init {
        val pad = context.dp(ErgoTheme.ERROR_PADDING_DP)
        val gap = ErgoTheme.ERROR_SPACE_DP
        column.setPadding(pad, pad, pad, pad)
        column.addView(title, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        column.addView(spinner, context.space(spinner, gap))
        column.addView(reason, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.dp(gap) })
        column.addView(address, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.dp(gap) })
        column.addView(checkTitle, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.dp(gap) })
        column.addView(checks, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        row.addView(retry, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, context.dp(ErgoTheme.BUTTON_HEIGHT_DP)))
        row.addView(
            rescan,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, context.dp(ErgoTheme.BUTTON_HEIGHT_DP)).apply {
                marginStart = context.dp(ErgoTheme.BUTTON_ROW_SPACE_DP)
            },
        )
        column.addView(row, context.space(row, gap))
        column.addView(back, context.space(back, ErgoTheme.BUTTON_ROW_SPACE_DP).apply { height = context.dp(ErgoTheme.BUTTON_HEIGHT_DP) })
    }

    /** 手势条那一截（像素）：内容留在它上面，底色铺到底下 */
    fun setBottomInset(px: Int) {
        val pad = context.dp(ErgoTheme.ERROR_PADDING_DP)
        column.setPadding(pad, pad, pad, pad + px)
    }

    /** 正在连 */
    fun showTesting(href: String) {
        title.text = t("harmony.connect.testing")
        spinner.visibility = View.VISIBLE
        reason.visibility = View.GONE
        address.text = href
        checkTitle.visibility = View.GONE
        checks.visibility = View.GONE
        row.visibility = View.GONE
        back.visibility = View.VISIBLE
    }

    /** 连不上：原因、提醒检查什么（先后已经排好）、重试和重新扫码。canRetry 假的是扫到的根本不是地址，重试没有意义 */
    fun showFailed(titleText: String, reasonText: String, href: String, checkList: List<String>, canRetry: Boolean) {
        title.text = titleText
        spinner.visibility = View.GONE
        reason.text = reasonText
        reason.visibility = View.VISIBLE
        address.text = href
        address.visibility = if (href.isEmpty()) View.GONE else View.VISIBLE
        checkKeys = checkList
        checkTitle.visibility = if (checkList.isEmpty()) View.GONE else View.VISIBLE
        checks.visibility = if (checkList.isEmpty()) View.GONE else View.VISIBLE
        retry.visibility = if (canRetry) View.VISIBLE else View.GONE
        rescan.layoutParams = (rescan.layoutParams as LinearLayout.LayoutParams).apply {
            marginStart = if (canRetry) context.dp(ErgoTheme.BUTTON_ROW_SPACE_DP) else 0
        }
        row.visibility = View.VISIBLE
        back.visibility = View.VISIBLE
        renderChecks()
    }

    private fun renderChecks() {
        val colors = palette ?: return
        checks.removeAllViews()
        for (key in checkKeys) {
            val line = TextView(context).apply {
                textSp(ErgoTheme.CONNECT_CHECK_SP)
                text = "• ${t("harmony.connect.check.$key")}"
                setTextColor(colors.textSecondary)
            }
            checks.addView(line, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.dp(ErgoTheme.CONNECT_CHECK_SPACE_DP) })
        }
    }

    override fun refresh(palette: ErgoTheme.Palette) {
        this.palette = palette
        checkTitle.text = t("harmony.connect.checkTitle")
        retry.text = t("harmony.connect.retry")
        rescan.text = t("harmony.connect.rescan")
        back.text = t("harmony.connect.back")
        scroll.background = ColorDrawable(palette.background)
        title.setTextColor(palette.textPrimary)
        reason.setTextColor(palette.textSecondary)
        address.setTextColor(palette.textSecondary)
        checkTitle.setTextColor(palette.textPrimary)
        spinner.indeterminateTintList = ColorStateList.valueOf(palette.emphasize)
        retry.applyPalette(palette)
        rescan.applyPalette(palette)
        back.applyPalette(palette)
        renderChecks()
    }
}

/**
 * 地址填成了能打开、但不是二狗的网站时，原生层唯一的出口（pages/Index.ets 的 NotErgoBar）。
 * 阴影照鸿蒙 radius 12、#33000000 自己画（安卓的 elevation 改不了模糊半径）；底色铺到手势条底下，内容留在避让区之上
 */
class NotErgoBar(private val context: Context, onChange: () -> Unit, onClose: () -> Unit) : NativePage {
    private val label = TextView(context).apply { textSp(ErgoTheme.BAR_TEXT_SP) }
    private val change = ErgoButton(context, ButtonKind.EMPHASIZED).apply { setOnClickListener { onChange() } }
    private val close = ErgoButton(context, ButtonKind.NORMAL).apply { setOnClickListener { onClose() } }
    private val inset = context.dp(ErgoTheme.BAR_SHADOW_RADIUS_DP.toInt())
    private val shadow = ShadowView(context, ErgoTheme.BAR_SHADOW_RADIUS_DP, 0f, 0, inset)
    private val bar = FrameLayout(context)
    private val row = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
    }
    override val view: View = bar

    init {
        bar.addView(shadow, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        val h = context.dp(ErgoTheme.BAR_PADDING_H_DP)
        val v = context.dp(ErgoTheme.BAR_PADDING_V_DP)
        row.setPadding(h, v, h, v)
        row.addView(label, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(
            change,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, context.dp(ErgoTheme.BUTTON_HEIGHT_DP)).apply {
                marginStart = context.dp(ErgoTheme.BAR_SPACE_DP)
            },
        )
        row.addView(
            close,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, context.dp(ErgoTheme.BUTTON_HEIGHT_DP)).apply {
                marginStart = context.dp(ErgoTheme.BAR_SPACE_DP)
            },
        )
        // 上面留出阴影的位置（透明，不挡触摸）
        bar.addView(row, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = inset })
    }

    /** 手势条那一截（像素）：内容留在它上面 */
    fun setBottomInset(px: Int) {
        val h = context.dp(ErgoTheme.BAR_PADDING_H_DP)
        val v = context.dp(ErgoTheme.BAR_PADDING_V_DP)
        row.setPadding(h, v, h, v + px)
    }

    override fun refresh(palette: ErgoTheme.Palette) {
        label.text = t("harmony.index.notErgo")
        change.text = t("harmony.index.changeAddress")
        close.text = t("harmony.index.close")
        label.setTextColor(palette.textPrimary)
        shadow.setFill(palette.background)
        change.applyPalette(palette)
        close.applyPalette(palette)
    }
}

/**
 * 阴影（照鸿蒙 .shadow({ radius, color: '#33000000', offsetX }) 的数值，elevation 的阴影改不了半径和偏移）：单独一个视图，摆在内容后面，
 * 比内容多出 insetLeft、insetTop 这两边让阴影画得下（软件图层画不到视图外面）。不能把 WebView 放进它里面：软件图层下 WebView 画不出来。
 */
class ShadowView(context: Context, radiusDp: Float, offsetXDp: Float, private val insetLeft: Int, private val insetTop: Int) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        setShadowLayer(context.dpf(radiusDp), context.dpf(offsetXDp), 0f, ErgoTheme.SHADOW_COLOR)
    }
    private val rect = RectF()

    init {
        // setShadowLayer 要软件图层才画
        setLayerType(LAYER_TYPE_SOFTWARE, null)
    }

    fun setFill(color: Int) {
        paint.color = color
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        rect.set(insetLeft.toFloat(), insetTop.toFloat(), width.toFloat(), height.toFloat())
        canvas.drawRect(rect, paint)
    }
}

/**
 * 轻提示（对应鸿蒙的 promptAction.showToast）：下载开始、存好了这些。自己画一个，不用系统 Toast：系统 Toast 的样子每个厂商都不一样
 */
class ToastHost(private val context: Context) {
    private val label = TextView(context).apply {
        textSp(ErgoTheme.TOAST_TEXT_SP)
        gravity = Gravity.CENTER
        visibility = View.GONE
        elevation = context.dpf(6f)
        setPadding(
            context.dp(ErgoTheme.TOAST_PADDING_H_DP),
            context.dp(ErgoTheme.TOAST_PADDING_V_DP),
            context.dp(ErgoTheme.TOAST_PADDING_H_DP),
            context.dp(ErgoTheme.TOAST_PADDING_V_DP),
        )
    }
    private val handler = Handler(Looper.getMainLooper())
    private val hide = Runnable { label.visibility = View.GONE }
    val view: View = label

    fun layoutParams(): FrameLayout.LayoutParams =
        FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply {
            bottomMargin = context.dp(ErgoTheme.TOAST_BOTTOM_DP)
            marginStart = context.dp(24)
            marginEnd = context.dp(24)
        }

    fun show(text: String) {
        label.text = text
        label.visibility = View.VISIBLE
        label.bringToFront()
        handler.removeCallbacks(hide)
        handler.postDelayed(hide, ErgoTheme.TOAST_DURATION_MS)
    }

    fun refresh(palette: ErgoTheme.Palette) {
        label.setTextColor(palette.toastText)
        label.background = GradientDrawable().apply {
            cornerRadius = context.dpf(ErgoTheme.TOAST_RADIUS_DP)
            setColor(palette.toastFill)
        }
    }
}

/**
 * 权限说明（对应鸿蒙 module.json5 里 requestPermissions 的 reason：鸿蒙的系统授权框上写着这句，安卓的系统框写不了字，
 * 所以系统框弹着的时候在屏幕上方自己写一句）
 */
class PermissionNote(private val context: Context) {
    private val label = TextView(context).apply {
        textSp(ErgoTheme.TOAST_TEXT_SP)
        visibility = View.GONE
        elevation = context.dpf(6f)
        setPadding(
            context.dp(ErgoTheme.TOAST_PADDING_H_DP),
            context.dp(ErgoTheme.PERMISSION_NOTE_PADDING_V_DP),
            context.dp(ErgoTheme.TOAST_PADDING_H_DP),
            context.dp(ErgoTheme.PERMISSION_NOTE_PADDING_V_DP),
        )
    }
    val view: View = label

    fun layoutParams(): FrameLayout.LayoutParams =
        FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP).apply {
            val margin = context.dp(ErgoTheme.PERMISSION_NOTE_MARGIN_DP)
            setMargins(margin, margin, margin, 0)
        }

    fun show(text: String) {
        label.text = text
        label.visibility = View.VISIBLE
        label.bringToFront()
    }

    fun hide() {
        label.visibility = View.GONE
    }

    fun refresh(palette: ErgoTheme.Palette) {
        label.setTextColor(palette.toastText)
        label.background = GradientDrawable().apply {
            cornerRadius = context.dpf(ErgoTheme.TOAST_RADIUS_DP)
            setColor(palette.toastFill)
        }
    }
}
