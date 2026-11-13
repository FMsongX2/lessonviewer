#!/usr/bin/env python3
# ~/Downloads 에 크롬으로 받은 eClass 자료를 출처 URL의 과목 키(ky=)로 판별해 과목 폴더로 옮기고,
# ppt류는 PDF로 변환하고 원본은 과목의 .pptx/ 숨김 폴더에 둠. LibreOffice가 시스템 폰트를 못 보는 문제는 프로필 폰트 링크로 우회함.
# launchd가 Downloads 변경 때마다 실행함. 키를 모르는 파일은 건드리지 않음.

import ctypes, ctypes.util, filecmp, os, plistlib, re, shutil, subprocess, sys, tempfile, time, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DOWNLOADS = Path.home() / "Downloads"
# eClass 과목 키(KJKEY) -> 과목 폴더. 새 과목은 받은 파일에 `xattr -p com.apple.metadata:kMDItemWhereFroms` 로 ky를 보고 추가
# 예: "A0000000000000001": "MachineLearning",
COURSES: dict[str, str] = {
}
STASH = ".pptx"   # 변환 뒤 원본 ppt를 두는 숨김 폴더. 변환이 손실이 있어 원본을 지우지 않음. 탐색기·LessonViewer 둘 다 점 폴더는 안 보임
SLIDE_EXT = {".pptx", ".ppt"}
SOFFICE = "/Applications/LibreOffice.app/Contents/MacOS/soffice"   # Keynote 15.1.1은 AppleScript 변환 중 크래시나서 LibreOffice 씀
LO_PROFILE = Path.home() / "Library/Caches/eclass_sort-lo"          # 사용자가 연 LibreOffice와 프로필 잠금이 겹치지 않게 따로 둠
FONT_DIRS = [Path("/System/Library/Fonts"), Path("/System/Library/Fonts/Supplemental"), Path("/Library/Fonts"), Path.home() / "Library/Fonts"]
FONT_EXT = {".ttf", ".ttc", ".otf"}


LIBC = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
WHEREFROMS = b"com.apple.metadata:kMDItemWhereFroms"


def origin(p):
    """크롬이 남긴 출처 URL 목록. 없으면 빈 목록. 파일 수백 개를 30초마다 훑으므로 프로세스 대신 libc getxattr로 읽음."""
    path = os.fsencode(p)
    n = LIBC.getxattr(path, WHEREFROMS, None, 0, 0, 0)
    if n <= 0:
        return []
    buf = ctypes.create_string_buffer(n)
    if LIBC.getxattr(path, WHEREFROMS, buf, n, 0, 0) != n:
        return []
    try:
        return plistlib.loads(buf.raw)
    except Exception:
        return []


def course_of(p):
    """파일의 과목 폴더 이름. eClass 다운로드가 아니거나 모르는 키면 None."""
    for u in origin(p):
        m = re.search(r"eclass\.seoultech\.ac\.kr.*[?&]ky=([A-Z0-9]+)", u)
        if m:
            return COURSES.get(m.group(1))
    return None


def ensure_fonts():
    """LibreOffice 프로필의 user/fonts 에 시스템·사용자 폰트를 심볼릭 링크로 채우고 새로 건 수를 돌려줌.
    LibreOffice 26.8이 macOS 26에서 시스템 폰트를 하나도 못 봐(Arial 조차 Liberation 으로 대체) 한글이 통째로 빠지는데, 프로필 user/fonts 는 읽음."""
    dst_dir = LO_PROFILE / "user/fonts"
    dst_dir.mkdir(parents=True, exist_ok=True)
    n = 0
    for d in FONT_DIRS:
        if not d.is_dir():
            continue
        for f in d.iterdir():
            if f.suffix.lower() not in FONT_EXT:
                continue
            dst = dst_dir / f.name
            if dst.is_symlink() and not dst.exists():   # 지워진 폰트의 링크
                dst.unlink()
            if dst.exists():
                continue
            dst.symlink_to(f)
            n += 1
    return n


def convert_office(src, outdir, fmt):
    """입력: 원본 경로, 출력 폴더, 변환 형식; 반환: 완성된 파일 경로. 변환 실패나 시간 초과는 예외로 알린다."""
    r = subprocess.run([SOFFICE, f"-env:UserInstallation={LO_PROFILE.as_uri()}", "--headless",
                        "--convert-to", fmt, "--outdir", str(outdir), str(src)],
                       capture_output=True, text=True, timeout=300)
    made = outdir / (src.stem + "." + fmt)
    if r.returncode != 0 or not made.exists():
        raise RuntimeError(r.stderr.strip() or r.stdout.strip() or "LibreOffice가 변환 파일을 만들지 않음")
    return made


def to_pdf(p):
    """입력: PPT/PPTX 경로; 반환: 옆에 만든 PDF 경로. 기존 필기본은 재사용하며 변환 실패는 예외로 알린다."""
    out = p.with_name(p.name + ".pdf")
    if out.exists():
        return out
    ensure_fonts()
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / p.name
        if p.suffix.lower() == ".pptx":
            # Gamma에서 보낸 일부 pptx는 zip 구조 탓에 LibreOffice가 로드를 거부함. 내용 그대로 다시 압축하면 읽힘
            with zipfile.ZipFile(p) as zi, zipfile.ZipFile(src, "w") as zo:
                for it in zi.infolist():
                    zo.writestr(it, zi.read(it))
        else:
            shutil.copy(p, src)
        made = convert_office(src, Path(tmp) / "out", "pdf")
        shutil.move(made, out)   # 다 만든 뒤 옮겨서 반쯤 쓴 PDF가 보이지 않게 함
    return out


def slide_count(p):
    """입력: PPT/PPTX 경로; 반환: 슬라이드 수, 읽기 실패는 0. 구형 PPT는 임시 PPTX로 변환해 세며 원본은 보존한다."""
    try:
        if p.suffix.lower() == ".ppt":
            ensure_fonts()
            with tempfile.TemporaryDirectory() as tmp:
                src = Path(tmp) / p.name
                shutil.copy2(p, src)
                return slide_count(convert_office(src, Path(tmp) / "out", "pptx"))
        with zipfile.ZipFile(p) as z:
            return len([x for x in z.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", x)])
    except Exception:
        return 0


def pdf_pages(p):
    """LibreOffice가 막 만든 PDF의 페이지 수. 필기로 페이지 트리가 재구성된 PDF에는 값이 틀리므로 쓰면 안 됨."""
    return len(re.findall(rb"/Type\s*/Page[^s]", p.read_bytes()))


def trash(p):
    """파일을 ~/.Trash 로 옮김. 같은 이름이 있으면 뒤에 숫자를 붙임. Finder를 거치지 않아 백그라운드에서도 됨."""
    dst = Path.home() / ".Trash" / p.name
    i = 1
    while dst.exists():
        dst = dst.with_name(f"{p.stem} {i}{p.suffix}")
        i += 1
    p.rename(dst)
    return dst


def stash(p):
    """원본 ppt를 같은 과목의 숨김 폴더로 옮기고 옮긴 경로를 돌려줌."""
    dst = p.parent / STASH / p.name
    dst.parent.mkdir(exist_ok=True)
    p.rename(dst)
    return dst


def archive_slide(src, pdf):
    """입력: 원본 슬라이드와 PDF 경로; 반환: 열 PDF 경로. 쪽수가 같으면 이름을 정리하고 원본을 보관하며 진단은 stderr에 쓴다."""
    n, pages = slide_count(src), pdf_pages(pdf)
    if n == 0 or n != pages:
        print(f"  슬라이드 {n} != 페이지 {pages} — ppt 원본을 남겨 둠", file=sys.stderr)
        return pdf
    out = src.with_suffix(".pdf")
    if out.exists():
        print(f"  {out.name} 이 이미 있어 ppt 원본을 남겨 둠", file=sys.stderr)
        return pdf
    pdf.rename(out)
    stash(src)
    print(f"  -> {out.name} (원본은 {STASH}/)", file=sys.stderr)
    return out


def sort_downloads():
    """완료된 다운로드만 과목 폴더로 옮기고 ppt류는 PDF로 변환함. 옮긴 경로 목록을 반환함. 같은 이름이 이미 있으면 그대로 둠."""
    moved = []
    for p in DOWNLOADS.iterdir():
        if not p.is_file() or p.suffix == ".crdownload" or p.name.startswith("."):
            continue
        if time.time() - p.stat().st_mtime < 2:   # 아직 쓰는 중일 수 있음. 다음 실행에 잡힘
            continue
        sub = course_of(p)
        if not sub:
            continue
        dst = ROOT / sub / re.sub(r" \(\d+\)(?=\.[^.]+$)", "", p.name)   # 크롬이 재다운로드에 붙인 " (1)" 을 뗌
        if dst.exists():
            if filecmp.cmp(p, dst, shallow=False):   # 같은 파일을 또 받은 것 -> Downloads 쪽을 치움
                trash(p)
                print(f"중복 -> 휴지통: {p.name}")
            else:
                print(f"skip (같은 이름, 다른 내용): {dst}")
            continue
        dst.parent.mkdir(exist_ok=True)
        p.rename(dst)
        moved.append(dst)
        print(f"{p.name} -> {sub}/")
        if dst.suffix.lower() in SLIDE_EXT:
            try:
                archive_slide(dst, to_pdf(dst))
            except Exception as ex:   # 변환 실패해도 옮기기는 유지. 뷰어에서 열 때 다시 시도함
                print(f"  변환 실패: {ex}")
    return moved


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        assert course_of(Path("/nonexistent")) is None
        assert re.search(r"[?&]ky=([A-Z0-9]+)", "x.acl?ud=1&ky=A0000000000000001&pf=2").group(1) == "A0000000000000001"
        assert slide_count(Path("/nonexistent")) == 0   # 못 읽으면 0 -> archive_slide 가 ppt를 남김
        ensure_fonts(); assert any((LO_PROFILE / "user/fonts").glob("AppleSDGothicNeo*"))   # 한글 폰트가 LibreOffice에 보이는 상태
        assert Path("a/Week 1.2 (x).pptx").with_suffix(".pdf").name == "Week 1.2 (x).pdf"   # 이름 속 점을 건드리지 않음
        assert re.sub(r" \(\d+\)(?=\.[^.]+$)", "", "오리엔테이션 (1).pdf") == "오리엔테이션.pdf"   # 재다운로드 접미사만 뗌
        assert re.sub(r" \(\d+\)(?=\.[^.]+$)", "", "Week 2 (Chapter 1).pptx") == "Week 2 (Chapter 1).pptx"   # 이름 속 괄호는 그대로
        print("selftest ok")
    else:
        sort_downloads()
