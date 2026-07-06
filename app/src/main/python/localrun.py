"""
localrun.py — run a Python web app from the active workspace, in-process.

Supported entry points (first match wins), served on 127.0.0.1:<port>:
  1. app.py exposing a WSGI callable named `app` (Flask/Bottle/plain WSGI)
  2. a `wsgi.py` exposing `app`
  3. otherwise: a static file server rooted at the workspace

The server runs on a daemon background thread so the Kotlin WebView can load
http://127.0.0.1:<port>/. Only one server runs at a time.
"""

import os
import sys
import threading
import traceback
import importlib.util
from pathlib import Path
from wsgiref.simple_server import make_server, WSGIRequestHandler

_PORT = 8765
_server = None
_thread = None


def _workspace() -> Path:
    ws = os.environ.get("AGENT_WORKSPACE") or os.path.join(
        os.environ.get("HOME", "/tmp"), "workspace")
    p = Path(ws)
    p.mkdir(parents=True, exist_ok=True)
    return p


def _load_wsgi_app(root: Path):
    """Return a WSGI callable from app.py / wsgi.py, or None."""
    for name in ("app.py", "wsgi.py"):
        fp = root / name
        if fp.exists():
            sys.path.insert(0, str(root))
            spec = importlib.util.spec_from_file_location("user_app", str(fp))
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            app = getattr(mod, "app", None)
            if app is not None:
                return app
    return None


# Development preview: forbid caching so every reload reflects the latest edit.
_NO_CACHE_HEADERS = [
    ("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0"),
    ("Pragma", "no-cache"),
    ("Expires", "0"),
]


def _static_app(root: Path):
    """A tiny WSGI static-file server rooted at the workspace."""
    import mimetypes

    def app(environ, start_response):
        path = environ.get("PATH_INFO", "/").lstrip("/") or "index.html"
        fp = (root / path)
        if fp.is_dir():
            fp = fp / "index.html"
        if not fp.exists() or not fp.is_file():
            # Directory listing fallback.
            listing = "<h3>Files</h3><ul>" + "".join(
                f'<li><a href="/{p.relative_to(root)}">{p.relative_to(root)}</a></li>'
                for p in sorted(root.rglob("*")) if p.is_file() and ".git" not in p.parts
            ) + "</ul>"
            start_response("200 OK", [("Content-Type", "text/html")] + _NO_CACHE_HEADERS)
            return [listing.encode()]
        ctype = mimetypes.guess_type(str(fp))[0] or "application/octet-stream"
        start_response("200 OK", [("Content-Type", ctype)] + _NO_CACHE_HEADERS)
        return [fp.read_bytes()]

    return app


class _QuietHandler(WSGIRequestHandler):
    def log_message(self, *args):
        pass


def start() -> str:
    """(Re)start the server for the active workspace. Returns a status string."""
    global _server, _thread
    try:
        stop()
        root = _workspace()
        app = _load_wsgi_app(root) or _static_app(root)
        _server = make_server("127.0.0.1", _PORT, app, handler_class=_QuietHandler)
        _thread = threading.Thread(target=_server.serve_forever, daemon=True)
        _thread.start()
        kind = "app" if (root / "app.py").exists() or (root / "wsgi.py").exists() else "static files"
        return f"http://127.0.0.1:{_PORT}/  ({kind})"
    except Exception:
        return "Local run failed:\n" + traceback.format_exc()


def stop() -> str:
    global _server, _thread
    try:
        if _server is not None:
            _server.shutdown()
            _server = None
        return "stopped"
    except Exception:
        return "stop failed"


def url() -> str:
    return f"http://127.0.0.1:{_PORT}/"
