import type {
  ModuleChatEvent, ModuleChatSource, ModuleConversation, ModuleChatMessage, ModuleDocument, ModuleDocumentDetail,
  ModuleJob, ModuleJobErrorCode, ModuleJobResult, ModuleReaderProgress, ModuleStatus,
} from "../../shared/agent";
import { MODULE_HEADERS } from "../../shared/agent";

// /api/module 호출. 변경 요청에는 로컬 화면 표시 헤더(X-StudyApp: 1)를 붙임. 오류 코드는 한국어 문장으로 바꿔 올림
export class ModuleApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ModuleApiError";
  }
}

// Relative to the served UI directory, so /lessonviewer/?embed=1 works behind a host proxy.
const BASE = typeof location === "undefined" ? "/api/module" : new URL("./api/module", location.href).pathname.replace(/\/$/, "");

function resolveDocument(detail: ModuleDocumentDetail): ModuleDocumentDetail {
  return { ...detail, pages: detail.pages.map((page) => ({
    ...page, imageUrl: page.imageUrl.startsWith("/api/module/") ? BASE + page.imageUrl.slice("/api/module".length) : page.imageUrl,
  })) };
}

// 서버 오류 코드별 안내. 서버 문장은 한국어일 때만 그대로 쓰고, 영어 문장은 코드에 맞는 안내로 바꿈
const ERROR_TEXT: Record<string, string> = {
  invalid_request: "요청 내용을 처리할 수 없어요. 파일과 입력을 확인해 주세요.",
  too_large: "파일이 너무 커요. 크기 제한 안의 PDF로 다시 올려 주세요.",
  invalid_state: "지금 상태에서는 할 수 없는 작업이에요. 화면을 새로 고친 뒤 다시 확인해 주세요.",
  conflict: "이 자료는 이미 해설을 만들고 있어요. 진행 중인 작업을 확인해 주세요.",
  not_found: "찾는 자료나 작업이 없어요. 삭제되었을 수 있어요.",
  forbidden: "이 작업을 할 권한이 없어요.",
  unauthorized: "인증이 필요해요. 연결된 서비스에서 다시 열어 주세요.",
  busy: "이전 요청을 아직 처리하고 있어요. 잠시 뒤 다시 시도해 주세요.",
  not_configured: "서버에 모델 API가 설정되지 않아 이 기능을 쓸 수 없어요.",
};

async function fail(res: Response): Promise<never> {
  let code = `http_${res.status}`;
  let serverText = "";
  try {
    const data = await res.json() as { error?: string; code?: string };
    if (data?.code) code = data.code;
    if (data?.error) serverText = data.error;
  } catch { /* 본문이 JSON이 아님 */ }
  const message = /[가-힣]/.test(serverText) ? serverText
    : ERROR_TEXT[code] ?? `요청을 처리하지 못했어요 (${res.status}). 잠시 뒤 다시 시도해 주세요.`;
  throw new ModuleApiError(res.status, code, message);
}

async function call<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, signal?: AbortSignal, keepalive = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers[MODULE_HEADERS.local] = "1";
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(BASE + path, { method, headers, body: payload, signal, keepalive });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ModuleApiError(0, "network", "서버에 연결하지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.");
  }
  if (!res.ok) await fail(res);
  return res.json() as Promise<T>;
}

const enc = encodeURIComponent;

// 대화 목록 조회용 출처 표기: document:<id> 또는 lecture:<course>/<lecture>
export const sourceKey = (s: ModuleChatSource) =>
  s.kind === "document" ? `document:${s.documentId}` : `lecture:${s.course}/${s.lecture}`;

export const moduleApi = {
  status: (signal?: AbortSignal) => call<ModuleStatus>("GET", "/status", undefined, signal),

  documents: (signal?: AbortSignal) => call<{ documents: ModuleDocument[] }>("GET", "/documents", undefined, signal).then((r) => r.documents),
  upload: (file: File, title: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("title", title);
    return call<{ document: ModuleDocument }>("POST", "/documents", form).then((r) => r.document);
  },
  document: (id: string, signal?: AbortSignal) => call<ModuleDocumentDetail>("GET", `/documents/${enc(id)}`, undefined, signal).then(resolveDocument),
  deleteDocument: (id: string) => call<{ ok: boolean }>("DELETE", `/documents/${enc(id)}`),
  publish: (documentId: string, jobId: string) =>
    call<{ document: ModuleDocument } & ModuleJobResult>("POST", `/documents/${enc(documentId)}/publish`, { jobId }),

  progress: (documentId: string, signal?: AbortSignal) =>
    call<{ progress: ModuleReaderProgress }>("GET", `/documents/${enc(documentId)}/progress`, undefined, signal).then((r) => r.progress),
  // keepalive: 화면을 떠나는 중에도 끝까지 보냄(본문이 작아서 브라우저 제한 안에 듦)
  saveProgress: (documentId: string, update: { lastPage?: number | null; seen?: number[] }, keepalive = false) =>
    call<{ progress: ModuleReaderProgress }>("PUT", `/documents/${enc(documentId)}/progress`, update, undefined, keepalive).then((r) => r.progress),

  jobs: (documentId?: string, signal?: AbortSignal) =>
    call<{ jobs: ModuleJob[] }>("GET", documentId ? `/jobs?documentId=${enc(documentId)}` : "/jobs", undefined, signal).then((r) => r.jobs),
  job: (id: string, signal?: AbortSignal) => call<{ job: ModuleJob }>("GET", `/jobs/${enc(id)}`, undefined, signal).then((r) => r.job),
  createJob: (documentId: string) => call<{ job: ModuleJob }>("POST", "/jobs", { documentId }).then((r) => r.job),
  cancelJob: (id: string) => call<{ job: ModuleJob }>("POST", `/jobs/${enc(id)}/cancel`, {}).then((r) => r.job),
  retryJob: (id: string) => call<{ job: ModuleJob }>("POST", `/jobs/${enc(id)}/retry`, {}).then((r) => r.job),
  jobResult: (id: string, signal?: AbortSignal) => call<ModuleJobResult>("GET", `/jobs/${enc(id)}/result`, undefined, signal),

  conversations: (source: ModuleChatSource, signal?: AbortSignal) =>
    call<{ conversations: ModuleConversation[] }>("GET", `/conversations?source=${enc(sourceKey(source))}`, undefined, signal).then((r) => r.conversations),
  createConversation: (source: ModuleChatSource, page?: number) =>
    call<{ conversation: ModuleConversation }>("POST", "/conversations", { source, page }).then((r) => r.conversation),
  conversation: (id: string, signal?: AbortSignal) =>
    call<{ conversation: ModuleConversation; messages: ModuleChatMessage[] }>("GET", `/conversations/${enc(id)}`, undefined, signal),
};

// 대화 답을 SSE로 받음. 이벤트마다 onEvent를 부름. signal로 끊으면 서버도 모델 요청을 멈춤.
// 스트림이 done/error 없이 끝나면 연결이 끊긴 것으로 보고 오류를 올림
export async function streamChat(
  conversationId: string,
  body: { message: string; page?: number },
  onEvent: (e: ModuleChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/conversations/${enc(conversationId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", [MODULE_HEADERS.local]: "1" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ModuleApiError(0, "network", "서버에 연결하지 못했어요. 연결을 확인한 뒤 다시 보내 주세요.");
  }
  if (!res.ok) await fail(res);
  if (!res.body) throw new ModuleApiError(0, "stream", "답을 받을 수 없는 응답이에요.");

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let finished = false;
  const dispatch = (block: string) => {
    let name = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") name = value;
      else if (field === "data") data.push(value);
    }
    if (!data.length) return;
    let parsed: unknown;
    try { parsed = JSON.parse(data.join("\n")); } catch { return; }
    if (name === "done" || name === "error") finished = true;
    onEvent({ event: name, data: parsed } as ModuleChatEvent);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value.replace(/\r\n?/g, "\n");
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        dispatch(buffer.slice(0, cut));
        buffer = buffer.slice(cut + 2);
      }
    }
    if (buffer.trim()) dispatch(buffer);
  } finally {
    reader.releaseLock();
  }
  if (!finished) throw new ModuleApiError(0, "stream", "답을 받는 중에 연결이 끊겼어요.");
}

// 사용자에게 보여 줄 오류 문장. 한국어가 아닌 오류 문장은 일반 안내로 바꿈
export const errorText = (e: unknown) =>
  e instanceof ModuleApiError ? e.message
    : e instanceof Error && /[가-힣]/.test(e.message) ? e.message : "알 수 없는 오류가 생겼어요. 잠시 뒤 다시 시도해 주세요.";

const JOB_ERROR_TEXT: Record<ModuleJobErrorCode, string> = {
  interrupted: "서버가 작업 중에 멈췄어요. 자동으로 다시 돌리지 않으니 필요하면 다시 생성해 주세요.",
  not_configured: "서버에 모델 API가 설정되지 않아 해설을 만들 수 없었어요.",
  provider: "모델 API 요청이 실패했어요. 잠시 뒤 다시 생성해 주세요.",
  invalid_output: "모델이 만든 해설이 형식 검사를 통과하지 못했어요. 다시 생성해 주세요.",
  budget: "이 자료에 쓸 수 있는 처리량을 넘었어요.",
  input: "PDF 내용을 해설 생성에 쓸 수 없었어요.",
  internal: "해설을 만드는 중에 서버 오류가 생겼어요.",
};

// 생성 작업 오류 안내. 서버 문장이 한국어면 그대로, 아니면 코드별 안내
export const jobErrorText = (error: ModuleJob["error"]) =>
  !error ? null : /[가-힣]/.test(error.message) ? error.message : JOB_ERROR_TEXT[error.code] ?? "해설을 만들지 못했어요.";

// 문서 추출 실패 이유. 서버 문장이 한국어가 아니면 일반 안내
export const documentErrorText = (error: string | null) =>
  error && /[가-힣]/.test(error) ? error : "PDF를 읽지 못했어요. 손상되었거나 암호가 걸린 파일인지 확인해 주세요.";
