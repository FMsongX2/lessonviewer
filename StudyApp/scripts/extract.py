#!/usr/bin/env python3
# courses.json 의 강의 PDF를 슬라이드 이미지와 페이지별 텍스트로 뽑아 data/ 에 둠.
# 원본(.orig.pdf)은 clean/, 사용자 필기가 있는 페이지는 주석본(.pdf)에서 ink/ 로 따로 렌더함.
# 해설 생성(유미)과 앱 서버가 이 결과를 읽음. 원본이 바뀌지 않았으면 건너뜀.
# 실행: ../.venv/bin/python scripts/extract.py [--force] [course/lecture ...]

import json, sys
from pathlib import Path
import pymupdf

APP = Path(__file__).resolve().parent.parent
CONFIG = json.loads((APP / "courses.json").read_text())
ROOT = (APP / CONFIG["materialsRoot"]).resolve()
OUT_SLIDES = APP / "data" / "slides"
OUT_TEXT = APP / "data" / "extract"
WIDTH = 1600          # 렌더 폭(px). 720pt 슬라이드면 약 2.2배
JPG_QUALITY = 82


def stamp(*paths):
    """원본이 바뀌었는지 판단할 서명. 경로·크기·mtime."""
    return [[str(p), p.stat().st_size, int(p.stat().st_mtime)] for p in paths if p]


def render(page, path):
    zoom = WIDTH / page.rect.width
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
    pix.save(path, output="jpg", jpg_quality=JPG_QUALITY)


def extract(course, lec, force):
    base = ROOT / course["dir"] / lec["file"]
    orig, annotated = base.with_name(base.name + ".orig.pdf"), base.with_name(base.name + ".pdf")
    clean = orig if orig.exists() else annotated
    if not clean.exists():
        print(f"  ! 원본 없음: {base}")
        return
    ink_src = annotated if annotated.exists() else None   # 주석본이 없으면 필기 렌더도 없음
    # inkFile: 개정판으로 바꿨을 때, 이전 판에 남긴 필기를 같은 쪽 번호로 계속 보여 줌(새 판에 필기가 있으면 그쪽 우선)
    old_ink = ROOT / course["dir"] / (lec["inkFile"] + ".pdf") if lec.get("inkFile") else None
    if old_ink and not old_ink.exists():
        print(f"  ! 이전 판 필기본 없음: {old_ink}")
        old_ink = None
    # prevFile: 작년 자료. 모든 쪽을 prevall/(작년 쪽 번호)로 렌더하고, 올해 쪽과의 짝은 content/<course>/prev.json (scripts/prev-map.py)
    prev_pdf = ROOT / course["dir"] / (lec["prevFile"] + ".pdf") if lec.get("prevFile") else None
    if prev_pdf and not prev_pdf.exists():
        print(f"  ! 작년 자료 없음: {prev_pdf}")
        prev_pdf = None

    meta_path = OUT_TEXT / course["id"] / f"{lec['id']}.json"
    sig = stamp(clean, ink_src, old_ink, prev_pdf)
    if not force and meta_path.exists() and json.loads(meta_path.read_text()).get("stamp") == sig:
        print(f"  = {lec['id']} (변경 없음)")
        return

    out = OUT_SLIDES / course["id"] / lec["id"]
    for sub in ("clean", "ink", "prevall"):
        (out / sub).mkdir(parents=True, exist_ok=True)
        for old in (out / sub).glob("*.jpg"):
            old.unlink()
    if prev_pdf:
        with pymupdf.open(prev_pdf) as pdoc:
            for i, page in enumerate(pdoc):
                render(page, out / "prevall" / f"{i + 1:03d}.jpg")

    cdoc = pymupdf.open(clean)
    idoc = pymupdf.open(ink_src) if ink_src else None
    odoc = pymupdf.open(old_ink) if old_ink else None
    pages = []
    for i, page in enumerate(cdoc):
        n = i + 1
        render(page, out / "clean" / f"{n:03d}.jpg")
        notes, ink, ink_from = [], False, None
        for doc, label in ((idoc, None), (odoc, "old")):
            if ink or not doc or i >= len(doc):
                continue
            ipage = doc[i]
            annots = list(ipage.annots() or [])
            if annots:
                notes = [a.info.get("content", "").strip() for a in annots if a.type[1] == "FreeText" and a.info.get("content", "").strip()]
                ink, ink_from = True, label
                render(ipage, out / "ink" / f"{n:03d}.jpg")
        entry = {"page": n, "text": page.get_text().strip(), "notes": notes, "ink": ink}
        if ink_from:
            entry["inkFrom"] = lec["inkFile"]   # 이 쪽 필기는 이전 판 위에 쓴 것
        pages.append(entry)

    meta = {
        "course": course["id"], "lecture": lec["id"],
        "source": str(clean.relative_to(ROOT)),
        "pageCount": len(cdoc), "width": cdoc[0].rect.width, "height": cdoc[0].rect.height,
        "stamp": sig, "pages": pages,
    }
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    print(f"  + {lec['id']}: {len(cdoc)}쪽, 필기 {sum(p['ink'] for p in pages)}쪽")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    for course in CONFIG["courses"]:
        print(course["title"])
        for lec in course["lectures"]:
            if args and f"{course['id']}/{lec['id']}" not in args and course["id"] not in args:
                continue
            extract(course, lec, force)


if __name__ == "__main__":
    main()
