#!/usr/bin/env python3
# 올해 슬라이드와 작년 자료의 같은 내용 쪽을 짝지어 content/<course>/prev.json 에 씀.
# 쪽 텍스트의 글자 3-gram 코사인 유사도로 순서를 지키는 정렬(DP)을 하고, 텍스트가 없는 쪽은 앞뒤 기준쪽 사이에서 위치로 짝지음.
# kind: same(유사도 0.85 이상) / changed(0.35 이상, 내용이 바뀜) / pos(텍스트가 거의 없어 위치로만 짝지음) / 짝이 없으면 올해 추가.
# 실행: ../.venv/bin/python scripts/prev-map.py   (courses.json 의 prevFile 이 있는 강의만)

import collections, json, math, re
from pathlib import Path
import pymupdf

APP = Path(__file__).resolve().parent.parent
CONFIG = json.loads((APP / "courses.json").read_text())
ROOT = (APP / CONFIG["materialsRoot"]).resolve()
SAME, MIN = 0.85, 0.35


def norm(s):
    return re.sub(r"[\s\W_]+", "", s)


def grams(s, n=3):
    s = norm(s)
    return collections.Counter(s[i:i + n] for i in range(len(s) - n + 1))


def cos(a, b):
    if not a or not b:
        return 0.0
    d = sum(v * b.get(k, 0) for k, v in a.items())
    return d / math.sqrt(sum(v * v for v in a.values()) * sum(v * v for v in b.values()))


def align(S, N, M):
    dp = [[0.0] * (M + 1) for _ in range(N + 1)]
    bk = [[None] * (M + 1) for _ in range(N + 1)]
    for i in range(1, N + 1):
        for j in range(1, M + 1):
            best, b = dp[i - 1][j], "u"
            if dp[i][j - 1] > best:
                best, b = dp[i][j - 1], "l"
            v = dp[i - 1][j - 1] + S[i - 1][j - 1] if S[i - 1][j - 1] > MIN else -1
            if v > best:
                best, b = v, "d"
            dp[i][j], bk[i][j] = best, b
    i, j, pair = N, M, {}
    while i > 0 and j > 0:
        if bk[i][j] == "d":
            pair[i] = j
            i, j = i - 1, j - 1
        elif bk[i][j] == "u":
            i -= 1
        else:
            j -= 1
    return pair


def main():
    out = {}
    for course in CONFIG["courses"]:
        for lec in course["lectures"]:
            if not lec.get("prevFile"):
                continue
            base = ROOT / course["dir"] / lec["file"]
            new_pdf = base.with_name(base.name + ".orig.pdf")
            if not new_pdf.exists():
                new_pdf = base.with_name(base.name + ".pdf")
            old_pdf = ROOT / course["dir"] / (lec["prevFile"] + ".pdf")
            ndoc, odoc = pymupdf.open(new_pdf), pymupdf.open(old_pdf)
            nt, ot = [p.get_text() for p in ndoc], [p.get_text() for p in odoc]
            ng, og = [grams(t) for t in nt], [grams(t) for t in ot]
            N, M = len(ng), len(og)
            S = [[cos(a, b) for b in og] for a in ng]
            pair = align(S, N, M)
            kinds = {i: ("same" if S[i - 1][j - 1] >= SAME else "changed") for i, j in pair.items()}
            # 기준쪽 사이의 빈 구간: 올해·작년 쪽 수가 같으면 위치로 짝지음
            anchors = [(0, 0)] + sorted(pair.items()) + [(N + 1, M + 1)]
            for (i1, j1), (i2, j2) in zip(anchors, anchors[1:]):
                if i2 - i1 > 1 and i2 - i1 == j2 - j1:
                    for k in range(1, i2 - i1):
                        i, j = i1 + k, j1 + k
                        pair[i] = j
                        kinds[i] = "pos"
            used = set(pair.values())
            pages = {str(i): {"page": j, "kind": kinds[i], "score": round(S[i - 1][j - 1], 3)} for i, j in sorted(pair.items())}
            out.setdefault(course["id"], {})[lec["id"]] = {
                "source": lec["prevFile"], "pages": pages,
                "removed": [j for j in range(1, M + 1) if j not in used],   # 작년에만 있던 쪽
            }
            c = collections.Counter(v["kind"] for v in pages.values())
            print(f"{course['id']}/{lec['id']}: 올해 {N}쪽 중 same {c['same']}, changed {c['changed']}, pos {c['pos']}, 추가 {N - len(pair)} / 작년 {M}쪽 중 올해에 없음 {M - len(used)}")
    for cid, lecs in out.items():
        (APP / "content" / cid / "prev.json").write_text(json.dumps(lecs, ensure_ascii=False, indent=1) + "\n")


if __name__ == "__main__":
    main()
