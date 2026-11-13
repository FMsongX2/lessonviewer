#!/usr/bin/env python3
# content/<course>/prev-notes.<lecture>.json (이미지를 보고 확정한 판정과 "올해 달라진 점")을 prev.json 에 합침.
# 판정은 {"<올해 쪽>": {"kind": "same|changed|new", "prev": 작년 쪽|null, "diff": "..."}}. 합친 노트 파일은 지움.
# 실행: ../.venv/bin/python scripts/prev-merge.py <course> [--keep]

import json, sys
from pathlib import Path

APP = Path(__file__).resolve().parent.parent


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    keep = "--keep" in sys.argv
    if not args:
        sys.exit("사용법: prev-merge.py <course> [--keep]")
    course = args[0]
    path = APP / "content" / course / "prev.json"
    prev = json.loads(path.read_text())
    for notes_path in sorted((APP / "content" / course).glob("prev-notes.*.json")):
        lec = notes_path.name.split(".")[1]
        info = prev[lec]
        notes = json.loads(notes_path.read_text())
        for page, n in notes.items():
            kind, old = n["kind"], n.get("prev")
            if kind not in ("same", "changed", "new") or (kind != "new" and not old) or (kind == "new" and old):
                sys.exit(f"{notes_path.name} p.{page}: kind/prev가 맞지 않음 {n}")
            e = {"page": old if kind != "new" else None, "kind": kind}
            if n.get("diff"):
                e["diff"] = n["diff"].strip()
            info["pages"][page] = e
        used = {e["page"] for e in info["pages"].values() if e.get("page")}
        total = len(list((APP / "data" / "slides" / course / lec / "prevall").glob("*.jpg")))
        info["removed"] = [j for j in range(1, total + 1) if j not in used]
        c = {}
        for e in info["pages"].values():
            c[e["kind"]] = c.get(e["kind"], 0) + 1
        print(f"{course}/{lec}: 노트 {len(notes)}쪽 합침 → {c}, 작년에만 있음 {len(info['removed'])}쪽")
        if not keep:
            notes_path.unlink()
    # 노트에 없는 쪽 중 짝이 아예 없는 쪽은 올해 추가로 표시
    for lec, info in prev.items():
        n = json.loads((APP / "data" / "extract" / course / f"{lec}.json").read_text())["pageCount"]
        for i in range(1, n + 1):
            info["pages"].setdefault(str(i), {"page": None, "kind": "new"})
        info["pages"] = dict(sorted(info["pages"].items(), key=lambda kv: int(kv[0])))
    path.write_text(json.dumps(prev, ensure_ascii=False, indent=1) + "\n")


if __name__ == "__main__":
    main()
