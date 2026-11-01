// 二狗的安卓 App。依赖只从官方源取（Google Maven、Maven Central、Gradle 插件门户），版本写死。
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "ergo-android"
include(":app")
