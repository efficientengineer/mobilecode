"""
projectmap.py — a deterministic dependency graph of the workspace.

For each source file it parses the *outgoing* references — Python imports, JS/TS
`import`/`require`, and HTML `<script src>` / `<link href>` — and resolves the
ones that point at another file in the workspace. The result is a compact map:

    path — role?  → imports: a.js, b.js   [ext: babylonjs]

persisted at `.agent/depgraph.json` and rendered into the agent's context every
turn. It is static and cheap (no model call), and it answers the question the
agent otherwise burns tokens re-discovering: *to understand feature X, which
files do I actually have to read?* — start at X's entry file and follow its
imports, instead of grepping the whole project.
"""

import os
import re
import json
from pathlib import Path

_SRC_EXT = (".py", ".js", ".mjs", ".jsx", ".ts", ".tsx", ".html", ".htm", ".css")

# Python: `import a.b`, `from a.b import c`, `from . import d`, `from .e import f`
_PY_IMPORT = re.compile(
    r'^\s*(?:from\s+(\.*[\w.]*)\s+import|import\s+([\w.]+))', re.M)
# JS/TS: static import, dynamic import(), require(), re-export
_JS_IMPORT = re.compile(
    r'''(?:import\b[^'"]*?from\s*|import\s*|export\b[^'"]*?from\s*|require\s*\(\s*)'''
    r'''['"]([^'"]+)['"]''')
# HTML: src/href on script/link/img/audio/source/iframe
_HTML_REF = re.compile(
    r'''<(?:script|link|img|audio|video|source|iframe)\b[^>]*?\b(?:src|href)\s*=\s*'''
    r'''['"]([^'"]+)['"]''', re.I)


def _workspace() -> Path:
    ws = os.environ.get("AGENT_WORKSPACE") or os.path.join(
        os.environ.get("HOME", "/tmp"), "workspace")
    return Path(ws)


def _lang(rel: str) -> str:
    ext = os.path.splitext(rel)[1].lower()
    if ext == ".py":
        return "py"
    if ext in (".js", ".mjs", ".jsx", ".ts", ".tsx"):
        return "js"
    if ext in (".html", ".htm"):
        return "html"
    if ext == ".css":
        return "css"
    return "other"


def _src_files(root: Path, max_files: int = 250) -> list:
    # os.walk with in-place dir pruning so we never descend into node_modules/.git
    # (rglob would materialize + sort every path first, including those trees).
    skip = {".git", ".agent", "node_modules", "__pycache__"}
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in skip)
        for name in sorted(filenames):
            if name in ("meta.json", "transcript.jsonl"):
                continue
            p = Path(dirpath) / name
            if p.suffix.lower() in _SRC_EXT:
                out.append(str(p.relative_to(root)))
                if len(out) >= max_files:
                    return out
    return out


def _is_external(ref: str) -> bool:
    return ref.startswith(("http://", "https://", "//", "data:"))


def _resolve_path(root: Path, importer: str, ref: str, fileset: set) -> str:
    """Resolve a JS/HTML path-like ref to a workspace-relative file, or ''."""
    ref = ref.split("?")[0].split("#")[0]
    if ref.startswith("/"):
        base = ref.lstrip("/")
    else:
        base = os.path.normpath(os.path.join(os.path.dirname(importer), ref))
    base = base.replace("\\", "/").lstrip("./")
    cands = [base, base + ".js", base + ".mjs", base + ".ts",
             base + "/index.js", base + "/index.html"]
    for c in cands:
        c = c.lstrip("/")
        if c in fileset:
            return c
    return ""


def _resolve_pymod(root: Path, importer: str, mod: str, fileset: set) -> str:
    """Resolve a Python module ref to a workspace-relative .py file, or ''."""
    if not mod:
        return ""
    if mod.startswith("."):
        # Relative import: strip leading dots, resolve against importer's dir.
        dots = len(mod) - len(mod.lstrip("."))
        rest = mod.lstrip(".").replace(".", "/")
        base_dir = os.path.dirname(importer)
        for _ in range(dots - 1):
            base_dir = os.path.dirname(base_dir)
        stem = os.path.normpath(os.path.join(base_dir, rest)) if rest else base_dir
    else:
        stem = mod.replace(".", "/")
    stem = stem.replace("\\", "/").lstrip("./")
    for c in (stem + ".py", stem + "/__init__.py"):
        c = c.lstrip("/")
        if c in fileset:
            return c
    return ""


def _refs(rel: str, text: str, lang: str):
    """(local_ref_strings, external_ref_strings) extracted from one file."""
    local, ext = [], []
    if lang == "py":
        for m in _PY_IMPORT.finditer(text):
            local.append(m.group(1) if m.group(1) is not None else m.group(2))
    elif lang == "js":
        for m in _JS_IMPORT.finditer(text):
            (ext if _is_external(m.group(1)) else local).append(m.group(1))
    elif lang == "html":
        for m in _HTML_REF.finditer(text):
            (ext if _is_external(m.group(1)) else local).append(m.group(1))
    return local, ext


def _short_ext(ref: str) -> str:
    """A readable name for an external ref (CDN url or bare package)."""
    if _is_external(ref):
        tail = ref.rstrip("/").split("/")[-1]
        tail = re.sub(r'[@?].*$', '', tail)
        tail = re.sub(r'\.(min\.)?(js|css)$', '', tail)
        return tail or ref
    return ref.split("/")[0]


def build_graph(root: Path = None) -> dict:
    root = root or _workspace()
    files = _src_files(root)
    fileset = set(files)
    graph = {}
    for f in files:
        try:
            text = (root / f).read_text(encoding="utf-8", errors="replace")
        except Exception:
            text = ""
        lang = _lang(f)
        raw_local, raw_ext = _refs(f, text, lang)
        imports, external = [], []
        for r in raw_local:
            res = (_resolve_pymod(root, f, r, fileset) if lang == "py"
                   else _resolve_path(root, f, r, fileset))
            if res and res != f:
                imports.append(res)
            elif lang != "py" and not res:
                external.append(_short_ext(r))
        for r in raw_ext:
            external.append(_short_ext(r))
        graph[f] = {"lang": lang, "imports": sorted(set(imports)),
                    "external": sorted(set(external)), "importedBy": []}
    for f, d in graph.items():
        for imp in d["imports"]:
            if imp in graph:
                graph[imp]["importedBy"].append(f)
    for d in graph.values():
        d["importedBy"] = sorted(set(d["importedBy"]))
    return graph


# Files whose JOB is wiring: they load/import the feature files, so a high
# fan-out there is the spine working, not tangle.
_ENTRY_NAMES = ("index.html", "index.htm", "main.js", "main.py", "app.py",
                "app.js", "wsgi.py", "game.js", "bootstrap.js")


def entry_points(graph: dict) -> list:
    """Files nothing imports but which pull others in (or a known entry name) —
    the roots to start reading a feature from."""
    ep = []
    for f, d in graph.items():
        rooty = os.path.basename(f).lower() in _ENTRY_NAMES
        if not d["importedBy"] and (d["imports"] or rooty):
            ep.append(f)
    return sorted(ep)


def graph_markdown(graph: dict, cap: int = 4000) -> str:
    """Compact dependency map for context. Only files that actually have edges."""
    lines = []
    ep = entry_points(graph)
    if ep:
        lines.append("Entry points: " + ", ".join(ep))
    for f in sorted(graph):
        d = graph[f]
        if not d["imports"] and not d["external"]:
            continue
        seg = f
        if d["imports"]:
            seg += " → " + ", ".join(d["imports"])
        if d["external"]:
            seg += "  [ext: " + ", ".join(d["external"][:5]) + "]"
        lines.append(seg)
    out = "\n".join(lines)
    return out[:cap]


def save_graph(root: Path = None) -> dict:
    root = root or _workspace()
    graph = build_graph(root)
    d = root / ".agent"
    try:
        d.mkdir(parents=True, exist_ok=True)
        (d / "depgraph.json").write_text(json.dumps(graph), encoding="utf-8")
    except Exception:
        pass
    return graph


def load_markdown(root: Path = None) -> str:
    """Rendered map from the persisted graph (empty string if none)."""
    root = root or _workspace()
    fp = root / ".agent" / "depgraph.json"
    if not fp.exists():
        return ""
    try:
        return graph_markdown(json.loads(fp.read_text(encoding="utf-8")))
    except Exception:
        return ""


# --- structure gate (context-friendliness) -----------------------------------
# Deterministic checks that the "file per feature" spine actually holds: small
# files, few direct imports between them, no cycles. Backs the agent's
# check_structure tool and the post-run verify gate, so a run cannot finish
# with tangled code — the prompt asks for this structure; this enforces it.

MAX_FILE_LINES = int(os.environ.get("AGENT_MAX_FILE_LINES", "400"))
MAX_LOCAL_IMPORTS = int(os.environ.get("AGENT_MAX_LOCAL_IMPORTS", "3"))
HUB_FAN_IN = 3   # imported by >= this many files → shared hub (events/store)
MAX_INLINE_SCRIPT = int(os.environ.get("AGENT_MAX_INLINE_SCRIPT", "40"))

_CDN_HOSTS = ("cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com",
              "esm.sh", "cdn.skypack.dev", "ga.jspm.io")
_VERSIONED = re.compile(r"@\d|/[vr]?\d")     # pkg@1, /1.2.3/, /v5/, /r128/
_INLINE_SCRIPT = re.compile(r"<script\b(?![^>]*\bsrc\s*=)[^>]*>(.*?)</script>",
                            re.I | re.S)
_SAFE_NAME = re.compile(r"^[a-z0-9._/-]+$")
# Loaded via string APIs the graph can't see — never treat as orphans.
_NEVER_ORPHAN = ("sw.js", "service-worker.js")


def line_counts(root: Path = None) -> dict:
    """{relpath: line count} for every source file — a cheap run-start snapshot
    so the gate can tell debt created this run from pre-existing debt."""
    root = root or _workspace()
    out = {}
    for rel in _src_files(root):
        try:
            out[rel] = (root / rel).read_text(
                encoding="utf-8", errors="replace").count("\n") + 1
        except Exception:
            pass
    return out


def _cycles(graph: dict, within: set) -> list:
    """Import cycles whose every node is in `within`, deduped by member set."""
    out, done, seen = [], set(), set()

    def dfs(node, stack):
        if node in stack:
            cyc = stack[stack.index(node):]
            key = frozenset(cyc)
            if key not in seen:
                seen.add(key)
                out.append(cyc)
            return
        if node in done:
            return
        stack.append(node)
        for nxt in graph.get(node, {}).get("imports", []):
            if nxt in within:
                dfs(nxt, stack)
        stack.pop()
        done.add(node)

    for f in sorted(within):
        dfs(f, [])
    return out


def check_structure(touched, created=None, baseline_lines=None,
                    root: Path = None) -> str:
    """Deterministic context-friendliness check over this run's files.
    Returns one problem per line, '' when clean. Flags only debt the run
    itself introduced, so an unrelated edit never demands restructuring old
    code:
      - a touched file that crossed MAX_FILE_LINES this run (files already
        over the cap at run start are skipped),
      - a file CREATED this run importing more than MAX_LOCAL_IMPORTS other
        workspace files directly — shared hubs (imported by >= HUB_FAN_IN
        files, e.g. events.js / store.js), wiring/entry files, and HTML
        (whose job is loading scripts) are exempt,
      - an import cycle made entirely of touched files,
      - a touched full-document HTML file missing the mobile shell basics
        (charset, width=device-width viewport, title),
      - an inline <script> over MAX_INLINE_SCRIPT lines in HTML created this
        run (that code belongs in its own .js file),
      - a CDN <script>/import without a pinned version on a touched file,
      - a .js/.css file created this run that nothing loads (dead weight
        that confuses future runs),
      - a file created this run with a non-URL-safe name."""
    root = root or _workspace()
    graph = build_graph(root)
    touched = {str(t).replace("\\", "/") for t in (touched or [])} & set(graph)
    if not touched:
        return ""
    created = ({str(c).replace("\\", "/") for c in created}
               if created is not None else set(touched))
    baseline_lines = baseline_lines or {}
    hubs = {f for f, d in graph.items() if len(d["importedBy"]) >= HUB_FAN_IN}
    problems = []
    for f in sorted(touched):
        try:
            text = (root / f).read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        n = text.count("\n") + 1
        lang, low, base = graph[f]["lang"], text.lower(), os.path.basename(f).lower()
        was = baseline_lines.get(f)
        is_new = f in created
        if n > MAX_FILE_LINES and (was is None or was <= MAX_FILE_LINES):
            problems.append(
                f"{f}: {n} lines (cap {MAX_FILE_LINES}) — split it into "
                "single-responsibility files wired from the entry file")
        if is_new and lang != "html" and base not in _ENTRY_NAMES:
            peers = [i for i in graph[f]["imports"] if i not in hubs]
            if len(peers) > MAX_LOCAL_IMPORTS:
                problems.append(
                    f"{f}: imports {len(peers)} workspace files directly "
                    f"({', '.join(peers)}; cap {MAX_LOCAL_IMPORTS}) — talk to "
                    "other features through a shared hub (an event bus / "
                    "store) instead of importing peers")
        if lang == "html" and "<html" in low:
            missing = []
            if "<meta charset" not in low:
                missing.append('<meta charset="utf-8">')
            if not ("<meta name=\"viewport\"" in low.replace("'", '"')
                    and "width=device-width" in low):
                missing.append('<meta name="viewport" content='
                               '"width=device-width, initial-scale=1">')
            if "<title" not in low:
                missing.append("<title>")
            if missing:
                problems.append(f"{f}: missing mobile shell basics — add "
                                + " and ".join(missing))
        if is_new and lang == "html":
            for m in _INLINE_SCRIPT.finditer(text):
                inl = m.group(1).count("\n")
                if inl > MAX_INLINE_SCRIPT:
                    problems.append(
                        f"{f}: inline <script> of {inl} lines (cap "
                        f"{MAX_INLINE_SCRIPT}) — move it into its own .js "
                        "file loaded via <script src>")
        if lang in ("html", "js"):
            _loc, ext = _refs(f, text, lang)
            for url in ext:
                if (_is_external(url)
                        and any(h in url for h in _CDN_HOSTS)
                        and not _VERSIONED.search(url.split("//", 1)[-1])):
                    problems.append(
                        f"{f}: unpinned CDN reference {url} — pin a version "
                        "(e.g. …/npm/babylonjs@7/…) so an upstream release "
                        "can't silently break the app")
        if (is_new and lang in ("js", "css") and not graph[f]["importedBy"]
                and base not in _ENTRY_NAMES and base not in _NEVER_ORPHAN
                and "worker" not in base):
            problems.append(
                f"{f}: created but nothing loads it — add a <script>/<link>/"
                "import for it, or delete it")
        if is_new and not _SAFE_NAME.match(f):
            problems.append(
                f"{f}: rename it — use only lowercase letters, digits, ., -, "
                "_ and / so the path is URL-safe on every server")
    for cyc in _cycles(graph, touched):
        problems.append(
            "import cycle: " + " → ".join(cyc + [cyc[0]]) + " — break it "
            "(move the shared piece into its own module or use events)")
    return "\n".join(problems)


def deps_of(target: str, root: Path = None, depth: int = 3) -> str:
    """The transitive files to read to understand `target` — its import closure.
    A convenience the agent (or UI) can call to scope a feature."""
    root = root or _workspace()
    graph = build_graph(root)
    if target not in graph:
        # allow basename match
        hits = [f for f in graph if os.path.basename(f) == target]
        if not hits:
            return json.dumps({"target": target, "read": [], "note": "not found"})
        target = hits[0]
    seen, frontier = set(), [target]
    for _ in range(max(1, depth)):
        nxt = []
        for f in frontier:
            for imp in graph.get(f, {}).get("imports", []):
                if imp not in seen:
                    seen.add(imp)
                    nxt.append(imp)
        frontier = nxt
        if not frontier:
            break
    return json.dumps({"target": target, "read": [target] + sorted(seen)})
