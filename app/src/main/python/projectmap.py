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
    out = []
    for p in sorted(root.rglob("*")):
        if any(x in p.parts for x in (".git", ".agent", "node_modules")):
            continue
        if p.name in ("meta.json", "transcript.jsonl"):
            continue
        if p.is_file() and p.suffix.lower() in _SRC_EXT:
            out.append(str(p.relative_to(root)))
        if len(out) >= max_files:
            break
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


def entry_points(graph: dict) -> list:
    """Files nothing imports but which pull others in (or a known entry name) —
    the roots to start reading a feature from."""
    ep = []
    for f, d in graph.items():
        name = os.path.basename(f).lower()
        rooty = name in ("index.html", "index.htm", "main.js", "main.py",
                         "app.py", "app.js", "wsgi.py", "game.js")
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
