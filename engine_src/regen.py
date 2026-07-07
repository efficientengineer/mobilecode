#!/usr/bin/env python3
"""Pack the engine sources into app/src/main/python/engine3d.py.

engine_src/ is the readable, testable source of the custom 3D engine. This
script bundles the template files (engine/**, game/**, index.html, guidelines.md)
into engine3d.py, which templates.py lays into a workspace. Dev-only files
(this script, the node test, package.json, README) are excluded.

    node test.mjs        # verify the engine sim + cameras
    python3 regen.py     # repack engine3d.py from these sources
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DEST = os.path.join(HERE, "..", "app", "src", "main", "python", "engine3d.py")
EXCLUDE = {"regen.py", "test.mjs", "package.json", "README.md"}
EXCLUDE_DIRS = {"node_modules", ".git"}


def collect():
    files = {}
    for root, dirs, names in os.walk(HERE):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for name in names:
            rel = os.path.relpath(os.path.join(root, name), HERE).replace(os.sep, "/")
            if rel in EXCLUDE:
                continue
            with open(os.path.join(root, name), encoding="utf-8") as f:
                files[rel] = f.read()
    return files


def main():
    files = collect()
    header = (
        '"""\n'
        'engine3d.py -- packed files for the "3D game (custom engine)" template.\n\n'
        "Our own event-driven, low-poly WebGL engine (no third-party 3D lib). This\n"
        "module is only the delivery vehicle: templates.py lays these down as real,\n"
        "readable source files in the user's project, where the AI GLUES against\n"
        "engine/CONTRACTS.md instead of reopening the engine.\n\n"
        "GENERATED from engine_src/ by engine_src/regen.py -- do not edit by hand.\n"
        '"""\n\n'
    )
    lines = ["FILES = {"]
    for rel in sorted(files):
        lines.append("    %s: %s," % (json.dumps(rel), json.dumps(files[rel])))
    lines.append("}\n")
    with open(DEST, "w", encoding="utf-8") as f:
        f.write(header + "\n".join(lines))
    print("packed %d files -> %s" % (len(files), os.path.relpath(DEST, HERE)))


if __name__ == "__main__":
    main()
