import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 调试 WebView 默认关：开着的 App 接上 USB 就能被 adb 经 DevTools 取走设备凭证 cookie。只有 npm run build:android -- --webview-debug 才开
val webviewDebug = providers.gradleProperty("webviewDebug").orNull == "true"

// 正式签名的材料只在本机（keystore.properties 不进仓库）；没有这个文件时 release 不签名，调试版用调试签名
val signingFile = rootProject.file("keystore.properties")
val signing = Properties().apply { if (signingFile.exists()) signingFile.inputStream().use { load(it) } }

android {
    namespace = "com.catmaniii.ergo"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.catmaniii.ergo"
        minSdk = 26
        targetSdk = 36
        versionCode = 1000
        versionName = "0.1.0"
        buildConfigField("boolean", "WEBVIEW_DEBUG", webviewDebug.toString())
    }

    buildFeatures {
        buildConfig = true
    }

    if (signingFile.exists()) {
        signingConfigs {
            create("release") {
                storeFile = rootProject.file(signing.getProperty("storeFile"))
                storePassword = signing.getProperty("storePassword")
                keyAlias = signing.getProperty("keyAlias")
                keyPassword = signing.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            // 可调试的包 WebView 调试关不掉（Chromium 对 debuggable 的 App 一律开着），还能 run-as 读私有数据（包括设备凭证）。
            // 手册让用户装的就是这个调试签名的包，所以只有明确要调试时才可调试
            isDebuggable = webviewDebug
        }
        release {
            isMinifyEnabled = false
            if (signingFile.exists()) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    lint {
        abortOnError = false
    }
}

dependencies {
    // 原生桥要的 WebViewCompat.addWebMessageListener、addDocumentStartJavaScript
    implementation("androidx.webkit:webkit:1.14.0")
    // 窗口避让（webkit 本来就带着它，这里只是让代码能直接用）；别的都用系统自带的
    implementation("androidx.core:core:1.16.0")
    // 扫码连接（364 号票）：只要 ZXing 的解码核心，不要它带界面的那些包；取景用系统的 Camera2
    implementation("com.google.zxing:core:3.5.3")
    testImplementation("junit:junit:4.13.2")
}
