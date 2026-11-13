import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { ModuleDocumentDetail, ModuleJob, ModuleJobResult, ModuleStatus } from "../../shared/agent";
import { AgentPanel } from "./AgentPanel";
import { Inline, Markdown } from "./Markdown";
import { documentErrorText, errorText, jobErrorText, moduleApi } from "./moduleApi";
import { href } from "./route";
import { TAG_LABEL } from "./SlideRow";
import { ToolbarSlot, useModalFocus } from "./Toolbar";
import { useWrites } from "./useWrites";

// 등록한 자료 읽기: 원본 쪽 + 게시된 해설(또는 jobId가 있으면 검토할 후보 해설) + 이 자료를 출처로 한 대화
const POLL_MS = 2000;
const SAVE_DELAY = 800;

function useMedia(query: string) {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}

export function ModuleDocumentView({ documentId, jobId }: { documentId: string; jobId?: string }) {
  const [detail, setDetail] = useState<ModuleDocumentDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<ModuleStatus | null>(null);
  const [job, setJob] = useState<ModuleJob | null>(null);
  const [candidate, setCandidate] = useState<ModuleJobResult | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState(1);
  const [ready, setReady] = useState(false);              // 저장된 읽기 위치를 반영한 뒤부터 진도를 저장
  const seen = useRef(new Set<number>());
  const compact = useMedia("(max-width: 960px)");
  const [agentOpen, setAgentOpen] = useState(() => !matchMedia("(max-width: 960px)").matches);
  const [agentMounted, setAgentMounted] = useState(agentOpen);   // 한 번 연 대화는 닫아도 남겨 둠(받는 중인 답과 쓰던 질문 유지)
  useEffect(() => { if (agentOpen) setAgentMounted(true); }, [agentOpen]);
  const agentRef = useRef<HTMLDivElement>(null);
  const agentButton = useRef<HTMLButtonElement>(null);
  const ids = useId();

  // 문서·쪽·게시된 해설과 읽기 진도
  useEffect(() => {
    const ac = new AbortController();
    setLoadError(null);
    Promise.all([moduleApi.document(documentId, ac.signal), moduleApi.progress(documentId, ac.signal)]).then(([d, progress]) => {
      setDetail(d);
      if (!ready) {
        for (const p of progress.seen) seen.current.add(p);
        const count = d.pages.length || d.document.pageCount || 1;
        if (progress.lastPage && progress.lastPage <= count) setPage(progress.lastPage);
        setReady(true);
      }
    }, (e) => { if ((e as Error).name !== "AbortError") setLoadError(errorText(e)); });
    moduleApi.status(ac.signal).then(setStatus, () => {});
    return () => ac.abort();
    // ready는 처음 한 번만 진도를 반영하려는 표시라 의존성에서 뺌
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, reload]);

  // PDF 쪽 추출이 끝날 때까지 문서를 다시 받음
  const processing = detail?.document.status === "processing";
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(() => {
      if (!document.hidden) moduleApi.document(documentId).then(setDetail, () => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [processing, documentId]);

  // 검토할 작업과 후보 해설
  useEffect(() => {
    setJob(null);
    setCandidate(null);
    setJobError(null);
    if (!jobId) return;
    const ac = new AbortController();
    let timer = 0;
    const load = async () => {
      try {
        const j = await moduleApi.job(jobId, ac.signal);
        if (j.documentId !== documentId) { setJobError("이 작업은 다른 자료의 작업이에요."); return; }
        setJob(j);
        if (j.status === "completed" && j.hasResult) {
          setCandidate(await moduleApi.jobResult(jobId, ac.signal));
        } else if (j.status === "queued" || j.status === "running") {
          timer = window.setTimeout(load, POLL_MS);
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") setJobError(errorText(e));
      }
    };
    void load();
    return () => { ac.abort(); clearTimeout(timer); };
  }, [jobId, documentId, reload]);

  const pageCount = detail ? detail.pages.length || detail.document.pageCount || 0 : 0;
  const reviewing = !!jobId;
  const pack = reviewing ? candidate?.pack ?? null : detail?.pack ?? null;
  const review = (reviewing ? candidate?.review : detail?.review) ?? {};
  const reviewPages = useMemo(() => Object.keys(review).map(Number).filter(Number.isFinite).sort((a, b) => a - b), [review]);

  const go = useCallback((p: number) => {
    if (!pageCount) return;
    setPage(Math.min(Math.max(1, Math.round(p)), pageCount));
  }, [pageCount]);

  // 읽기 진도 저장: 마지막 쪽과 본 쪽 전체. 쪽을 빠르게 넘길 때는 멈춘 뒤 한 번만 보냄.
  // 실패하면 마지막 의도(그때의 쪽·본 쪽 목록)를 남겨 두고 화면에 알려 다시 보낼 수 있게 함
  const writes = useWrites();
  const persist = writes.persist;
  const unsaved = useRef<{ lastPage: number; seen: number[] } | null>(null);   // 아직 보내지 않은 진도
  useEffect(() => {
    if (!ready || !pageCount) return;
    seen.current.add(page);
    const update = { lastPage: page, seen: [...seen.current].sort((a, b) => a - b) };
    unsaved.current = update;
    const timer = setTimeout(() => {
      unsaved.current = null;
      persist("progress", () => moduleApi.saveProgress(documentId, update));
    }, SAVE_DELAY);
    return () => clearTimeout(timer);
  }, [page, ready, pageCount, documentId, persist]);

  // 쪽을 넘기자마자 화면을 떠나거나 창을 닫아도 마지막 위치는 보냄(keepalive, 결과는 기다리지 않음)
  useEffect(() => {
    const flush = () => {
      const update = unsaved.current;
      if (!update) return;
      unsaved.current = null;
      moduleApi.saveProgress(documentId, update, true).catch(() => {});
    };
    addEventListener("pagehide", flush);
    return () => {
      removeEventListener("pagehide", flush);
      flush();
    };
  }, [documentId]);

  const modal = agentOpen && compact;

  // 화살표로 쪽 넘기기. 입력 중이거나 대화 창이 화면을 덮고 있을 때는 건드리지 않음
  useEffect(() => {
    if (modal) return;
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === "ArrowRight") { e.preventDefault(); go(page + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(page - 1); }
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [go, page, modal]);

  // 좁은 화면에서는 대화가 화면 전체를 덮는 창이 됨: 초점을 창 안에 가두고, 뒤 화면 스크롤을 막고, Esc로 닫음
  const closeAgent = useCallback(() => {
    setAgentOpen(false);
    requestAnimationFrame(() => agentButton.current?.focus());
  }, []);
  useModalFocus(modal, agentRef);
  useEffect(() => {
    if (!modal) return;
    const html = document.documentElement;
    const before = html.style.overflow;
    html.style.overflow = "hidden";
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); closeAgent(); } };
    addEventListener("keydown", on);
    return () => {
      html.style.overflow = before;
      removeEventListener("keydown", on);
    };
  }, [modal, closeAgent]);

  const publish = async () => {
    if (!job || acting) return;
    if (detail?.document.published && !confirm("지금 게시된 해설이 이 후보 해설로 바뀌어요. 게시할까요?")) return;
    setActing(true);
    setActionError(null);
    try {
      const r = await moduleApi.publish(documentId, job.id);
      setDetail((d) => d && { ...d, document: r.document, pack: r.pack, review: r.review });
      location.hash = href.document(documentId);
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setActing(false);
    }
  };

  const jobAction = async (action: () => Promise<ModuleJob>) => {
    if (acting) return;
    setActing(true);
    setActionError(null);
    try {
      const next = await action();
      if (next.id !== jobId) location.hash = href.document(documentId, next.id);
      else setReload((n) => n + 1);
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setActing(false);
    }
  };

  const jumpSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = Number(new FormData(e.currentTarget).get("page"));
    if (Number.isFinite(value)) go(value);
  };

  if (loadError) {
    return (
      <div className="mod-page">
        <div className="mod-notice warn" role="alert">
          <p>자료를 불러오지 못했어요. {loadError}</p>
          <div className="mod-actions">
            <button type="button" className="mod-btn" onClick={() => setReload((n) => n + 1)}>다시 불러오기</button>
            <a className="mod-btn" href={href.library()}>자료 관리로 돌아가기</a>
          </div>
        </div>
      </div>
    );
  }
  if (!detail) return <div className="mod-page"><p className="mod-muted" role="status">자료를 불러오는 중이에요</p></div>;

  const doc = detail.document;
  const pageInfo = detail.pages.find((p) => p.page === page);
  const slide = pack?.slides.find((s) => s.page === page) ?? null;
  const beatIndex = pack ? pack.story.findIndex((b) => b.from <= page && page <= b.to) : -1;
  const beat = beatIndex >= 0 ? pack!.story[beatIndex] : null;
  const note = review[String(page)];
  const canGenerate = !!status?.configured && status.capabilities.generation;
  const jobActive = job && (job.status === "queued" || job.status === "running");
  const live = !!job && doc.published?.jobId === job.id;   // 지금 게시된 해설이 이 작업의 결과인지(문서 기준)

  return (
    <div className={`mod-doc${agentOpen ? " agent-open" : ""}${compact ? " compact" : ""}`}>
      <ToolbarSlot><span className="where"><b>{doc.title}</b></span></ToolbarSlot>
      <article className="mod-reader" aria-label={doc.title}>
        <nav className="mod-crumb" aria-label="위치">
          <a href={href.library()}>자료 관리</a><span aria-hidden="true"> / </span><span>{doc.title}</span>
        </nav>

        {reviewing && (
          <section className={`mod-review-banner${job?.status === "failed" ? " err" : ""}`} aria-label="후보 해설 검토">
            {jobError ? (
              <>
                <p role="alert">작업 상태를 확인하지 못했어요. {jobError}</p>
                <div className="mod-actions">
                  <button type="button" className="mod-btn" onClick={() => setReload((n) => n + 1)}>다시 확인</button>
                  <a className="mod-btn" href={href.library()}>자료 관리로</a>
                </div>
              </>
            ) : !job ? (
              <p className="mod-muted" role="status">작업 상태를 확인하는 중이에요</p>
            ) : jobActive ? (
              <>
                <p><strong>해설을 만드는 중이에요.</strong> {job.progress.pagesDone}/{job.progress.pagesTotal}쪽 · {job.progress.message}</p>
                <div className="mod-actions">
                  <button type="button" className="mod-btn" disabled={acting} onClick={() => void jobAction(() => moduleApi.cancelJob(job.id))}>작업 취소</button>
                </div>
              </>
            ) : job.status === "completed" && candidate ? (
              <>
                <p>
                  <strong>{live ? "지금 게시된 해설이에요." : job.publishedAt ? "이전에 게시했던 해설이에요." : "검토 중인 후보 해설이에요."}</strong>{" "}
                  {live ? "자료를 읽는 화면에 이 내용이 보여요." : "게시하면 지금 보이는 해설이 이 내용으로 바뀌어요."}
                  {reviewPages.length ? ` 확인이 필요한 쪽이 ${reviewPages.length}곳 있어요.` : ""}
                </p>
                {job.warnings.length > 0 && (
                  <details className="mod-warn-list"><summary>생성 중 남긴 주의할 점 {job.warnings.length}개</summary>
                    <ul>{job.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                  </details>
                )}
                <div className="mod-actions">
                  {!live && (
                    <button type="button" className="mod-btn primary" disabled={acting} onClick={() => void publish()}>
                      {acting ? "게시하는 중" : "이 해설 게시하기"}
                    </button>
                  )}
                  <a className="mod-btn" href={href.document(documentId)}>{doc.published ? "게시된 해설 보기" : "원본만 보기"}</a>
                </div>
              </>
            ) : job.status === "completed" ? (
              job.hasResult
                ? <p className="mod-muted" role="status">후보 해설을 불러오는 중이에요</p>
                : <p role="alert">작업은 끝났지만 저장된 후보 해설이 없어요. 자료 관리에서 다시 생성해 주세요.</p>
            ) : (
              <>
                <p><strong>{job.status === "failed" ? "해설을 만들지 못했어요." : "작업을 취소했어요."}</strong> {jobErrorText(job.error) ?? "원본은 그대로 남아 있어요."}</p>
                <div className="mod-actions">
                  <button type="button" className="mod-btn" disabled={!canGenerate || acting}
                    title={canGenerate ? undefined : "해설 생성은 서버에 모델 API를 설정한 뒤 쓸 수 있어요."}
                    onClick={() => void jobAction(() => moduleApi.retryJob(job.id))}>다시 생성</button>
                  <a className="mod-btn" href={href.library()}>자료 관리로</a>
                </div>
              </>
            )}
            {actionError && <p className="mod-err" role="alert">{actionError}</p>}
          </section>
        )}

        {doc.status === "processing" ? (
          <div className="mod-notice" role="status"><p>PDF에서 쪽과 그림을 꺼내고 있어요. 끝나면 이 화면에 바로 보여요.</p></div>
        ) : doc.status === "failed" ? (
          <div className="mod-notice warn" role="alert">
            <p>{documentErrorText(doc.error)}</p>
            <a className="mod-btn" href={href.library()}>자료 관리로 돌아가기</a>
          </div>
        ) : (
          <>
            {writes.failedCount > 0 && (
              <div className="mod-notice warn" role="alert">
                <p>읽은 위치를 저장하지 못했어요. 연결을 확인한 뒤 다시 저장해 주세요.</p>
                <button type="button" className="mod-btn" onClick={writes.retry}>다시 저장</button>
              </div>
            )}
            <div className="mod-pager">
              <span className="mod-pill" aria-live="polite">{page} / {pageCount}쪽</span>
              <button type="button" className="mod-btn" onClick={() => go(page - 1)} disabled={page <= 1}>이전 쪽</button>
              <button type="button" className="mod-btn" onClick={() => go(page + 1)} disabled={page >= pageCount}>다음 쪽</button>
              <form className="mod-jump" onSubmit={jumpSubmit}>
                <label htmlFor={`${ids}-jump`} className="mod-sr">이동할 쪽</label>
                <input id={`${ids}-jump`} key={page} name="page" className="mod-input" type="number" inputMode="numeric"
                  min={1} max={pageCount} defaultValue={page} />
                <button type="submit" className="mod-btn">이동</button>
              </form>
              <span className="mod-muted mode">{pack ? (reviewing ? "원본 + 후보 해설" : "원본 + 해설") : "원본"}</span>
            </div>

            <h1 id={`${ids}-title`} className="mod-title">{slide ? <Inline text={slide.title} /> : doc.title}</h1>
            {beat && (
              <p className="mod-beat-ref">
                <span className="n">{beatIndex + 1}</span>
                <span><Inline text={beat.title} /></span>
                <span className="r">{beat.from === beat.to ? `${beat.from}쪽` : `${beat.from}–${beat.to}쪽`}</span>
              </p>
            )}

            <figure className="mod-sheet" style={doc.aspect ? { aspectRatio: String(doc.aspect) } : undefined}>
              {pageInfo
                ? <img src={pageInfo.imageUrl} alt={`${page}쪽 원본`} decoding="async" />
                : <figcaption className="mod-muted">이 쪽 이미지를 찾지 못했어요</figcaption>}
            </figure>

            {note && (
              <div className="mod-uncertain" role="note">
                <strong>확인이 필요해요</strong>
                <p><Inline text={note} /></p>
              </div>
            )}

            {slide ? (
              <section className="mod-explain" aria-label={`${page}쪽 해설`}>
                <span className={`mod-tag ${slide.tag}`}>{TAG_LABEL[slide.tag]}</span>
                <div className="explain"><Markdown text={slide.explain} untrusted /></div>
              </section>
            ) : pack ? (
              <p className="mod-muted">이 쪽에는 해설이 없어요.</p>
            ) : !reviewing && (
              <div className="mod-notice">
                <p>아직 게시된 해설이 없어요. 자료 관리에서 해설을 만들고 검토한 뒤 게시하면 여기에 보여요.</p>
                <a className="mod-btn" href={href.library()}>자료 관리로</a>
              </div>
            )}

            {beat && beat.from === page && (
              <section className="mod-beat" aria-label="이 구간의 흐름">
                <h2><Inline text={beat.title} /></h2>
                <dl>
                  <dt>문제</dt><dd><Inline text={beat.problem} /></dd>
                  <dt>해결</dt><dd><Inline text={beat.answer} /></dd>
                  {beat.tradeoff && <><dt>trade-off</dt><dd><Inline text={beat.tradeoff} /></dd></>}
                  {beat.extra && <><dt>보충</dt><dd><Inline text={beat.extra} /></dd></>}
                </dl>
                {beat.bridge && <p className="bridge"><Inline text={beat.bridge} /></p>}
              </section>
            )}

            {pageInfo?.text && (
              <details className="mod-pagetext">
                <summary>이 쪽에서 읽은 글</summary>
                <p>{pageInfo.text}</p>
              </details>
            )}

            {reviewPages.length > 0 && (
              <nav className="mod-review-pages" aria-label="확인이 필요한 쪽">
                <span className="mod-muted">확인이 필요한 쪽</span>
                {reviewPages.map((p) => (
                  <button key={p} type="button" className="mod-chip" aria-current={p === page ? "page" : undefined} onClick={() => go(p)}>{p}쪽</button>
                ))}
              </nav>
            )}

            {pack && page === 1 && (
              <p className="mod-question"><span className="mod-muted">이 자료의 질문</span><Inline text={pack.question} /></p>
            )}
          </>
        )}

        {doc.status === "ready" && (
          <div className="mod-bottom">
            <button ref={agentButton} type="button" className={`mod-btn${agentOpen ? "" : " primary"}`}
              aria-expanded={agentOpen} aria-controls={`${ids}-agent`}
              onClick={() => (agentOpen ? closeAgent() : setAgentOpen(true))}>
              {agentOpen ? "에이전트 닫기" : "이 쪽 질문하기"}
            </button>
          </div>
        )}
      </article>

      {agentMounted && doc.status === "ready" && (
        <div id={`${ids}-agent`} ref={agentRef} className="mod-doc-agent" tabIndex={-1} hidden={!agentOpen}
          role={compact ? "dialog" : "complementary"} aria-modal={(compact && agentOpen) || undefined} aria-label="학습 에이전트">
          <AgentPanel source={{ kind: "document", documentId }} title={doc.title} page={page}
            onNavigate={(p) => { go(p); if (compact) closeAgent(); }} onClose={closeAgent} />
        </div>
      )}
    </div>
  );
}
