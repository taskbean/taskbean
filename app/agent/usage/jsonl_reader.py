"""Incremental JSONL reader with partial-line and rotation safety.

Advances offset only to the last complete ``\\n``. If ``file_size < last_offset``
we treat the file as rotated/truncated and reset. Returns (complete_lines,
new_offset, new_mtime_ms).
"""

from __future__ import annotations

import logging
import os


logger = logging.getLogger("usage.scanner")


def read_jsonl_incremental(
    path: str,
    last_offset: int,
    last_mtime: int,
) -> tuple[list[str], int, int]:
    try:
        st = os.stat(path)
    except OSError:
        return [], last_offset, last_mtime

    size = st.st_size
    mtime_ms = int(st.st_mtime * 1000)

    # Truncation / rotation: start over.
    if size < last_offset:
        logger.info(
            "[usage.scanner] %s rotated, resetting offset from %d",
            path, last_offset,
        )
        last_offset = 0

    # File unchanged since last scan — nothing to do.
    if size == last_offset and mtime_ms == last_mtime:
        return [], last_offset, mtime_ms

    if size == last_offset:
        return [], last_offset, mtime_ms

    with open(path, "rb") as f:
        f.seek(last_offset)
        chunk = f.read(size - last_offset)

    # Only advance to the last complete newline.
    nl = chunk.rfind(b"\n")
    if nl < 0:
        # No complete line yet; don't advance.
        return [], last_offset, last_mtime

    complete = chunk[: nl + 1]
    new_offset = last_offset + len(complete)

    lines = [
        ln.decode("utf-8", errors="replace")
        for ln in complete.split(b"\n")
        if ln.strip()
    ]
    return lines, new_offset, mtime_ms
