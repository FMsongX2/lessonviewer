import { useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { LabCell, RunOutput, RunResult } from "../../shared/types";
import { api } from "./api";

// 해설 속 코드 블록 하나를 실행할 수 있게 감쌈. 고쳐 보기를 누르면 코드를 바꿔서 돌려 볼 수 있음
export function RunCell({ course, lecture, index, cell, original, pre }: {
  course: string; lecture: string; index: number; cell: LabCell; original: string; pre: ReactNode;
}) {
  const [draft, setDraft] = useState<string | null>(null);     // null이면 고치지 않은 원래 코드
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const editing = draft !== null;

  const run = async () => {
    if (running) return;
    setRunning(true);
    setFailure(null);
    try { setResult(await api.run(course, lecture, index, editing ? draft : undefined)); }
    catch (e) { setFailure(String(e instanceof Error ? e.message : e)); }
    finally { setRunning(false); }
  };

  const edit = () => {
    setDraft(cell.code ?? original);
    requestAnimationFrame(() => area.current?.focus());
  };

  if (cell.skip) {
    return (
      <div className="cell skip">
        {pre}
        <p className="cell-bar"><span className="cell-note">이건 실행하지 않는 코드야. {cell.skip}</span></p>
      </div>
    );
  }

  return (
    <div className={`cell${editing ? " editing" : ""}${running ? " running" : ""}`}>
      {editing ? (
        <textarea ref={area} className="cell-code" value={draft} spellCheck={false}
          rows={Math.min(24, Math.max(3, draft.split("\n").length + 1))}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey || e.shiftKey)) { e.preventDefault(); run(); }
            if (e.key === "Tab") {
              e.preventDefault();
              const t = e.currentTarget, { selectionStart: a, selectionEnd: b } = t;
              setDraft(t.value.slice(0, a) + "  " + t.value.slice(b));
              requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = a + 2; });
            }
          }} />
      ) : pre}

      <div className="cell-bar">
        <button className="run" onClick={run} disabled={running} title={editing ? "실행 (⌘↩ 또는 ⇧↩)" : "실행"}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z" fill="currentColor" /></svg>
          {running ? "실행 중" : "실행"}
        </button>
        {editing
          ? <button className="ghost" onClick={() => setDraft(null)}>원래 코드로</button>
          : <button className="ghost" onClick={edit}>고쳐 보기</button>}
        {cell.code && !editing && <span className="cell-note">슬라이드 코드를 바로 돌릴 수 있게 다듬은 코드로 실행해.</span>}
        {result && !running && <span className="cell-time">{result.ms < 1000 ? `${result.ms}ms` : `${(result.ms / 1000).toFixed(1)}초`}</span>}
      </div>
      {cell.note && <p className="cell-memo">{cell.note}</p>}

      <AnimatePresence initial={false}>
        {(result || failure) && (
          <motion.div className={`out${result && !result.ok ? " bad" : ""}`} key="out"
            initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
            {failure && <pre className="out-error">{failure}</pre>}
            {result?.ran && result.ran.length > 0 && (
              <p className="out-ran">앞 셀(p.{result.ran.join(", p.")})을 먼저 차례로 실행했어.</p>
            )}
            {result?.stdout && <pre className="out-text">{result.stdout}</pre>}
            {result?.outputs.map((o, i) => <Output key={i} o={o} />)}
            {result?.error && cell.expectError && <p className="out-ran">이 오류가 바로 이 슬라이드에서 보려던 결과야!</p>}
            {result?.error && <pre className="out-error">{result.error.trim()}</pre>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Output({ o }: { o: RunOutput }) {
  if (o.type === "image") return <img className="out-img" src={`data:image/png;base64,${o.png}`} alt="실행 결과 그림" />;
  if (o.type === "text") return <pre className="out-text">{o.text}</pre>;
  return (
    <div className="table-wrap out-table">
      {o.label && <p className="out-label">{o.label}</p>}
      <table>
        <thead><tr>{o.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
        <tbody>
          {o.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={v === null ? "null" : typeof v === "number" ? "num" : undefined}>{v === null ? "NULL" : String(v)}</td>)}</tr>)}
        </tbody>
      </table>
      <p className="out-count">{o.rows.length === 0 ? "결과 행이 없어" : String(o.total) !== String(o.rows.length) ? `${o.total}행 중 앞 ${o.rows.length}행` : `${o.total}행`}</p>
    </div>
  );
}
