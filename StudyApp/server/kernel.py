"""StudyApp 코드 실행기. 강의 하나당 프로세스 하나가 떠서 셀을 노트북처럼 차례로 실행함.

프로토콜: stdin 한 줄에 JSON 요청 {"id", "kind": "sql"|"python", "code", "isolate"?} 하나, stdout 한 줄에 JSON 응답 하나.
사용자 코드의 print는 따로 잡아 응답에 담으므로 프로토콜 줄과 섞이지 않음.
응답: {"id", "ok", "stdout", "outputs": [...], "error"?, "ms"}
  outputs 항목: {"type": "table", "columns", "rows", "total"} | {"type": "text", "text"} | {"type": "image", "png"(base64)}
"""
import ast
import base64
import io
import json
import os
import sys
import time
import traceback
import contextlib

os.environ.setdefault("MPLBACKEND", "Agg")
PROTO = sys.stdout                      # 응답 전용. 사용자 print는 아래에서 가로챔
MAX_ROWS = 200
MAX_TEXT = 20000

ns = {"__name__": "__main__", "DATA": os.environ.get("STUDYAPP_DATA", os.getcwd())}
con = None                              # DuckDB 연결은 SQL을 처음 쓸 때 만듦


def cell(v):
    """표 칸 하나를 JSON으로 보낼 수 있는 값으로 바꿈"""
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if isinstance(v, float):
        return v if v == v and abs(v) != float("inf") else str(v)
    return str(v)


def table(columns, rows, total=None):
    rows = [[cell(x) for x in r] for r in rows[:MAX_ROWS]]
    return {"type": "table", "columns": [str(c) for c in columns], "rows": rows, "total": total if total is not None else len(rows)}


def show(value):
    """마지막 식의 값을 Jupyter처럼 보여 줌. DataFrame/Series는 표, 나머지는 repr"""
    try:
        import pandas as pd
        if isinstance(value, pd.DataFrame):
            head = value.head(MAX_ROWS)
            idx = head.index.name or ""
            cols = [idx] + [str(c) for c in head.columns]
            rows = [[i] + list(r) for i, r in zip(head.index, head.itertuples(index=False))]
            return table(cols, rows, len(value))
        if isinstance(value, pd.Series):
            return show(value.to_frame())
    except ImportError:
        pass
    text = repr(value)
    return {"type": "text", "text": text[:MAX_TEXT] + ("\n…" if len(text) > MAX_TEXT else "")}


def figures():
    """그려 둔 matplotlib 그림을 PNG로 꺼내고 닫음"""
    if "matplotlib.pyplot" not in sys.modules:
        return []
    import matplotlib.pyplot as plt
    out = []
    for num in plt.get_fignums():
        buf = io.BytesIO()
        plt.figure(num).savefig(buf, format="png", dpi=110, bbox_inches="tight")
        out.append({"type": "image", "png": base64.b64encode(buf.getvalue()).decode()})
    plt.close("all")
    return out


def run_python(code):
    outputs = []
    tree = ast.parse(code, mode="exec")
    last = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last = ast.Expression(tree.body.pop().value)
    exec(compile(tree, "<cell>", "exec"), ns)
    if last is not None:
        value = eval(compile(last, "<cell>", "eval"), ns)
        if value is not None:
            outputs.append(show(value))
    return outputs


def run_sql(code, isolate=False, prelude="", postlude=""):
    """isolate면 셀이 바꾼 내용을 끝나고 되돌림(슬라이드마다 같은 기본 데이터에서 시작).
    prelude는 결과를 버리고 먼저 실행, postlude는 셀 뒤에 실행해 '실행 뒤' 표로 붙임(DML 결과 보여 주기)"""
    global con
    import duckdb
    if con is None:
        con = duckdb.connect(":memory:")
        ns["con"] = con
    if isolate:
        con.execute("BEGIN TRANSACTION")
        try:
            return run_sql(code, False, prelude, postlude)
        finally:
            try:
                con.execute("ROLLBACK")
            except Exception:
                pass
    if prelude.strip():
        run_sql_plain(prelude)
    outputs = run_sql_plain(code)
    if postlude.strip():
        after = [o for o in run_sql_plain(postlude) if o["type"] == "table"]
        for o in after:
            o["label"] = "실행 뒤"
        outputs = [o for o in outputs if not (o["type"] == "text" and o["text"] == "실행 완료" and after)] + after
    return outputs


def run_sql_plain(code):
    outputs = []
    import duckdb
    for stmt in duckdb.extract_statements(code):
        cur = con.execute(stmt)
        if cur.description:
            cols = [d[0] for d in cur.description]
            rows = cur.fetchmany(MAX_ROWS + 1)
            more = len(rows) > MAX_ROWS
            outputs.append(table(cols, rows, f"{MAX_ROWS}+" if more else len(rows)))
    if not outputs:
        outputs.append({"type": "text", "text": "실행 완료"})
    return outputs


def handle(req):
    out, err = io.StringIO(), io.StringIO()
    started = time.time()
    res = {"id": req.get("id"), "ok": True, "outputs": []}
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            if req.get("kind") == "sql":
                res["outputs"] = run_sql(req.get("code", ""), bool(req.get("isolate")), req.get("prelude") or "", req.get("postlude") or "")
            else:
                if (req.get("prelude") or "").strip():
                    run_python(req["prelude"])
                res["outputs"] = run_python(req.get("code", ""))
                if (req.get("postlude") or "").strip():
                    after = run_python(req["postlude"])
                    for o in after:
                        o["label"] = "실행 뒤"
                    res["outputs"] += after
            res["outputs"] += figures()
    except Exception as e:  # 사용자 코드의 오류는 응답으로 돌려줌
        res["ok"] = False
        if req.get("kind") == "sql":            # SQL은 Python 추적 대신 DuckDB 메시지만
            res["error"] = str(e)[-MAX_TEXT:]
            res["outputs"] += figures()
            res["stdout"] = (out.getvalue() + err.getvalue())[-MAX_TEXT:]
            res["ms"] = int((time.time() - started) * 1000)
            return res
        tb = traceback.format_exception(type(e), e, e.__traceback__)
        # 실행기 내부 프레임은 빼고 셀 부분만 남김
        tb = [t for t in tb if 'kernel.py' not in t]
        res["error"] = "".join(tb)[-MAX_TEXT:]
        res["outputs"] += figures()
    res["stdout"] = (out.getvalue() + err.getvalue())[-MAX_TEXT:]
    res["ms"] = int((time.time() - started) * 1000)
    return res


def main():
    PROTO.write(json.dumps({"ready": True}) + "\n")
    PROTO.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        PROTO.write(json.dumps(handle(req), ensure_ascii=False) + "\n")
        PROTO.flush()


if __name__ == "__main__":
    main()
