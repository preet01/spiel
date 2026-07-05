"""Generate Hark PNG icons using stdlib only (no PIL required).
Icon design: indigo→violet gradient rounded square, white play triangle + 3 text lines.
"""
import struct, zlib, math, os

def make_png(w, h, pixels):
    """pixels: list of (r,g,b) tuples, length w*h, row-major."""
    def u32(n): return struct.pack('>I', n)
    def chunk(tag, data):
        crc = zlib.crc32(tag + data) & 0xffffffff
        return u32(len(data)) + tag + data + u32(crc)

    raw = b''
    for y in range(h):
        raw += b'\x00'
        for x in range(w):
            r, g, b = pixels[y * w + x]
            raw += bytes([r, g, b])

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))


def lerp(a, b, t):
    return int(a + (b - a) * max(0.0, min(1.0, t)))


def make_icon(size):
    r_corner = size * 0.22
    pixels = []

    for y in range(size):
        for x in range(size):
            nx = x / size
            ny = y / size

            # ── Rounded corner mask ──
            ex = max(r_corner - x, 0, x - (size - 1 - r_corner))
            ey = max(r_corner - y, 0, y - (size - 1 - r_corner))
            if ex > 0 or ey > 0:
                if math.sqrt(ex * ex + ey * ey) > r_corner:
                    pixels.append((255, 255, 255))  # outside = white (transparent in context)
                    continue

            # ── Gradient background: indigo → violet ──
            t = (nx + ny) / 2.0
            bg = (lerp(79, 109, t), lerp(70, 40, t), lerp(229, 217, t))

            # ── Artwork: play triangle + 3 text lines ──
            pad = 0.16
            in_art = False

            # Play triangle — left portion
            tri_x1, tri_x2 = pad, pad + 0.27
            tri_mid = 0.5
            tri_half_h = (1 - 2 * (pad + 0.05)) / 2  # half-height at the base

            if tri_x1 <= nx <= tri_x2:
                progress = (nx - tri_x1) / (tri_x2 - tri_x1)
                # Width of triangle narrows as we move right (pointy end on right)
                allowed = tri_half_h * (1.0 - progress)
                if abs(ny - tri_mid) <= allowed:
                    in_art = True

            # Text lines — right portion, 3 horizontal bars
            lines_x1 = pad + 0.32
            lines_x2 = 1.0 - pad
            line_centers = [0.30, 0.50, 0.70]
            line_half_h = 0.038  # half-height of each bar

            if not in_art and lines_x1 <= nx <= lines_x2:
                for cy in line_centers:
                    if abs(ny - cy) <= line_half_h:
                        in_art = True
                        break

            pixels.append((255, 255, 255) if in_art else bg)

    return make_png(size, size, pixels)


os.makedirs('dist/icons', exist_ok=True)
for size in [16, 48, 128]:
    data = make_icon(size)
    path = f'dist/icons/icon{size}.png'
    with open(path, 'wb') as f:
        f.write(data)
    print(f'✓ {path} ({len(data)} bytes)')
