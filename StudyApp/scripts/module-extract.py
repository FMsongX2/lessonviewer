#!/usr/bin/env python3
# LessonViewer 모듈 업로드 PDF를 페이지 이미지와 텍스트로 뽑음. server/generation.ts 의 extractPdf가 부름.
# 실행: python scripts/module-extract.py <pdf 경로> <출력 디렉터리> [--max-bytes N] [--max-pages N]
# 출력 디렉터리는 비어 있어야 함. 결과: extract.json, NNN.jpg(화면용), model/NNN.jpg(모델 입력용).
# stdout 마지막 줄은 {"ok": true, ...} 또는 {"ok": false, "code": ..., "message": ...} JSON.
# 진행은 {"progress": n, "total": N} 줄로 알림. 원본 PDF는 읽기만 함.

import hashlib, json, os, sys
from pathlib import Path

DISPLAY_WIDTH = 1600      # 화면용 폭(px). 기존 data/slides 와 같음
DISPLAY_MAX_HEIGHT = 2400 # 세로로 긴 페이지의 화면용 상한
MODEL_LONG_EDGE = 1024    # 모델 입력 이미지의 긴 변 상한. 토큰 사용량을 묶음
DISPLAY_QUALITY = 82
MODEL_QUALITY = 72
MAX_TEXT = 20000          # 페이지당 텍스트 상한(문자)
MIN_SIDE_PT = 1.0
MAX_SIDE_PT = 14400.0     # PDF 사양상 페이지 한 변 상한(200in)


class Fail(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def parse_args(argv):
    pos, opts = [], {"--max-bytes": 50 * 1024 * 1024, "--max-pages": 200}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in opts:
            if i + 1 >= len(argv):
                raise Fail("failed", f"{a} 값이 없어요.")
            opts[a] = int(argv[i + 1])
            i += 2
            continue
        pos.append(a)
        i += 1
    if len(pos) != 2:
        raise Fail("failed", "사용법: module-extract.py <pdf> <outDir>")
    return Path(pos[0]), Path(pos[1]), opts["--max-bytes"], opts["--max-pages"]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def render(page, path, zoom, quality):
    import pymupdf
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
    pix.save(str(path), output="jpg", jpg_quality=quality)
    return pix.width, pix.height


def main():
    pdf, out, max_bytes, max_pages = parse_args(sys.argv[1:])
    if not pdf.is_file():
        raise Fail("invalid_pdf", "PDF 파일을 찾을 수 없어요.")
    size = pdf.stat().st_size
    if size == 0:
        raise Fail("empty", "빈 파일이에요.")
    if size > max_bytes:
        raise Fail("too_large", f"파일이 너무 커요. {max_bytes // (1024 * 1024)}MB 이하만 받을 수 있어요.")
    with open(pdf, "rb") as f:
        head = f.read(1024)
    if b"%PDF-" not in head:
        raise Fail("invalid_pdf", "PDF 형식이 아니에요.")
    if out.exists() and any(out.iterdir()):
        raise Fail("failed", "출력 디렉터리가 비어 있지 않아요.")

    import pymupdf
    pymupdf.TOOLS.mupdf_display_errors(False)
    try:
        doc = pymupdf.open(str(pdf), filetype="pdf")
    except Exception:
        raise Fail("invalid_pdf", "PDF를 열 수 없어요. 파일이 손상됐을 수 있어요.")
    with doc:
        if doc.needs_pass or doc.is_encrypted:
            raise Fail("encrypted", "암호가 걸린 PDF는 읽을 수 없어요. 암호를 푼 파일로 올려 주세요.")
        count = doc.page_count
        if count <= 0:
            raise Fail("empty", "페이지가 없는 PDF예요.")
        if count > max_pages:
            raise Fail("too_many_pages", f"페이지가 {count}쪽이에요. {max_pages}쪽 이하만 받을 수 있어요.")
        # 비싼 렌더 전에 모든 페이지 크기를 먼저 확인
        for i in range(count):
            r = doc[i].rect
            if not (MIN_SIDE_PT <= r.width <= MAX_SIDE_PT and MIN_SIDE_PT <= r.height <= MAX_SIDE_PT):
                raise Fail("invalid_pdf", f"{i + 1}쪽 크기가 올바르지 않아요.")

        out.mkdir(parents=True, exist_ok=True)
        (out / "model").mkdir(exist_ok=True)
        meta = doc.metadata or {}
        title = (meta.get("title") or "").strip() or None
        pages = []
        emit({"progress": 0, "total": count})
        for i in range(count):
            n = i + 1
            page = doc[i]
            r = page.rect
            try:
                dzoom = min(DISPLAY_WIDTH / r.width, DISPLAY_MAX_HEIGHT / r.height)
                image = f"{n:03d}.jpg"
                w, h = render(page, out / image, dzoom, DISPLAY_QUALITY)
                mzoom = MODEL_LONG_EDGE / max(r.width, r.height)
                model_image = f"model/{n:03d}.jpg"
                mw, mh = render(page, out / model_image, mzoom, MODEL_QUALITY)
                text = page.get_text().strip()
            except Exception:
                raise Fail("invalid_pdf", f"{n}쪽을 읽다가 실패했어요. 파일이 손상됐을 수 있어요.")
            truncated = len(text) > MAX_TEXT
            pages.append({
                "page": n,
                "text": text[:MAX_TEXT],
                "textTruncated": truncated,
                "image": image,
                "modelImage": model_image,
                "width": w, "height": h,
                "modelWidth": mw, "modelHeight": mh,
                "imageBytes": (out / image).stat().st_size,
                "modelImageBytes": (out / model_image).stat().st_size,
            })
            emit({"progress": n, "total": count})

        manifest = {
            "version": 1,
            "pageCount": count,
            "sha256": sha256(pdf),
            "bytes": size,
            "title": title,
            "width": pages[0]["width"],
            "height": pages[0]["height"],
            "pages": pages,
        }
    tmp = out / "extract.json.tmp"
    tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    os.replace(tmp, out / "extract.json")
    emit({"ok": True, "pageCount": count})


if __name__ == "__main__":
    try:
        main()
    except Fail as e:
        emit({"ok": False, "code": e.code, "message": e.message})
        sys.exit(2)
    except Exception:
        emit({"ok": False, "code": "failed", "message": "PDF 처리 중 알 수 없는 오류가 났어요."})
        sys.exit(1)
