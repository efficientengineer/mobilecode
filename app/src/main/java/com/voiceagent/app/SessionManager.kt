package com.voiceagent.app

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * Repo-owned sessions. A **repo is the source of truth**; a **session** is a unit
 * of work under exactly one repo (fixed for its life). Sessions are stored nested
 * under their repo:
 *
 *   filesDir/sessions/<repoKey>/<sessionId>/
 *     - the folder itself is the git workspace (an independent clone of the repo)
 *     - meta.json holds { name, repo, models }
 *     - the conversation lives in .agent/discussion.jsonl (owned by Python)
 *
 * `repoKey` is the repo full name (owner/repo) sanitized for the filesystem
 * (owner__repo). A session created before its repo is known lives under the
 * reserved `__unassigned__` bucket until `assignRepo` moves it under its repo —
 * a **write-once** assignment; a session's repo never changes afterward.
 *
 * The active session is stored in SharedPreferences as its "<repoKey>/<id>" path;
 * its folder is what gets passed to Python as AGENT_WORKSPACE.
 */
class SessionManager(private val ctx: Context) {

    private val root = File(ctx.filesDir, "sessions").apply { mkdirs() }
    private val prefs = ctx.getSharedPreferences("session", Context.MODE_PRIVATE)

    data class Session(
        val id: String,
        val repoKey: String,
        val name: String,
        val repo: String,
        val orchestratorModel: String = "",
        val implementerModel: String = "",
        val modelsConfigured: Boolean = false,
    ) {
        val path: String get() = "$repoKey/$id"
    }

    init { migrate() }

    private companion object {
        const val UNASSIGNED = "__unassigned__"
        val SAFE = Regex("[^A-Za-z0-9._-]")
    }

    private fun repoKey(repo: String): String =
        if (repo.isBlank()) UNASSIGNED else repo.trim().replace(SAFE, "__")

    // --- migration: flat sessions/<id>/ -> sessions/<repoKey>/<id>/ ----------
    // One-time, idempotent, move-only (never deletes). Runs on construction.
    private fun migrate() {
        val children = root.listFiles()?.filter { it.isDirectory } ?: return
        for (dir in children) {
            // A repoKey bucket contains session subfolders; a legacy session
            // folder contains meta.json directly. Only migrate the latter.
            if (!File(dir, "meta.json").exists()) continue
            val meta = JSONObject(File(dir, "meta.json").readText())
            val repo = meta.optString("repo", meta.optString("activeRepo", "")).trim()
            val key = repoKey(repo)
            val dest = File(File(root, key), dir.name)
            if (dest.exists()) continue // already migrated
            dest.parentFile?.mkdirs()
            if (dir.renameTo(dest)) {
                // normalize meta to the new schema (repo, not activeRepo)
                writeMeta(readMetaAt(key, dir.name).copy(repo = repo))
                // fix the active pointer if it referenced the old flat id
                if (prefs.getString("active", null) == dir.name) {
                    prefs.edit().putString("active", "$key/${dir.name}").apply()
                }
            }
        }
    }

    // --- active session -----------------------------------------------------

    fun activePath(): String? {
        val p = prefs.getString("active", null)
        return if (p != null && File(root, p).isDirectory) p else null
    }

    /** The active session id, or "" when there is no active session (UI shows Projects). */
    fun activeId(): String = activePath()?.substringAfterLast('/') ?: ""

    fun activeDir(): File {
        val p = activePath()
        if (p != null) return File(root, p).apply { mkdirs() }
        // No active session yet: a neutral scratch dir so Python always has a
        // valid AGENT_WORKSPACE; the UI should be presenting Projects.
        return File(File(root, UNASSIGNED), "_scratch").apply { mkdirs() }
    }

    fun setActive(id: String) {
        val path = findPath(id) ?: return
        prefs.edit().putString("active", path).apply()
    }

    // --- lookup / listing ---------------------------------------------------

    private fun findPath(id: String): String? {
        if (id.isBlank()) return null
        val buckets = root.listFiles()?.filter { it.isDirectory } ?: return null
        for (b in buckets) {
            if (File(File(b, id), "meta.json").exists()) return "${b.name}/$id"
        }
        return null
    }

    private fun dirFor(id: String): File? = findPath(id)?.let { File(root, it) }

    fun list(): List<Session> {
        val out = ArrayList<Session>()
        val buckets = root.listFiles()?.filter { it.isDirectory } ?: return out
        for (b in buckets) {
            val sids = b.listFiles()?.filter { it.isDirectory } ?: continue
            for (s in sids) {
                if (!File(s, "meta.json").exists()) continue // skip _scratch / orphans
                out.add(readMetaAt(b.name, s.name))
            }
        }
        return out.sortedBy { it.name.lowercase() }
    }

    fun listRepos(): List<String> =
        list().map { it.repo }.filter { it.isNotBlank() }.distinct().sorted()

    fun listSessions(repo: String): List<Session> =
        list().filter { it.repo == repo }

    // --- create / assign / mutate ------------------------------------------

    /** Create an UNASSIGNED session (repo attached later via assignRepo). */
    fun create(name: String): String = createIn("", name)

    /** Create a session already bound to a repo. */
    fun create(repo: String, name: String): String = createIn(repo, name)

    private fun createIn(repo: String, name: String): String {
        val id = "s_" + System.currentTimeMillis().toString()
        val key = repoKey(repo)
        File(File(root, key), id).mkdirs()
        writeMeta(Session(id, key, name.ifBlank { id }, repo))
        return id
    }

    /**
     * Write-once repo assignment: move an unassigned session under its repo and
     * record it. If the session already has a repo, this is a no-op (a session's
     * repo is immutable) — returns false so callers can tell.
     */
    fun assignRepo(id: String, repo: String): Boolean {
        if (repo.isBlank()) return false
        val cur = readMeta(id)
        if (cur.repo.isNotBlank()) return false // immutable once set
        val key = repoKey(repo)
        val from = dirFor(id) ?: return false
        val dest = File(File(root, key), id)
        dest.parentFile?.mkdirs()
        val wasActive = activePath() == cur.path
        if (from.absolutePath != dest.absolutePath && !from.renameTo(dest)) return false
        writeMeta(cur.copy(repoKey = key, repo = repo))
        if (wasActive) prefs.edit().putString("active", "$key/$id").apply()
        return true
    }

    fun delete(id: String) {
        val path = findPath(id) ?: return
        File(root, path).deleteRecursively()
        if (prefs.getString("active", null) == path) prefs.edit().remove("active").apply()
    }

    fun rename(id: String, name: String) {
        if (name.isBlank()) return
        writeMeta(readMeta(id).copy(name = name.trim()))
    }

    fun setModels(id: String, orchestrator: String, implementer: String) {
        writeMeta(readMeta(id).copy(
            orchestratorModel = orchestrator,
            implementerModel = implementer,
            modelsConfigured = true,
        ))
    }

    // --- meta read/write ----------------------------------------------------

    fun readMeta(id: String): Session {
        val path = findPath(id) ?: return Session(id, UNASSIGNED, id, "")
        val (key, sid) = path.split("/", limit = 2)
        return readMetaAt(key, sid)
    }

    private fun readMetaAt(repoKey: String, id: String): Session {
        val f = File(File(File(root, repoKey), id), "meta.json")
        if (!f.exists()) return Session(id, repoKey, id, "")
        val o = JSONObject(f.readText())
        return Session(
            id,
            repoKey,
            o.optString("name", id),
            o.optString("repo", o.optString("activeRepo", "")),
            o.optString("orchestratorModel", ""),
            o.optString("implementerModel", ""),
            o.optBoolean("modelsConfigured", false),
        )
    }

    private fun writeMeta(s: Session) {
        val dir = File(File(root, s.repoKey), s.id).apply { mkdirs() }
        File(dir, "meta.json").writeText(
            JSONObject()
                .put("name", s.name)
                .put("repo", s.repo)
                .put("orchestratorModel", s.orchestratorModel)
                .put("implementerModel", s.implementerModel)
                .put("modelsConfigured", s.modelsConfigured)
                .toString()
        )
    }
}
