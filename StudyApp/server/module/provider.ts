// 모델 제공자 연결. API 키 방식만 씀(OAuth·코딩 CLI 없음).
//  - anthropic: Messages API (POST {base}/v1/messages, x-api-key, 스트리밍)
//  - openai-compatible: Chat Completions (POST {base}/chat/completions, Bearer, 스트리밍)
// 두 방식 모두 같은 ChatTurn 모양으로 바꿔 돌려줌. 해설 생성(generation.ts)에는 callModel 로 넘김.

import type { CallModel, ModelContent, ModelRequest, ModelResponse } from "../generation";
import { redact, type ModuleConfig } from "./config";
import { parseSSE } from "./sse";

export interface ToolDef { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ToolCall { id: string; name: string; input: unknown }
export type ChatMsg =
  | { role: "user"; content: ModelContent[] }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; results: { id: string; content: ModelContent[]; isError?: boolean }[] };

export interface ChatTurnRequest {
  system: string;
  messages: ChatMsg[];
  tools?: ToolDef[];
  maxTokens: number;
  temperature?: number;
  signal: AbortSignal;
  onText?: (text: string) => void;
}
export type StopReason = "end" | "max_tokens" | "tool_use" | "other";
export interface Usage { inputTokens: number; outputTokens: number }
export interface ChatTurn { text: string; toolCalls: ToolCall[]; stopReason: StopReason; usage: Usage }

export type ProviderErrorCode = "auth" | "rate_limit" | "bad_request" | "server" | "network" | "protocol" | "not_configured";
export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, message: string, readonly status: number | null = null, readonly retryAfterMs: number | null = null) {
    super(message);
    this.name = "ProviderError";
  }
  get retryable() { return this.code === "rate_limit" || this.code === "server" || this.code === "network"; }
}

export interface Provider {
  kind: ModuleConfig["provider"];
  model: string;
  vision: boolean;
  stream(req: ChatTurnRequest): Promise<ChatTurn>;
  callModel: CallModel;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const IDLE_TIMEOUT_MS = 120_000;   // 이만큼 아무 바이트도 안 오면 끊김으로 봄
const MAX_ATTEMPTS = 3;

export const abortError = () => new DOMException("The operation was aborted", "AbortError");
export const isAbort = (e: unknown) => e instanceof Error && e.name === "AbortError";

// 글 조각만 이어 붙임(이미지는 뺌)
export const textOf = (parts: ModelContent[]) =>
  parts.flatMap((p) => p.type === "text" ? [p.text] : []).join("\n");

function sleep(ms: number, signal: AbortSignal) {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal.aborted) { reject(abortError()); return promise; }
  const onAbort = () => { clearTimeout(t); reject(abortError()); };
  const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}

// HTTP 오류 응답을 ProviderError 로. 본문의 오류 문구는 비밀값을 지우고 짧게 줄여서만 씀
async function httpError(res: Response, secrets: Pick<ModuleConfig, "apiKey" | "hostToken">): Promise<ProviderError> {
  let detail = "";
  try {
    const raw = (await res.text()).slice(0, 4000);
    try {
      const j = JSON.parse(raw) as { error?: { message?: string; type?: string } | string; message?: string };
      detail = typeof j.error === "string" ? j.error : j.error?.message ?? j.message ?? "";
    } catch { detail = raw; }
  } catch { /* 본문을 못 읽어도 상태 코드로 판단 */ }
  detail = redact(detail.replace(/\s+/g, " ").trim(), secrets).slice(0, 300);
  const s = res.status;
  const code: ProviderErrorCode = s === 401 || s === 403 ? "auth" : s === 429 ? "rate_limit" : s >= 500 ? "server" : "bad_request";
  const ra = Number(res.headers.get("retry-after"));
  const label = { auth: "API key was rejected", rate_limit: "provider rate limit", server: "provider server error", bad_request: "provider rejected the request" }[code as "auth"];
  return new ProviderError(code, `${label} (HTTP ${s})${detail ? `: ${detail}` : ""}`, s, Number.isFinite(ra) && ra > 0 ? ra * 1000 : null);
}

// ── 요청 모양 바꾸기 ──

export function toAnthropicBody(model: string, vision: boolean, req: Omit<ChatTurnRequest, "signal" | "onText">) {
  const part = (p: ModelContent) => p.type === "text"
    ? { type: "text", text: p.text }
    : vision
      ? { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } }
      : { type: "text", text: "[이미지 생략: 이 모델 설정은 이미지를 받지 않음]" };
  const messages: { role: "user" | "assistant"; content: Record<string, unknown>[] }[] = [];
  const push = (role: "user" | "assistant", blocks: Record<string, unknown>[]) => {
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...blocks);   // 같은 역할이 이어지면 한 메시지로 합침
    else messages.push({ role, content: blocks });
  };
  for (const m of req.messages) {
    if (m.role === "user") push("user", m.content.map(part));
    else if (m.role === "assistant") {
      push("assistant", [
        ...(m.text ? [{ type: "text", text: m.text }] : []),
        ...m.toolCalls.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.input ?? {} })),
      ]);
    } else {
      push("user", m.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content.map(part), ...(r.isError ? { is_error: true } : {}) })));
    }
  }
  return {
    model, max_tokens: req.maxTokens, stream: true, system: req.system, messages,
    ...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
  };
}

export function toOpenAIBody(model: string, vision: boolean, baseUrl: string, req: Omit<ChatTurnRequest, "signal" | "onText">) {
  const part = (p: ModelContent) => p.type === "text"
    ? { type: "text", text: p.text }
    : vision
      ? { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data}` } }
      : { type: "text", text: "[이미지 생략: 이 모델 설정은 이미지를 받지 않음]" };
  const messages: Record<string, unknown>[] = [{ role: "system", content: req.system }];
  for (const m of req.messages) {
    if (m.role === "user") messages.push({ role: "user", content: m.content.map(part) });
    else if (m.role === "assistant") {
      messages.push({
        role: "assistant", content: m.text || null,
        ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } })) } : {}),
      });
    } else {
      // tool 메시지는 글만 받는 곳이 많아 이미지는 뒤이은 user 메시지로 보냄
      const images: ModelContent[] = [];
      for (const r of m.results) {
        const text = textOf(r.content);
        messages.push({ role: "tool", tool_call_id: r.id, content: (r.isError ? "ERROR: " : "") + text });
        images.push(...r.content.filter((p) => p.type === "image"));
      }
      if (images.length && vision) messages.push({ role: "user", content: [{ type: "text", text: "(위 도구 결과의 쪽 이미지)" }, ...images.map(part)] });
    }
  }
  // api.openai.com 의 새 모델은 max_tokens 를 거부함. 다른 호환 서버는 대부분 max_tokens 만 앎
  const official = new URL(baseUrl).hostname === "api.openai.com";
  return {
    model, messages, stream: true, stream_options: { include_usage: true },
    ...(official ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens }),
    ...(req.temperature !== undefined && !official ? { temperature: req.temperature } : {}),
    ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}),
  };
}

// ── 스트림 읽기 ──

function parseToolInput(raw: string, name: string): unknown {
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); }
  catch { throw new ProviderError("protocol", `model sent malformed arguments for tool ${name}`); }
}

// 제공자가 보내는 이벤트에서 읽는 필드만 적음. 모두 선택 항목이라 빠져 있어도 안전하게 읽힘
interface AnthropicEvent {
  type?: string;
  index?: number;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  content_block?: { type?: string; id?: string; name?: string; text?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}
interface OpenAIChunk {
  error?: { message?: string } | string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: {
    delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
    finish_reason?: string | null;
  }[];
}

function jsonData<T extends object>(data: string): T {
  let v: unknown;
  try { v = JSON.parse(data); }
  catch { throw new ProviderError("protocol", "provider stream contained malformed JSON"); }
  if (!v || typeof v !== "object") throw new ProviderError("protocol", "provider stream event is not an object");
  return v as T;   // 필드는 모두 선택 항목으로 적어 둠
}

export async function readAnthropicStream(body: ReadableStream<Uint8Array>, onText?: (t: string) => void): Promise<ChatTurn> {
  let text = "";
  const blocks = new Map<number, { id: string; name: string; json: string }>();
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stop: StopReason | null = null;
  let finished = false;
  for await (const ev of parseSSE(body)) {
    if (ev.event === "ping") continue;
    const d = jsonData<AnthropicEvent>(ev.data);
    switch (d.type) {
      case "message_start":
        usage.inputTokens = d.message?.usage?.input_tokens ?? 0;
        usage.outputTokens = d.message?.usage?.output_tokens ?? 0;
        break;
      case "content_block_start":
        if (d.content_block?.type === "tool_use") blocks.set(d.index ?? -1, { id: String(d.content_block.id), name: String(d.content_block.name), json: "" });
        else if (d.content_block?.type === "text" && d.content_block.text) { text += d.content_block.text; onText?.(d.content_block.text); }
        break;
      case "content_block_delta":
        if (d.delta?.type === "text_delta" && d.delta.text) { text += d.delta.text; onText?.(d.delta.text); }
        else if (d.delta?.type === "input_json_delta") {
          const b = blocks.get(d.index ?? -1);
          if (!b) throw new ProviderError("protocol", "tool input delta for unknown block");
          b.json += d.delta.partial_json ?? "";
        }
        break;
      case "message_delta":
        if (d.delta?.stop_reason) stop = ({ end_turn: "end", stop_sequence: "end", max_tokens: "max_tokens", tool_use: "tool_use" } as Record<string, StopReason>)[d.delta.stop_reason] ?? "other";
        if (d.usage?.output_tokens !== undefined) usage.outputTokens = d.usage.output_tokens;
        if (d.usage?.input_tokens) usage.inputTokens = d.usage.input_tokens;
        break;
      case "message_stop":
        finished = true;
        break;
      case "error": {
        const type = String(d.error?.type ?? "");
        const code: ProviderErrorCode = type === "overloaded_error" || type === "api_error" ? "server" : type === "rate_limit_error" ? "rate_limit"
          : type === "authentication_error" || type === "permission_error" ? "auth" : "bad_request";
        throw new ProviderError(code, `provider stream error: ${String(d.error?.message ?? type)}`);   // 잘라내기·비밀값 지우기는 createProvider 에서 한 번에
      }
    }
  }
  if (!finished) throw new ProviderError("network", "provider stream ended before the message finished");
  const toolCalls = [...blocks.values()].map((b) => ({ id: b.id, name: b.name, input: parseToolInput(b.json, b.name) }));
  return { text, toolCalls, stopReason: stop ?? (toolCalls.length ? "tool_use" : "end"), usage };
}

export async function readOpenAIStream(body: ReadableStream<Uint8Array>, onText?: (t: string) => void): Promise<ChatTurn> {
  let text = "";
  const calls = new Map<number, { id: string; name: string; args: string }>();
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stop: StopReason | null = null;
  let done = false;
  for await (const ev of parseSSE(body)) {
    if (ev.data === "[DONE]") { done = true; break; }
    const d = jsonData<OpenAIChunk>(ev.data);
    if (d.error) throw new ProviderError("server", `provider stream error: ${String(typeof d.error === "string" ? d.error : d.error.message)}`);
    if (d.usage) { usage.inputTokens = d.usage.prompt_tokens ?? usage.inputTokens; usage.outputTokens = d.usage.completion_tokens ?? usage.outputTokens; }
    const choice = d.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) { text += delta.content; onText?.(delta.content); }
    for (const tc of delta.tool_calls ?? []) {
      const idx = typeof tc.index === "number" ? tc.index : calls.size;
      const cur = calls.get(idx) ?? { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      calls.set(idx, cur);
    }
    if (choice.finish_reason) {
      stop = ({ stop: "end", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use" } as Record<string, StopReason>)[choice.finish_reason] ?? "other";
    }
  }
  if (!done && !stop) throw new ProviderError("network", "provider stream ended before the message finished");
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([i, c]) => {
    if (!c.name) throw new ProviderError("protocol", "model sent a tool call without a name");
    return { id: c.id || `call_${i}`, name: c.name, input: parseToolInput(c.args, c.name) };
  });
  return { text, toolCalls, stopReason: stop ?? (toolCalls.length ? "tool_use" : "end"), usage };
}

// ── 제공자 ──

export function createProvider(config: ModuleConfig, fetchImpl: FetchLike = fetch): Provider | null {
  if (!config.apiKey || !config.model) return null;
  const { apiKey, model, baseUrl, vision, provider: kind } = config;
  const secrets = { apiKey: config.apiKey, hostToken: config.hostToken };

  async function once(req: ChatTurnRequest, emitted: { any: boolean }): Promise<ChatTurn> {
    // 바깥 취소와 무응답 시간 제한을 같이 거는 신호
    const idle = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const kick = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => idle.abort(), IDLE_TIMEOUT_MS); };
    const signal = AbortSignal.any([req.signal, idle.signal]);
    kick();
    const onText = (t: string) => { emitted.any = true; kick(); req.onText?.(t); };
    try {
      const anthropic = kind === "anthropic";
      const url = anthropic ? `${baseUrl}/v1/messages` : `${baseUrl}/chat/completions`;
      const headers: Record<string, string> = anthropic
        ? { "content-type": "application/json", "x-api-key": apiKey!, "anthropic-version": "2023-06-01", accept: "text/event-stream" }
        : { "content-type": "application/json", authorization: `Bearer ${apiKey}`, accept: "text/event-stream" };
      const body = anthropic ? toAnthropicBody(model, vision, req) : toOpenAIBody(model, vision, baseUrl, req);
      let res: Response;
      try { res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal }); }
      catch (e) {
        if (req.signal.aborted) throw abortError();
        if (idle.signal.aborted) throw new ProviderError("network", "provider did not respond in time");
        throw new ProviderError("network", `could not reach provider: ${redact(String((e as Error)?.message ?? e), secrets).slice(0, 200)}`);
      }
      if (!res.ok) throw await httpError(res, secrets);
      if (!res.body) throw new ProviderError("protocol", "provider returned an empty body");
      const ctype = res.headers.get("content-type") ?? "";
      if (!ctype.includes("text/event-stream")) {
        throw new ProviderError("protocol", `provider did not stream (content-type ${ctype.split(";")[0] || "missing"}); check LESSONVIEWER_API_BASE_URL`);
      }
      // 바이트가 들어올 때마다 무응답 타이머를 다시 잼
      const watched = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, ctl) { kick(); ctl.enqueue(chunk); } }));
      try {
        return anthropic ? await readAnthropicStream(watched, onText) : await readOpenAIStream(watched, onText);
      } catch (e) {
        if (req.signal.aborted) throw abortError();
        if (idle.signal.aborted) throw new ProviderError("network", "provider stream stalled");
        if (e instanceof ProviderError) throw e;
        throw new ProviderError("network", `provider stream failed: ${redact(String((e as Error)?.message ?? e), secrets).slice(0, 200)}`);
      }
    } catch (e) {
      // 제공자가 보낸 오류 문구는 여기서 한 번에 비밀값을 지운 뒤 자름(자른 뒤 지우면 키 일부가 남을 수 있음)
      if (e instanceof ProviderError) throw new ProviderError(e.code, redact(e.message, secrets).slice(0, 400), e.status, e.retryAfterMs);
      throw e;
    } finally {
      clearTimeout(idleTimer);
    }
  }

  // 일시적 오류는 아직 글을 하나도 내보내지 않았을 때만 다시 시도함(사용자에게 같은 글이 두 번 가지 않게)
  async function stream(req: ChatTurnRequest): Promise<ChatTurn> {
    const emitted = { any: false };
    for (let attempt = 1; ; attempt++) {
      try { return await once(req, emitted); }
      catch (e) {
        if (!(e instanceof ProviderError) || !e.retryable || emitted.any || attempt >= MAX_ATTEMPTS || req.signal.aborted) throw e;
        await sleep(Math.min(e.retryAfterMs ?? 2000 * 2 ** (attempt - 1), 30_000), req.signal);
      }
    }
  }

  // 해설 생성 쪽(generation.ts)이 ProviderError.retryable 을 보고 직접 다시 시도하므로 여기서는 한 번만 보냄
  const callModel: CallModel = async (r: ModelRequest): Promise<ModelResponse> => {
    const turn = await once({
      system: r.system, maxTokens: r.maxTokens, signal: r.signal, temperature: 0.3,
      messages: r.messages.map((m) => m.role === "user" ? { role: "user" as const, content: m.content } : {
        role: "assistant" as const, text: textOf(m.content), toolCalls: [],
      }),
    }, { any: false });
    return { text: turn.text, usage: turn.usage, stopReason: turn.stopReason };
  };

  return { kind, model, vision, stream, callModel };
}
