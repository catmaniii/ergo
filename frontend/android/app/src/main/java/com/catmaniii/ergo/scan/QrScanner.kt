package com.catmaniii.ergo.scan

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.graphics.ImageFormat
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Log
import android.util.Size
import android.view.Gravity
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.catmaniii.ergo.common.TAG
import com.catmaniii.ergo.common.t
import com.catmaniii.ergo.ui.ButtonKind
import com.catmaniii.ergo.ui.ErgoButton
import com.catmaniii.ergo.ui.ErgoTheme
import com.catmaniii.ergo.ui.NativePage
import com.catmaniii.ergo.ui.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.ChecksumException
import com.google.zxing.DecodeHintType
import com.google.zxing.FormatException
import com.google.zxing.LuminanceSource
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.io.File

/** 解码：只认二维码，交给 ZXing 的最小包（core）。这里不碰相机，单独能测 */
object QrDecoder {
    private val HINTS = mapOf(
        DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
        DecodeHintType.CHARACTER_SET to "UTF-8",
        DecodeHintType.TRY_HARDER to true,
    )

    /** 解一帧；没有码、这一帧模糊都回 null（下一帧再来） */
    fun decode(source: LuminanceSource): String? = try {
        QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source)), HINTS).text
    } catch (_: NotFoundException) {
        null
    } catch (_: ChecksumException) {
        null
    } catch (_: FormatException) {
        null
    }

    /** 灰度数组解码（相机的 Y 平面、JVM 单测读的图都走这里） */
    fun decodeLuminance(width: Int, height: Int, pixels: IntArray): String? = decode(RGBLuminanceSource(width, height, pixels))

    /** 解一张图片文件（联调的测试入口用，走和相机同一个解码器）：读不了、没有码回 null */
    fun decodeFile(file: File): String? {
        val bitmap: Bitmap = BitmapFactory.decodeFile(file.path) ?: return null
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        return decodeLuminance(bitmap.width, bitmap.height, pixels)
    }
}

/** 取景框外面盖一层半透明，中间留一个框：对准的提示。颜色不跟深浅色走（底下是相机画面） */
private class ScanFrame(context: Context) : View(context) {
    private val shade = Paint().apply { color = 0x99000000.toInt() }
    private val clear = Paint(Paint.ANTI_ALIAS_FLAG).apply { xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR) }
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
    }
    private val frame = RectF()

    init {
        setLayerType(LAYER_TYPE_SOFTWARE, null)
        line.strokeWidth = context.dp(2).toFloat()
    }

    override fun onDraw(canvas: Canvas) {
        val side = minOf(width, height) * 0.7f
        val left = (width - side) / 2f
        val top = (height - side) / 2f
        frame.set(left, top, left + side, top + side)
        val radius = context.dp(12).toFloat()
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), shade)
        canvas.drawRoundRect(frame, radius, radius, clear)
        canvas.drawRoundRect(frame, radius, radius, line)
    }
}

/**
 * 扫码页：Camera2 取景，每帧的亮度交给 ZXing。鸿蒙用系统的扫码界面（@kit.ScanKit），安卓系统没有这样的界面，所以自己画一个最简单的：
 * 取景、框、一句提示、取消。相机权限由调用方要好（MainActivity 只在点"扫码连接"时才要）。
 */
class ScanPage(
    private val context: Context,
    private val onResult: (String) -> Unit,
    private val onCancel: () -> Unit,
    private val onUnavailable: (String) -> Unit,
) : NativePage {
    private val preview = TextureView(context)
    private val title = TextView(context).apply {
        setTextColor(Color.WHITE)
        textSize = ErgoTheme.ADDRESS_HEADING_SP
        gravity = Gravity.CENTER
    }
    private val hint = TextView(context).apply {
        setTextColor(Color.WHITE)
        textSize = ErgoTheme.ADDRESS_HINT_SP
        gravity = Gravity.CENTER
    }
    // 底下是相机画面：浅色的普通按钮看不清字，用强调色的
    private val cancel = ErgoButton(context, ButtonKind.EMPHASIZED).apply { setOnClickListener { onCancel() } }
    private val bottom = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
    }
    private val top = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
    }
    private val layer = FrameLayout(context).apply { setBackgroundColor(Color.BLACK) }
    override val view: View = layer

    private val main = Handler(Looper.getMainLooper())
    private var thread: HandlerThread? = null
    private var worker: Handler? = null
    private var camera: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var reader: ImageReader? = null
    private var running = false
    private var previewSize: Size? = null

    init {
        layer.addView(preview, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        layer.addView(ScanFrame(context), FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        val pad = context.dp(ErgoTheme.ADDRESS_PADDING_DP)
        top.setPadding(pad, pad * 2, pad, pad)
        top.addView(title)
        top.addView(hint, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.dp(8) })
        layer.addView(top, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP))
        bottom.setPadding(pad, pad, pad, pad)
        bottom.addView(cancel, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, context.dp(ErgoTheme.BUTTON_HEIGHT_DP)))
        layer.addView(bottom, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        preview.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
            override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
                if (running) openCamera()
            }

            override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) = fitPreview()
            override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean = true
            override fun onSurfaceTextureUpdated(surface: SurfaceTexture) = Unit
        }
    }

    /** 手势条那一截（像素）：按钮留在它上面 */
    fun setBottomInset(px: Int) {
        val pad = context.dp(ErgoTheme.ADDRESS_PADDING_DP)
        bottom.setPadding(pad, pad, pad, pad + px)
    }

    fun start() {
        if (running) return
        running = true
        if (preview.isAvailable) openCamera()
    }

    /** 关相机（取消、扫到了、切后台）：相机不留着 */
    fun stop() {
        running = false
        try {
            session?.close()
        } catch (_: Exception) {
        }
        session = null
        camera?.close()
        camera = null
        reader?.close()
        reader = null
        thread?.quitSafely()
        thread = null
        worker = null
    }

    /** 后置优先，没有就用第一个 */
    private fun pickCamera(manager: CameraManager): String? {
        val ids = manager.cameraIdList
        return ids.firstOrNull { manager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK } ?: ids.firstOrNull()
    }

    /** 不超过 1280x720 里最大的：二维码用不着更高，也省电 */
    private fun pickSize(manager: CameraManager, id: String): Size {
        val map = manager.getCameraCharacteristics(id).get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        val sizes = map?.getOutputSizes(ImageFormat.YUV_420_888).orEmpty()
        return sizes.filter { it.width <= 1280 && it.height <= 720 }.maxByOrNull { it.width * it.height } ?: sizes.minByOrNull { it.width * it.height } ?: Size(640, 480)
    }

    @SuppressLint("MissingPermission") // MainActivity 要好了相机权限才调 start()
    private fun openCamera() {
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        try {
            val id = pickCamera(manager) ?: return unavailable("no camera")
            val size = pickSize(manager, id)
            previewSize = size
            val background = HandlerThread("ergo-scan").apply { start() }
            thread = background
            val handler = Handler(background.looper)
            worker = handler
            val images = ImageReader.newInstance(size.width, size.height, ImageFormat.YUV_420_888, 2)
            reader = images
            images.setOnImageAvailableListener({ source -> analyze(source) }, handler)
            manager.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(device: CameraDevice) {
                    if (!running) {
                        device.close()
                        return
                    }
                    camera = device
                    startSession(device, size)
                }

                override fun onDisconnected(device: CameraDevice) {
                    device.close()
                    camera = null
                }

                override fun onError(device: CameraDevice, error: Int) {
                    device.close()
                    camera = null
                    unavailable("camera error $error")
                }
            }, handler)
        } catch (e: Exception) {
            unavailable(e.javaClass.simpleName)
        }
    }

    @Suppress("DEPRECATION") // createCaptureSession 的新写法要 API 28，这个 App 最低 26
    private fun startSession(device: CameraDevice, size: Size) {
        val texture = preview.surfaceTexture ?: return unavailable("no surface")
        texture.setDefaultBufferSize(size.width, size.height)
        main.post { fitPreview() }
        val surface = Surface(texture)
        val images = reader ?: return
        try {
            device.createCaptureSession(listOf(surface, images.surface), object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(capture: CameraCaptureSession) {
                    if (!running) return
                    session = capture
                    val request = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                        addTarget(surface)
                        addTarget(images.surface)
                        set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                    }
                    try {
                        capture.setRepeatingRequest(request.build(), null, worker)
                    } catch (e: Exception) {
                        unavailable(e.javaClass.simpleName)
                    }
                }

                override fun onConfigureFailed(capture: CameraCaptureSession) = unavailable("session")
            }, worker)
        } catch (e: Exception) {
            unavailable(e.javaClass.simpleName)
        }
    }

    /** 一帧：只要亮度平面，解得出就停 */
    private fun analyze(source: ImageReader) {
        val image = try {
            source.acquireLatestImage()
        } catch (_: Exception) {
            null
        } ?: return
        val text = try {
            val plane = image.planes[0]
            val width = image.width
            val height = image.height
            val data = ByteArray(width * height)
            val buffer = plane.buffer
            for (row in 0 until height) {
                buffer.position(row * plane.rowStride)
                buffer.get(data, row * width, width)
            }
            QrDecoder.decode(PlanarYUVLuminanceSource(data, width, height, 0, 0, width, height, false))
        } catch (e: Exception) {
            Log.w(TAG, "scan frame failed: ${e.javaClass.simpleName}")
            null
        } finally {
            image.close()
        }
        if (text != null) {
            main.post {
                if (running) {
                    stop()
                    onResult(text)
                }
            }
        }
    }

    private fun unavailable(why: String) {
        Log.w(TAG, "scan unavailable: $why")
        main.post {
            if (running) {
                stop()
                onUnavailable(why)
            }
        }
    }

    /** 取景铺满（多出来的裁掉，不变形）：相机的画面是横的，屏幕转到哪边换算到哪边 */
    private fun fitPreview() {
        val size = previewSize ?: return
        val width = preview.width.toFloat()
        val height = preview.height.toFloat()
        if (width == 0f || height == 0f) return
        @Suppress("DEPRECATION")
        val rotation = (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.rotation
        val matrix = Matrix()
        val sideways = rotation == Surface.ROTATION_90 || rotation == Surface.ROTATION_270
        val bufferW = if (sideways) size.width.toFloat() else size.height.toFloat()
        val bufferH = if (sideways) size.height.toFloat() else size.width.toFloat()
        val scale = maxOf(width / bufferW, height / bufferH)
        matrix.setScale(scale * bufferW / width, scale * bufferH / height, width / 2f, height / 2f)
        if (sideways) {
            val view = RectF(0f, 0f, width, height)
            val buffer = RectF(0f, 0f, height, width)
            buffer.offset(view.centerX() - buffer.centerX(), view.centerY() - buffer.centerY())
            val rotate = Matrix()
            rotate.setRectToRect(view, buffer, Matrix.ScaleToFit.FILL)
            rotate.postRotate(90f * (rotation - 2), view.centerX(), view.centerY())
            matrix.postConcat(rotate)
        }
        preview.setTransform(matrix)
    }

    override fun refresh(palette: ErgoTheme.Palette) {
        title.text = t("harmony.scan.title")
        hint.text = t("harmony.scan.hint")
        cancel.text = t("harmony.scan.cancel")
        cancel.applyPalette(palette)
    }
}
