package com.catmaniii.ergo.common

import android.content.Context
import android.util.Log
import org.json.JSONObject

const val TAG = "ErgoApp"

/**
 * App 原生的字（对应鸿蒙 common/AppTexts.ets，175 号票）：句子不写在代码里，都在共享协议包的 locales/<语言>/harmony.json（key 是 harmony.*，
 * 安卓独有的在 harmony.android.*）。npm run build:android 收进 assets/harmony-texts.json；连上之后二狗的网页经 setTexts 交来当前语言的这几句，
 * 记在偏好里，App 重开时先用记下的；从没连上过用英文。找不到依次退到自带的同一种语言、自带的中文，都没有回 key 本身。
 */
object AppTexts {
    private const val BUNDLED_FILE = "harmony-texts.json"
    private const val DEFAULT_LANGUAGE = "zh-CN"
    private const val FIRST_LANGUAGE = "en"
    private const val KEY_PREFIX = "harmony."
    private const val TEXT_MAX = 1000
    private const val TEXTS_MAX = 500

    private val bundled = HashMap<String, Map<String, String>>()
    private var language = DEFAULT_LANGUAGE
    private var fromWeb: Map<String, String> = emptyMap()
    private var listener: (() -> Unit)? = null
    private var settings: AppSettings? = null

    private class Parsed(val language: String, val texts: Map<String, String>)

    /** 网页交来的一份（或记下的那份）认不认得：认得就回语言代码和只留 harmony.* 的句子 */
    private fun parse(json: String): Parsed? {
        val message = try {
            JSONObject(json)
        } catch (_: Exception) {
            return null
        }
        val lang = message.optString("language")
        val texts = message.optJSONObject("texts")
        if (lang.isEmpty() || texts == null) return null
        val kept = HashMap<String, String>()
        var seen = 0
        for (key in texts.keys()) {
            if (seen++ >= TEXTS_MAX) break
            val text = texts.opt(key)
            if (key.startsWith(KEY_PREFIX) && text is String && text.isNotEmpty()) kept[key] = text.take(TEXT_MAX)
        }
        return Parsed(lang, kept)
    }

    /** App 起来时读 assets 里的自带语言；记得上次网页交来的就用它，没有就用英文 */
    fun load(context: Context) {
        try {
            val text = context.assets.open(BUNDLED_FILE).bufferedReader(Charsets.UTF_8).use { it.readText() }
            val all = JSONObject(text)
            for (lang in all.keys()) {
                val messages = all.getJSONObject(lang)
                val map = HashMap<String, String>()
                for (key in messages.keys()) {
                    val value = messages.opt(key)
                    if (value is String) map[key] = value
                }
                bundled[lang] = map
            }
        } catch (e: Exception) {
            Log.e(TAG, "app texts missing (run npm run build:android)", e)
        }
        language = if (bundled.containsKey(FIRST_LANGUAGE)) FIRST_LANGUAGE else DEFAULT_LANGUAGE
        val store = AppSettings(context)
        settings = store
        val remembered = parse(store.appTexts())
        if (remembered != null) {
            language = remembered.language
            fromWeb = remembered.texts
        }
        Log.i(TAG, "app texts: ${bundled.size} bundled languages, using $language")
    }

    /** 取一句，{name} 换成参数；没给的参数原样留着 */
    fun get(key: String, params: Map<String, String> = emptyMap()): String {
        var out = fromWeb[key] ?: bundled[language]?.get(key) ?: bundled[DEFAULT_LANGUAGE]?.get(key) ?: key
        for ((name, value) in params) out = out.replace("{$name}", value)
        return out
    }

    /** 二狗的网页交来当前语言的这几句（原生桥 setTexts）：认得出来就整份换上（没交的那几句退回自带的），回 true */
    fun setFromWeb(json: String): Boolean {
        val message = parse(json)
        if (message == null) {
            Log.w(TAG, "app texts from web ignored: bad shape")
            return false
        }
        val changed = message.language != language || message.texts != fromWeb
        language = message.language
        fromWeb = message.texts
        if (changed) {
            Log.i(TAG, "app texts from web: $language, ${message.texts.size} texts")
            // 记下来：App 重开时地址页、出错页一开场就是这种语言（只记收拾过的那份）
            settings?.setAppTexts(JSONObject().put("language", language).put("texts", JSONObject(message.texts)).toString())
            listener?.invoke()
        }
        return true
    }

    /** 换了字时调它（只有一个：MainActivity） */
    fun listen(next: (() -> Unit)?) {
        listener = next
    }
}

/** 取 App 原生的一句（key 是 harmony.*，句子在共享协议包的 locales/<语言>/harmony.json） */
fun t(key: String, params: Map<String, String> = emptyMap()): String = AppTexts.get(key, params)
