package org.shalomchurch.driverlog

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.Settings
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File

/**
 * The Driver Log Shalom website inside an app, plus what a website cannot do on its own:
 * background location during trips (LocationService), camera photos, file uploads and PDF downloads.
 * The website talks to the app through `window.DriverLogApp` (see Bridge below).
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private val baseHost: String? = Uri.parse(BuildConfig.BASE_URL).host

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var cameraFile: File? = null
    private var cameraUri: Uri? = null
    private var geoCallback: GeolocationPermissions.Callback? = null
    private var geoOrigin: String? = null
    private var pendingStart: Triple<String, String, String>? = null

    companion object {
        const val EXTRA_OPEN_URL = "open_url"
        private const val REQ_NOTIFICATIONS = 30
        private const val REQ_FILE = 10
        private const val REQ_WEB_LOCATION = 20
        private const val REQ_TRACKING = 21
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            setGeolocationEnabled(true)
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString DriverLogShalomApp/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        web.addJavascriptInterface(Bridge(), "DriverLogApp")

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.scheme == "https" && url.host == baseHost) return false
                // phone numbers, Google Maps, Play Store … open in their own apps
                try { startActivity(Intent(Intent.ACTION_VIEW, url)) } catch (_: Exception) {}
                return true
            }

            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                // remember the login for the background reminder check, and look for new reminders
                Reminders.saveCookie(this@MainActivity, CookieManager.getInstance().getCookie(BuildConfig.BASE_URL))
                Reminders.checkSoon(this@MainActivity)
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) view.loadDataWithBaseURL(null, offlinePage(), "text/html", "utf-8", null)
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                if (hasLocation()) {
                    callback.invoke(origin, true, false)
                } else {
                    geoOrigin = origin
                    geoCallback = callback
                    requestPermissions(locationPermissions(), REQ_WEB_LOCATION)
                }
            }

            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    startActivityForResult(fileChooser(params), REQ_FILE)
                    true
                } catch (_: Exception) {
                    fileCallback = null
                    false
                }
            }
        }

        web.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            download(url, userAgent, contentDisposition, mimeType)
        }

        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(startUrl(intent))

        Reminders.schedule(this)
        askNotificationPermissionOnce()
    }

    /** A reminder notification was tapped: open the page it belongs to. */
    private fun startUrl(i: Intent?): String {
        val path = i?.getStringExtra(EXTRA_OPEN_URL)
        return if (path != null && path.startsWith("/")) BuildConfig.BASE_URL.trimEnd('/') + path else BuildConfig.BASE_URL
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getStringExtra(EXTRA_OPEN_URL) != null) web.loadUrl(startUrl(intent))
    }

    private fun askNotificationPermissionOnce() {
        if (Build.VERSION.SDK_INT < 33 || Reminders.allowed(this)) return
        val prefs = getSharedPreferences("app", MODE_PRIVATE)
        if (prefs.getBoolean("asked_notifications", false)) return
        prefs.edit().putBoolean("asked_notifications", true).apply()
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS)
    }

    private fun openNotificationSettings() {
        try {
            val i = if (Build.VERSION.SDK_INT >= 26) Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
            else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
            startActivity(i)
        } catch (_: Exception) {
        }
    }

    // ------------------------------------------------------------------ bridge for the website
    inner class Bridge {
        /** Start sharing the location in the background (called by the website at "Start trip"). */
        @JavascriptInterface
        fun startTracking(deviceId: String, serverUrl: String, label: String) {
            runOnUiThread {
                if (!trusted() || !serverUrl.startsWith("https://")) return@runOnUiThread
                if (hasLocation()) startService(deviceId, serverUrl, label)
                else {
                    pendingStart = Triple(deviceId, serverUrl, label)
                    requestPermissions(trackingPermissions(), REQ_TRACKING)
                }
            }
        }

        /** Stop sharing (called at "End trip"). The last waiting points are sent first. */
        @JavascriptInterface
        fun stopTracking() {
            runOnUiThread {
                if (!trusted()) return@runOnUiThread
                startService(Intent(this@MainActivity, LocationService::class.java).setAction(LocationService.ACTION_STOP))
            }
        }

        @JavascriptInterface
        fun isTracking(): Boolean = TrackingStore(this@MainActivity).active

        /** {"active":..,"queued":..,"sent":..,"last_fix":ms,"last_sent":ms,"last_error":".."} */
        @JavascriptInterface
        fun status(): String = TrackingStore(this@MainActivity).statusJson()

        @JavascriptInterface
        fun batteryOptimised(): Boolean {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            return !pm.isIgnoringBatteryOptimizations(packageName)
        }

        @JavascriptInterface
        fun openBatterySettings() {
            runOnUiThread { askBatteryExemption() }
        }

        @JavascriptInterface
        fun version(): String = BuildConfig.VERSION_NAME

        /** Reminders appear as phone notifications from the app (checked every 30 minutes). */
        @JavascriptInterface
        fun notificationsAllowed(): Boolean = Reminders.allowed(this@MainActivity)

        @JavascriptInterface
        fun openNotificationSettings() {
            runOnUiThread {
                if (Build.VERSION.SDK_INT >= 33 && !Reminders.allowed(this@MainActivity)) {
                    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS)
                } else this@MainActivity.openNotificationSettings()
            }
        }

        /** Look for new reminders right away (e.g. after the admin pressed "Check now"). */
        @JavascriptInterface
        fun checkReminders() {
            Reminders.checkSoon(this@MainActivity)
        }
    }

    private fun trusted(): Boolean = Uri.parse(web.url ?: "").host == baseHost

    private fun startService(deviceId: String, serverUrl: String, label: String) {
        val i = Intent(this, LocationService::class.java)
            .setAction(LocationService.ACTION_START)
            .putExtra(LocationService.EXTRA_DEVICE, deviceId)
            .putExtra(LocationService.EXTRA_SERVER, serverUrl)
            .putExtra(LocationService.EXTRA_LABEL, label)
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i) else startService(i)
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (!pm.isIgnoringBatteryOptimizations(packageName)) {
            Toast.makeText(this, "Tip: allow Driver Log Shalom to run in the background (battery settings) so tracking is not stopped.", Toast.LENGTH_LONG).show()
        }
    }

    @SuppressLint("BatteryLife")
    private fun askBatteryExemption() {
        try {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            val intent = if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
            } else {
                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            }
            startActivity(intent)
        } catch (_: Exception) {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        }
    }

    // ------------------------------------------------------------------ permissions
    private fun hasLocation() =
        checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun locationPermissions() = arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)

    private fun trackingPermissions(): Array<String> =
        if (Build.VERSION.SDK_INT >= 33) locationPermissions() + Manifest.permission.POST_NOTIFICATIONS else locationPermissions()

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            REQ_NOTIFICATIONS -> {
                if (Reminders.allowed(this)) Reminders.checkSoon(this)
                web.evaluateJavascript("window.onDriverLogApp && window.onDriverLogApp('notifications')", null)
            }
            REQ_WEB_LOCATION -> {
                geoCallback?.invoke(geoOrigin, hasLocation(), false)
                geoCallback = null
            }
            REQ_TRACKING -> {
                val p = pendingStart
                pendingStart = null
                if (p != null && hasLocation()) startService(p.first, p.second, p.third)
                else if (p != null) {
                    Toast.makeText(this, "Location permission is needed to share the trip location.", Toast.LENGTH_LONG).show()
                    web.evaluateJavascript("window.onDriverLogApp && window.onDriverLogApp('denied')", null)
                }
            }
        }
    }

    // ------------------------------------------------------------------ photos & files
    private fun fileChooser(params: WebChromeClient.FileChooserParams): Intent {
        val types = params.acceptTypes.filter { it.isNotBlank() }
        val wantsImage = types.isEmpty() || types.any { it.startsWith("image") }
        val pick = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = if (types.size == 1) types[0] else "*/*"
            if (types.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE)
        }
        cameraFile = null
        cameraUri = null
        val extra = mutableListOf<Intent>()
        if (wantsImage) {
            val dir = File(cacheDir, "camera").apply { mkdirs() }
            val f = File(dir, "photo_${System.currentTimeMillis()}.jpg")
            val uri = FileProvider.getUriForFile(this, "$packageName.files", f)
            val cam = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                .putExtra(MediaStore.EXTRA_OUTPUT, uri)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            if (cam.resolveActivity(packageManager) != null) {
                cameraFile = f
                cameraUri = uri
                extra.add(cam)
            }
        }
        // <input capture> on the website (odometer / accident photos) → open the camera straight away
        if (params.isCaptureEnabled && extra.isNotEmpty()) return extra[0]
        return Intent.createChooser(pick, "Choose a photo or file").apply {
            if (extra.isNotEmpty()) putExtra(Intent.EXTRA_INITIAL_INTENTS, extra.toTypedArray())
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQ_FILE) {
            @Suppress("DEPRECATION")
            super.onActivityResult(requestCode, resultCode, data)
            return
        }
        val cb = fileCallback
        fileCallback = null
        var result: Array<Uri>? = null
        if (resultCode == RESULT_OK) {
            val clip = data?.clipData
            val single = data?.data
            val photo = cameraFile
            result = when {
                clip != null && clip.itemCount > 0 -> Array(clip.itemCount) { clip.getItemAt(it).uri }
                single != null -> arrayOf(single)
                photo != null && photo.length() > 0 && cameraUri != null -> arrayOf(cameraUri!!)
                else -> null
            }
        }
        cb?.onReceiveValue(result)
    }

    private fun download(url: String, userAgent: String, contentDisposition: String?, mimeType: String?) {
        try {
            val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
            val req = DownloadManager.Request(Uri.parse(url)).apply {
                addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                addRequestHeader("User-Agent", userAgent)
                setMimeType(mimeType)
                setTitle(name)
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                if (Build.VERSION.SDK_INT >= 29) setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
                else setDestinationInExternalFilesDir(this@MainActivity, Environment.DIRECTORY_DOWNLOADS, name)
            }
            (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
            Toast.makeText(this, "Downloading $name – see your notifications / Downloads", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(this, "Download failed: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun offlinePage(): String = """
        <html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="font-family:sans-serif;text-align:center;padding:48px 20px;color:#111827;background:#f4f6f8">
          <div style="font-size:56px">📶</div><h2>No connection</h2>
          <p>Driver Log Shalom needs the internet. Trip location keeps being recorded and is sent when you are back online.</p>
          <p><a href="${BuildConfig.BASE_URL}" style="display:inline-block;padding:12px 22px;background:#0f766e;color:#fff;border-radius:10px;text-decoration:none">Try again</a></p>
        </body></html>
    """.trimIndent()

    // ------------------------------------------------------------------ lifecycle
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        // let the page refresh its "location sharing" bar
        web.evaluateJavascript("window.onDriverLogApp && window.onDriverLogApp('resume')", null)
    }

    override fun onPause() {
        CookieManager.getInstance().flush()
        web.onPause()
        super.onPause()
    }
}
