#!/usr/bin/env python3
# content/<course>/fix.<part>.json (작년 자료 기준으로 다시 쓴 해설·diff·확인 필요)을 pack, prev.json, review.json 에 합침.
# 형식: {"<올해 쪽>": {"kind": "changed|same|new", "prev": 작년 쪽|null, "title"?, "explain", "diff", "review"?}}. 파트 파일 이름의 챕터는 앞 4글자(ch02a → ch02).
# 실행: ../.venv/bin/python scripts/prev-fix.py <course> [--keep]

import json, re, sys
from pathlib import Path

APP = Path(__file__).resolve().parent.parent


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    keep = "--keep" in sys.argv
    if not args:
        sys.exit("사용법: prev-fix.py <course> [--keep]")
    course = args[0]
    cdir = APP / "content" / course
    prev = json.loads((cdir / "prev.json").read_text())
    review_path = cdir / "review.json"
    review = json.loads(review_path.read_text()) if review_path.exists() else {}
    for fix_path in sorted(cdir.glob("fix.*.json")):
        part = fix_path.name.split(".")[1]
        ch = part[:4]
        pack_path = cdir / f"{ch}.json"
        pack = json.loads(pack_path.read_text())
        slides = {s["page"]: s for s in pack["slides"]}
        fixes = json.loads(fix_path.read_text())
        count = {}
        for page, f in fixes.items():
            kind, old = f["kind"], f.get("prev")
            if kind not in ("same", "changed", "new") or (kind != "new" and not old) or (kind == "new" and old):
                sys.exit(f"{fix_path.name} p.{page}: kind/prev가 맞지 않음 {kind} {old}")
            s = slides[int(page)]
            if f.get("explain"):
                s["explain"] = f["explain"].strip()
            if f.get("title"):
                s["title"] = f["title"].strip()
            e = {"page": old if kind != "new" else None, "kind": kind}
            if f.get("diff"):
                e["diff"] = f["diff"].strip()
            prev[ch]["pages"][page] = e
            if f.get("review"):
                review.setdefault(ch, {})[page] = f["review"].strip()
            count[kind] = count.get(kind, 0) + 1
        prev[ch]["pages"] = dict(sorted(prev[ch]["pages"].items(), key=lambda kv: int(kv[0])))
        pack_path.write_text(json.dumps(pack, ensure_ascii=False, indent=2) + "\n")
        print(f"{ch} ({part}): {len(fixes)}쪽 합침 {count}")
        if not keep:
            fix_path.unlink()
    for ch, info in prev.items():
        used = {e["page"] for e in info["pages"].values() if e.get("page")}
        total = len(list((APP / "data" / "slides" / course / ch / "prevall").glob("*.jpg")))
        info["removed"] = [j for j in range(1, total + 1) if j not in used]
    (cdir / "prev.json").write_text(json.dumps(prev, ensure_ascii=False, indent=1) + "\n")
    review_path.write_text(json.dumps(review, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
