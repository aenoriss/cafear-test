"""Render a fake phone-camera feed (.y4m) of the coffee bag with the QR on it.

Chrome plays the file in a loop as the webcam (--use-file-for-fake-video-capture),
so the WebAR page can be tested on the desktop.

Usage: python make_feed.py <qr.png> <out.y4m> [--qr-px 160] [--tilt 15] [--seconds 6]
  --qr-px  QR side in the output frame, pixels (≈ how close the phone is)
  --tilt   max yaw of the view, degrees (the camera sways between ±tilt)
"""
import argparse
import math

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W, H, FPS = 480, 640, 30  # portrait, as a phone held upright delivers it

ap = argparse.ArgumentParser()
ap.add_argument("qr")
ap.add_argument("out")
ap.add_argument("--qr-px", type=int, default=160)
ap.add_argument("--tilt", type=float, default=15)
ap.add_argument("--seconds", type=float, default=6)
ap.add_argument("--still", action="store_true", help="no camera motion (matches the still fake IMU)")
args = ap.parse_args()
if args.still:
    args.tilt = 0

rng = np.random.default_rng(1)

# Base scene at 2x, fronto-parallel: wall, table, black bag, QR label on the bag.
S = 2
bw, bh = W * S, H * S
wall = rng.normal(150, 12, (bh // 16, bw // 16, 3)).clip(0, 255).astype(np.uint8)
scene = Image.fromarray(wall).resize((bw, bh), Image.BICUBIC).filter(ImageFilter.GaussianBlur(6))
d = ImageDraw.Draw(scene)
table_y = int(bh * 0.82)
wood = rng.normal(0, 18, (bh - table_y, bw)).cumsum(axis=1) * 0.05 + 120
wood = np.stack([wood + 30, wood, wood - 30], -1).clip(0, 255).astype(np.uint8)
scene.paste(Image.fromarray(wood), (0, table_y))

qr_side = args.qr_px * S
bag_w, bag_h = int(qr_side * 1.7), int(qr_side * 2.3)
bag_x, bag_y = int(bw * 0.5) - bag_w // 2, table_y - bag_h + int(qr_side * 0.15)
d.rounded_rectangle([bag_x, bag_y, bag_x + bag_w, bag_y + bag_h], radius=12 * S, fill=(22, 22, 24))
qr = Image.open(args.qr).convert("RGB").resize((qr_side, qr_side), Image.NEAREST)
qr_x, qr_y = bag_x + (bag_w - qr_side) // 2, bag_y + int(bag_h * 0.42) - qr_side // 2
scene.paste(qr, (qr_x, qr_y))


def homography(src, dst):
    """Coefficients PIL wants: maps output (dst) pixels back to input (src)."""
    A, b = [], []
    for (x, y), (u, v) in zip(dst, src):
        A += [[x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]]
        b += [u, v]
    return np.linalg.solve(np.array(A, float), np.array(b, float))


def frame(t):
    # Camera sways in yaw and bobs slightly: a rotation about the vertical axis
    # through the QR, seen through a pinhole, approximated by keystoning.
    yaw = math.radians(args.tilt) * math.sin(2 * math.pi * t / args.seconds)
    k = 0.5 * math.sin(yaw)
    sway = 0 if args.still else 1
    dx = sway * 12 * S * math.sin(2 * math.pi * t / 3.1)
    dy = sway * 6 * S * math.sin(2 * math.pi * t / 2.3)
    cx = qr_x + qr_side / 2
    src = [(0, 0), (bw, 0), (bw, bh), (0, bh)]
    dst = []
    for x, y in src:
        side = (x - cx) / bw  # -..+ across the frame
        squeeze = 1 + k * side * 2
        dst.append((cx + (x - cx) * math.cos(yaw) + dx, bh / 2 + (y - bh / 2) * squeeze + dy))
    img = scene.transform((bw, bh), Image.PERSPECTIVE, homography(src, dst), Image.BICUBIC)
    img = img.resize((W, H), Image.LANCZOS)
    a = np.asarray(img, np.float32) + rng.normal(0, 3, (H, W, 3))
    return a.clip(0, 255)


def to_yuv420(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    y = 0.299 * r + 0.587 * g + 0.114 * b
    u = (b - y) * 0.564 + 128
    v = (r - y) * 0.713 + 128
    sub = lambda c: c.reshape(H // 2, 2, W // 2, 2).mean(axis=(1, 3))
    return [p.clip(0, 255).astype(np.uint8).tobytes() for p in (y, sub(u), sub(v))]


n = int(args.seconds * FPS)
with open(args.out, "wb") as f:
    f.write(f"YUV4MPEG2 W{W} H{H} F{FPS}:1 Ip A1:1 C420jpeg\n".encode())
    for i in range(n):
        f.write(b"FRAME\n")
        for plane in to_yuv420(frame(i / FPS)):
            f.write(plane)
        if i == 0:
            Image.fromarray(frame(0).astype(np.uint8)).save(args.out.replace(".y4m", "_first.png"))
print(f"{n} frames {W}x{H} -> {args.out}")
