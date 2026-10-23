"""Generate the QR that both opens the WebAR page and serves as its image target.

Usage: python make_qr.py <url> <out.png>
Needs: qrcode, Pillow.
"""
import sys

import qrcode
from qrcode.constants import ERROR_CORRECT_M

url, out = sys.argv[1], sys.argv[2]

# Short URL + M correction keeps the version low: fewer, larger modules give the
# tracker bigger, less repetitive corners to lock on to.
qr = qrcode.QRCode(error_correction=ERROR_CORRECT_M, box_size=1, border=4)
qr.add_data(url)
qr.make(fit=True)
img = qr.make_image(fill_color="black", back_color="white").convert("L")

modules = img.size[0]
scale = 1600 // modules
img = img.resize((modules * scale, modules * scale), resample=0)
img.save(out)
print(f"version {qr.version}, {modules} modules incl. border, {img.size[0]}px -> {out}")
