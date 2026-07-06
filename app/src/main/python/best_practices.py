"""
best_practices.py — a curated, extensible playbook the agent follows by default.

The problem it solves: left alone the model makes plausible-but-bad mobile
choices — fixed d-pad buttons instead of a floating joystick, text too small to
read, a canvas that ignores the notch, audio that autoplays and gets blocked.
This injects terse, opinionated best practices into the agent's context *when
they're relevant*, grouped so it gets the right ones:

  - Controls & game loop  → game projects only
  - UI & text             → any mobile web project (games and apps)
  - Performance & limits   → any mobile web project

Two layers: BUILT-IN practices shipped here (OTA-updatable) and the USER's own
global best_practices.md that persists across every project and OVERRIDES the
built-ins. Kept terse so it rides the cached context prefix — after the first
turn it's a cache hit and costs ~nothing per step.

Injection is NOT limited to input/movement requests: once a project is a game
(or any web project), the relevant practices ride along on EVERY request.
"""

import os
from pathlib import Path

# --- built-in playbook ------------------------------------------------------
# Controls & game loop — game projects. Floating joystick first: fixed d-pad
# buttons are the single most common bad default.
MOBILE_GAME = [
    "Movement: use a FLOATING JOYSTICK, not fixed d-pad/arrow buttons. It "
    "appears where the thumb first touches the left half of the screen, the "
    "stick follows within a max radius, and it resets on release. Action buttons "
    "(jump/fire) go on the right half, reachable by the right thumb.",
    "Multi-touch: handle input with Pointer Events keyed by pointerId, so moving "
    "with the left thumb and firing with the right at the same time both "
    "register. Never assume a single active touch.",
    "Loop: advance by delta time from requestAnimationFrame (or a fixed timestep "
    "with an accumulator) so speed is identical on 60Hz and 120Hz devices. Never "
    "move a constant amount per frame.",
    "Auto-pause and mute when the game isn't visible: listen for visibilitychange "
    "and window blur, stop the loop and audio, resume on return.",
    "Unlock audio on the first user gesture (mobile blocks autoplay): start/resume "
    "the AudioContext from a tap, behind a tap-to-start overlay.",
    "Haptics: navigator.vibrate on impactful events (hit, pickup, death) where "
    "supported — short, sparing pulses make mobile feel responsive.",
    "Canvas fills the viewport, is redrawn on resize, and scales its backing "
    "store by devicePixelRatio so it's crisp on high-DPI phones.",
]

# UI & text — any mobile web project.
MOBILE_UI = [
    "Text >= 16px for body (also stops iOS from zooming when an input is "
    "focused); size with clamp()/rem and respect the OS font-size setting; never "
    "tiny fixed px.",
    "High contrast (WCAG AA, >= 4.5:1); don't encode meaning in color alone; put "
    "a scrim/backdrop behind text laid over images or video so it stays legible.",
    "Touch targets >= 48px with >= 8px gaps. Put primary actions in the bottom "
    "thumb zone; keep destructive/rare ones away from it. Top corners are hard to "
    "reach one-handed.",
    "Respect safe areas: viewport-fit=cover plus env(safe-area-inset-*) padding so "
    "a notch, rounded corner, or home indicator never covers UI.",
    "Every tap gives instant feedback (pressed state, and haptic where it "
    "matters). Never rely on hover — touch devices have none; no hover-only menus "
    "or tooltips.",
    "Use dynamic viewport units (100dvh / svh), NOT 100vh — the mobile URL bar "
    "shows/hides and 100vh gets clipped or leaves gaps.",
    "Handle the on-screen keyboard: scroll the focused field into view so the "
    "keyboard doesn't cover it, and set inputmode / enterkeyhint / type "
    "(email, number, tel) so the right keyboard appears.",
    "Design single-column with generous spacing and large hit areas; don't shrink "
    "a dense desktop layout onto a phone. Prefer big tap zones over precise ones.",
    "On interactive surfaces disable stray gestures (touch-action, "
    "user-select:none, block double-tap zoom / pull-to-refresh) — but keep normal "
    "content scrollable.",
    "Show loading / empty / error states for every async action; mobile networks "
    "are slow and flaky, so never leave a dead-looking screen.",
]

# Performance & mobile constraints — any mobile web project.
MOBILE_PERF = [
    "Do less work: pause rendering/logic when hidden or offscreen and cap the "
    "frame rate to what's needed — a busy loop drains the battery and heats the "
    "phone.",
    "Stay light: avoid big blurs/shadows/filters, oversized images (serve sized & "
    "compressed), and layout thrash; reuse objects instead of allocating each "
    "frame to avoid GC stutter.",
    "Free assets and remove listeners on scene/route change — mobile RAM is tight "
    "and leaks eventually crash the tab.",
    "Assume a slow, flaky connection: keep the initial payload small, lazy-load, "
    "cache, and degrade gracefully offline.",
    "Verify on a real mid-range phone in BOTH orientations with a notch — the "
    "desktop preview misrepresents size, touch, and speed.",
]

CATEGORIES = {
    "mobile-game": MOBILE_GAME,
    "mobile-ui": MOBILE_UI,
    "mobile-perf": MOBILE_PERF,
}
_CATEGORY_LABEL = {
    "mobile-game": "Controls & game loop",
    "mobile-ui": "UI & text",
    "mobile-perf": "Performance & mobile constraints",
}

_GAME_FILE_SIGNALS = ("babylon", "phaser", "three", "pixi", "kaboom", "<canvas",
                      "requestanimationframe", "playcanvas", "matter.js", "howler")
_GAME_TASK_WORDS = ("game", "joystick", "control", "player", "move", "sprite",
                    "canvas", "level", "score", "enemy", "shoot", "jump", "3d",
                    "2d", "multiplayer", "physics", "collision")
_WEB_TASK_WORDS = ("app", "ui", "screen", "page", "button", "form", "menu",
                   "layout", "web", "site", "mobile", "text", "font", "input",
                   "keyboard", "modal", "nav", "scroll", "theme")


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


def _has_web(root: Path) -> bool:
    try:
        for p in root.iterdir():
            if p.is_file() and p.suffix.lower() in (".html", ".htm"):
                return True
    except Exception:
        pass
    return False


def _task_is_gamey(task: str) -> bool:
    t = (task or "").lower()
    return any(w in t for w in _GAME_TASK_WORDS)


def _task_is_webby(task: str) -> bool:
    t = (task or "").lower()
    return any(w in t for w in _WEB_TASK_WORDS)


def categories_for(task: str = "", root: Path = None) -> list:
    """Which practice categories apply. Games get all three; any other web
    project gets UI + performance; a pure backend gets none."""
    root = root or _workspace()
    game = _looks_like_game(root) or _task_is_gamey(task)
    web = game or _has_web(root) or _task_is_webby(task)
    if game:
        return ["mobile-game", "mobile-ui", "mobile-perf"]
    if web:
        return ["mobile-ui", "mobile-perf"]
    return []


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
    cats = categories_for(task, root)
    if not cats:
        return ""
    groups = [_CATEGORY_LABEL[c] + ":\n- " + "\n- ".join(CATEGORIES[c]) for c in cats]
    return "Mobile best practices — apply these by default:\n\n" + "\n\n".join(groups)


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
    return render(task, _workspace()) or "(no best practices apply to this project yet)"
