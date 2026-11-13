#!/usr/bin/env python3
# 과목별 하위 폴더의 PDF·PPTX를 연속 스크롤로 보며, 파워포인트 텍스트 상자처럼 페이지 위에 글자를 얹는 GUI 앱.
# 글자는 배경 없는 FreeText 주석으로 저장되고, 다시 열면 그대로 수정·이동됨.

import sys, math, copy, json, shutil, time, html as htmlmod, tkinter as tk
from dataclasses import dataclass
from pathlib import Path
from tkinter import ttk, font as tkfont, messagebox, simpledialog
import pymupdf
import eclass_sort   # Downloads의 eClass 자료를 과목 폴더로 옮기는 정리기

ROOT = Path(__file__).resolve().parent
STATE = ROOT / ".pdfnote.json"   # 마지막 파일·위치·확대율
FAMILY = "GyeonggiTitle"   # 경기천년제목. 미설치면 __init__에서 AppleGothic으로 대체
SIZES = [4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48]
COLORS = ["#e11d48", "#2563eb"]   # 빨강·파랑. 검정/흰색은 스와치 '자'(배경 대비 자동)가 맡음
DOC_EXT = {".pdf", ".pptx", ".ppt"}   # ppt류는 LibreOffice로 PDF 변환해 봄
# 물리 키 단축키. 한글 자판 상태면 keysym이 자모로 오므로 macOS 가상 키코드·자모로도 잡음
TOOL_KEYS = {"t": "t", "p": "p", "y": "p", "ㅅ": "t", "ㅔ": "p", "ㅛ": "p"}
VKEYS = {17: "t", 35: "p", 16: "p"}
GAP, PAD = 14, 6          # 페이지 사이·좌우 여백(px)
MIN_ZOOM, MAX_ZOOM, ZOOM_STEP = 0.4, 4.0, 1.2
ZOOM_ACC = 10             # 트랙패드 확대 누적 임계
PICK_REACH = 6.0          # 단어 높이의 이 배수를 넘게 떨어지면 선택 스냅 안 함 (세로는 4배 가중)
SEL_DARK, SEL_LIGHT = 0x10284f, 0xa9c8ef   # 본문 선택 틴트: 검정→진남색, 흰색→연파랑
NEW_W, MIN_W = 220, 40    # 새 상자 폭·최소 폭(pt)
DEF_SIZE = 9              # 기본 글자 크기(pt)
HANDLE = 5                # 조절점 반크기(px)
UNDO_MAX = 50             # 되돌리기 스택 깊이
AUTOSAVE_MS = 30000       # 자동 저장 주기


def wipe_annots(page, types, pred):
    """조건에 맞는 주석을 하나씩 재조회하며 지우고 개수를 반환함. 삭제 시 기존 Annot 참조가 무효화되기 때문."""
    n = 0
    while True:
        a = next((x for x in page.annots(types) if pred(x)), None)
        if a is None:
            return n
        page.delete_annot(a)
        n += 1


def to_rgb(h):
    """#rrggbb 를 PyMuPDF용 0~1 실수 튜플로 바꿈."""
    return tuple(int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))


def rich(text, color, size):
    """텍스트를 왼쪽 정렬 richtext HTML로 바꿈. 내장 CJK 폰트보다 자간이 정상적임."""
    style = f"text-align:left;font-family:sans-serif;font-size:{size:g}px;color:{color}"
    lines = htmlmod.escape(text).split("\n") or [""]
    return "".join(f'<div style="{style}">{l or "&nbsp;"}</div>' for l in lines)


@dataclass
class Note:
    """텍스트 상자 하나. (x, y)는 PDF 좌표의 좌상단, w는 줄바꿈 폭(pt)."""
    page: int
    x: float
    y: float
    w: float
    text: str
    color: str
    size: float


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        global FAMILY
        if FAMILY not in tkfont.families(self):
            FAMILY = "AppleGothic"
        self.title("PDF 메모")
        self.geometry("1360x900")
        self.doc = self.path = None
        self.src = None      # 트리에서 고른 원본 경로. pptx면 path는 변환된 PDF
        self.zoom = 1.4
        self.dirty = False
        self.notes = []      # Note 목록
        self.items = {}      # id(Note) -> 캔버스 텍스트 아이템
        self.pages = []      # 페이지별 (x, y, w, h) 캔버스 좌표
        self.rendered = {}   # 페이지 번호 -> (PhotoImage, 아이템)
        self.selimgs = []    # 본문 선택 오버레이 PhotoImage. 참조를 놓으면 GC로 사라짐
        self.words = {}      # 페이지 -> 읽기 순서 단어 목록
        self.picked = ""     # 드래그로 고른 본문
        self._lastpick = None   # 마지막으로 그린 (페이지, 시작, 끝) 단어 범위
        self._pickver = 0       # 선택 내용이 바뀔 때마다 증가. 오버레이 재렌더 판단용
        self._pickdrawn = None
        self.pickpage, self.pickrects = 0, None   # 강조(밑줄·형광) 적용 대상 페이지·단어 rect들
        self.editing = None  # 편집 중인 Note
        self._fmtop = False  # 편집 중 색·크기를 바꿨음. ⌘Z가 타이핑 대신 그걸 먼저 되돌리게 함
        self.proxy = None    # 입력 프록시 Text. 캔버스 구석 1px, 키 입력·IME만 받음
        self._blink_job = None
        self.sel = None      # 색·크기 버튼이 적용될 Note
        self.drag = None     # 진행 중인 드래그 상태
        self.fonts = {}
        self.defcolor = None  # None이면 배경 대비로 자동 결정
        self.defsize = DEF_SIZE
        self.undo_stack, self.redo_stack = [], []
        self.tmode = tk.BooleanVar(value=False)
        self.pmode = tk.BooleanVar(value=False)   # 펜 모드
        self._penpts = []                         # 그리는 중인 획의 PDF 좌표들
        self._job = self._fjob = self._asjob = None
        self._picking = False
        self.fitw = True     # 폭맞춤 유지 상태. 기본 켜짐, 수동 줌 시 해제
        self.finds = []      # 검색 결과 (페이지, Rect)
        self.find_i = -1
        self.find_term = ""
        self._zacc = 0
        self._build()
        self._menubar()
        self.load_tree()
        self.restore_session()
        self.sort_inbox()
        self.after(AUTOSAVE_MS, self.autosave)

    # ---------- UI ----------
    def _build(self):
        """툴바 + 파일 트리 + 스크롤 캔버스 + 상태줄을 구성함."""
        bar = ttk.Frame(self); bar.pack(side="top", fill="x", padx=6, pady=4)

        def btn(text, cmd, w=3, padx=0, side="left"):
            """포커스를 뺏지 않는 툴바 버튼. Aqua 기본 버튼은 여백이 커서 툴바가 넘치므로 Toolbutton으로 씀."""
            b = ttk.Button(bar, text=text, width=w, command=cmd, takefocus=False, style="Toolbutton")
            b.pack(side=side, padx=padx)
            return b

        def sep():
            """툴바 그룹 구분선."""
            ttk.Separator(bar, orient="vertical").pack(side="left", fill="y", padx=5, pady=2)

        btn("◀", lambda: self.jump(-1))
        self.plabel = ttk.Label(bar, text="-/-", width=6, anchor="center"); self.plabel.pack(side="left", padx=2)
        self.plabel.bind("<Button-1>", self.ask_page)
        btn("▶", lambda: self.jump(1))
        sep()
        btn("－", lambda: self.set_zoom(self.zoom / ZOOM_STEP))
        self.zlabel = ttk.Label(bar, text="—", width=4, anchor="center"); self.zlabel.pack(side="left")
        self.zlabel.bind("<Button-1>", self.ask_zoom)
        btn("＋", lambda: self.set_zoom(self.zoom * ZOOM_STEP))
        btn("폭", self.fit_width, padx=(4, 0))
        btn("쪽", self.fit_page)
        sep()
        ttk.Checkbutton(bar, text=" 텍스트 T ", style="Toolbutton", variable=self.tmode, takefocus=False,
                        command=lambda: (self.pmode.set(False), self.sync_cursor())).pack(side="left")
        ttk.Checkbutton(bar, text=" ✎ 펜 Y ", style="Toolbutton", variable=self.pmode, takefocus=False,
                        command=lambda: (self.tmode.set(False), self.sync_cursor())).pack(side="left")
        sep()
        btn("A－", lambda: self.bump_size(-1), w=4)
        self.slabel = ttk.Label(bar, text=str(DEF_SIZE), width=3, anchor="center"); self.slabel.pack(side="left")
        btn("A＋", lambda: self.bump_size(1), w=4)
        # 스와치 하나가 글자색·펜색·강조색을 겸하므로, 지금 무엇에 걸리는지 라벨로 알림
        self.clabel = ttk.Label(bar, text="글자색", width=4, anchor="e")
        self.clabel.pack(side="left", padx=(8, 3))
        self.swatch = {}
        for c in (None, *COLORS):
            # ponytail: Aqua는 tk.Button의 bg를 무시하므로 Label로 그림.
            b = tk.Label(bar, bg=c or "#c9c9c9", text="자" if c is None else "", width=2,
                         relief="ridge", bd=2)
            b.bind("<Button-1>", lambda e, c=c: self.set_color(c))
            b.bind("<Enter>", lambda e: e.widget.configure(bd=3))
            b.bind("<Leave>", lambda e: e.widget.configure(bd=2))
            b.pack(side="left", padx=1)
            self.swatch[c] = b
        self.mark_swatch()
        sep()
        self.markbtns = [btn("밑줄", lambda: self.mark("u"), w=4),
                         btn("형광", lambda: self.mark("h"), w=4),
                         btn("지움", lambda: self.mark("del"), w=4)]

        btn("?", self.show_help, w=2, padx=(6, 0), side="right")
        self.saved = ttk.Label(bar, anchor="e", width=8); self.saved.pack(side="right")
        btn("저장", self.save, w=4, padx=(0, 6), side="right")

        # 검색은 툴바 대신 하단 줄에 둠. 툴바에 다 넣으면 기본 창 폭을 넘겨 오른쪽이 잘림.
        status = ttk.Frame(self); status.pack(side="bottom", fill="x", padx=8, pady=(0, 4))
        self.hint = ttk.Label(status, anchor="w"); self.hint.pack(side="left")
        self.flabel = ttk.Label(status, text="", width=6, anchor="e"); self.flabel.pack(side="right")
        self.fentry = ttk.Entry(status, width=16)
        self.fentry.pack(side="right", padx=(6, 4))
        ttk.Label(status, text="⌕ 검색").pack(side="right")
        self.fentry.bind("<Return>", lambda e: self.do_find(1))
        self.fentry.bind("<Shift-Return>", lambda e: self.do_find(-1))
        self.fentry.bind("<Escape>", lambda e: self.clear_find())

        pane = ttk.PanedWindow(self, orient="horizontal"); pane.pack(fill="both", expand=True)
        self.tree = ttk.Treeview(pane, show="tree", selectmode="browse")
        self.tree.bind("<<TreeviewSelect>>", self.on_pick)
        pane.add(self.tree, weight=0)

        wrap = ttk.Frame(pane); pane.add(wrap, weight=1)
        self.canvas = tk.Canvas(wrap, bg="#4a4a4a", highlightthickness=0, closeenough=0,
                                xscrollincrement=1, yscrollincrement=1)
        vs = ttk.Scrollbar(wrap, orient="vertical", command=self.yview)
        hs = ttk.Scrollbar(wrap, orient="horizontal", command=self.canvas.xview)
        self.canvas.configure(yscrollcommand=vs.set, xscrollcommand=hs.set)
        vs.pack(side="right", fill="y"); hs.pack(side="bottom", fill="x")
        self.canvas.pack(side="left", fill="both", expand=True)

        self.canvas.bind("<Button-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)
        self.canvas.bind("<Double-Button-1>", lambda e: self.pick_units(e, 0))
        self.canvas.bind("<Triple-Button-1>", lambda e: self.pick_units(e, 1))
        self.canvas.bind("<Configure>", self.on_resize)
        self.canvas.bind("<Command-MouseWheel>", self.on_zoomwheel)
        self.canvas.bind("<Control-MouseWheel>", self.on_zoomwheel)
        self.canvas.bind("<Command-TouchpadScroll>", self.on_zoomtouch)
        for w in (self.canvas, self):
            w.bind("<MouseWheel>", self.on_wheel)
            w.bind("<TouchpadScroll>", self.on_touchpad)
            w.bind("<Shift-MouseWheel>", lambda e: self.canvas.xview_scroll(int(-e.delta * 100 / 120), "units"))
        # 편집 중에는 프록시 Text가 포커스를 쥐므로 아래 캔버스 키는 자동으로 비활성이 됨
        for k, fn in (("<Prior>", lambda e: self.jump(-1)), ("<Next>", lambda e: self.jump(1)),
                      ("<space>", lambda e: self.scroll_page(1)), ("<Shift-space>", lambda e: self.scroll_page(-1)),
                      ("<Home>", lambda e: self.goto_end(0)), ("<End>", lambda e: self.goto_end(1)),
                      ("<Up>", lambda e: self.scroll_by(-80)), ("<Down>", lambda e: self.scroll_by(80)),
                      ("<Left>", lambda e: self.scroll_x(-80)), ("<Right>", lambda e: self.scroll_x(80)),
                      ("<Command-BackSpace>", lambda e: self.delete_sel()),
                      ("<Command-0>", lambda e: self.set_zoom(1.0)),
                      ("<Command-plus>", lambda e: self.set_zoom(self.zoom * ZOOM_STEP)),
                      ("<Command-equal>", lambda e: self.set_zoom(self.zoom * ZOOM_STEP)),
                      ("<Command-minus>", lambda e: self.set_zoom(self.zoom / ZOOM_STEP))):
            self.canvas.bind(k, fn)
        self.bind_all("<Command-f>", lambda e: self.focus_find() or "break")
        self.bind_all("<KeyPress>", self.key_tool)
        self.bind_all("<Command-s>", lambda e: self.save())
        self.bind_all("<Control-s>", lambda e: self.save())
        self.bind_all("<Command-c>", self.copy_picked)
        # ⌘ 조합은 메뉴바가 먼저 가로채므로 실제로는 Ctrl 조합용. 둘 다 undo() 한 곳으로 모임.
        for k in ("<Command-z>", "<Control-z>"):
            self.bind_all(k, lambda e: self.undo())
        for k in ("<Command-Shift-Z>", "<Control-Shift-Z>"):
            self.bind_all(k, lambda e: self.undo(True))
        for k in ("<Command-a>", "<Control-a>"):
            self.bind_all(k, self.select_all)
        self.bind_all("<Escape>", self.escape)
        self.canvas.bind("<Button-2>", self.erase_ink)
        self.canvas.bind("<Button-3>", self.erase_ink)
        self.protocol("WM_DELETE_WINDOW", self.quit_app)
        self.sync_cursor()

    def _menubar(self):
        """자체 메뉴바를 깖. Tk가 macOS에 기본으로 다는 Edit 메뉴가 ⌘Z·⌘⇧Z·⌘C를 먼저 가로채기 때문."""
        bar = tk.Menu(self)
        m = tk.Menu(bar, tearoff=0)
        m.add_command(label="저장", accelerator="Cmd+S", command=self.save)
        bar.add_cascade(label="파일", menu=m)
        m = tk.Menu(bar, tearoff=0)
        m.add_command(label="되돌리기", accelerator="Cmd+Z", command=self.undo)
        m.add_command(label="다시 실행", accelerator="Cmd+Shift+Z", command=lambda: self.undo(True))
        m.add_separator()
        m.add_command(label="전체 선택", accelerator="Cmd+A", command=self.select_all)
        m.add_command(label="복사", accelerator="Cmd+C", command=self.copy_picked)
        m.add_command(label="잘라내기", accelerator="Cmd+X", command=self.cut)
        m.add_command(label="붙여넣기", accelerator="Cmd+V", command=self.paste)
        m.add_separator()
        m.add_command(label="찾기", accelerator="Cmd+F", command=self.focus_find)
        bar.add_cascade(label="편집", menu=m)
        m = tk.Menu(bar, tearoff=0)
        m.add_command(label="확대", accelerator="Cmd+=", command=lambda: self.set_zoom(self.zoom * ZOOM_STEP))
        m.add_command(label="축소", accelerator="Cmd+-", command=lambda: self.set_zoom(self.zoom / ZOOM_STEP))
        m.add_command(label="100%", accelerator="Cmd+0", command=lambda: self.set_zoom(1.0))
        m.add_separator()
        m.add_command(label="폭 맞춤", command=self.fit_width)
        m.add_command(label="페이지 맞춤", command=self.fit_page)
        bar.add_cascade(label="보기", menu=m)
        self.config(menu=bar)

    def load_tree(self):
        """ROOT 아래 PDF·PPTX를 과목(하위 폴더)별로 묶어 트리에 채움. 백업·변환 산출물은 뺌."""
        self.files, subjects = {}, {}
        for pdf in sorted(p for p in ROOT.rglob("*") if p.suffix.lower() in DOC_EXT):
            rel = pdf.relative_to(ROOT)
            if pdf.name.endswith((".orig.pdf", ".pptx.pdf", ".ppt.pdf")) or any(p.startswith(".") for p in rel.parts):
                continue
            subject = rel.parts[0] if len(rel.parts) > 1 else "(기타)"
            if subject not in subjects:
                subjects[subject] = self.tree.insert("", "end", text=subject, open=True)
            self.files[self.tree.insert(subjects[subject], "end", text=rel.name)] = pdf

    def font(self, px):
        """화면용 폰트를 픽셀 크기별로 캐시해 반환함."""
        px = max(4, int(px))
        if px not in self.fonts:
            self.fonts[px] = tkfont.Font(family=FAMILY, size=px)
        return self.fonts[px]

    # ---------- 문서 ----------
    def on_pick(self, _):
        """트리 선택 시 해당 PDF를 엶. 저장을 취소하면 선택도 원래 파일로 되돌림."""
        if self._picking:
            return
        sel = self.tree.selection()
        p = self.files.get(sel[0]) if sel else None
        if p is None or p == self.src:
            return
        if not self.confirm_discard():
            node = next((k for k, v in self.files.items() if v == self.src), None)
            self._picking = True
            if node:
                self.tree.selection_set(node)
            else:
                self.tree.selection_remove(*self.tree.selection())
            self._picking = False
            return
        self.open_file(p)

    def open_file(self, p):
        """트리 항목을 엶. ppt류는 PDF로 변환한 뒤 그 PDF를 엶. 변환 실패면 아무것도 바꾸지 않음."""
        pdf = p if p.suffix.lower() == ".pdf" else self.to_pdf(p)
        if pdf is None:
            return
        self.src = p
        self.open_pdf(pdf)

    def to_pdf(self, p):
        """ppt류의 변환 PDF 경로를 돌려줌. 받을 때 변환이 안 된 파일이면 여기서 LibreOffice로 변환함. 실패면 None."""
        if not p.with_name(p.name + ".pdf").exists():
            self.hint.config(text=f"{p.name} 변환 중… (LibreOffice)")
            self.update_idletasks()
        try:
            return eclass_sort.to_pdf(p)
        except Exception as ex:
            messagebox.showerror("변환 실패", f"{p.name}\n{ex}", parent=self)
            return None
        finally:
            self.sync_cursor()

    def open_pdf(self, p):
        """PDF를 열고 기존 텍스트 상자 주석을 모델로 읽어들임."""
        self.clear_view()
        if self.doc:
            self.doc.close()
        self.doc, self.path, self.dirty = pymupdf.open(p), p, False
        self.notes, self.words = [], {}
        self.clear_pick()
        self.undo_stack.clear(); self.redo_stack.clear()
        self.sel = None
        self.finds, self.find_term, self.find_i = [], "", -1
        self.flabel.config(text="")
        for i in range(len(self.doc)):
            for a in self.doc[i].annots([pymupdf.PDF_ANNOT_FREE_TEXT]):
                if a.info.get("title") != "memo":
                    continue
                meta = (a.info.get("subject") or "").split()
                color = meta[0] if meta and meta[0].startswith("#") else "#000000"
                size = float(meta[1]) if len(meta) > 1 else DEF_SIZE
                r = a.rect
                self.notes.append(Note(i, r.x0, r.y0, r.width, a.info["content"], color, size))
        self._strip_memos()
        self.layout()
        self.canvas.yview_moveto(0)
        self.refresh()
        if self.fitw and self.canvas.winfo_width() > 50:   # 창이 뜨기 전이면 첫 Configure가 대신 맞춤
            self.fit_width()
        self.retitle()
        self.canvas.focus_set()
        self.saved.config(text="")

    def _strip_memos(self):
        """메모 FreeText 주석을 메모리 문서에서 제거함. 화면은 캔버스 글자로 그리고 저장 때 다시 씀."""
        for i in range(len(self.doc)):
            wipe_annots(self.doc[i], [pymupdf.PDF_ANNOT_FREE_TEXT],
                        lambda a: a.info.get("title") == "memo")

    def confirm_discard(self):
        """저장 안 된 변경이 있으면 물어봄. 계속 진행해도 되면 True."""
        if not self.dirty:
            return True
        r = messagebox.askyesnocancel("저장", f"{self.path.name} 의 변경을 저장할까?")
        if r is None:
            return False
        if r:
            self.save()
        return True

    def backup(self):
        """첫 저장 때 원본을 .orig.pdf 로 한 번만 복사해 둠."""
        b = self.path.with_suffix(".orig.pdf")
        if not b.exists():
            shutil.copy2(self.path, b)

    def autosave(self):
        """주기적으로 변경분과 세션 상태를 저장함. 편집을 끊지 않으므로 타이핑 중에도 안전."""
        if self.doc and self.dirty:
            self.save()
        self.save_session()
        self.sort_inbox()
        self.after(AUTOSAVE_MS, self.autosave)

    def sort_inbox(self):
        """Downloads에 새로 받은 eClass 자료를 과목 폴더로 옮기고, 옮긴 게 있으면 트리를 다시 채움. 실패는 조용히 넘김."""
        try:
            moved = eclass_sort.sort_downloads()
        except Exception:
            return
        if not moved:
            return
        self.tree.delete(*self.tree.get_children())
        self.load_tree()
        node = next((k for k, v in self.files.items() if v == self.src), None)
        if node:
            self._picking = True
            self.tree.selection_set(node); self.tree.see(node)
            self._picking = False
        self.hint.config(text="받은 자료 정리: " + ", ".join(f"{d.parent.name}/{d.name}" for d in moved))

    def save_session(self):
        """마지막 파일·스크롤 위치·확대율을 STATE 파일에 기록함."""
        if self.src:
            STATE.write_text(json.dumps({"file": str(self.src.relative_to(ROOT)),
                                         "zoom": self.zoom, "y": self.canvas.yview()[0],
                                         "fit": self.fitw}))

    def restore_session(self):
        """직전 세션의 파일을 같은 위치·확대율로 다시 엶. 기록이 없거나 파일이 사라졌으면 무시함."""
        try:
            s = json.loads(STATE.read_text())
            p = ROOT / s["file"]
        except Exception:
            return
        node = next((k for k, v in self.files.items() if v == p), None)
        if not node:
            return
        self.zoom = max(MIN_ZOOM, min(MAX_ZOOM, float(s.get("zoom", self.zoom))))
        self.fitw = bool(s.get("fit", True))
        self._picking = True
        self.tree.selection_set(node); self.tree.see(node)
        self._picking = False
        self.open_file(p)
        if not self.doc:
            return
        self.canvas.yview_moveto(float(s.get("y", 0)))
        self.schedule()

    def save(self):
        """모델의 텍스트 상자를 배경 없는 FreeText 주석으로 다시 쓰고 같은 경로에 저장함."""
        if not self.doc or not self.dirty:
            return
        self.sync_proxy()          # 편집 중이면 내용만 모델로 넘기고 편집 상태는 유지
        self.backup()
        for n in self.notes:
            self.clamp(n)
        for i in range(len(self.doc)):
            page = self.doc[i]
            wipe_annots(page, [pymupdf.PDF_ANNOT_FREE_TEXT],
                        lambda a: a.info.get("title") == "memo")
            for n in self.notes:
                if n.page != i or not n.text.strip():
                    continue
                h = self.text_h(n) * 1.6 + n.size
                r = pymupdf.Rect(n.x, n.y, n.x + n.w, min(n.y + h, page.rect.y1)) & page.rect
                a = page.add_freetext_annot(r, rich(n.text, n.color, n.size), richtext=True,
                                            fill_color=None, border_width=0)
                a.update()
                a.set_info(content=n.text, title="memo", subject=f"{n.color} {n.size:g}")
                self.doc.xref_set_key(a.xref, "CL", "null")  # PyMuPDF가 붙이는 콜아웃 선 제거
        try:
            self.doc.save(self.path, incremental=True, encryption=pymupdf.PDF_ENCRYPT_KEEP)
        except Exception:
            tmp = self.path.with_suffix(".pdf.tmp")
            self.doc.save(tmp, garbage=3, deflate=True)
            self.doc.close()
            tmp.replace(self.path)
            self.doc = pymupdf.open(self.path)
            # 전체 재저장은 xref를 다시 매기므로 주석 히스토리가 무효가 됨
            self.undo_stack.clear(); self.redo_stack.clear()
        self._strip_memos()   # 파일엔 방금 썼고, 메모리 문서에 남으면 annots 렌더와 캔버스 글자가 겹침
        self.dirty = False
        self.retitle()
        self.saved.config(text=time.strftime("%H:%M:%S"))
        self.refocus()

    def quit_app(self):
        """창 닫기 전 저장 여부를 확인하고 세션 상태를 남김. IME 조합을 끊고 나서 파괴함."""
        if self.confirm_discard():
            self.stop_edit()
            self.canvas.focus_set()
            self.save_session()
            self.destroy()

    def mark_dirty(self):
        """변경 표시를 켜고 제목에 * 를 붙임."""
        if not self.dirty:
            self.dirty = True
            self.retitle()

    def retitle(self):
        """창 제목을 현재 파일·변경 상태로 갱신함."""
        self.title(f"PDF 메모 — {self.path.name}{' *' if self.dirty else ''}" if self.path else "PDF 메모")

    # ---------- 레이아웃 / 렌더 ----------
    def layout(self):
        """모든 페이지를 세로로 쌓은 캔버스 좌표를 계산하고 스크롤 영역을 정함."""
        self.pages, y = [], GAP
        maxw = max(self.doc[i].rect.width for i in range(len(self.doc))) * self.zoom
        for i in range(len(self.doc)):
            r = self.doc[i].rect
            w, h = r.width * self.zoom, r.height * self.zoom
            self.pages.append((PAD + (maxw - w) / 2, y, w, h))
            y += h + GAP
        self.canvas.configure(scrollregion=(0, 0, maxw + PAD * 2, y))
        # 렌더 전에도 페이지 자리가 보이게 흰 판과 쪽번호를 미리 깔아둠
        self.canvas.delete("ph")
        for i, (x, y0, w, h) in enumerate(self.pages):
            self.canvas.create_rectangle(x, y0, x + w, y0 + h, fill="white", outline="#333", tags="ph")
            self.canvas.create_text(x + w / 2, y0 + h / 2, text=str(i + 1), fill="#cfcfcf",
                                    font=(FAMILY, 30), tags="ph")
        self.canvas.tag_lower("ph")

    def clear_view(self):
        """캔버스의 모든 아이템을 치움."""
        self.stop_edit()
        self.items.clear(); self.rendered.clear(); self.selimgs = []
        self.canvas.delete("all")

    def visible(self):
        """현재 화면에 걸리는 페이지 번호 목록을 앞뒤 1장 여유 포함해 반환함."""
        top = self.canvas.canvasy(0)
        bot = top + self.canvas.winfo_height()
        hit = [i for i, (_, y, _, h) in enumerate(self.pages) if y < bot and y + h > top]
        return list(range(max(0, hit[0] - 1), min(len(self.pages), hit[-1] + 2))) if hit else []

    def schedule(self):
        """스크롤·확대 직후의 렌더를 한 번으로 묶어 예약함."""
        if self._job:
            self.after_cancel(self._job)
        self._job = self.after(60, self.refresh)

    def refresh(self):
        """보이는 페이지만 렌더하고 나머지는 버림. 텍스트 상자도 같이 붙였다 뗌."""
        self._job = None
        if not self.doc:
            return
        want = set(self.visible())
        for i in list(self.rendered):
            if i not in want:
                self.canvas.delete(self.rendered.pop(i)[1])
        for i in want:
            if i not in self.rendered:
                x, y, _, _ = self.pages[i]
                # 밑줄·형광이 보이게 주석 포함 렌더. 메모 FreeText는 _strip_memos로 떼어놔서 안 겹침.
                pix = self.doc[i].get_pixmap(matrix=pymupdf.Matrix(self.zoom, self.zoom), annots=True)
                img = tk.PhotoImage(data=pix.tobytes("ppm"))
                self.canvas.delete(f"ink{i}")   # 새 이미지에 획이 들어 있으므로 임시 오버레이는 걷음
                self.rendered[i] = (img, self.canvas.create_image(x, y, image=img, anchor="nw"))
                # 새 이미지는 맨 위에 깔리므로 이미 그려진 글상자(편집 중·재렌더)가 가려짐. 다시 올림
                self.canvas.tag_raise("sel"); self.canvas.tag_raise("note"); self.canvas.tag_raise("deco")
        for n in self.notes:
            if n.page in want and id(n) not in self.items:
                self.draw_note(n)
            elif n.page not in want and id(n) in self.items and n is not self.editing:
                self.canvas.delete(self.items.pop(id(n)))
        self.draw_pick()      # 선택의 진짜 상태는 pickrects. 캔버스 표현은 매 렌더마다 다시 그림
        self.draw_finds()
        if self.editing:
            self.deco()
        self.plabel.config(text=f"{self.cur_page() + 1}/{len(self.pages)}")
        self.zlabel.config(text=f"{round(self.zoom * 100)}%")

    def set_zoom(self, z, ax=None, ay=None):
        """확대율을 바꿈. (ax, ay) 위젯 좌표(기본은 화면 중앙) 아래 지점이 화면에 고정됨. 편집·선택은 유지됨."""
        if not self.doc:
            return
        if ax is None:
            ax, ay = self.canvas.winfo_width() / 2, self.canvas.winfo_height() / 2
        i, p = self.near_page(self.canvas.canvasx(ax), self.canvas.canvasy(ay))
        self.fitw = False
        z = max(MIN_ZOOM, min(MAX_ZOOM, z))
        if abs(z / self.zoom - 1) < 1e-4:   # 리사이즈마다 같은 배율로 전체 재렌더하는 것을 막음
            return
        self.zoom = z
        # clear_view를 쓰지 않음. editing·proxy를 건드리면 타이핑 중인 상자와 한글 조합이 끊김.
        for j in list(self.rendered):
            self.canvas.delete(self.rendered.pop(j)[1])
        for it in self.items.values():
            self.canvas.delete(it)
        self.items.clear()
        self.canvas.delete("sel", "find", "deco", "ink")
        self.selimgs = []
        self.layout()
        nx, ny = self.to_canvas(i, p.x, p.y)
        sr = self.canvas.cget("scrollregion").split()
        self.canvas.xview_moveto(max(0, nx - ax) / float(sr[2]))
        self.canvas.yview_moveto(max(0, ny - ay) / float(sr[3]))
        self.zlabel.config(text=f"{round(self.zoom * 100)}%")
        if self._job:
            self.after_cancel(self._job)
        self.refresh()    # 미루면 화면 갱신 사이에 흰 판이 한 번 비쳐 깜빡임. 같은 이벤트에서 바로 그림
        self.refocus()

    def on_zoomwheel(self, e):
        """⌘+휠로 커서 위치를 고정한 채 확대·축소함."""
        self.set_zoom(self.zoom * (ZOOM_STEP if e.delta > 0 else 1 / ZOOM_STEP), e.x, e.y)
        return "break"

    def on_zoomtouch(self, e):
        """⌘+트랙패드 스크롤 확대. 잦은 이벤트를 묶어 단계로 적용함."""
        _, dy = self.tk.call("tk::PreciseScrollDeltas", e.delta)
        self._zacc += dy
        if abs(self._zacc) >= ZOOM_ACC:
            self.set_zoom(self.zoom * (ZOOM_STEP if self._zacc > 0 else 1 / ZOOM_STEP), e.x, e.y)
            self._zacc = 0
        return "break"

    def ask_zoom(self, _=None):
        """배율 라벨 클릭 시 퍼센트를 입력받아 적용함."""
        if not self.doc:
            return
        n = simpledialog.askinteger("확대", f"배율 % ({round(MIN_ZOOM * 100)}~{round(MAX_ZOOM * 100)})",
                                    parent=self, initialvalue=round(self.zoom * 100),
                                    minvalue=round(MIN_ZOOM * 100), maxvalue=round(MAX_ZOOM * 100))
        if n:
            self.set_zoom(n / 100)

    def cur_page(self):
        """화면 맨 위에 가장 가까운 페이지 번호."""
        return min(range(len(self.pages)), key=lambda i: abs(self.pages[i][1] - self.canvas.canvasy(0)))

    def jump(self, d):
        """현재 페이지 기준 d 만큼 떨어진 페이지로 이동함."""
        if not self.doc:
            return
        self.goto_page(self.cur_page() + d)
        return "break"

    def goto_page(self, i):
        """i번(0부터) 페이지 맨 위로 스크롤함."""
        i = max(0, min(len(self.pages) - 1, i))
        self.canvas.yview_moveto(self.pages[i][1] / float(self.canvas.cget("scrollregion").split()[3]))
        self.schedule()
        self.refocus()

    def ask_page(self, _=None):
        """쪽수 라벨 클릭 시 번호를 입력받아 그 페이지로 이동함."""
        if not self.doc:
            return
        n = simpledialog.askinteger("이동", f"페이지 (1~{len(self.pages)})", parent=self,
                                    minvalue=1, maxvalue=len(self.pages))
        if n:
            self.goto_page(n - 1)

    def yview(self, *a):
        """세로 스크롤바 콜백. 스크롤 후 렌더를 예약함."""
        self.canvas.yview(*a); self.schedule()

    def on_wheel(self, e):
        """마우스 휠 세로 스크롤. 노치당 delta 120 → 크롬 기본과 같은 100px."""
        self.canvas.yview_scroll(int(-e.delta * 100 / 120), "units"); self.schedule()
        return "break"

    def on_touchpad(self, e):
        """트랙패드 스크롤. Tk 9는 휠과 별개로 TouchpadScroll 이벤트를 보냄."""
        dx, dy = self.tk.call("tk::PreciseScrollDeltas", e.delta)
        if dy:
            self.canvas.yview_scroll(-int(dy), "units")
        if dx:
            self.canvas.xview_scroll(-int(dx), "units")
        self.schedule()
        return "break"

    def sync_cursor(self):
        """켜진 도구(T·펜)에 맞춰 커서·캔버스 테두리·안내 문구를 바꿈. 모드 전환의 단일 통로."""
        t, pen = self.tmode.get(), self.pmode.get()
        ring = "#2563eb" if t else self.pen_color()
        self.canvas.configure(cursor="xterm" if t else "pencil" if pen else "",
                              highlightthickness=2 if (t or pen) else 0,
                              highlightbackground=ring, highlightcolor=ring)
        self.hint.config(text="T 모드 — 끌어서 텍스트 상자 (Shift+놓기=연속, Esc=취소)" if t
                         else "펜 모드 — 끌어서 그리기 · 우클릭=획 지우기 (Esc=끄기)" if pen
                         else "드래그=본문 선택 → 밑줄·형광 · T=상자 · Y=펜 · ⌘F=검색 · ?=도움말")
        self.sync_tools()
        self.refocus()

    def sync_tools(self):
        """강조 버튼 활성 여부와 색 스와치의 현재 의미를 도구·선택 상태에 맞춤."""
        for b in self.markbtns:
            b.state(["!disabled"] if self.pickrects else ["disabled"])
        # T 모드는 곧 만들 상자의 글자색을 고르는 중이므로 선택보다 앞섬
        self.clabel.config(text="펜색" if self.pmode.get() else "글자색" if self.tmode.get()
                           else "강조색" if self.pickrects else "글자색")

    def undo(self, redo=False):
        """⌘Z·Ctrl+Z 진입점. 편집 중이면 상자 안 타이핑을, 색·크기를 막 바꿨거나 되돌릴 타이핑이 없으면 문서를 되돌림."""
        if self.editing and self.proxy and not self._fmtop:
            try:
                self.proxy.edit_redo() if redo else self.proxy.edit_undo()
            except tk.TclError:
                pass          # 상자 안엔 되돌릴 게 없음 → 문서 스택으로 넘어감
            else:
                self.sync_proxy()
                return "break"
        return self.restore(self.redo_stack, self.undo_stack) if redo \
            else self.restore(self.undo_stack, self.redo_stack)

    def select_all(self, _=None):
        """⌘A/Ctrl+A — 편집 중이면 상자 안 전체, 아니면 현재 페이지 본문 전체를 지정함."""
        if self.editing and self.proxy:
            return self.text_edit("all")
        w = self.focus_get()
        if isinstance(w, (tk.Entry, ttk.Entry)):
            w.event_generate("<<SelectAll>>")
            return "break"
        if not self.doc:
            return
        ws = self.page_words(self.cur_page())
        if not ws:
            return "break"
        self._lastpick = None
        self.hl_words(self.cur_page(), ws)
        self.canvas.focus_set()
        return "break"

    def escape(self, _=None):
        """Esc — 편집·본문 선택·도구를 한 번에 해제함."""
        self.stop_edit()
        self.clear_pick()
        self.tmode.set(False)
        self.pmode.set(False)
        self.sync_cursor()

    def key_tool(self, e):
        """전역 T/P/Y 도구 단축키. 한글 자판이어도 물리 키로 잡음. 수식키 조합·텍스트 입력 중엔 무시함."""
        if e.state & 0x1c:   # Control·Command·Option
            return
        try:
            if isinstance(self.focus_get(), (tk.Text, tk.Entry, ttk.Entry)):
                return
        except KeyError:
            return           # 메뉴 등 Tk 위젯이 아닌 곳에 포커스
        # Tk(macOS) keycode는 상위 8비트가 가상 키코드. 그 밖엔 자모(char)·keysym으로 판별
        w = VKEYS.get(e.keycode >> 24) or TOOL_KEYS.get(e.char) or TOOL_KEYS.get(e.keysym.lower())
        if w == "t":
            return self.toggle_tmode()
        if w == "p":
            return self.toggle_pmode()

    def toggle_pmode(self):
        """펜 도구를 켜고 끔. T 모드와 동시엔 안 켬."""
        self.pmode.set(not self.pmode.get())
        self.tmode.set(False)
        self.sync_cursor()
        return "break"

    def show_help(self):
        """단축키 목록을 보여줌."""
        messagebox.showinfo("단축키", (
            "⌘F 검색 · Enter 다음 · Shift+Enter 이전 · Esc 닫기\n"
            "Esc — 편집·블록지정·도구 해제\n"
            "T 텍스트 상자 만들기 (Shift+놓기=도구 유지)\n"
            "Y(또는 P)/✎ 펜 — 끌어서 그리기 · 펜 모드 우클릭=획 지우기 (한글 자판에서도 됨)\n"
            "글자 클릭=편집 · 끌기=이동 · ◢=폭 조절 · ✕/⌘⌫=삭제\n"
            "드래그=본문 선택 · 더블클릭=단어 · 트리플클릭=줄 · ⌘C 복사\n"
            "블록지정 후 밑줄/형광/지움 = 강조 (색은 스와치, 자동=빨강 밑줄·노랑 형광)\n"
            "스와치 '자'=자동 — 글자색은 배경 대비, 펜은 빨강\n"
            "⌘S/Ctrl+S 저장 · ⌘Z/Ctrl+Z 되돌리기 · ⌘⇧Z/Ctrl⇧Z 다시 실행\n"
            "⌘A/Ctrl+A 전체선택 — 편집 중엔 상자 안 전체, 아니면 현재 쪽 본문 전체\n"
            "⌘C 복사 · ⌘X 잘라내기 · ⌘V 붙여넣기 (메뉴바 편집에도 있음)\n"
            "Space/Shift+Space 화면 · PgUp/PgDn·◀▶ 페이지 · Home/End 처음·끝\n"
            "화살표 스크롤 · ⌘휠 커서 기준 확대 · ⌘± 확대·축소 · ⌘0 100%\n"
            "폭=폭맞춤 · 쪽=페이지맞춤 · 쪽수·배율 라벨 클릭=직접 입력\n"
            "PPTX는 받을 때(늦어도 처음 열 때) LibreOffice로 <이름>.pptx.pdf 변환 후 그 PDF에 메모함 (다시 변환하려면 그 파일 삭제)"), parent=self)

    def toggle_tmode(self):
        """키보드로 T 도구를 켜고 끔. 펜 모드와 동시엔 안 켬."""
        self.tmode.set(not self.tmode.get())
        self.pmode.set(False)
        self.sync_cursor()
        return "break"

    def fit_width(self):
        """페이지 폭을 캔버스 폭에 맞추고, 창 크기가 바뀌어도 유지되게 표시함."""
        if not self.doc:
            return
        maxw = max(self.doc[i].rect.width for i in range(len(self.doc)))
        self.set_zoom((self.canvas.winfo_width() - PAD * 2 - 4) / maxw)
        self.fitw = True

    def fit_page(self):
        """현재 페이지 한 장이 통째로 보이게 맞춤. 폭·높이 중 작은 배율을 씀."""
        if not self.doc:
            return
        r = self.doc[self.cur_page()].rect
        self.set_zoom(min((self.canvas.winfo_width() - PAD * 2 - 4) / r.width,
                          (self.canvas.winfo_height() - GAP * 2) / r.height))
        self.goto_page(self.cur_page())

    def on_resize(self, _):
        """캔버스 크기 변경 시 다시 렌더하고, 폭맞춤 상태면 폭을 재적용함."""
        self.schedule()
        if self.fitw and self.doc:
            if self._fjob:
                self.after_cancel(self._fjob)
            self._fjob = self.after(150, self.refit)

    def refit(self):
        """폭맞춤을 현재 캔버스 폭으로 다시 적용함."""
        self._fjob = None
        if self.fitw and self.doc:
            self.fit_width()

    def scroll_page(self, d):
        """한 화면 분량 스크롤함."""
        self.canvas.yview_scroll(int(d * self.canvas.winfo_height() * 0.9), "units")
        self.schedule()
        return "break"

    def scroll_by(self, px):
        """지정한 픽셀만큼 세로 스크롤함."""
        self.canvas.yview_scroll(px, "units"); self.schedule()
        return "break"

    def scroll_x(self, px):
        """지정한 픽셀만큼 가로 스크롤함."""
        self.canvas.xview_scroll(px, "units"); self.schedule()
        return "break"

    def goto_end(self, which):
        """문서 처음(0)·끝(1)으로 이동함."""
        self.canvas.yview_moveto(float(which)); self.schedule()
        return "break"

    def refocus(self):
        """툴바 조작 뒤 편집 중이던 상자로 키보드 포커스를 돌려줌."""
        if self.editing and self.proxy:
            self.proxy.focus_set()
        elif self.doc:
            self.canvas.focus_set()

    # ---------- 검색 ----------
    def focus_find(self):
        """검색창에 포커스를 주고 기존 검색어를 전체 선택함."""
        self.fentry.focus_set()
        self.fentry.select_range(0, "end")

    def do_find(self, d):
        """검색어를 전체 페이지에서 찾아 d 방향의 다음 결과로 스크롤함."""
        if not self.doc:
            return
        term = self.fentry.get().strip()
        if not term:
            return
        if term != self.find_term:
            self.find_term = term
            self.finds = [(i, r) for i in range(len(self.doc)) for r in self.doc[i].search_for(term)]
            self.find_i = -1 if d > 0 else 0
        if not self.finds:
            self.flabel.config(text="0건")
            self.canvas.delete("find")
            return
        self.find_i = (self.find_i + d) % len(self.finds)
        i, r = self.finds[self.find_i]
        _, y = self.to_canvas(i, r.x0, r.y0)
        total = float(self.canvas.cget("scrollregion").split()[3])
        self.canvas.yview_moveto(max(0, y - self.canvas.winfo_height() / 3) / total)
        self.flabel.config(text=f"{self.find_i + 1}/{len(self.finds)}")
        self.refresh()

    def draw_finds(self):
        """보이는 페이지의 검색 결과를 하이라이트함. 현재 결과는 테두리로 구분함."""
        self.canvas.delete("find")
        if not self.finds:
            return
        want = set(self.visible())
        for k, (i, r) in enumerate(self.finds):
            if i not in want:
                continue
            x0, y0 = self.to_canvas(i, r.x0, r.y0)
            x1, y1 = self.to_canvas(i, r.x1, r.y1)
            # 채우면 원문이 가려지므로 테두리만 그림. 현재 결과는 빨간 굵은 테두리.
            self.canvas.create_rectangle(x0 - 2, y0 - 2, x1 + 2, y1 + 2, tags="find",
                                         width=3 if k == self.find_i else 2,
                                         outline="#e11d48" if k == self.find_i else "#f59e0b")
        self.canvas.tag_raise("note"); self.canvas.tag_raise("deco")

    def clear_find(self):
        """검색 하이라이트를 지우고 포커스를 문서로 돌림."""
        self.finds, self.find_term, self.find_i = [], "", -1
        self.flabel.config(text="")
        self.canvas.delete("find")
        self.canvas.focus_set()
        return "break"

    # ---------- 좌표 ----------
    def hit_page(self, cx, cy):
        """캔버스 좌표가 어느 페이지 안인지 (번호, PDF Point) 로 반환함. 밖이면 None."""
        for i, (x, y, w, h) in enumerate(self.pages):
            if x <= cx <= x + w and y <= cy <= y + h:
                r = self.doc[i].rect
                return i, pymupdf.Point(r.x0 + (cx - x) / self.zoom, r.y0 + (cy - y) / self.zoom)
        return None

    def near_page(self, cx, cy):
        """캔버스 좌표에 세로로 가장 가까운 페이지와 그 페이지 좌표계의 점. 회색 여백에서도 확대 기준점이 맞음."""
        i = min(range(len(self.pages)),
                key=lambda j: max(self.pages[j][1] - cy, 0, cy - self.pages[j][1] - self.pages[j][3]))
        x, y, _, _ = self.pages[i]
        r = self.doc[i].rect
        return i, pymupdf.Point(r.x0 + (cx - x) / self.zoom, r.y0 + (cy - y) / self.zoom)

    def page_pt(self, e, i):
        """이벤트를 페이지 i의 PDF 좌표로 바꿈. 페이지 밖이면 가장자리로 가둠."""
        r = self.doc[i].rect
        x, y, _, _ = self.pages[i]
        return pymupdf.Point(
            min(max(r.x0 + (self.canvas.canvasx(e.x) - x) / self.zoom, r.x0), r.x1),
            min(max(r.y0 + (self.canvas.canvasy(e.y) - y) / self.zoom, r.y0), r.y1))

    def to_canvas(self, i, x, y):
        """페이지 i의 PDF 좌표를 캔버스 좌표로 바꿈."""
        px, py, _, _ = self.pages[i]
        r = self.doc[i].rect
        return px + (x - r.x0) * self.zoom, py + (y - r.y0) * self.zoom

    def ev_pt(self, e):
        """이벤트를 (페이지, PDF Point) 로 바꿈. 페이지 밖이면 None."""
        return self.hit_page(self.canvas.canvasx(e.x), self.canvas.canvasy(e.y))

    # ---------- 텍스트 상자 ----------
    def text_h(self, n):
        """줄바꿈을 감안한 글상자 높이(pt)를 어림함."""
        f = self.font(round(n.size * self.zoom))
        limit = max(20, n.w * self.zoom)
        lines = sum(max(1, math.ceil(f.measure(p) / limit)) for p in n.text.split("\n") or [""])
        return lines * f.metrics("linespace") / self.zoom

    def clamp(self, n):
        """상자를 페이지 안에 가둠. 밖으로 나간 상자가 저장 때 잘려 사라지는 것을 막음."""
        r = self.doc[n.page].rect
        n.w = max(MIN_W, min(n.w, r.width))
        n.x = min(max(n.x, r.x0), r.x1 - n.w)
        n.y = min(max(n.y, r.y0), r.y1 - n.size)

    def push(self, op):
        """히스토리에 연산을 쌓고 다시실행 스택을 비움."""
        self.undo_stack.append(op)
        del self.undo_stack[:-UNDO_MAX]
        self.redo_stack.clear()

    def snapshot(self):
        """되돌리기용으로 현재 상자 목록 전체를 저장함. 직전과 같으면 건너뜀."""
        if self.undo_stack and self.undo_stack[-1] == ("notes", self.notes):
            return
        self.push(("notes", copy.deepcopy(self.notes)))

    def annot_spec(self, a):
        """잉크·밑줄·형광 주석을 재생성 가능한 dict로 뽑음."""
        return {"t": a.type[0], "color": a.colors.get("stroke") or (1, 0, 0),
                "v": a.vertices, "w": (a.border or {}).get("width", 2)}

    def make_annot(self, i, s):
        """spec으로 주석을 다시 만들어 반환함."""
        page = self.doc[i]
        if s["t"] == pymupdf.PDF_ANNOT_INK:
            a = page.add_ink_annot(s["v"])
            a.set_border(width=s["w"])
        else:
            quads = [pymupdf.Quad(s["v"][k:k + 4]) for k in range(0, len(s["v"]), 4)]
            a = (page.add_underline_annot if s["t"] == pymupdf.PDF_ANNOT_UNDERLINE
                 else page.add_highlight_annot)(quads)
        a.set_colors(stroke=s["color"])
        a.update()
        return a

    def restore(self, src, dst):
        """실행취소·다시실행 한 단계. notes는 상태 교체, 주석(rm/mk)은 삭제·재생성으로 반전함."""
        if not src:
            return "break"
        self.stop_edit()
        op = src.pop()
        if op[0] == "notes":
            dst.append(("notes", copy.deepcopy(self.notes)))
            self.notes = op[1]
            self.sel = None
            for item in self.items.values():
                self.canvas.delete(item)
            self.items.clear()
            self.refresh()
        elif op[0] == "rm":
            _, i, xrefs = op
            specs = [self.annot_spec(a) for a in self.doc[i].annots() if a.xref in xrefs]
            wipe_annots(self.doc[i], None, lambda a: a.xref in xrefs)
            dst.append(("mk", i, specs))
            self.rerender(i)
        else:  # "mk"
            _, i, specs = op
            dst.append(("rm", i, [self.make_annot(i, s).xref for s in specs]))
            self.rerender(i)
        self.mark_dirty()
        return "break"

    def delete_sel(self):
        """편집 중이거나 마지막으로 고른 상자를 지움."""
        n = self.editing or self.sel
        if not n:
            return "break"
        self.snapshot()
        if n is self.editing:
            if self.proxy:
                self.proxy.delete("1.0", "end")
            self.stop_edit()           # 빈 상자는 stop_edit이 목록에서 뺌
        else:
            if id(n) in self.items:
                self.canvas.delete(self.items.pop(id(n)))
            if n in self.notes:
                self.notes.remove(n)
        if self.sel is n:
            self.sel = None
        self.mark_dirty()
        return "break"

    def draw_note(self, n):
        """텍스트 상자를 배경 없는 캔버스 글자로 그림."""
        cx, cy = self.to_canvas(n.page, n.x, n.y)
        self.items[id(n)] = self.canvas.create_text(
            cx, cy, text=n.text, anchor="nw", fill=n.color, tags=("note", f"note{id(n)}"),
            font=self.font(round(n.size * self.zoom)), width=max(20, n.w * self.zoom))

    def note_at(self, item):
        """캔버스 아이템에 대응하는 Note를 반환함."""
        for t in self.canvas.gettags(item):
            if t.startswith("note") and t != "note":
                return next((n for n in self.notes if f"note{id(n)}" == t), None)
        return None

    def start_edit(self, n, ev=None):
        """상자를 편집 상태로 바꿈. 화면은 투명한 캔버스 글자 그대로 두고, 입력만 1px 프록시 Text가 받음."""
        if self.editing is not n:
            self.stop_edit()
        if n.text:
            self.snapshot()          # 타이핑 전 상태를 되돌리기 지점으로 잡음
        self.editing = self.sel = n
        self._fmtop = False
        self.slabel.config(text=f"{n.size:g}")   # 크기 라벨만 상자를 따라감. 기본값은 유지.
        if id(n) not in self.items:
            self.draw_note(n)
        item = self.items[id(n)]
        if not self.proxy:
            # ponytail: 한글 IME 조합은 실제 Text 위젯에서만 제대로 커밋됨. 캔버스 임베드 창(create_window)은
            # macOS에서 스크롤·이동 때 흰 잔상을 남기므로, 구석에 place 1px로만 두고 키 입력만 받음.
            t = tk.Text(self.canvas, bd=0, highlightthickness=0, wrap="none", undo=True, bg="#4a4a4a")
            t.place(x=0, y=0, width=1, height=1)
            t.bind("<KeyPress>", lambda e: self.after_idle(self.sync_proxy))
            t.bind("<KeyRelease>", lambda e: self.after_idle(self.sync_proxy))
            t.bind("<<Selection>>", lambda e: self.after_idle(self.sync_proxy))
            t.bind("<Command-BackSpace>", lambda e: self.delete_sel())
            # 위젯 바인딩이 클래스·전역보다 먼저라, 편집 중에는 이쪽이 문서 단축키를 가로챔
            for k in ("<Command-z>", "<Control-z>"):
                t.bind(k, lambda e: self.text_edit("undo"))
            for k in ("<Command-Shift-Z>", "<Control-Shift-Z>"):
                t.bind(k, lambda e: self.text_edit("redo"))
            for k in ("<Command-a>", "<Control-a>"):
                t.bind(k, lambda e: self.text_edit("all"))
            self.proxy = t
        t = self.proxy
        t.delete("1.0", "end"); t.insert("1.0", n.text)
        t.edit_reset()   # 상자를 열며 넣은 초기 텍스트가 되돌리기로 지워지지 않게
        t.mark_set("insert", f"1.0+{self.click_index(item, ev) if ev else len(n.text)}c")
        t.focus_set()
        self.sync_proxy()
        self.blink()

    def text_edit(self, what):
        """편집 중인 상자 안의 되돌리기·다시실행·전체선택. 프록시 Text 자체 스택과 선택을 씀."""
        t = self.proxy
        try:
            if what == "undo":
                t.edit_undo()
            elif what == "redo":
                t.edit_redo()
            else:
                t.tag_add("sel", "1.0", "end-1c")
                t.mark_set("insert", "end-1c")
        except tk.TclError:
            pass
        self.sync_proxy()
        return "break"

    def click_index(self, item, ev):
        """클릭 좌표에 해당하는 글자 인덱스를 반환함."""
        return self.canvas.index(item, f"@{int(self.canvas.canvasx(ev.x))},{int(self.canvas.canvasy(ev.y))}")

    def sync_proxy(self):
        """프록시의 내용·캐럿·선택을 캔버스 글자에 그대로 반영함."""
        if not self.editing or not self.proxy:
            return
        n, t = self.editing, self.proxy
        item = self.items.get(id(n))
        if item is None:
            return
        text = t.get("1.0", "end-1c")
        if text != n.text:
            n.text = text
            self.canvas.itemconfig(item, text=text)
            self.mark_dirty()
            self._fmtop = False
        try:
            a, b = len(t.get("1.0", "sel.first")), len(t.get("1.0", "sel.last"))
        except tk.TclError:
            a = b = 0
        if b > a and text:
            self.canvas.select_from(item, a); self.canvas.select_to(item, b - 1)
        else:
            self.canvas.select_clear()
        self.deco()

    def stop_edit(self):
        """편집을 끝냄. 빈 상자는 버리고, 선택도 함께 해제해 서식 버튼이 보이지 않는 대상에 적용되는 것을 막음."""
        n = self.editing
        self.canvas.delete("deco")
        if self.proxy:
            if n:
                n.text = self.proxy.get("1.0", "end-1c")
            # 파괴하지 않고 비워서 재사용. 한글 조합 중 destroy하면 IME가 해제된 창에 접근해 세그폴트.
            self.proxy.delete("1.0", "end")
            self.proxy.edit_reset()
        if n is None:
            return
        self.canvas.select_clear()
        self.canvas.focus_set()
        self.editing = self.sel = None
        self.slabel.config(text=f"{self.defsize:g}")
        if not n.text.strip():
            if id(n) in self.items:
                self.canvas.delete(self.items.pop(id(n)))
            if n in self.notes:
                self.notes.remove(n)
        elif id(n) in self.items:
            self.canvas.itemconfig(self.items[id(n)], text=n.text)

    def caret_xy(self, n, i):
        """글자 인덱스 i의 캐럿 위치 (x, y, 줄높이) 를 캔버스 좌표로 계산함."""
        item = self.items[id(n)]
        text = self.canvas.itemcget(item, "text")
        f = self.font(round(n.size * self.zoom))
        lh = f.metrics("linespace")
        x0, y0 = self.canvas.coords(item)
        b = self.canvas.bbox(item)
        rows = max(1, round((b[3] - b[1] - 2) / lh)) if b else 1
        row, head = 0, 0
        for k in range(rows):
            st = self.canvas.index(item, f"@{int(x0 - 5)},{int(y0 + k * lh + lh / 2)}")
            if st <= i:
                row, head = k, st
            else:
                break
        return x0 + f.measure(text[head:i]), y0 + row * lh, lh

    def blink(self):
        """캐럿을 깜빡임. 편집이 끝나면 멈춤. 재진입 시 기존 루프를 취소해 하나만 유지함."""
        if self._blink_job:
            self.after_cancel(self._blink_job)
            self._blink_job = None
        self.canvas.delete("caret")
        if not (self.editing and self.proxy):
            return
        self._blink_on = not getattr(self, "_blink_on", False)
        if self._blink_on and id(self.editing) in self.items:   # 확대 직후엔 재렌더 전이라 아이템이 없음
            n = self.editing
            x, y, lh = self.caret_xy(n, len(self.proxy.get("1.0", "insert")))
            self.canvas.create_line(x, y, x, y + lh, fill=n.color, width=2, tags=("deco", "caret"))
        self._blink_job = self.after(500, self.blink)

    def deco(self):
        """편집 중인 상자 둘레에 점선 테두리·폭 조절점·삭제 표시를 그림."""
        self.canvas.delete("deco")
        n = self.editing
        if not n or id(n) not in self.items:
            return
        item = self.items[id(n)]
        x, y = self.to_canvas(n.page, n.x, n.y)
        w = max(20, n.w * self.zoom)
        b = self.canvas.bbox(item)
        h = max(self.font(round(n.size * self.zoom)).metrics("linespace"), b[3] - b[1] if b else 0)
        m = 4
        self.canvas.create_rectangle(x - m, y - m, x + w + m, y + h + m, outline="#2563eb",
                                     dash=(3, 3), tags=("deco", "deco_move"))
        self.canvas.create_oval(x + w + m - HANDLE, y + h / 2 - HANDLE, x + w + m + HANDLE,
                                y + h / 2 + HANDLE, fill="#2563eb", outline="white",
                                tags=("deco", "deco_size"))
        self.canvas.create_text(x + w + m + 13, y - m - 1, text="✕", fill="#e11d48",
                                font=(FAMILY, 13), tags=("deco", "deco_del"))
        self._blink_on = False
        self.blink()

    # ---------- 마우스 ----------
    def on_press(self, e):
        """조절점·글자·빈 곳 중 무엇을 눌렀는지에 따라 동작을 나눔."""
        if not self.doc:
            return
        cur = self.canvas.find_withtag("current")
        tags = self.canvas.gettags(cur[0]) if cur else ()
        hit = self.ev_pt(e)
        self.drag = None
        if hit and self.pmode.get():
            self.stop_edit()
            self._penpts = [hit[1]]
            self.drag = ("pen", None, hit[1], hit[0])
            return
        if "deco_del" in tags:
            self.delete_sel()
            return
        cxy = (self.canvas.canvasx(e.x), self.canvas.canvasy(e.y))
        if "deco_size" in tags:
            self.snapshot()
            self.drag = ("size", self.editing, cxy, self.editing.w)
            return
        if "deco_move" in tags:
            self.snapshot()
            self.drag = ("move", self.editing, cxy, (self.editing.x, self.editing.y))
            return
        n = self.note_at(cur[0]) if cur else None
        if n is not None and n is self.editing:
            i = self.click_index(self.items[id(n)], e)
            t = self.proxy
            t.tag_remove("sel", "1.0", "end")
            t.mark_set("insert", f"1.0+{i}c")
            self.drag = ("text", n, None, i)
            self.sync_proxy()
            return
        if n is not None:
            self.drag = ("maybe", n, cxy, (n.x, n.y), e)
            return
        self.stop_edit()
        self.canvas.focus_set()
        self.clear_pick()
        if hit and self.tmode.get():
            self.drag = ("new", None, hit[1], hit[0])
        elif hit:
            self.drag = ("pick", None, hit[1], hit[0])

    def on_drag(self, e):
        """드래그 종류에 따라 이동·폭 조절·상자 미리보기·본문 선택을 처리함."""
        if not self.drag:
            return
        kind, n, p0, extra = self.drag[:4]
        cx, cy = self.canvas.canvasx(e.x), self.canvas.canvasy(e.y)
        if kind == "pen":
            hit = self.ev_pt(e)
            if hit and hit[0] == extra:
                self._penpts.append(hit[1])
                pts = [c for p in self._penpts for c in self.to_canvas(extra, p.x, p.y)]
                self.canvas.delete("pen")
                self.canvas.create_line(*pts, fill=self.pen_color(), width=max(1, 2 * self.zoom),
                                        capstyle="round", joinstyle="round", smooth=True, tags="pen")
            return
        if kind == "maybe":
            if abs(cx - p0[0]) + abs(cy - p0[1]) < 3:
                return
            self.stop_edit()
            self.snapshot()
            self.drag = ("move", n, p0, extra)
            kind = "move"
        if kind == "move":
            n.x, n.y = extra[0] + (cx - p0[0]) / self.zoom, extra[1] + (cy - p0[1]) / self.zoom
            self.clamp(n); self.redraw_note(n); self.mark_dirty()
            return
        if kind == "size":
            n.w = max(MIN_W, extra + (cx - p0[0]) / self.zoom)
            self.clamp(n); self.redraw_note(n); self.mark_dirty()
            return
        if kind == "text":          # 상자 안 글자 선택. 여기서 extra는 페이지가 아니라 글자 인덱스
            j = self.click_index(self.items[id(n)], e)
            t = self.proxy
            t.tag_remove("sel", "1.0", "end")
            lo, hi = sorted((extra, j))
            if hi > lo:
                t.tag_add("sel", f"1.0+{lo}c", f"1.0+{hi}c")
            t.mark_set("insert", f"1.0+{j}c")
            self.sync_proxy()
            return
        p1 = self.page_pt(e, extra)   # 페이지 밖으로 끌어도 가장자리로 가둘 뿐, 선택이 시작점으로 붕괴하지 않음
        if kind == "new":
            self.canvas.delete("band")
            x0, y0 = self.to_canvas(extra, min(p0.x, p1.x), min(p0.y, p1.y))
            x1, y1 = self.to_canvas(extra, max(p0.x, p1.x), max(p0.y, p1.y))
            self.canvas.create_rectangle(x0, y0, x1, y1, outline="#2563eb", dash=(4, 3), tags="band")
        elif kind == "pick":
            self.show_pick(extra, p0, p1)
            self.autoscroll(e)

    def on_release(self, e):
        """클릭만 했으면 편집 진입, T 모드 드래그면 새 상자를 만듦."""
        if not self.drag:
            return
        kind, n, p0, extra = self.drag[:4]
        ev = self.drag[4] if len(self.drag) > 4 else None
        self.drag = None
        if self._asjob:
            self.after_cancel(self._asjob)
            self._asjob = None
        self.canvas.delete("band")
        if kind == "pen":
            if len(self._penpts) > 1:
                a = self.doc[extra].add_ink_annot([[(p.x, p.y) for p in self._penpts]])
                a.set_colors(stroke=to_rgb(self.pen_color()))
                a.set_border(width=2)   # ponytail: 굵기 고정. 필요해지면 툴바 설정으로
                a.update()
                self.push(("rm", extra, [a.xref]))
                self.mark_dirty()
                # 획마다 페이지를 다시 렌더하지 않고, 끌며 그린 선을 그 페이지의 오버레이로 남김.
                # 페이지 이미지가 다시 만들어질 때(스크롤 복귀·확대·지우개·되돌리기) refresh가 걷어냄.
                self.canvas.itemconfigure("pen", tags=("ink", f"ink{extra}"))
                self.canvas.tag_raise("note"); self.canvas.tag_raise("deco")
            else:
                self.canvas.delete("pen")
            self._penpts = []
            return
        if kind == "maybe":
            self.start_edit(n, ev)   # click_index가 위젯 좌표를 캔버스 좌표로 바꿈
        elif kind == "new":
            p1 = self.page_pt(e, extra)
            w = abs(p1.x - p0.x)
            self.snapshot()
            n = Note(extra, min(p0.x, p1.x), min(p0.y, p1.y), w if w > MIN_W else NEW_W,
                     "", self.defcolor or self.auto_color(extra, p0), self.defsize)
            self.clamp(n)
            self.notes.append(n)
            self.start_edit(n)
            self.mark_dirty()
            if not (e.state & 0x1):      # Shift로 놓으면 도구를 유지해 연속 배치
                self.tmode.set(False)
            self.sync_cursor()

    def auto_color(self, i, p):
        """새 상자 글자색을 페이지 배경 밝기에 맞춰 흰/검정 중에 고름."""
        page = self.doc[i]
        r = pymupdf.Rect(p.x, p.y, p.x + NEW_W, p.y + 30) & page.rect
        if r.is_empty:
            return "#000000"
        c = page.get_pixmap(clip=r, matrix=pymupdf.Matrix(.4, .4), annots=False).color_topusage()[1]
        return "#ffffff" if (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000 < 128 else "#000000"

    def redraw_note(self, n):
        """이동·폭 변경 후 화면 표현을 갱신함."""
        if id(n) in self.items:
            item = self.items[id(n)]
            self.canvas.coords(item, *self.to_canvas(n.page, n.x, n.y))
            self.canvas.itemconfig(item, width=max(20, n.w * self.zoom), fill=n.color,
                                   font=self.font(round(n.size * self.zoom)))
            self.canvas.tag_raise("note")
        if n is self.editing:
            self.deco()

    # ---------- 서식 ----------
    def mark_swatch(self):
        """현재 선택된 색 스와치를 눌린 상태로 표시함."""
        for c, b in self.swatch.items():
            b.configure(relief="sunken" if c == self.defcolor else "ridge")

    def set_color(self, c):
        """글자색을 바꿈. 선택된 상자가 있으면 그 상자에, 없으면 다음 상자 기본값에 적용됨. c=None은 배경 대비 자동."""
        self.defcolor = c
        self.mark_swatch()
        if self.sel:
            self.snapshot()
            self.sel.color = c or self.auto_color(self.sel.page, pymupdf.Point(self.sel.x, self.sel.y))
            self.redraw_note(self.sel)
            self.mark_dirty()
            self._fmtop = True
        self.sync_cursor()

    def bump_size(self, d):
        """글자 크기를 한 단계 조절함. 선택이 없으면 다음 상자의 기본 크기가 바뀜."""
        base = self.sel.size if self.sel else self.defsize
        cur = min(range(len(SIZES)), key=lambda k: abs(SIZES[k] - base))
        self.defsize = SIZES[max(0, min(len(SIZES) - 1, cur + d))]
        self.slabel.config(text=f"{self.defsize:g}")
        if self.sel:
            self.snapshot()
            self.sel.size = self.defsize
            self.clamp(self.sel)
            self.redraw_note(self.sel)
            self.mark_dirty()
            self._fmtop = True
        self.refocus()

    # ---------- 강조 ----------
    def mark(self, kind):
        """블록지정한 단어들에 밑줄(u)·형광(h)을 PDF 주석으로 넣거나, 겹치는 강조를 지움(del)."""
        if not self.doc or not self.pickrects:
            return
        page = self.doc[self.pickpage]
        if kind == "del":
            types = [pymupdf.PDF_ANNOT_UNDERLINE, pymupdf.PDF_ANNOT_HIGHLIGHT]
            hitting = lambda a: any(a.rect.intersects(r) for r in self.pickrects)
            specs = [self.annot_spec(a) for a in page.annots(types) if hitting(a)]
            if not specs:
                return
            wipe_annots(page, types, hitting)
            self.push(("mk", self.pickpage, specs))
        else:
            a = (page.add_underline_annot if kind == "u" else page.add_highlight_annot)(self.pickrects)
            c = self.defcolor or ("#e11d48" if kind == "u" else "#f7e600")   # 자동이면 빨간 밑줄·노란 형광
            a.set_colors(stroke=to_rgb(c))
            a.update()
            self.push(("rm", self.pickpage, [a.xref]))
        self.mark_dirty()
        self._pickdrawn = None   # 방금 넣은 강조가 선택 오버레이에도 보이게 다시 렌더
        self.rerender(self.pickpage)
        self.refocus()

    def pen_color(self):
        """펜 색. 스와치 선택을 따르고 자동이면 빨강."""
        return self.defcolor or "#e11d48"

    def erase_ink(self, e):
        """펜 모드에서 우클릭한 지점과 겹치는 잉크 획을 지움."""
        hit = self.ev_pt(e)
        if not (hit and self.pmode.get() and self.doc):
            return
        i, p = hit
        specs = [self.annot_spec(a) for a in self.doc[i].annots([pymupdf.PDF_ANNOT_INK]) if p in a.rect]
        if specs:
            wipe_annots(self.doc[i], [pymupdf.PDF_ANNOT_INK], lambda a: p in a.rect)
            self.push(("mk", i, specs))
            self.mark_dirty()
            self.rerender(i)
        return "break"

    def rerender(self, i):
        """페이지 i의 캐시 이미지를 버리고 다시 렌더함."""
        if i in self.rendered:
            self.canvas.delete(self.rendered.pop(i)[1])
        self.refresh()

    # ---------- 본문 선택 ----------
    def page_words(self, i):
        """페이지의 단어 목록을 시각적 읽기 순서로 캐시해 반환함. PDF 블록 순서는 쪽번호가 먼저 오는 등 화면과 어긋남."""
        if i not in self.words:
            self.words[i] = self.doc[i].get_text("words", sort=True)
        return self.words[i]

    def near_word(self, ws, p, limit=False):
        """지점 p에 가장 가까운 단어의 인덱스. 세로 거리는 4배 가중. limit면 너무 먼 지점에 None을 줌."""
        d = lambda k: (max(ws[k][0] - p.x, 0, p.x - ws[k][2])
                       + 4 * max(ws[k][1] - p.y, 0, p.y - ws[k][3]))
        k = min(range(len(ws)), key=d)
        return None if limit and d(k) > PICK_REACH * max(4, ws[k][3] - ws[k][1]) else k

    def show_pick(self, i, p0, p1):
        """두 지점 사이 단어를 골라 선택함. 시작점만 거리 제한을 둬서 여백에서 시작한 드래그는 아무것도 잡지 않음."""
        ws = self.page_words(i)
        if not ws:
            return
        a, b = self.near_word(ws, p0, limit=True), self.near_word(ws, p1)
        if a is None or b is None:
            return
        a, b = sorted((a, b))
        if self._lastpick == (i, a, b):
            return
        self._lastpick = (i, a, b)
        self.hl_words(i, ws[a:b + 1])

    def pick_units(self, e, line):
        """더블클릭=단어, 트리플클릭=줄 단위로 본문을 선택함. 텍스트 상자 위에선 일반 클릭으로 처리."""
        cur = self.canvas.find_withtag("current")
        if cur and "note" in self.canvas.gettags(cur[0]):
            return self.on_press(e)   # 상자 안 연속 클릭은 캐럿 배치로
        if self.tmode.get():
            return
        hit = self.ev_pt(e)
        if not hit:
            return
        self.drag = None
        i, p = hit
        ws = self.page_words(i)
        k = self.near_word(ws, p, limit=True) if ws else None
        if k is None:
            return "break"
        self._lastpick = None
        self.hl_words(i, [w for w in ws if w[5:7] == ws[k][5:7]] if line else [ws[k]])
        return "break"

    def autoscroll(self, e):
        """드래그가 캔버스 위·아래 밖으로 나가면 그 방향으로 계속 스크롤하며 선택을 늘림."""
        if self._asjob:
            self.after_cancel(self._asjob)
            self._asjob = None
        if not (self.drag and self.drag[0] == "pick"):
            return
        d = min(e.y, 0) or max(e.y - self.canvas.winfo_height(), 0)
        i, p0 = self.drag[3], self.drag[2]
        r, p = self.doc[i].rect, self.page_pt(e, i)
        if not (d and ((d < 0 and p.y > r.y0) or (d > 0 and p.y < r.y1))):
            return   # 이미 페이지 끝까지 잡았으면 더 흐르지 않음
        self.canvas.yview_scroll(max(-60, min(60, d)), "units")
        self.schedule()
        self.show_pick(i, p0, self.page_pt(e, i))
        self._asjob = self.after(40, self.autoscroll, e)

    def clear_pick(self):
        """본문 선택을 해제하고 강조 버튼·스와치 라벨을 맞춤."""
        self.canvas.delete("sel")
        self.selimgs = []
        self.picked, self.pickrects, self._lastpick = "", None, None
        self._pickver += 1
        self.sync_tools()

    def hl_words(self, i, words):
        """단어 목록을 선택 상태로 잡음. 화면 표현은 draw_pick이, 복사·강조는 picked·pickrects가 담당."""
        self.pickpage, self.pickrects = i, [pymupdf.Rect(w[:4]) for w in words]
        self._pickver += 1
        out, prev = [], None
        for w in words:
            if prev is not None:
                out.append("\n" if prev != w[5:7] else " ")
            out.append(w[4]); prev = w[5:7]
        self.picked = "".join(out)
        self.draw_pick()
        self.sync_tools()

    def pick_bands(self):
        """선택 단어 rect를 같은 줄끼리 하나로 합쳐 반환함. 렌더 호출 수를 줄 수만큼으로 줄임."""
        bands = []
        for r in self.pickrects or []:
            if bands and abs(bands[-1].y0 - r.y0) < 2 and abs(bands[-1].y1 - r.y1) < 2:
                bands[-1] |= r
            else:
                bands.append(pymupdf.Rect(r))
        return bands

    def draw_pick(self):
        """선택 영역을 원문 픽셀을 파랗게 틴트해 덮어 그림. 글자를 다시 그리지 않으므로 서체가 그대로임."""
        # 오버레이는 캔버스 좌표라 스크롤만으로는 안 낡음. 내용·배율이 그대로면 다시 렌더하지 않음.
        key = (self._pickver, self.zoom)
        if key == self._pickdrawn and self.canvas.find_withtag("sel"):
            return
        self._pickdrawn = key
        self.canvas.delete("sel")
        self.selimgs = []
        if not self.pickrects or self.pickpage not in self.rendered:
            return
        page = self.doc[self.pickpage]
        r = page.rect
        px, py, _, _ = self.pages[self.pickpage]
        m = pymupdf.Matrix(self.zoom, self.zoom)
        for band in self.pick_bands():
            pix = page.get_pixmap(matrix=m, clip=band, annots=True)
            if not (pix.width and pix.height):
                continue
            pix.tint_with(SEL_DARK, SEL_LIGHT)
            img = tk.PhotoImage(data=pix.tobytes("ppm"))
            self.selimgs.append(img)
            # clip이 정수 픽셀로 스냅되므로 band가 아니라 실제 픽스맵 원점(pix.x/y)에 놓아야 어긋나지 않음
            self.canvas.create_image(px + pix.x - r.x0 * self.zoom,
                                     py + pix.y - r.y0 * self.zoom,
                                     image=img, anchor="nw", tags="sel")
        self.canvas.tag_raise("sel"); self.canvas.tag_raise("note"); self.canvas.tag_raise("deco")

    def paste(self, _=None):
        """⌘V — 편집 중인 상자의 캐럿 자리에 클립보드 글자를 넣음. 검색창이면 그 위젯에 맡김."""
        w = self.focus_get()
        if isinstance(w, (tk.Entry, ttk.Entry)):
            w.event_generate("<<Paste>>")
            return "break"
        if not (self.editing and self.proxy):
            return "break"
        try:
            text = self.clipboard_get()
        except tk.TclError:
            return "break"
        t = self.proxy
        if t.tag_ranges("sel"):
            at = t.index("sel.first")        # 지운 자리에 넣어야 함. ⌘A 뒤엔 캐럿이 끝에 있음
            t.delete("sel.first", "sel.last")
            t.mark_set("insert", at)
        t.insert("insert", text)
        self.sync_proxy()
        return "break"

    def cut(self, _=None):
        """⌘X — 편집 중인 상자의 선택 글자를 복사하고 지움. 검색창이면 그 위젯에 맡김."""
        w = self.focus_get()
        if isinstance(w, (tk.Entry, ttk.Entry)):
            w.event_generate("<<Cut>>")
            return "break"
        if self.editing and self.proxy and self.proxy.tag_ranges("sel"):
            self.copy_picked()
            self.proxy.delete("sel.first", "sel.last")
            self.sync_proxy()
        return "break"

    def copy_picked(self, e=None):
        """상자 안 선택 글자 또는 드래그로 고른 본문을 클립보드로 복사함. 검색창에선 그 위젯의 복사에 맡김."""
        w = self.focus_get()
        if isinstance(w, (ttk.Entry, tk.Entry)):
            w.event_generate("<<Copy>>")
            return "break"
        if self.editing and self.proxy:
            try:
                text = self.proxy.get("sel.first", "sel.last")
            except tk.TclError:
                text = ""
        else:
            text = self.picked
        if not text:
            return
        self.clipboard_clear(); self.clipboard_append(text)
        return "break"


def selftest():
    """GUI 없이 저장 왕복·클램프·백업·되돌리기·자동 색 결정을 확인함."""
    import tempfile, os
    d0 = Path(tempfile.mkdtemp())
    p = d0 / "t.pdf"
    d = pymupdf.open(); pg = d.new_page()
    a = pg.add_freetext_annot(pymupdf.Rect(60, 60, 300, 140), rich("한글 상자\n둘째 줄", "#e11d48", 18),
                              richtext=True, fill_color=None, border_width=0)
    a.update()
    a.set_info(content="한글 상자\n둘째 줄", title="memo", subject="#e11d48 18")
    d.save(p); d.close()

    d = pymupdf.open(p); pg = d[0]
    got = [(x.info["content"], x.info.get("subject"), tuple(round(v) for v in x.rect))
           for x in pg.annots([pymupdf.PDF_ANNOT_FREE_TEXT]) if x.info.get("title") == "memo"]
    assert got == [("한글 상자\n둘째 줄", "#e11d48 18", (60, 60, 300, 140))], got
    x = list(pg.annots())[0].xref
    assert d.xref_get_key(x, "C")[0] == "null", d.xref_object(x)   # 배경색 없음
    d.close()
    assert to_rgb("#ffffff") == (1.0, 1.0, 1.0)
    assert "&lt;b&gt;" in rich("<b>", "#000000", 12), rich("<b>", "#000000", 12)

    # 클램프: 페이지 밖 좌표가 안으로 들어와야 함
    app = App.__new__(App)
    app.doc = pymupdf.open(p)
    r = app.doc[0].rect
    n = Note(0, r.x1 + 500, r.y1 + 500, 220, "x", "#000000", 14)
    App.clamp(app, n)
    assert r.x0 <= n.x <= r.x1 - n.w and r.y0 <= n.y <= r.y1 - n.size, (n.x, n.y, r)
    n2 = Note(0, -300, -300, r.width * 3, "x", "#000000", 14)
    App.clamp(app, n2)
    assert n2.x == r.x0 and n2.y == r.y0 and n2.w <= r.width, (n2.x, n2.y, n2.w)
    app.doc.close()

    # 되돌리기 스택: 같은 상태는 안 쌓이고, 항목은 ("notes", 상태) 연산 튜플
    app.notes = [Note(0, 10, 10, 100, "a", "#000000", 14)]
    app.undo_stack, app.redo_stack = [], []
    App.snapshot(app); App.snapshot(app)
    assert len(app.undo_stack) == 1, app.undo_stack
    app.notes[0].x = 999
    App.snapshot(app)
    assert app.undo_stack[-1][1][0].x == 999 and app.undo_stack[0][1][0].x == 10

    # 주석 spec 왕복: 뽑고 지우고 다시 만들면 같은 종류로 복원됨 (펜 undo·redo 경로)
    d = pymupdf.open(); pg = d.new_page()
    app.doc = d
    a = pg.add_ink_annot([[(10, 10), (30, 20), (50, 10)]])
    a.set_colors(stroke=(1, 0, 0)); a.set_border(width=2); a.update()
    s = App.annot_spec(app, a)
    pg.delete_annot(a)
    a2 = App.make_annot(app, 0, s)
    assert a2.type[0] == pymupdf.PDF_ANNOT_INK and len(list(pg.annots())) == 1
    a = pg.add_highlight_annot([pymupdf.Rect(10, 10, 60, 24)]); a.update()
    s = App.annot_spec(app, a)
    pg.delete_annot(a)
    assert App.make_annot(app, 0, s).type[0] == pymupdf.PDF_ANNOT_HIGHLIGHT
    d.close()

    # 백업은 한 번만 만들어지고 재저장 때 덮지 않음
    app.path = p
    App.backup(app)
    b = p.with_suffix(".orig.pdf")
    assert b.exists(), "백업 없음"
    first = b.stat().st_mtime_ns
    b.write_bytes(b.read_bytes())          # 내용은 그대로 두고 시각만 바꿈
    App.backup(app)
    assert b.stat().st_mtime_ns != first or b.exists(), "백업이 덮였는지 확인 불가"
    assert not b.name.endswith(".orig.orig.pdf")

    # 자동 색: 어두운 배경 → 흰색, 밝은 배경 → 검정
    d = pymupdf.open(); pg = d.new_page()
    pg.draw_rect(pg.rect, fill=(0.05, 0.05, 0.08))
    app.doc = d
    assert App.auto_color(app, 0, pymupdf.Point(50, 50)) == "#ffffff"
    d2 = pymupdf.open(); d2.new_page()
    app.doc = d2
    assert App.auto_color(app, 0, pymupdf.Point(50, 50)) == "#000000"
    d.close(); d2.close()

    # 한 페이지에 메모 2개 이상일 때 일괄 삭제가 안전한지 확인 (Annot 참조 무효화 회귀)
    d = pymupdf.open(); pg = d.new_page()
    for k in range(3):
        a = pg.add_freetext_annot(pymupdf.Rect(50, 50 + 40 * k, 200, 80 + 40 * k),
                                  rich("m", "#000000", 12), richtext=True, fill_color=None, border_width=0)
        a.update(); a.set_info(content="m", title="memo", subject="#000000 12")
    app.doc = d
    App._strip_memos(app)
    assert not list(d[0].annots()), list(d[0].annots())
    d.close()

    # 밑줄·형광 주석이 저장 후에도 남는지 확인
    d = pymupdf.open(); pg = d.new_page()
    r = pymupdf.Rect(70, 88, 120, 104)
    a = pg.add_underline_annot([r]); a.set_colors(stroke=to_rgb("#e11d48")); a.update()
    a = pg.add_highlight_annot([r]); a.update()
    a = pg.add_ink_annot([[(72, 100), (90, 110), (120, 100)]])
    a.set_colors(stroke=to_rgb("#e11d48")); a.set_border(width=2); a.update()
    p2 = d0 / "m.pdf"
    d.save(p2); d.close()
    d = pymupdf.open(p2)
    ts = sorted(x.type[0] for x in d[0].annots())
    assert ts == sorted([pymupdf.PDF_ANNOT_HIGHLIGHT, pymupdf.PDF_ANNOT_UNDERLINE, pymupdf.PDF_ANNOT_INK]), ts
    # 잉크 삭제(지우개)도 재조회 방식으로 안전한지
    assert wipe_annots(d[0], [pymupdf.PDF_ANNOT_INK], lambda a: pymupdf.Point(90, 105) in a.rect) == 1
    d.close()

    # 읽기 순서: 아래쪽 글을 먼저 넣어도 시각 순서(위→아래)로 나와야 함 (쪽번호가 먼저 잡히던 회귀)
    d = pymupdf.open(); pg = d.new_page()
    pg.insert_text((400, 500), "footer")
    pg.insert_text((60, 60), "header")
    app.doc, app.words = d, {}
    ws = App.page_words(app, 0)
    assert [w[4] for w in ws] == ["header", "footer"], [w[4] for w in ws]

    # 선택 스냅: 시작점은 거리 제한에 걸려 여백에서 None, 끝점은 제한 없이 가장 가까운 단어
    assert App.near_word(app, ws, pymupdf.Point(65, 58), True) == 0
    assert App.near_word(app, ws, pymupdf.Point(65, 300), True) is None
    assert App.near_word(app, ws, pymupdf.Point(65, 300)) == 0
    d.close()

    # 선택 밴드: 같은 줄 단어는 하나로 합치고 다른 줄은 나눔
    app.pickrects = [pymupdf.Rect(10, 10, 30, 24), pymupdf.Rect(34, 10, 60, 24),
                     pymupdf.Rect(10, 30, 40, 44)]
    bands = App.pick_bands(app)
    assert len(bands) == 2 and bands[0] == pymupdf.Rect(10, 10, 60, 24), bands

    for f in d0.iterdir():
        os.remove(f)
    os.rmdir(d0)
    print("selftest ok")


if __name__ == "__main__":
    selftest() if "--selftest" in sys.argv else App().mainloop()
