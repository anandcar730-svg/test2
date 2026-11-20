plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The website the app opens. Build for another address with:  gradle assembleRelease -PbaseUrl=https://example.org
val baseUrl: String = (project.findProperty("baseUrl") as String?) ?: "https://driver-log.shalomchurch.co.in"

android {
    namespace = "org.shalomchurch.driverlog"
    compileSdk = 34

    defaultConfig {
        applicationId = "org.shalomchurch.driverlog"
        minSdk = 24
        targetSdk = 34
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "1.0." + (System.getenv("GITHUB_RUN_NUMBER") ?: "0")
        buildConfigField("String", "BASE_URL", "\"$baseUrl\"")
    }

    signingConfigs {
        create("shared") {
            // A private key from the DRIVERLOG_KEYSTORE secret is used when present (see README); otherwise the key in signing/.
            val secretStore = System.getenv("DRIVERLOG_KEYSTORE_FILE")
            if (secretStore != null && file(secretStore).exists()) {
                storeFile = file(secretStore)
                storePassword = System.getenv("DRIVERLOG_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("DRIVERLOG_KEY_ALIAS") ?: "driverlog"
                keyPassword = System.getenv("DRIVERLOG_KEYSTORE_PASSWORD")
            } else {
                storeFile = file("signing/driverlog.p12")
                storePassword = "driverlog"
                keyAlias = "driverlog"
                keyPassword = "driverlog"
            }
            storeType = "pkcs12"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("shared")
        }
        debug {
            signingConfig = signingConfigs.getByName("shared")
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core:1.13.1") // FileProvider for camera photos
}
