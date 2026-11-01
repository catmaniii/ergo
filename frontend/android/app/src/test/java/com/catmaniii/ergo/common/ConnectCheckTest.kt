package com.catmaniii.ergo.common

import com.catmaniii.ergo.scan.QrDecoder
import com.google.zxing.PlanarYUVLuminanceSource
import java.io.File
import java.io.FileNotFoundException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 扫码连接：和鸿蒙拿同一份例子（frontend/test/connect-vectors.tsv，鸿蒙那边由 frontend/test/connect.test.ts 跑），
 * 网页生成的二维码（frontend/test/qr-samples.tsv，和 qrcode-generator 的输出核对过）用真的 ZXing 解一遍比对内容。
 */
class ConnectCheckTest {
    /** Gradle 跑 JVM 单测时当前目录是 frontend/android/app */
    private fun testFile(name: String) = File("../../test/$name")

    private val vectors: List<List<String>> by lazy {
        testFile("connect-vectors.tsv").readLines(Charsets.UTF_8)
            .filter { it.isNotEmpty() && !it.startsWith("#") }
            .map { it.split('\t') }
    }

    private fun of(kind: String) = vectors.filter { it[0] == kind }

    @Test
    fun addressRulesMatchTheSharedExamples() {
        assertTrue(of("address").size > 10)
        for (row in of("address")) {
            val checked = checkServerAddress(row[1])
            assertEquals(row[1], row[2], if (checked.address == null) checked.errorKey else "ok")
        }
    }

    @Test
    fun tailnetHostsMatchTheSharedExamples() {
        assertTrue(of("tailnet").size > 5)
        for (row in of("tailnet")) assertEquals(row[1], row[2], isTailnetHost(row[1]).toString())
    }

    @Test
    fun checklistOrderMatchesTheSharedExamples() {
        for (row in of("checks")) assertEquals(row[1], row[2], connectChecklist(row[1]).joinToString(","))
    }

    @Test
    fun ergoAccessMatchesTheSharedExamples() {
        assertTrue(of("access").size > 5)
        for (row in of("access")) assertEquals(row[2], row[3], isErgoAccess(row[1].toInt(), row[2]).toString())
    }

    @Test
    fun failuresAreClassified() {
        assertEquals(ConnectFailure.DNS, classifyConnectFailure(UnknownHostException("x")))
        assertEquals(ConnectFailure.TIMEOUT, classifyConnectFailure(SocketTimeoutException("x")))
        assertEquals(ConnectFailure.CERT, classifyConnectFailure(SSLHandshakeException("x")))
        assertEquals(ConnectFailure.CERT, classifyConnectFailure(SSLPeerUnverifiedException("x")))
        assertEquals(ConnectFailure.REFUSED, classifyConnectFailure(ConnectException("x")))
        assertEquals(ConnectFailure.REFUSED, classifyConnectFailure(NoRouteToHostException("x")))
        assertEquals(ConnectFailure.NOT_ERGO, classifyConnectFailure(FileNotFoundException("x")))
        assertEquals(ConnectFailure.OTHER, classifyConnectFailure(IllegalStateException("x")))
        // 包在别的异常里的也认
        assertEquals(ConnectFailure.CERT, classifyConnectFailure(RuntimeException(SSLHandshakeException("x"))))
    }

    /** 方阵画成一张白底的图（每格放大 8 倍，四周留 4 格白边），和屏幕上那张一样 */
    private fun render(rows: List<String>, scale: Int = 8, quiet: Int = 4): Triple<Int, Int, IntArray> {
        val side = (rows.size + quiet * 2) * scale
        val pixels = IntArray(side * side) { 0xFFFFFFFF.toInt() }
        rows.forEachIndexed { r, row ->
            row.forEachIndexed { c, cell ->
                if (cell == '1') {
                    for (y in 0 until scale) for (x in 0 until scale) {
                        pixels[((r + quiet) * scale + y) * side + (c + quiet) * scale + x] = 0xFF000000.toInt()
                    }
                }
            }
        }
        return Triple(side, side, pixels)
    }

    @Test
    fun zxingReadsTheCodesTheWebPageGenerates() {
        val samples = testFile("qr-samples.tsv").readLines(Charsets.UTF_8).filter { it.isNotEmpty() }
        assertTrue(samples.size >= 4)
        for (sample in samples) {
            val (url, matrix) = sample.split('\t')
            val (width, height, pixels) = render(matrix.split(','))
            val decoded = QrDecoder.decodeLuminance(width, height, pixels)
            assertNotNull("ZXing 解不出：$url", decoded)
            assertEquals(url, decoded)
        }
    }

    /** 相机那条路（取景页每一帧的亮度平面）：画面是横的，码在画面里是转了 90 度的，四周还有别的东西 */
    @Test
    fun cameraFramesDecodeThroughTheLuminancePlane() {
        val (url, matrix) = testFile("qr-samples.tsv").readLines(Charsets.UTF_8).first().split('\t')
        val (side, _, pixels) = render(matrix.split(','))
        val width = side + 400
        val height = side + 80
        val frame = ByteArray(width * height) { 0x90.toByte() }
        for (y in 0 until side) {
            for (x in 0 until side) {
                // 顺时针转 90 度，贴到画面中间
                val dark = pixels[(side - 1 - x) * side + y] == 0xFF000000.toInt()
                frame[(y + 40) * width + x + 200] = if (dark) 0x10 else 0xF0.toByte()
            }
        }
        assertEquals(url, QrDecoder.decode(PlanarYUVLuminanceSource(frame, width, height, 0, 0, width, height, false)))
    }

    @Test
    fun zxingReturnsNothingForAPictureWithoutACode() {
        assertEquals(null, QrDecoder.decodeLuminance(64, 64, IntArray(64 * 64) { 0xFFFFFFFF.toInt() }))
    }
}
