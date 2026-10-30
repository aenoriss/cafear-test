"""Downscale every texture in a .glb and repack it.

A 7 cm cage covers ~150 px on a phone screen, so 2K textures cost GPU memory
(22 MB each, decoded) for detail nobody sees.

Usage: python shrink_glb.py <in.glb> <out.glb> [--max 512] [--quality 85]
                             [--remap MATERIAL_REGEX DARK_HEX LIGHT_HEX]...
--remap recolours the base-colour texture of matching materials by brightness,
black -> DARK, white -> LIGHT (e.g. grey baked feathers to the bird's browns).
Needs: Pillow.
"""
import re
import argparse
import io
import json
import struct

from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("src")
ap.add_argument("dst")
ap.add_argument("--max", type=int, default=512)
ap.add_argument("--quality", type=int, default=85)
ap.add_argument("--remap", nargs=3, action="append", default=[], metavar=("MATERIAL_REGEX", "DARK", "LIGHT"))
args = ap.parse_args()

data = open(args.src, "rb").read()
off = 12
gltf, bin_chunk = None, b""
while off < len(data):
    length, kind = struct.unpack_from("<I4s", data, off)
    chunk = data[off + 8: off + 8 + length]
    if kind == b"JSON":
        gltf = json.loads(chunk)
    elif kind == b"BIN\x00":
        bin_chunk = chunk
    off += 8 + length

views = gltf["bufferViews"]
image_views = {im["bufferView"]: i for i, im in enumerate(gltf.get("images", [])) if "bufferView" in im}


def view_bytes(v):
    return bin_chunk[v.get("byteOffset", 0): v.get("byteOffset", 0) + v["byteLength"]]


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


# image index -> (dark, light, material name)
remaps = {}
for pattern, dark, light in args.remap:
    for m in gltf.get("materials", []):
        tex = m.get("pbrMetallicRoughness", {}).get("baseColorTexture")
        if tex is not None and re.search(pattern, m.get("name", "")):
            remaps[gltf["textures"][tex["index"]]["source"]] = (hex_rgb(dark), hex_rgb(light), m["name"])
    if not any(re.search(pattern, m.get("name", "")) for m in gltf.get("materials", [])):
        print(f"--remap {pattern}: no material matches, skipped")


def remap(img, dark, light):
    lum = img.convert("L")
    return Image.merge("RGB", [lum.point(lambda v, d=d, l=l: round(d + (l - d) * v / 255)) for d, l in zip(dark, light)])


# Rebuild the binary chunk view by view, re-encoding images.
new_bin = bytearray()
for vi, v in enumerate(views):
    raw = view_bytes(v)
    if vi in image_views:
        im = gltf["images"][image_views[vi]]
        img = Image.open(io.BytesIO(raw))
        before = img.size
        img.thumbnail((args.max, args.max), Image.LANCZOS)
        if image_views[vi] in remaps:
            dark, light, name = remaps[image_views[vi]]
            img = remap(img, dark, light)
            print(f"{im.get('name', vi)} ({name}): remapped to {dark}..{light}")
        buf = io.BytesIO()
        # Every map here is opaque, so JPEG is fine even for normal and
        # metallic/roughness maps at this size.
        img.convert("RGB").save(buf, "JPEG", quality=args.quality, optimize=True)
        raw = buf.getvalue()
        im["mimeType"] = "image/jpeg"
        print(f"{im.get('name', vi)}: {before} -> {img.size}, {v['byteLength']} -> {len(raw)} bytes")
    while len(new_bin) % 4:
        new_bin.append(0)
    v["byteOffset"] = len(new_bin)
    v["byteLength"] = len(raw)
    new_bin += raw
while len(new_bin) % 4:
    new_bin.append(0)
gltf["buffers"][0]["byteLength"] = len(new_bin)

js = json.dumps(gltf, separators=(",", ":")).encode()
js += b" " * (-len(js) % 4)
out = struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(new_bin))
out += struct.pack("<I4s", len(js), b"JSON") + js
out += struct.pack("<I4s", len(new_bin), b"BIN\x00") + bytes(new_bin)
open(args.dst, "wb").write(out)
print(f"{len(data)} -> {len(out)} bytes -> {args.dst}")
