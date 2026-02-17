#!/usr/bin/env python3
"""atomic_write.py — Atomic JSON write helper for rdloop.

Usage:
    python3 atomic_write.py <filepath> '<json_string>'
    echo '<json_string>' | python3 atomic_write.py <filepath> -

Writes JSON atomically: temp file -> flush -> fsync -> os.replace.
Also supports append mode for JSONL files:
    python3 atomic_write.py --append <filepath> '<json_line>'
"""
import json
import os
import sys
import tempfile


def atomic_write_json(filepath, data):
    """Write data as JSON to filepath atomically."""
    dirname = os.path.dirname(os.path.abspath(filepath))
    os.makedirs(dirname, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=dirname, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, filepath)
    except:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def append_jsonl(filepath, data):
    """Append a JSON line to filepath with flush+fsync."""
    dirname = os.path.dirname(os.path.abspath(filepath))
    os.makedirs(dirname, exist_ok=True)
    with open(filepath, "a") as f:
        f.write(json.dumps(data) + "\n")
        f.flush()
        os.fsync(f.fileno())


def main():
    if len(sys.argv) < 3:
        sys.stderr.write("Usage: atomic_write.py [--append] <filepath> <json_or_->\n")
        sys.exit(1)

    append_mode = False
    args = sys.argv[1:]
    if args[0] == "--append":
        append_mode = True
        args = args[1:]

    filepath = args[0]
    if len(args) > 1 and args[1] == "-":
        raw = sys.stdin.read()
    elif len(args) > 1:
        raw = args[1]
    else:
        raw = sys.stdin.read()

    data = json.loads(raw)

    if append_mode:
        append_jsonl(filepath, data)
    else:
        atomic_write_json(filepath, data)


if __name__ == "__main__":
    main()
