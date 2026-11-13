import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ModuleChatMessage, ModuleChatSource, ModuleCitation, ModuleConversation, ModuleStatus } from "../../shared/agent";
import { Markdown } from "./Markdown";
import { ModuleApiError, errorText, moduleApi, sourceKey, streamChat } from "./moduleApi";

type Props = {
  source: ModuleChatSource;
  title: string;                       // 지금 보는 자료 이름
  page: number;                        // 지금 보는 쪽. 질문과 함께 보냄
  onNavigate: (page: number) => void;  // 근거 쪽으로 이동
  onClose?: () => void;
};

type ToolStep = { name: "search_source" | "read_page"; query?: string; page?: number };
// 받는 중인 답. 서버가 meta를 보내면 질문이 저장된 것
type Draft = { prompt: string; accepted: boolean; text: string; tools: ToolStep[]; citations: ModuleCitation[] };
type Failure = { prompt: string; message: string; canRetry: boolean };

const chatError = (code: string, fallback: string) => {
  switch (code) {
    case "not_configured": return "서버에 모델 API가 설정되지 않아 답할 수 없어요. 관리자가 API 키를 설정하면 쓸 수 있어요.";
    case "busy": return "이전 질문의 답을 아직 정리하고 있어요. 잠시 뒤 다시 보내 주세요.";
    case "auth": return "모델 API 인증에 실패했어요. 서버의 API 키 설정을 확인해 주세요.";
    case "rate_limit": return "모델 API 요청이 잠시 많아요. 조금 뒤 다시 보내 주세요.";
    case "budget": return "이 질문에 쓸 수 있는 처리량을 넘었어요. 질문을 좁혀서 다시 보내 주세요.";
    case "bad_request": return "모델이 이 요청을 받지 않았어요. 질문을 바꿔 다시 보내 주세요.";
    case "server": return "모델 API 서버에 문제가 생겼어요. 잠시 뒤 다시 보내 주세요.";
    case "network": return "모델 API에 연결하지 못했어요. 잠시 뒤 다시 보내 주세요.";
    case "protocol": return "모델 응답을 해석하지 못했어요. 다시 보내 주세요.";
    case "internal": return "답을 만드는 중에 서버 오류가 생겼어요. 다시 보내 주세요.";
    default: return /[가-힣]/.test(fallback) ? fallback : "답을 받지 못했어요. 잠시 뒤 다시 보내 주세요.";
  }
};

function CitationList({ citations, onNavigate }: { citations: ModuleCitation[]; onNavigate: (page: number) => void }) {
  if (!citations.length) return null;
  return (
    <ul className="mod-cites" aria-label="근거 쪽">
      {citations.map((c, i) => (
        <li key={`${c.page}-${i}`}>
          <button type="button" className="mod-cite" onClick={() => onNavigate(c.page)}
            aria-label={`${c.page}쪽으로 이동: ${c.title}`}>
            <span className="p">{c.page}쪽</span>
            <span className="t">{c.title}</span>
          </button>
          {c.quote && <q className="mod-cite-quote">{c.quote}</q>}
        </li>
      ))}
    </ul>
  );
}

export function AgentPanel({ source, title, page, onNavigate, onClose }: Props) {
  const key = sourceKey(source);
  const [status, setStatus] = useState<ModuleStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ModuleConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ModuleChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const sending = useRef(false);              // 연타·엔터 반복으로 같은 질문이 두 번 가지 않게 막음
  const abort = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scope = useRef(key);                  // 출처가 바뀐 뒤 도착한 이전 출처 응답은 버림
  scope.current = key;
  const loadCtl = useRef<AbortController | null>(null);   // 대화 불러오기는 마지막 요청만 반영함
  const ids = useId();

  // 새 불러오기를 시작하면 이전 불러오기는 끊음
  const beginLoad = () => {
    loadCtl.current?.abort();
    const ac = new AbortController();
    loadCtl.current = ac;
    return ac;
  };

  // 서버 설정 상태
  useEffect(() => {
    const ac = new AbortController();
    moduleApi.status(ac.signal).then((s) => { setStatus(s); setStatusError(null); }, (e) => {
      if ((e as Error).name !== "AbortError") setStatusError(errorText(e));
    });
    return () => ac.abort();
  }, [reload]);

  // 출처가 바뀌면 진행 중인 답을 끊고 그 출처의 대화만 다시 불러옴
  useEffect(() => {
    abort.current?.abort();
    sending.current = false;
    setDraft(null);
    setFailure(null);
    setInput("");                             // 다른 출처에 쓰던 질문이 이 출처로 가지 않게 비움
    setMessages([]);
    setActiveId(null);
    setConversations([]);
    setLoading(true);
    setLoadError(null);
    const ac = beginLoad();
    (async () => {
      const list = await moduleApi.conversations(source, ac.signal);
      if (ac.signal.aborted) return;
      setConversations(list);
      const first = list[0];
      if (first) {
        const { messages } = await moduleApi.conversation(first.id, ac.signal);
        if (ac.signal.aborted) return;
        setActiveId(first.id);
        setMessages(messages);
      }
      setLoading(false);
    })().catch((e) => {
      if ((e as Error).name === "AbortError" || ac.signal.aborted) return;
      setLoadError(errorText(e));
      setLoading(false);
    });
    return () => ac.abort();
    // source는 key로 비교함(호출하는 쪽이 매번 새 객체를 넘겨도 다시 불러오지 않게)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reload]);

  useEffect(() => () => { abort.current?.abort(); loadCtl.current?.abort(); }, []);

  // 새 글이 오면 맨 아래로
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, draft?.text, draft?.tools.length, failure]);

  const openConversation = async (id: string) => {
    if (sending.current) return;
    const ac = beginLoad();
    setFailure(null);
    setLoading(true);
    setLoadError(null);
    setActiveId(id);
    setMessages([]);
    try {
      const { messages } = await moduleApi.conversation(id, ac.signal);
      if (ac.signal.aborted) return;
      setMessages(messages);
      setLoading(false);
    } catch (e) {
      if ((e as Error).name === "AbortError" || ac.signal.aborted) return;
      setLoadError(errorText(e));
      setLoading(false);
    }
  };

  const startNew = () => {
    if (sending.current) return;
    loadCtl.current?.abort();
    setLoading(false);
    setLoadError(null);
    setActiveId(null);
    setMessages([]);
    setFailure(null);
    inputRef.current?.focus();
  };

  const chatReady = !!status?.configured && status.capabilities.chat
    && (source.kind === "document" || status.capabilities.lectureSources);
  const maxChars = status?.limits.maxMessageChars ?? 4000;

  const send = async (prompt: string) => {
    const message = prompt.trim();
    // 대화를 불러오는 중에는 어느 대화에 붙일지 정해지지 않았으므로 보내지 않음
    if (!message || sending.current || loading || !chatReady) return;
    if (message.length > maxChars) {
      setFailure({ prompt, message: `질문은 ${maxChars.toLocaleString()}자까지 보낼 수 있어요.`, canRetry: false });
      return;
    }
    sending.current = true;
    setFailure(null);
    const owner = scope.current;
    const ac = new AbortController();
    abort.current = ac;
    setDraft({ prompt: message, accepted: false, text: "", tools: [], citations: [] });
    let accepted = false;
    let settled = false;
    let received = "";                         // 멈췄을 때 받은 데까지 남기려고 따로 모음
    let cited: ModuleCitation[] = [];
    let conversationId = activeId;
    const fail = (text: string, canRetry = true) => {
      if (scope.current !== owner) return;
      setFailure({ prompt: message, message: text, canRetry });
      // 서버가 질문을 받지 못했으면 입력창에 그대로 돌려 둠
      if (!accepted) setInput((cur) => cur.trim() ? cur : message);
    };
    try {
      if (!conversationId) {
        const conversation = await moduleApi.createConversation(source, page);
        if (scope.current !== owner) return;
        conversationId = conversation.id;
        setActiveId(conversation.id);
        setConversations((list) => [conversation, ...list.filter((c) => c.id !== conversation.id)]);
      }
      const cid = conversationId;
      await streamChat(cid, { message, page }, (ev) => {
        if (scope.current !== owner) return;
        switch (ev.event) {
          case "meta":
            accepted = true;
            setInput((cur) => (cur.trim() === message ? "" : cur));
            setMessages((list) => [...list, {
              id: ev.data.userMessageId, role: "user", content: message, page, citations: [], status: "complete", error: null, createdAt: Date.now(),
            }]);
            setDraft((d) => d && { ...d, accepted: true });
            break;
          case "delta":
            received += ev.data.text;
            setDraft((d) => d && { ...d, text: d.text + ev.data.text });
            break;
          case "tool":
            setDraft((d) => d && { ...d, tools: [...d.tools, ev.data] });
            break;
          case "citations":
            cited = ev.data.citations;
            setDraft((d) => d && { ...d, citations: ev.data.citations });
            break;
          case "done":
            settled = true;
            setMessages((list) => [...list.filter((m) => m.id !== ev.data.message.id), ev.data.message]);
            setDraft(null);
            break;
          case "error":
            settled = true;
            if (ev.data.message) {
              const saved = ev.data.message;
              setMessages((list) => [...list.filter((m) => m.id !== saved.id), saved]);
            }
            setDraft(null);
            fail(chatError(ev.data.code, ev.data.error));
            break;
        }
      }, ac.signal);
      if (scope.current === owner) {
        // 대화를 고른 순서(최근 순)가 바뀌므로 목록을 새로 받음
        moduleApi.conversations(source).then((list) => { if (scope.current === owner) setConversations(list); }, () => {});
      }
    } catch (e) {
      if (scope.current !== owner) return;
      setDraft(null);
      // 멈춘 답: 받은 데까지는 보여 주되 끝나지 않았다고 표시. 서버도 cancelled로 저장함
      if (accepted && received && (e as Error).name === "AbortError") {
        setMessages((list) => [...list, {
          id: `local-${Date.now()}`, role: "assistant", content: received, page, citations: cited, status: "cancelled", error: null, createdAt: Date.now(),
        }]);
      }
      if ((e as Error).name === "AbortError") {
        if (!accepted) setInput((cur) => cur.trim() ? cur : message);
      } else if (!settled) {
        const code = e instanceof ModuleApiError ? e.code : "";
        fail(e instanceof ModuleApiError && code !== "network" ? e.message : chatError(code, errorText(e)), code !== "not_configured");
      }
    } finally {
      if (abort.current === ac) abort.current = null;
      if (scope.current === owner) sending.current = false;
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글 조합 중 엔터는 글자를 확정하는 엔터라서 보내지 않음
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void send(input);
  };

  const busy = draft !== null;
  const active = conversations.find((c) => c.id === activeId);
  const lectureBlocked = source.kind === "lecture" && status && !status.capabilities.lectureSources;

  return (
    <section className="mod-agent" aria-labelledby={`${ids}-h`}>
      <header className="mod-agent-head">
        <div>
          <h2 id={`${ids}-h`}>학습 에이전트</h2>
          <p className="mod-muted">자료를 근거로 함께 살펴봐요</p>
        </div>
        {onClose && (
          <button type="button" className="mod-btn ghost" onClick={onClose}>닫기</button>
        )}
      </header>

      <div className="mod-agent-threads">
        <label className="mod-sr" htmlFor={`${ids}-conv`}>대화 선택</label>
        <select id={`${ids}-conv`} className="mod-select" value={activeId ?? ""} disabled={busy}
          onChange={(e) => (e.target.value ? void openConversation(e.target.value) : startNew())}>
          <option value="">새 대화</option>
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {`${c.page ? `${c.page}쪽 · ` : ""}${new Date(c.updatedAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`}
            </option>
          ))}
        </select>
        <button type="button" className="mod-btn" onClick={startNew} disabled={busy || !activeId}>새 대화</button>
      </div>

      <dl className="mod-agent-context">
        <dt>현재 자료</dt><dd>{title}</dd>
        <dt>참고 위치</dt><dd>{page}쪽{active?.page && active.page !== page ? ` (대화 시작 ${active.page}쪽)` : ""}</dd>
      </dl>

      {statusError && (
        <div className="mod-notice warn" role="alert">
          <p>서버 상태를 확인하지 못했어요. {statusError}</p>
          <button type="button" className="mod-btn" onClick={() => setReload((n) => n + 1)}>다시 확인</button>
        </div>
      )}
      {status && !status.configured && (
        <div className="mod-notice">
          <p><strong>모델 API가 설정되지 않았어요.</strong> 대화는 서버에 API 키를 설정한 뒤 쓸 수 있어요. 자료 읽기와 이전 대화 보기는 계속 할 수 있어요.</p>
        </div>
      )}
      {status?.configured && !status.capabilities.chat && (
        <div className="mod-notice"><p>지금 연결된 모델은 학습 대화를 지원하지 않아요. 서버 설정을 확인해 주세요.</p></div>
      )}
      {lectureBlocked && (
        <div className="mod-notice"><p>이 환경에서는 기존 강의를 대화 출처로 쓸 수 없어요. 등록한 자료에서 질문해 주세요.</p></div>
      )}

      <div className="mod-agent-log" ref={logRef} role="log" aria-live="polite" aria-busy={busy} aria-label="대화 내용">
        {loading && <p className="mod-muted" role="status">대화를 불러오는 중이에요</p>}
        {loadError && (
          <div className="mod-notice warn" role="alert">
            <p>대화를 불러오지 못했어요. {loadError}</p>
            <button type="button" className="mod-btn" onClick={() => setReload((n) => n + 1)}>다시 불러오기</button>
          </div>
        )}
        {!loading && !loadError && !messages.length && !draft && (
          <p className="mod-agent-empty">지금 보는 {page}쪽이나 자료 전체에 관해 물어보세요. 답에는 근거가 된 쪽이 함께 표시돼요.</p>
        )}
        {messages.map((m) => m.role === "user" ? (
          <div key={m.id} className="mod-bubble user">
            {m.page != null && <span className="mod-bubble-page">{m.page}쪽에서</span>}
            <p>{m.content}</p>
          </div>
        ) : (
          <div key={m.id} className={`mod-bubble bot ${m.status}`}>
            {m.content && <div className="explain"><Markdown text={m.content} untrusted /></div>}
            {m.status === "cancelled" && <p className="mod-msg-flag">답을 중간에 멈췄어요.</p>}
            {m.status === "failed" && <p className="mod-msg-flag err">답을 끝내지 못했어요.{m.error && /[가-힣]/.test(m.error) ? ` ${m.error}` : ""}</p>}
            <CitationList citations={m.citations} onNavigate={onNavigate} />
          </div>
        ))}
        {draft && (
          <>
            {!draft.accepted && (
              <div className="mod-bubble user pending"><p>{draft.prompt}</p></div>
            )}
            <div className="mod-bubble bot streaming" aria-live="off">
              {draft.tools.length > 0 && (
                <ul className="mod-tools" aria-label="자료 확인 과정">
                  {draft.tools.map((t, i) => (
                    <li key={i}>{t.name === "read_page" ? `${t.page ?? ""}쪽을 읽었어요` : `자료에서 "${t.query ?? ""}"을(를) 찾아봤어요`}</li>
                  ))}
                </ul>
              )}
              {draft.text
                ? <div className="explain"><Markdown text={draft.text} untrusted /></div>
                : <p className="mod-muted" role="status">{draft.accepted ? "자료를 살펴보는 중이에요" : "질문을 보내는 중이에요"}</p>}
              <CitationList citations={draft.citations} onNavigate={onNavigate} />
            </div>
          </>
        )}
        {failure && (
          <div className="mod-notice warn" role="alert">
            <p>{failure.message}</p>
            {failure.canRetry && chatReady && (
              <button type="button" className="mod-btn" disabled={busy} onClick={() => void send(failure.prompt)}>같은 질문 다시 보내기</button>
            )}
          </div>
        )}
      </div>

      <form className="mod-composer" onSubmit={onSubmit}>
        <label className="mod-sr" htmlFor={`${ids}-input`}>질문</label>
        <textarea id={`${ids}-input`} ref={inputRef} value={input} rows={3}
          placeholder={chatReady ? "이 자료에 관해 질문하기" : "모델 API 설정 후 질문할 수 있어요"}
          maxLength={maxChars} disabled={!chatReady && !!status}
          onChange={(e) => setInput(e.target.value)} onKeyDown={onKeyDown} />
        <div className="mod-composer-foot">
          <span className="mod-muted small">{input.length > maxChars * 0.8 ? `${input.length.toLocaleString()} / ${maxChars.toLocaleString()}자` : "Enter 보내기 · Shift+Enter 줄바꿈"}</span>
          {busy ? (
            <button type="button" className="mod-btn" onClick={() => abort.current?.abort()}>답 멈추기</button>
          ) : (
            <button type="submit" className="mod-btn primary" disabled={!chatReady || loading || !input.trim()}>질문 보내기</button>
          )}
        </div>
      </form>
    </section>
  );
}
