package com.voiceagent.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Foreground service that keeps long agent runs alive with the screen off or
 * the app backgrounded. MainActivity starts it when a run begins and stops it
 * when the run ends. A partial wake lock keeps the CPU (and thus the model's
 * HTTP streaming) running through Doze; without it, long calls stall and die
 * a few minutes after the screen turns off.
 */
class AgentService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())
        if (wakeLock == null) {
            try {
                wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
                    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "voiceagent:run")
                    .apply {
                        setReferenceCounted(false)
                        acquire(60 * 60 * 1000L) // 1h safety cap per run
                    }
            } catch (_: Throwable) {}
        }
        return START_STICKY
    }

    override fun onDestroy() {
        try { wakeLock?.release() } catch (_: Throwable) {}
        wakeLock = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Agent runs",
                NotificationManager.IMPORTANCE_LOW
            )
            getSystemService(NotificationManager::class.java)
                .createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("Voice Agent")
            .setContentText("Working on your task…")
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "agent_runs"
        private const val NOTIFICATION_ID = 1
    }
}
