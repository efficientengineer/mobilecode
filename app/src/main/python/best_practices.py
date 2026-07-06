"""
best_practices.py — a curated, extensible playbook the agent follows by default.

The problem it solves: left alone the model makes mediocre-but-plausible mobile
choices (fixed on-screen d-pad buttons, a canvas that ignores the notch, audio
that autoplays and gets blocked). This injects terse, opinionated best practices
into the agent's context *when they're relevant* (e.g. only for game projects),
so it makes the good choice without being told each time.

Two layers:
  - BUILT-IN practices shipped here (OTA-updatable), grouped by category.
  - The USER's own practices in a global best_practices.md that persists across
    every project — edited from the app — which take priority.

Kept terse on purpose: it rides in the cached context prefix, so after the first
turn it's a cache hit and costs ~nothing per step.
"""

import os
from pathlib import Path

# --- built-in playbook ------------------------------------------------------
# Mobile game practices. The floating joystick is first because fixed d-pad
# buttons are the single most common bad default.
MOBILE_GAME = [
    "Movement controls: use a FLOATING JOYSTICK, not fixed d-pad/arrow buttons. "
    "It appears where the thumb first touches the left half of the screen and the "
    "stick follows within a max radius; it resets on release. Put action buttons "
    "(jump/fire) on the right half, reachable by the right thumb.",
    "Size touch controls for thumbs: hit targets >= 48px, well spaced, and inside "
    "the safe area — use env(safe-area-inset-*) plus viewport-fit=cover so a "
    "notch or home indicator never covers a control.",
    "Canvas fills the viewport and is redrawn on resize; scale the backing store "
    "by devicePixelRatio for crispness. Size with 100dvw/100dvh (dynamic viewport "
    "units), never fixed pixels.",
    "Kill browser gestures on the play surface: CSS touch-action:none and "
    "user-select:none, preventDefault on touchmove, and block double-tap zoom, "
    "pull-to-refresh, and text selection so play never scrolls the page.",
    "Handle multi-touch with Pointer Events keyed by pointerId, so moving with the "
    "left thumb and firing with the right at the same time both register. Never "
    "assume a single active touch.",
    "Auto-pause and mute when the game is not visible: listen for "
    "visibilitychange and window blur, stop the loop and audio, resume on return. "
    "Backgrounding must not keep running or blast sound.",
    "Drive the loop with delta time from requestAnimationFrame (or a fixed "
    "timestep with an accumulator) so speed is identical on 60Hz and 120Hz "
    "devices. Never advance by a constant per frame.",
    "Unlock audio on first user gesture: mobile blocks autoplay, so start/resume "
    "the AudioContext from a tap and show a tap-to-start overlay.",
    "Add haptics on impactful moments (hit, pickup, death) via navigator.vibrate "
    "where supported — short, sparing pulses make mobile feel responsive.",
    "Persist progress/settings to localStorage and restore on load; a mobile "
    "player can be interrupted at any moment.",
]

CATEGORIES = {"mobile-game": MOBILE_GAME}

# Signals that a project (or task) is a game, so we inject the game practices.
_GAME_FILE_SIGNALS = ("babylon", "phaser", "three", "pixi", "kaboom", "<canvas",
                      "requestanimationframe", "playcanvas")
_GAME_TASK_WORDS = ("game", "joystick", "control", "player", "touch", "mobile",
                    "sprite", "canvas", "level", "score", "enemy", "shoot",
                    "jump", "3d", "2d", "multiplayer")


def _workspace() -> Path:
    ws = os.environ.get("AGENT_WORKSPACE") or os.path.join(
        os.environ.get("HOME", "/tmp"), "workspace")
    return Path(ws)


def _looks_like_game(root: Path) -> bool:
    try:
        for name in ("index.html", "game.js", "main.js", "index.htm"):
            fp = root / name
            if fp.exists():
                t = fp.read_text(encoding="utf-8", errors="replace").lower()
                if any(s in t for s in _GAME_FILE_SIGNALS):
                    return True
    except Exception:
        pass
    return False


def _task_is_gamey(task: str) -> bool:
    t = (task or "").lower()
    return any(w in t for w in _GAME_TASK_WORDS)


# --- user's global practices (persist across every project) -----------------

def user_file() -> Path:
    home = os.environ.get("HOME") or "/tmp"
    return Path(home) / "best_practices.md"


def get_user(_=None) -> str:
    fp = user_file()
    try:
        return fp.read_text(encoding="utf-8").strip() if fp.exists() else ""
    except Exception:
        return ""


def set_user(text="") -> str:
    try:
        user_file().write_text(str(text), encoding="utf-8")
        return "Saved your best practices"
    except Exception as e:
        return f"Save failed: {e}"


def add_user(text="") -> str:
    """Append one practice to the user's global list (from the app, hands-free)."""
    line = str(text).strip()
    if not line:
        return "(nothing to add)"
    if not line.startswith(("-", "*")):
        line = "- " + line
    cur = get_user()
    return set_user((cur + "\n" if cur else "") + line)


# --- rendering into context -------------------------------------------------

def builtin_block(task: str = "", root: Path = None) -> str:
    root = root or _workspace()
    if _looks_like_game(root) or _task_is_gamey(task):
        return "Mobile game best practices — apply these by default:\n- " + \
            "\n- ".join(MOBILE_GAME)
    return ""


def render(task: str = "", root: Path = None) -> str:
    """The full best-practices block for context, or '' if nothing applies.
    User practices come last so they can override a built-in."""
    root = root or _workspace()
    parts = []
    b = builtin_block(task, root)
    if b:
        parts.append(b)
    u = get_user()
    if u:
        parts.append("Your own best practices (these take priority):\n" + u)
    return "\n\n".join(parts)


def preview(task="") -> str:
    """What would be injected for the current project (for the app to show)."""
    r = render(task, _workspace())
    return r or "(no best practices apply to this project yet)"
