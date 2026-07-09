package com.voiceagent.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import org.json.JSONObject
import java.io.File

/**
 * Periodic "watch my PR" worker. Every cycle it polls the watched branch's PR
 * via git_ops.pr_check() and:
 *   - notifies (once per state change) when CI passes or fails,
 *   - on a CI failure, if auto-fix is enabled and no foreground run is active,
 *     runs the agent's fix_build loop and pushes the fix to the branch,
 *   - stops watching once the PR merges or closes.
 *
 * All the GitHub/CI logic lives in Python (git_ops); this worker is just the
 * scheduler + notifier so it stays small and hard to get wrong.
 */
class PrWatchWorker(private val ctx: Context, params: WorkerParameters) :
    CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val watch = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val workspace = watch.getString("workspace", null) ?: return Result.success()
        // The interpreter shares os.environ with any foreground run. Rewriting
        // AGENT_WORKSPACE/keys here mid-turn would redirect the live agent to
        // the wrong workspace, so skip this cycle entirely while a run is active.
        if (MainActivity.runsActive() != 0) return Result.success()
        try {
            if (!Python.isStarted()) Python.start(AndroidPlatform(ctx.applicationContext))
            val py = Python.getInstance()
            val os = py.getModule("os")
            fun set(k: String, v: String) { os.get("environ")?.callAttr("__setitem__", k, v) }
            val keys = ctx.getSharedPreferences("keys", Context.MODE_PRIVATE)
            val pyOverride = File(ctx.filesDir, "py_override")
            set("AGENT_WORKSPACE", workspace)
            set("HOME", ctx.filesDir.absolutePath)
            set("AGENT_OVERRIDE", File(pyOverride, "orchestrator.py").absolutePath)
            set("AGENT_OVERRIDE_DIR", pyOverride.absolutePath)
            set("AGENT_MAX_STEPS", "15") // bound a background fix to the work window
            keys.getString("ANTHROPIC_API_KEY", "")?.takeIf { it.isNotBlank() }?.let { set("ANTHROPIC_API_KEY", it) }
            keys.getString("DEEPSEEK_API_KEY", "")?.takeIf { it.isNotBlank() }?.let { set("DEEPSEEK_API_KEY", it) }
            keys.getString("OPENAI_API_KEY", "")?.takeIf { it.isNotBlank() }?.let { set("OPENAI_API_KEY", it) }
            keys.getString("GITHUB_TOKEN", "")?.takeIf { it.isNotBlank() }?.let { set("GITHUB_TOKEN", it) }
            set("LEAD_MODEL", watch.getString("lead", "").orEmpty())
            set("WORKER_MODEL", watch.getString("worker", "").orEmpty())
            set("AGENT_FALLBACK_MODEL", keys.getString("AGENT_FALLBACK_MODEL", "").orEmpty())

            val gitOps = py.getModule("git_ops")
            val c = JSONObject(gitOps.callAttr("pr_check").toString())
            val state = c.optString("state")
            val ci = c.optString("ci")
            val branch = c.optString("branch", "")
            val url = c.optString("url", "")
            val lastKey = watch.getString("lastNotified", "")
            val stateKey = "$state/$ci"

            when {
                state == "merged" || state == "closed" -> {
                    notify("PR $state", "$branch — watching stopped")
                    stopWatching()
                }
                state == "none" || state == "error" -> { /* no PR yet — keep waiting */ }
                ci == "failing" -> {
                    val autofix = watch.getBoolean("autofix", false)
                    if (autofix && MainActivity.runsActive() == 0) {
                        notify("CI failing — auto-fixing $branch", "Running the agent…")
                        py.getModule("agent_loader").callAttr("op", "fix_build", "")
                        gitOps.callAttr("push")
                        val after = JSONObject(gitOps.callAttr("pr_check").toString())
                        notify("Auto-fix pushed to $branch", "CI now: ${after.optString("ci")}")
                        watch.edit().putString("lastNotified", "open/${after.optString("ci")}").apply()
                    } else if (stateKey != lastKey) {
                        notify("CI failing on $branch", "Open the app to fix, or enable auto-fix")
                        watch.edit().putString("lastNotified", stateKey).apply()
                    }
                }
                ci == "passing" && stateKey != lastKey -> {
                    notify("CI passing on $branch", url)
                    watch.edit().putString("lastNotified", stateKey).apply()
                }
                else -> { /* running, or no change since last cycle */ }
            }
        } catch (_: Throwable) {
            // Swallow — try again next cycle rather than churning retries.
        }
        return Result.success()
    }

    private fun stopWatching() {
        WorkManager.getInstance(ctx.applicationContext).cancelUniqueWork(WORK_NAME)
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
    }

    private fun notify(title: String, body: String) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "PR watch", NotificationManager.IMPORTANCE_HIGH))
        }
        val n = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .build()
        try { nm.notify(NOTIFY_ID, n) } catch (_: Throwable) {}
    }

    companion object {
        const val WORK_NAME = "pr_watch"
        const val PREFS = "prwatch"
        private const val CHANNEL = "pr_watch"
        private const val NOTIFY_ID = 77
    }
}
