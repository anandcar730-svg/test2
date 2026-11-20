package org.shalomchurch.driverlog

import android.content.Context
import android.location.Location
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Trip tracking state + the queue of GPS points waiting to be sent (kept in a file, so nothing is
 * lost without signal or if the phone restarts the app). Points are sent to the website's
 * /api/osmand endpoint in the JSON format it accepts: {"device_id": ..., "location": [{timestamp, coords}]}.
 */
class TrackingStore(context: Context) {
    private val prefs = context.getSharedPreferences("tracking", Context.MODE_PRIVATE)
    private val queue = File(context.filesDir, "gps-queue.jsonl")

    val active: Boolean get() = prefs.getBoolean("active", false)
    val label: String get() = prefs.getString("label", "") ?: ""
    private val deviceId: String get() = prefs.getString("device_id", "") ?: ""
    private val server: String get() = prefs.getString("server", "") ?: ""

    fun start(deviceId: String, server: String, label: String) {
        prefs.edit()
            .putBoolean("active", true)
            .putString("device_id", deviceId)
            .putString("server", server)
            .putString("label", label)
            .putLong("started", System.currentTimeMillis())
            .putInt("sent", 0)
            .apply()
    }

    fun stop() {
        prefs.edit().putBoolean("active", false).apply()
    }

    @Synchronized
    fun add(l: Location) {
        val coords = JSONObject()
            .put("latitude", l.latitude)
            .put("longitude", l.longitude)
        if (l.hasAccuracy()) coords.put("accuracy", l.accuracy.toDouble())
        if (l.hasSpeed()) coords.put("speed", l.speed.toDouble())
        if (l.hasBearing()) coords.put("heading", l.bearing.toDouble())
        val point = JSONObject().put("timestamp", iso(l.time)).put("coords", coords)
        queue.appendText(point.toString() + "\n")
        prefs.edit().putLong("last_fix", l.time).apply()
    }

    @Synchronized
    fun queued(): Int = if (queue.exists()) queue.readLines().count { it.isNotBlank() } else 0

    /** Send up to 300 waiting points. Returns true when the queue is empty afterwards. Runs on a background thread. */
    fun send(): Boolean {
        val batch: List<String>
        synchronized(this) {
            batch = if (queue.exists()) queue.readLines().filter { it.isNotBlank() }.take(300) else emptyList()
        }
        if (batch.isEmpty()) return true
        if (server.isEmpty() || deviceId.isEmpty()) return false
        return try {
            val arr = JSONArray()
            batch.forEach { arr.put(JSONObject(it)) }
            val body = JSONObject().put("device_id", deviceId).put("location", arr).toString().toByteArray(Charsets.UTF_8)
            val conn = (URL(server).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 20_000
                readTimeout = 30_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("User-Agent", "DriverLogShalomApp/" + BuildConfig.VERSION_NAME)
            }
            conn.outputStream.use { it.write(body) }
            val code = conn.responseCode
            conn.disconnect()
            when {
                code in 200..299 -> { drop(batch.size); prefs.edit().putInt("sent", prefs.getInt("sent", 0) + batch.size).putLong("last_sent", System.currentTimeMillis()).apply(); queued() == 0 }
                code == 403 || code == 400 -> { drop(batch.size); prefs.edit().putString("last_error", "Server refused the points (HTTP $code) – log in again").apply(); false }
                else -> { prefs.edit().putString("last_error", "HTTP $code").apply(); false }
            }
        } catch (e: Exception) {
            prefs.edit().putString("last_error", e.javaClass.simpleName).apply()
            false // no signal – keep the points for later
        }
    }

    @Synchronized
    private fun drop(n: Int) {
        if (!queue.exists()) return
        val rest = queue.readLines().filter { it.isNotBlank() }.drop(n)
        if (rest.isEmpty()) queue.delete() else queue.writeText(rest.joinToString("\n") + "\n")
    }

    fun statusJson(): String = JSONObject()
        .put("active", active)
        .put("label", label)
        .put("queued", queued())
        .put("sent", prefs.getInt("sent", 0))
        .put("last_fix", prefs.getLong("last_fix", 0))
        .put("last_sent", prefs.getLong("last_sent", 0))
        .put("last_error", prefs.getString("last_error", "") ?: "")
        .toString()

    private fun iso(ms: Long): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }
        .format(Date(ms))
}
