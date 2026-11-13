import { useCallback, useEffect, useId, useRef, useState, type DragEvent, type FormEvent, type ReactElement } from "react";
import type { ModuleDocument, ModuleJob, ModuleStatus } from "../../shared/agent";
import { documentErrorText, errorText, jobErrorText, ModuleApiError, moduleApi } from "./moduleApi";
import { href } from "./route";
import { ToolbarSlot } from "./Toolbar";

// 자료 관리: PDF 등록, 해설 생성 작업, 후보 검토로 가는 길. 게시는 검토 화면에서만 함
const POLL_MS = 2000;

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)}MB`;
const when = (t: number | null) => t ? new Date(t).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
const isActive = (j: ModuleJob) => j.status === "queued" || j.status === "running";

const STAGE: Record<ModuleJob["progress"]["stage"], string> = {
  queued: "차례를 기다리는 중", pages: "쪽마다 해설을 쓰는 중", story: "전체 흐름을 엮는 중", validate: "결과를 확인하는 중", done: "마무리",
};
const JOB_LABEL: Record<ModuleJob["status"], string> = {
  queued: "대기 중", running: "생성 중", completed: "검토 대기", failed: "생성 실패", cancelled: "취소됨",
};

function JobProgress({ job }: { job: ModuleJob }) {
  const { pagesDone, pagesTotal, stage, message } = job.progress;
  const pct = pagesTotal ? Math.round((pagesDone / pagesTotal) * 100) : 0;
  return (
    <div className="mod-progress">
      <div className="mod-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={pagesTotal || 100}
        aria-valuenow={pagesTotal ? pagesDone : undefined} aria-valuetext={`${STAGE[stage]} ${pagesDone}/${pagesTotal}쪽`}>
        <span style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
      <small>{STAGE[stage]}{pagesTotal ? ` · ${pagesDone}/${pagesTotal}쪽` : ""}{message ? ` · ${message}` : ""}</small>
    </div>
  );
}

type Busy = Record<string, boolean>;

export function ModuleLibrary() {
  const [status, setStatus] = useState<ModuleStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<ModuleDocument[] | null>(null);
  const [jobs, setJobs] = useState<ModuleJob[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>({});
  const [reload, setReload] = useState(0);

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const ids = useId();

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [docs, jobList] = await Promise.all([moduleApi.documents(signal), moduleApi.jobs(undefined, signal)]);
    setDocuments(docs);
    setJobs([...jobList].sort((a, b) => b.createdAt - a.createdAt));
    setLoadError(null);
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    moduleApi.status(ac.signal).then((s) => { setStatus(s); setStatusError(null); }, (e) => {
      if ((e as Error).name !== "AbortError") setStatusError(errorText(e));
    });
    refresh(ac.signal).catch((e) => { if ((e as Error).name !== "AbortError") setLoadError(errorText(e)); });
    return () => ac.abort();
  }, [refresh, reload]);

  // 쪽 추출이나 생성이 진행 중일 때만 주기적으로 새로 받음. 창이 가려져 있으면 쉼
  const pending = !!documents?.some((d) => d.status === "processing") || jobs.some(isActive);
  useEffect(() => {
    if (!pending) return;
    let stop = false;
    let timer = 0;
    const tick = async () => {
      if (!document.hidden) await refresh().catch(() => {});
      if (!stop) timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    return () => { stop = true; clearTimeout(timer); };
  }, [pending, refresh]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    if (busy[key]) return;
    setBusy((b) => ({ ...b, [key]: true }));
    setActionError(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      if (e instanceof ModuleApiError && e.code === "conflict") {
        setActionError("이 자료는 이미 해설을 만들고 있어요. 진행 중인 작업을 확인해 주세요.");
        await refresh().catch(() => {});
      } else setActionError(errorText(e));
    } finally {
      setBusy((b) => { const next = { ...b }; delete next[key]; return next; });
    }
  };

  const limits = status?.limits;
  const pick = (f: File | null | undefined) => {
    setUploadError(null);
    if (!f) return;
    if (f.type !== "application/pdf" && !/\.pdf$/i.test(f.name)) {
      setUploadError("PDF 파일만 등록할 수 있어요.");
      return;
    }
    if (limits && f.size > limits.maxFileBytes) {
      setUploadError(`파일이 ${mb(f.size)}예요. ${mb(limits.maxFileBytes)} 이하로 줄여서 올려 주세요.`);
      return;
    }
    setFile(f);
    setTitle((t) => t.trim() ? t : f.name.replace(/\.pdf$/i, ""));
    requestAnimationFrame(() => titleRef.current?.focus());
  };

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      const doc = await moduleApi.upload(file, title.trim() || file.name.replace(/\.pdf$/i, ""));
      setDocuments((list) => [doc, ...(list ?? []).filter((d) => d.id !== doc.id)]);
      setFile(null);
      setTitle("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (err) {
      setUploadError(errorText(err));
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files[0]);
  };

  const canGenerate = !!status?.configured && status.capabilities.generation;
  const generateHint = !status ? "" : !status.configured
    ? "해설 생성은 서버에 모델 API를 설정한 뒤 쓸 수 있어요."
    : !status.capabilities.generation ? "지금 연결된 모델은 해설 생성을 지원하지 않아요." : "";
  // 지금 게시된 해설의 출처 작업. 이전에 게시했다가 바뀐 작업은 게시됨으로 보이지 않게 문서 기준으로 판단
  const liveJobs = new Set((documents ?? []).flatMap((d) => d.published ? [d.published.jobId] : []));

  const remove = (doc: ModuleDocument) => {
    if (!confirm(`'${doc.title}'을(를) 삭제할까요? 원본 PDF와 생성한 해설, 대화가 함께 지워져요.`)) return;
    void run(`del-${doc.id}`, () => moduleApi.deleteDocument(doc.id));
  };

  const row = (doc: ModuleDocument) => {
    const job = jobs.find((j) => j.documentId === doc.id);   // jobs는 최신순
    let state: { text: string; tone: string; note: string };
    if (doc.status === "processing") state = { text: "쪽 읽는 중", tone: "run", note: "PDF에서 쪽과 그림을 꺼내고 있어요" };
    else if (doc.status === "failed") state = { text: "등록 실패", tone: "err", note: documentErrorText(doc.error) };
    else if (job && isActive(job)) state = { text: JOB_LABEL[job.status], tone: "run", note: "" };
    else if (job?.status === "completed" && !liveJobs.has(job.id)) state = { text: "검토 대기", tone: "ok", note: "후보 해설을 확인한 뒤 게시해 주세요" };
    else if (job && (job.status === "failed" || job.status === "cancelled") && !doc.published)
      state = { text: JOB_LABEL[job.status], tone: job.status === "failed" ? "err" : "", note: jobErrorText(job.error) ?? "원본은 그대로 남아 있어요" };
    else if (doc.published) state = { text: "게시됨", tone: "ok", note: `${when(doc.published.at)} 게시` };
    else state = { text: "해설 없음", tone: "", note: "원본을 읽거나 해설을 만들 수 있어요" };

    const actions: ReactElement[] = [];
    const genBtn = (label: string) => (
      <button key="gen" type="button" className="mod-btn" disabled={!canGenerate || busy[`gen-${doc.id}`]}
        title={generateHint || undefined} onClick={() => void run(`gen-${doc.id}`, () => moduleApi.createJob(doc.id))}>
        {busy[`gen-${doc.id}`] ? "요청 중" : label}
      </button>
    );
    if (doc.status === "ready") {
      if (job && isActive(job)) {
        actions.push(
          <button key="cancel" type="button" className="mod-btn" disabled={busy[`cancel-${job.id}`]}
            onClick={() => void run(`cancel-${job.id}`, () => moduleApi.cancelJob(job.id))}>작업 취소</button>,
        );
      } else if (job?.status === "completed" && !liveJobs.has(job.id) && job.hasResult) {
        actions.push(<a key="review" className="mod-btn primary" href={href.document(doc.id, job.id)}>해설 검토</a>);
      } else if (job && (job.status === "failed" || job.status === "cancelled")) {
        actions.push(
          <button key="retry" type="button" className="mod-btn" disabled={!canGenerate || busy[`retry-${job.id}`]}
            title={generateHint || undefined} onClick={() => void run(`retry-${job.id}`, () => moduleApi.retryJob(job.id))}>
            {busy[`retry-${job.id}`] ? "요청 중" : "다시 생성"}
          </button>,
        );
      } else {
        actions.push(genBtn(doc.published ? "새로 생성" : "해설 생성"));
      }
      actions.push(<a key="read" className="mod-btn" href={href.document(doc.id)}>{doc.published ? "읽기" : "원본 보기"}</a>);
    }
    if (doc.status !== "processing" && !(job && isActive(job))) {
      actions.push(
        <button key="del" type="button" className="mod-btn ghost" disabled={busy[`del-${doc.id}`]} onClick={() => remove(doc)}
          aria-label={`${doc.title} 삭제`}>삭제</button>,
      );
    }

    return (
      <li key={doc.id} className="mod-row">
        <div className="mod-row-main">
          {doc.status === "ready"
            ? <a className="mod-row-title" href={href.document(doc.id)}>{doc.title}</a>
            : <span className="mod-row-title">{doc.title}</span>}
          <small>{doc.fileName} · {mb(doc.bytes)} · {when(doc.createdAt)} 등록</small>
          {job && isActive(job) ? <JobProgress job={job} /> : state.note && <small className={state.tone === "err" ? "mod-err" : undefined}>{state.note}</small>}
        </div>
        <span className="mod-row-pages">{doc.pageCount != null ? `${doc.pageCount}쪽` : "-"}</span>
        <span className={`mod-state ${state.tone}`}>{state.text}</span>
        <div className="mod-row-actions">{actions}</div>
      </li>
    );
  };

  return (
    <div className="mod-page mod-library">
      <ToolbarSlot><span className="where"><b>자료 관리</b></span></ToolbarSlot>
      <div className="mod-headline">
        <div>
          <h1>내 자료를 학습 자료로</h1>
          <p className="mod-muted">원본은 보존하고, 생성한 해설은 검토한 뒤 게시해요.</p>
        </div>
        <span className={`mod-pill ${status?.configured ? "ok" : statusError ? "err" : ""}`} role="status">
          {statusError ? "서버 상태 확인 실패" : !status ? "연결 상태 확인 중" : status.configured ? `모델 API 연결됨 · ${status.model}` : "모델 API 미설정"}
        </span>
      </div>

      <form className={`mod-upload${dragging ? " drag" : ""}`} onSubmit={upload}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
        <div className="mod-upload-text">
          <strong>{file ? file.name : "PDF 파일을 선택해 등록하세요"}</strong>
          <span className="mod-muted">
            {file ? `${mb(file.size)} · 제목을 확인하고 등록해 주세요`
              : limits ? `최대 ${mb(limits.maxFileBytes)} · ${limits.maxPages}쪽 · 원문과 그림을 함께 읽어요` : "원문과 그림을 함께 읽어요"}
          </span>
        </div>
        <input ref={fileRef} id={`${ids}-file`} className="mod-sr" type="file" accept="application/pdf,.pdf"
          onChange={(e) => pick(e.target.files?.[0])} />
        {file && (
          <div className="mod-field">
            <label htmlFor={`${ids}-title`}>자료 제목</label>
            <input ref={titleRef} id={`${ids}-title`} className="mod-input" value={title} maxLength={200}
              onChange={(e) => setTitle(e.target.value)} />
          </div>
        )}
        <div className="mod-upload-actions">
          <button type="button" className="mod-btn" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {file ? "다른 파일 선택" : "파일 선택"}
          </button>
          {file && <button type="submit" className="mod-btn primary" disabled={uploading}>{uploading ? "올리는 중" : "PDF 등록"}</button>}
        </div>
        {uploadError && <p className="mod-err" role="alert">{uploadError}</p>}
      </form>

      {actionError && (
        <div className="mod-notice warn" role="alert">
          <p>{actionError}</p>
          <button type="button" className="mod-btn ghost" onClick={() => setActionError(null)}>닫기</button>
        </div>
      )}

      <section className="mod-table" aria-labelledby={`${ids}-docs`}>
        <h2 id={`${ids}-docs`} className="mod-sr">등록한 자료</h2>
        <div className="mod-row head" aria-hidden="true">
          <span>자료</span><span>쪽 수</span><span>상태</span><span>작업</span>
        </div>
        {loadError ? (
          <div className="mod-empty" role="alert">
            <p>자료 목록을 불러오지 못했어요. {loadError}</p>
            <button type="button" className="mod-btn" onClick={() => setReload((n) => n + 1)}>다시 불러오기</button>
          </div>
        ) : documents === null ? (
          <p className="mod-empty mod-muted" role="status">자료 목록을 불러오는 중이에요</p>
        ) : documents.length === 0 ? (
          <div className="mod-empty">
            <p>아직 등록한 자료가 없어요. PDF를 올리면 여기에 보여요.</p>
            <button type="button" className="mod-btn primary" onClick={() => fileRef.current?.click()}>PDF 선택</button>
          </div>
        ) : (
          <ul className="mod-rows">{documents.map(row)}</ul>
        )}
      </section>

      {jobs.length > 0 && (
        <section className="mod-jobs" aria-labelledby={`${ids}-jobs`}>
          <h2 id={`${ids}-jobs`}>생성 작업</h2>
          <ul>
            {jobs.map((job) => (
              <li key={job.id} className="mod-job">
                <div className="mod-job-main">
                  <strong>{documents?.find((d) => d.id === job.documentId)?.title ?? "삭제된 자료"}</strong>
                  <small className="mod-muted">
                    {when(job.createdAt)} 요청{job.finishedAt ? ` · ${when(job.finishedAt)} 종료` : ""}
                    {job.retryOf ? " · 다시 생성한 작업" : ""}
                    {job.usage.calls ? ` · 모델 호출 ${job.usage.calls}회, 토큰 ${(job.usage.inputTokens + job.usage.outputTokens).toLocaleString()}` : ""}
                  </small>
                  {isActive(job) && <JobProgress job={job} />}
                  {job.error && <small className="mod-err">{jobErrorText(job.error)}</small>}
                  {job.warnings.length > 0 && (
                    <details className="mod-warn-list">
                      <summary>주의할 점 {job.warnings.length}개</summary>
                      <ul>{job.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                    </details>
                  )}
                </div>
                <span className={`mod-state ${job.status === "failed" ? "err" : job.status === "completed" ? "ok" : isActive(job) ? "run" : ""}`}>
                  {liveJobs.has(job.id) ? "게시됨" : job.publishedAt ? "이전 게시" : JOB_LABEL[job.status]}
                </span>
                <div className="mod-row-actions">
                  {isActive(job) && (
                    <button type="button" className="mod-btn" disabled={busy[`cancel-${job.id}`]}
                      onClick={() => void run(`cancel-${job.id}`, () => moduleApi.cancelJob(job.id))}>작업 취소</button>
                  )}
                  {job.status === "completed" && job.hasResult && (
                    <a className="mod-btn" href={href.document(job.documentId, job.id)}>{liveJobs.has(job.id) ? "결과 보기" : "해설 검토"}</a>
                  )}
                  {(job.status === "failed" || job.status === "cancelled") && (
                    <button type="button" className="mod-btn" disabled={!canGenerate || busy[`retry-${job.id}`]} title={generateHint || undefined}
                      onClick={() => void run(`retry-${job.id}`, () => moduleApi.retryJob(job.id))}>다시 생성</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(statusError || (status && !canGenerate)) && (
        <div className="mod-notice" role="note">
          <p><strong>{statusError ? "서버 상태를 확인하지 못했어요" : "모델 API가 설정되지 않았다면"}</strong></p>
          <p>자료 등록과 기존 해설 읽기는 계속 쓸 수 있어요. 해설 생성과 대화는 서버의 모델 API 설정이 필요해요. API 키는 브라우저에 저장하지 않아요.</p>
          {statusError && <button type="button" className="mod-btn" onClick={() => setReload((n) => n + 1)}>다시 확인</button>}
        </div>
      )}
    </div>
  );
}
