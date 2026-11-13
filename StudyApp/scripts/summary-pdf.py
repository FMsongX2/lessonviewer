#!/usr/bin/env python3
# 과목별 시험대비 요약 content/<course>/summary.md 를 A4 PDF로 만들어 ../<과목 폴더>/시험대비 요약.pdf 에 둠.
# Markdown → pandoc(HTML, 수식은 MathML) → Chrome headless 인쇄. 만든 뒤 쪽수를 출력함.
# pdfnote로 필기하면 .orig.pdf가 생기므로, 그때는 필기본을 덮지 않게 멈춤(--force면 .orig.pdf만 새로 씀).
# 실행: ../.venv/bin/python scripts/summary-pdf.py [course ...] [--force]

import json, subprocess, sys, tempfile
from pathlib import Path
import pymupdf

APP = Path(__file__).resolve().parent.parent
CONFIG = json.loads((APP / "courses.json").read_text())
ROOT = (APP / CONFIG["materialsRoot"]).resolve()
NAME = "시험대비 요약"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

CSS = """
@page { size: A4; margin: 11mm 12mm 12mm; }
html { font-family: "GyeonggiBatang", "Apple SD Gothic Neo", serif; font-size: 8.9pt; line-height: 1.42; color: #111; }
body { margin: 0; max-width: none; padding: 0; }
h1, h2, h3, h4 { font-family: "GyeonggiTitle", "Apple SD Gothic Neo", sans-serif; line-height: 1.25; break-after: avoid; }
h1 { font-size: 15pt; margin: 0 0 1.5mm; border-bottom: 2px solid #e11d48; padding-bottom: 1mm; }
h1 + p { margin-top: 0; color: #555; }
h2 { font-size: 11pt; margin: 3.2mm 0 1.2mm; color: #e11d48; }
h3 { font-size: 9.4pt; margin: 2.2mm 0 .8mm; color: #2563eb; }
p { margin: .8mm 0; }
ul, ol { margin: .6mm 0; padding-left: 4.2mm; }
li { margin: .2mm 0; }
li > ul, li > ol { margin: 0; }
strong { color: #000; }
code { font-family: "SF Mono", Menlo, monospace; font-size: 8pt; background: #f3f4f6; padding: 0 .6mm; border-radius: 1mm; }
pre { font-size: 7.6pt; line-height: 1.32; background: #f6f7f9; border-left: 2px solid #2563eb; padding: 1.2mm 2mm; margin: 1mm 0; white-space: pre-wrap; break-inside: avoid; }
pre code { background: none; padding: 0; font-size: inherit; }
table { border-collapse: collapse; margin: 1.2mm 0; width: 100%; break-inside: avoid; font-size: 8.3pt; }
th, td { border: 1px solid #cfd3da; padding: .6mm 1.4mm; vertical-align: top; text-align: left; }
th { background: #f1f2f5; font-family: "GyeonggiTitle", sans-serif; }
blockquote { margin: 1mm 0; padding: .4mm 2.4mm; border-left: 2px solid #e11d48; color: #333; }
hr { border: 0; border-top: 1px dashed #bbb; margin: 2mm 0; }
math { font-size: 1.02em; }
"""


def build(course, force):
    md = APP / "content" / course["id"] / "summary.md"
    if not md.exists():
        print(f"  ! {md} 없음")
        return False
    out_dir = ROOT / course["dir"]
    pdf, orig = out_dir / f"{NAME}.pdf", out_dir / f"{NAME}.orig.pdf"
    target = pdf
    if orig.exists():
        if not force:
            print(f"  ! {orig.name}가 있어(필기본). 필기를 덮지 않으려고 멈춤. 원본만 새로 쓰려면 --force")
            return False
        target = orig
    with tempfile.TemporaryDirectory() as tmp:
        css = Path(tmp) / "s.css"
        css.write_text(CSS)
        html = Path(tmp) / "s.html"
        subprocess.run(["pandoc", str(md), "-f", "gfm+tex_math_dollars+pipe_tables", "-t", "html5", "-s", "--math-method=mathml",
                        "--embed-resources", "-c", str(css), "--metadata", f"pagetitle={course['title']} {NAME}",
                        "-o", str(html)], check=True)
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-pdf-header-footer", f"--user-data-dir={tmp}/chrome",
                        f"--print-to-pdf={target}", html.as_uri()], check=True, capture_output=True)
    print(f"  + {target.relative_to(ROOT)}: {pymupdf.open(target).page_count}쪽")
    return True


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    ok = True
    for course in CONFIG["courses"]:
        if args and course["id"] not in args:
            continue
        if args or (APP / "content" / course["id"] / "summary.md").exists():
            ok = build(course, force) and ok
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
