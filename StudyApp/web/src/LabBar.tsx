import { useState } from "react";
import type { Lab } from "../../shared/types";
import { api } from "./api";

const KERNEL: Record<Lab["kernel"], string> = { sql: "SQL · DuckDB", python: "Python" };

// 강의 머리에 붙는 실습 안내: 어떤 데이터로 돌리는지, 노트북으로 열기, 실행 환경 초기화
export function LabBar({ course, lecture, lab }: { course: string; lecture: string; lab: Lab }) {
  const [msg, setMsg] = useState<string | null>(null);
  const runnable = lab.cells.filter((c) => !c.skip).length;
  const say = (m: string) => { setMsg(m); setTimeout(() => setMsg((cur) => (cur === m ? null : cur)), 4000); };

  return (
    <section className="labbar" aria-label="코드 실습">
      <div className="labbar-head">
        <span className="kernel">{KERNEL[lab.kernel]}</span>
        <p>이 강의 코드 {runnable}개는 해설 안에서 바로 실행해 볼 수 있어! 고쳐서 돌려 봐도 원본은 그대로야.</p>
      </div>
      <p className="labbar-data"><b>데이터</b> {lab.data}</p>
      <div className="labbar-actions">
        <button onClick={() => api.notebook(course, lecture).then(() => say("VS Code에서 노트북을 열었어. 커널은 StudyApp (.venv)를 골라 줘!")).catch((e) => say(String(e.message ?? e)))}>
          노트북으로 열기
        </button>
        <button onClick={() => api.resetLab(course, lecture).then(() => say("실행 환경을 처음 상태로 돌렸어.")).catch((e) => say(String(e.message ?? e)))}>
          실행 환경 초기화
        </button>
        {msg && <span className="labbar-msg" role="status">{msg}</span>}
      </div>
    </section>
  );
}
