from __future__ import annotations

import struct
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "packages" / "vscode-extension" / "media" / "icon.png"
SIZE = 128


def _chunk(kind: bytes, payload: bytes) -> bytes:
    checksum = zlib.crc32(kind + payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)


def _rgba_pixel(x: int, y: int) -> tuple[int, int, int, int]:
    margin = 10
    if x < margin or y < margin or x >= SIZE - margin or y >= SIZE - margin:
        return (17, 24, 39, 255)

    center = SIZE / 2
    dx = x - center
    dy = y - center
    distance = (dx * dx + dy * dy) ** 0.5
    base_r = int(18 + (x / (SIZE - 1)) * 21)
    base_g = int(31 + (y / (SIZE - 1)) * 40)
    base_b = int(53 + (1 - y / (SIZE - 1)) * 70)

    if 36 <= x <= 92 and 32 <= y <= 92:
        if 40 <= x <= 88 and 36 <= y <= 88:
            base_r, base_g, base_b = (236, 253, 245)
        if 46 <= x <= 82 and 44 <= y <= 82:
            base_r, base_g, base_b = (17, 24, 39)

    eye_left = (46 <= x <= 58 and 50 <= y <= 62)
    eye_right = (70 <= x <= 82 and 50 <= y <= 62)
    if eye_left or eye_right:
        return (45, 212, 191, 255)

    if 50 <= x <= 78 and 75 <= y <= 81:
        return (45, 212, 191, 255)

    if 28 <= distance <= 48 and 58 <= y <= 88:
        return (20, 184, 166, 255)

    if (20 <= x <= 108 and 104 <= y <= 110) or (18 <= x <= 30 and 96 <= y <= 118) or (98 <= x <= 110 and 96 <= y <= 118):
        return (45, 212, 191, 255)

    return (base_r, base_g, base_b, 255)


def main() -> int:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    raw = bytearray()
    for y in range(SIZE):
        raw.append(0)
        for x in range(SIZE):
            raw.extend(_rgba_pixel(x, y))

    png = bytearray()
    png.extend(b"\x89PNG\r\n\x1a\n")
    png.extend(_chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)))
    png.extend(_chunk(b"IDAT", zlib.compress(bytes(raw), level=9)))
    png.extend(_chunk(b"IEND", b""))
    OUTPUT.write_bytes(bytes(png))
    print(OUTPUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
