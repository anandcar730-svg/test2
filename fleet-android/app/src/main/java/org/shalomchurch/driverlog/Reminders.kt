package org.shalomchurch.driverlog

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Reminders as Android notifications (insurance / PUC / fitness expiry, oil & battery change …).
 *
 * Browser push does not work inside an app's WebView, so the app asks the website for new reminders
 * itself: every 30 minutes in the background (JobScheduler – survives restarts) and when the app opens.
 * It uses the login of the app (session cookie saved by MainActivity).
 */
object Reminders {
    private const val CHANNEL = "reminders"
    private const val JOB_PERIODIC = 1
    private const val JOB_NOW = 2
    private const val SUMMARY_ID = 100

    fun schedule(ctx: Context) {
        val js = ctx.getSystemService(JobScheduler::class.java) ?: return
        if (js.allPendingJobs.any { it.id == JOB_PERIODIC }) return
        js.schedule(
            JobInfo.Builder(JOB_PERIODIC, ComponentName(ctx, ReminderJob::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true) // keep after the phone restarts
                .setPeriodic(30 * 60 * 1000L)
                .build()
        )
    }

    /** Check within a minute (app opened / logged in). */
    fun checkSoon(ctx: Context) {
        val js = ctx.getSystemService(JobScheduler::class.java) ?: return
        js.schedule(
            JobInfo.Builder(JOB_NOW, ComponentName(ctx, ReminderJob::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setMinimumLatency(2_000L)
                .setOverrideDeadline(60_000L)
                .build()
        )
    }

    fun saveCookie(ctx: Context, cookie: String?) {
        if (!cookie.isNullOrBlank() && cookie.contains("sid=")) {
            prefs(ctx).edit().putString("cookie", cookie).putBoolean("login_warned", false).apply()
        }
    }

    fun allowed(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < 33 || ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("reminders", Context.MODE_PRIVATE)

    /** Ask the website for unread reminders and show the new ones. Returns false to retry later (no network). */
    fun check(ctx: Context): Boolean {
        val p = prefs(ctx)
        val cookie = p.getString("cookie", null) ?: return true // not logged in yet
        return try {
            val conn = (URL(BuildConfig.BASE_URL.trimEnd('/') + "/api/notifications").openConnection() as HttpURLConnection).apply {
                connectTimeout = 20_000
                readTimeout = 30_000
                setRequestProperty("Cookie", cookie)
                setRequestProperty("Accept", "application/json")
                setRequestProperty("User-Agent", "DriverLogShalomApp/" + BuildConfig.VERSION_NAME)
            }
            val code = conn.responseCode
            if (code == 401) {
                conn.disconnect()
                if (!p.getBoolean("login_warned", false)) {
                    show(ctx, 99, "Driver Log Shalom", "Please open the app and log in again to keep getting reminders.", "/")
                    p.edit().putBoolean("login_warned", true).apply()
                }
                return true
            }
            if (code !in 200..299) { conn.disconnect(); return false }
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            conn.disconnect()
            val items = JSONObject(body).getJSONArray("items")
            val lastShown = p.getLong("last_id", -1L)
            var maxId = lastShown
            val fresh = mutableListOf<JSONObject>()
            for (i in 0 until items.length()) {
                val n = items.getJSONObject(i)
                val id = n.getLong("id")
                if (id > maxId) maxId = id
                if (id > lastShown && n.isNull("read_at")) fresh.add(n)
            }
            // first time on this phone: don't flood with old reminders – show at most the 3 newest
            val toShow = (if (lastShown < 0) fresh.take(3) else fresh).sortedBy { it.getLong("id") }
            if (toShow.size == 1) {
                val n = toShow[0]
                show(ctx, (n.getLong("id") % 90_000).toInt() + 1000, n.optString("title"), n.optString("body"), n.optString("url", "/#/notifications"))
            } else if (toShow.size > 1) {
                showSummary(ctx, toShow)
            }
            p.edit().putLong("last_id", maxId).apply()
            true
        } catch (_: Exception) {
            false // offline – try again later
        }
    }

    private fun channel(ctx: Context): NotificationManager {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Insurance, PUC, fitness, oil change and battery reminders"
            })
        }
        return nm
    }

    private fun builder(ctx: Context): Notification.Builder =
        if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(ctx).setPriority(Notification.PRIORITY_HIGH)

    private fun openIntent(ctx: Context, requestCode: Int, url: String): PendingIntent =
        PendingIntent.getActivity(
            ctx, requestCode,
            Intent(ctx, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_OPEN_URL, url)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

    private fun show(ctx: Context, id: Int, title: String, text: String, url: String) {
        if (!allowed(ctx)) return
        val n = builder(ctx)
            .setSmallIcon(R.drawable.ic_stat_bell)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(openIntent(ctx, id, url))
            .build()
        channel(ctx).notify(id, n)
    }

    private fun showSummary(ctx: Context, items: List<JSONObject>) {
        if (!allowed(ctx)) return
        val style = Notification.InboxStyle()
        items.take(6).forEach { style.addLine(it.optString("title")) }
        if (items.size > 6) style.setSummaryText("+${items.size - 6} more")
        val n = builder(ctx)
            .setSmallIcon(R.drawable.ic_stat_bell)
            .setContentTitle("🔔 ${items.size} reminders – Driver Log Shalom")
            .setContentText(items.first().optString("title"))
            .setStyle(style)
            .setAutoCancel(true)
            .setContentIntent(openIntent(ctx, SUMMARY_ID, "/#/notifications"))
            .build()
        channel(ctx).notify(SUMMARY_ID, n)
    }
}

/** Runs Reminders.check() in the background when Android schedules it. */
class ReminderJob : JobService() {
    private val io = Executors.newSingleThreadExecutor()
    override fun onStartJob(params: JobParameters): Boolean {
        io.execute {
            val ok = Reminders.check(this)
            jobFinished(params, !ok)
        }
        return true
    }
    override fun onStopJob(params: JobParameters): Boolean = true
}
