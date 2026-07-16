#!/usr/bin/env python3
import json
import os
import struct
import zlib


PNG_SIG = b"\x89PNG\r\n\x1a\n"


def read_png(path):
    data = open(path, "rb").read()
    if not data.startswith(PNG_SIG):
        raise ValueError(f"not png: {path}")
    pos = 8
    width = height = color_type = None
    raw_parts = []
    while pos < len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        ctype = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            width, height, bit_depth, color_type, comp, filt, interlace = struct.unpack(">IIBBBBB", chunk)
            if bit_depth != 8 or comp != 0 or filt != 0 or interlace != 0:
                raise ValueError(f"unsupported PNG format: {path}")
            if color_type not in (2, 6):
                raise ValueError(f"unsupported color type {color_type}: {path}")
        elif ctype == b"IDAT":
            raw_parts.append(chunk)
        elif ctype == b"IEND":
            break
    channels = 4 if color_type == 6 else 3
    stride = width * channels
    raw = zlib.decompress(b"".join(raw_parts))
    rows = []
    prev = bytearray(stride)
    p = 0
    for _ in range(height):
        f = raw[p]
        p += 1
        row = bytearray(raw[p : p + stride])
        p += stride
        for i in range(stride):
            left = row[i - channels] if i >= channels else 0
            up = prev[i]
            up_left = prev[i - channels] if i >= channels else 0
            if f == 1:
                row[i] = (row[i] + left) & 255
            elif f == 2:
                row[i] = (row[i] + up) & 255
            elif f == 3:
                row[i] = (row[i] + ((left + up) >> 1)) & 255
            elif f == 4:
                pval = left + up - up_left
                pa = abs(pval - left)
                pb = abs(pval - up)
                pc = abs(pval - up_left)
                pred = left if pa <= pb and pa <= pc else up if pb <= pc else up_left
                row[i] = (row[i] + pred) & 255
            elif f != 0:
                raise ValueError(f"bad filter {f}")
        rows.append(row)
        prev = row
    return width, height, channels, rows


def write_rgba_png(path, width, height, rgba):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)
        raw.extend(rgba[y * stride : (y + 1) * stride])

    def chunk(ctype, payload):
        return (
            struct.pack(">I", len(payload))
            + ctype
            + payload
            + struct.pack(">I", zlib.crc32(ctype + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    out = PNG_SIG + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    open(path, "wb").write(out)


def extract_strokes(rows, channels, x, y, w, h):
    rgba = bytearray(w * h * 4)
    for yy in range(h):
        src_y = y + yy
        for xx in range(w):
            src_x = x + xx
            off = src_x * channels
            r, g, b = rows[src_y][off], rows[src_y][off + 1], rows[src_y][off + 2]
            # The rubbings are pale strokes on a dark green-black ground.
            # Use brightness and low saturation as a robust alpha matte.
            brightness = (r * 0.299 + g * 0.587 + b * 0.114)
            alpha = int(max(0, min(255, (brightness - 118) * 2.55)))
            if alpha < 18:
                alpha = 0
            dst = (yy * w + xx) * 4
            rgba[dst : dst + 4] = bytes((30, 29, 24, alpha))
    return rgba


def trim_rgba(width, height, rgba, pad=18):
    xs = []
    ys = []
    for y in range(height):
        for x in range(width):
            a = rgba[(y * width + x) * 4 + 3]
            if a > 26:
                xs.append(x)
                ys.append(y)
    if not xs:
        return width, height, rgba
    x0 = max(0, min(xs) - pad)
    y0 = max(0, min(ys) - pad)
    x1 = min(width - 1, max(xs) + pad)
    y1 = min(height - 1, max(ys) + pad)
    new_w = x1 - x0 + 1
    new_h = y1 - y0 + 1
    out = bytearray(new_w * new_h * 4)
    for yy in range(new_h):
        src = ((y0 + yy) * width + x0) * 4
        dst = yy * new_w * 4
        out[dst : dst + new_w * 4] = rgba[src : src + new_w * 4]
    return new_w, new_h, out


def main():
    data = json.load(open("data/glyphs.json", encoding="utf-8"))
    by_page = {}
    for ch, g in data["glyphs"].items():
        by_page.setdefault(g["page"], []).append((ch, g))

    page_cache = {}
    for page, items in by_page.items():
        print("page", page, len(items))
        if page not in page_cache:
            page_cache[page] = read_png(page)
        _, _, channels, rows = page_cache[page]
        for ch, g in items:
            path = f"assets/glyphs/u{ord(ch):04x}.png"
            rgba = extract_strokes(rows, channels, g["x"], g["y"], g["w"], g["h"])
            tw, th, trimmed = trim_rgba(g["w"], g["h"], rgba)
            write_rgba_png(path, tw, th, trimmed)
            g["image"] = path
            g["imageWidth"] = tw
            g["imageHeight"] = th

    data["assetMode"] = "transparent-glyphs"
    data["pagesKeptForSource"] = False
    json.dump(data, open("data/glyphs.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("glyph images", len(data["glyphs"]))


if __name__ == "__main__":
    main()
