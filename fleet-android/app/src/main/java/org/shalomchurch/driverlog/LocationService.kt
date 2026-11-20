package org.shalomchurch.driverlog

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import java.util.concurrent.Executors

/**
 * Foreground service that keeps receiving GPS positions during a trip – also with the screen off or
 * another app open. Android shows its notification while it runs. Started at "Start trip", stopped at "End trip".
 */
class LocationService : Service(), LocationListener {

    companion object {
        const val ACTION_START = "org.shalomchurch.driverlog.START"
        const val ACTION_STOP = "org.shalomchurch.driverlog.STOP"
        const val EXTRA_DEVICE = "device_id"
        const val EXTRA_SERVER = "server"
        const val EXTRA_LABEL = "label"
        private const val CHANNEL = "trip_location"
        private const val NOTIFICATION_ID = 7
        private const val FLUSH_MS = 45_000L
    }

    private lateinit var store: TrackingStore
    private var locationManager: LocationManager? = null
    private val handler = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var wakeLock: PowerManager.WakeLock? = null
    private var last: Location? = null

    private val flushTask = object : Runnable {
        override fun run() {
            io.execute { store.send() }
            handler.postDelayed(this, FLUSH_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        store = TrackingStore(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopTracking()
                return START_NOT_STICKY
            }
            ACTION_START -> store.start(
                intent.getStringExtra(EXTRA_DEVICE) ?: "",
                intent.getStringExtra(EXTRA_SERVER) ?: "",
                intent.getStringExtra(EXTRA_LABEL) ?: ""
            )
            else -> if (!store.active) { // restarted by Android after the trip already ended
                stopSelf()
                return START_NOT_STICKY
            }
        }
        if (!hasLocationPermission()) {
            stopTracking()
            return START_NOT_STICKY
        }
        goForeground()
        beginUpdates()
        return START_STICKY // Android restarts it if it has to kill it
    }

    private fun hasLocationPermission() =
        checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun goForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Trip location", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while your location is shared during a trip"
            })
        }
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
        val label = store.label
        val notification = builder
            .setContentTitle("Driver Log Shalom – sharing location")
            .setContentText(if (label.isNotEmpty()) "Trip $label · stops at End trip" else "During your trip · stops at End trip")
            .setSmallIcon(R.drawable.ic_stat_location)
            .setOngoing(true)
            .setContentIntent(open)
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    @SuppressLint("MissingPermission")
    private fun beginUpdates() {
        if (locationManager != null) return
        val lm = getSystemService(LOCATION_SERVICE) as LocationManager
        locationManager = lm
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            if (lm.allProviders.contains(provider)) {
                try {
                    lm.requestLocationUpdates(provider, 15_000L, 25f, this, Looper.getMainLooper())
                } catch (_: Exception) {
                }
            }
        }
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "driverlog:trip").apply {
            setReferenceCounted(false)
            acquire(14 * 60 * 60 * 1000L) // safety limit: 14 hours
        }
        handler.removeCallbacks(flushTask)
        handler.postDelayed(flushTask, 20_000L)
    }

    override fun onLocationChanged(location: Location) {
        val prev = last
        // Prefer GPS: ignore a network (mobile tower / Wi-Fi) fix shortly after a GPS fix
        if (location.provider == LocationManager.NETWORK_PROVIDER && prev != null &&
            prev.provider == LocationManager.GPS_PROVIDER && location.time - prev.time < 60_000L
        ) return
        // Keep a point every 30 s, or sooner after moving 50 m
        if (prev != null && location.time - prev.time < 30_000L && location.distanceTo(prev) < 50f) return
        last = location
        store.add(location)
        if (store.queued() >= 20) io.execute { store.send() }
    }

    // Needed on Android versions before 11, where LocationListener has no default implementations
    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
    override fun onProviderEnabled(provider: String) {}
    override fun onProviderDisabled(provider: String) {}

    private fun stopTracking() {
        locationManager?.removeUpdates(this)
        locationManager = null
        handler.removeCallbacks(flushTask)
        store.stop()
        io.execute {
            store.send() // last points
            handler.post {
                wakeLock?.let { if (it.isHeld) it.release() }
                wakeLock = null
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
    }

    override fun onDestroy() {
        locationManager?.removeUpdates(this)
        handler.removeCallbacks(flushTask)
        wakeLock?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }
}
