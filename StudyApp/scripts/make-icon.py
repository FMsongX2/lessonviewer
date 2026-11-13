#!/usr/bin/env python3
# LessonViewer 아이콘: 빨간 스토리 실과 beat 매듭, 겹친 슬라이드 카드, 파란 책갈피.
# 색은 앱과 같은 pdfnote 펜 색(빨강 #e11d48, 파랑 #2563eb). 4배 크기로 그린 뒤 줄여서 가장자리를 매끄럽게 함.
# 실행: ../.venv/bin/python scripts/make-icon.py  →  macos/AppIcon.icns, web/public/ 아이콘들

import subprocess, shutil
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

APP = Path(__file__).resolve().parent.parent
S = 4                      # 슈퍼샘플링 배율
N = 1024 * S

RED, BLUE, INK = (225, 29, 72), (37, 99, 235), (27, 34, 50)
PAPER_TOP, PAPER_BOTTOM = (252, 252, 253), (226, 231, 238)
LINE = (197, 204, 215)


def px(v):
    return int(round(v * S))


def rounded(draw, box, r, **kw):
    draw.rounded_rectangle([px(c) for c in box], radius=px(r), **kw)


def shadow(size, box, r, blur, offset, alpha):
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x0, y0, x1, y1 = box
    rounded(d, (x0 + offset[0], y0 + offset[1], x1 + offset[0], y1 + offset[1]), r, fill=(20, 28, 45, alpha))
    return layer.filter(ImageFilter.GaussianBlur(px(blur)))


def draw_icon():
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))

    # 몸통: macOS 아이콘 격자(824pt 정사각, 둥근 모서리)와 은은한 그림자
    body = (100, 100, 924, 924)
    img.alpha_composite(shadow(img.size, body, 185, 18, (0, 14), 70))
    grad = Image.new("RGBA", (N, N))
    gd = ImageDraw.Draw(grad)
    for y in range(N):
        t = y / (N - 1)
        gd.line([(0, y), (N, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(PAPER_TOP, PAPER_BOTTOM)) + (255,))
    mask = Image.new("L", (N, N), 0)
    rounded(ImageDraw.Draw(mask), body, 185, fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)

    # 뒤 카드(지난 슬라이드)
    back = (372, 262, 842, 614)
    img.alpha_composite(shadow(img.size, back, 26, 10, (0, 6), 40))
    d = ImageDraw.Draw(img)
    rounded(d, back, 26, fill=(243, 245, 248), outline=(214, 219, 227), width=px(3))

    # 앞 카드(지금 슬라이드): 제목 막대와 본문 줄
    front = (330, 330, 812, 692)
    img.alpha_composite(shadow(img.size, front, 28, 16, (0, 12), 75))
    d = ImageDraw.Draw(img)
    rounded(d, front, 28, fill=(255, 255, 255))
    rounded(d, (376, 384, 640, 414), 15, fill=INK)
    for i, w in enumerate([360, 300, 338]):
        y = 466 + i * 64
        rounded(d, (376, y, 376 + w, y + 24), 12, fill=LINE)
    # 핵심 줄에 빨간 펜 밑줄
    rounded(d, (376, 504, 600, 514), 5, fill=RED)

    # 파란 책갈피(다시 볼 슬라이드)
    bx0, bx1, by0, by1 = 718, 772, 330, 452
    d.polygon([(px(bx0), px(by0)), (px(bx1), px(by0)), (px(bx1), px(by1)), (px((bx0 + bx1) / 2), px(by1 - 26)), (px(bx0), px(by1))], fill=BLUE)

    # 빨간 스토리 실과 beat 매듭 셋
    tx = 236
    rounded(d, (tx - 7, 236, tx + 7, 792), 7, fill=RED + (150,))
    for y in (268, 511, 760):
        r = 40
        d.ellipse([px(tx - r - 10), px(y - r - 10), px(tx + r + 10), px(y + r + 10)], fill=(248, 249, 251))
        d.ellipse([px(tx - r), px(y - r), px(tx + r), px(y + r)], fill=RED)
    # 가운데 매듭에서 앞 카드로 잇는 선
    rounded(d, (tx + 40, 504, 330, 518), 7, fill=RED)

    return img.resize((1024, 1024), Image.LANCZOS)


def main():
    icon = draw_icon()
    mac = APP / "macos"
    mac.mkdir(exist_ok=True)
    icon.save(mac / "AppIcon.png")

    iconset = mac / "AppIcon.iconset"
    shutil.rmtree(iconset, ignore_errors=True)
    iconset.mkdir()
    for size in (16, 32, 128, 256, 512):
        icon.resize((size, size), Image.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
        icon.resize((size * 2, size * 2), Image.LANCZOS).save(iconset / f"icon_{size}x{size}@2x.png")
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(mac / "AppIcon.icns")], check=True)
    shutil.rmtree(iconset)

    pub = APP / "web" / "public"
    pub.mkdir(parents=True, exist_ok=True)
    for name, size in (("icon-512.png", 512), ("icon-192.png", 192), ("apple-touch-icon.png", 180), ("favicon.png", 64)):
        icon.resize((size, size), Image.LANCZOS).save(pub / name)
    print("macos/AppIcon.icns, macos/AppIcon.png, web/public/*.png")


if __name__ == "__main__":
    main()
