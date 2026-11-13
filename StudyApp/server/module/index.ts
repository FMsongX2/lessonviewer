// LessonViewer 모듈(/api/module). 로컬 화면과 외부 호스트가 같은 핸들러를 씀. 설명서: server/module/README.md
// createModule 은 부르기 전까지 아무것도 하지 않음(테스트에서 따로 띄울 수 있음).

import { Hono, type Context } from "hono";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  ModuleChatEvent, ModuleChatMessage, ModuleChatSource, ModuleDocumentDetail, ModuleError, ModuleJob, ModulePage, ModuleStatus,
} from "../../shared/agent";
import * as generation from "../generation";
import { authenticate, type Identity } from "./auth";
import { runChat } from "./chat";
import { isConfigured, redact, type ModuleConfig } from "./config";
import { createWorkers, publishResult, readJobResult, type GenerationApi, type Workers } from "./jobs";
import { abortError, createProvider, isAbort, ProviderError, type FetchLike, type Provider } from "./provider";
import { documentDir, extractDir, parseSourceBody, parseSourceParam, readPublished, resolveSource, type LectureCatalog } from "./sources";
import { sseFrame } from "./sse";
import { isId, isTerminal, newId, openModuleStore, sourceKey, type ModuleStore } from "./store";

export type { LectureCatalog } from "./sources";

export interface ModuleOptions {
  config: ModuleConfig;
  catalog: LectureCatalog | null;   // 기존 강의 자료. 로컬 신원에서만 쓰임
  gen?: GenerationApi;              // 테스트에서 추출·생성을 바꿔 끼울 때
  fetch?: FetchLike;                // 테스트에서 모델 서버를 흉내 낼 때
  log?: (msg: string) => void;
}
export interface ModuleInstance { app: Hono<Env>; store: ModuleStore; workers: Workers; close(): void }

type Env = { Variables: { who: Identity } };
type Ctx = Context<Env>;
type Status = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 500 | 503;

const fail = (c: Ctx, status: Status, code: string, error: string) => c.json<ModuleError>({ error, code }, status);
const MULTIPART_SLACK = 1024 * 1024;   // 파일 외 multipart 머리글·제목 몫
const JSON_LIMIT = 64 * 1024;
const HEARTBEAT_MS = 15_000;

class BodyTooLarge extends Error {}

// 본문을 읽으면서 바이트를 셈. Content-Length 가 없거나(chunked) 거짓이어도 한도를 넘는 순간 읽기를 멈춤
export async function readBodyLimited(req: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new BodyTooLarge();
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw new BodyTooLarge(); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const ch of chunks) { out.set(ch, at); at += ch.byteLength; }
  return out;
}

// 사람이 읽을 이름만 남김. 경로·제어 문자는 버려서 사용자 컴퓨터 경로가 새지 않게 함
export function cleanName(raw: string, max: number): string {
  const base = basename(raw.replace(/\\/g, "/"));
  return base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

const intOr = (v: unknown, fallback: number | null) => (Number.isInteger(v) ? Number(v) : fallback);

export function createModule(opts: ModuleOptions): ModuleInstance {
  const { config } = opts;
  const gen = opts.gen ?? { extractPdf: generation.extractPdf, generatePack: generation.generatePack };
  mkdirSync(config.dataDir, { recursive: true });
  const store = openModuleStore(join(config.dataDir, "module.db"));
  const provider: Provider | null = createProvider(config, opts.fetch);
  const workers = createWorkers({ store, config, provider, gen, log: opts.log });

  // 다시 켜짐: 하다 만 생성 작업은 돈이 다시 들지 않게 interrupted 로 끝내고, 추출은 비용이 없으니 다시 돌림
  const interrupted = store.failInterruptedJobs();
  if (interrupted) (opts.log ?? console.error)(`[module] marked ${interrupted} interrupted job(s) as failed`);
  for (const id of store.processingDocuments()) workers.enqueueExtraction(id);

  // 답을 만드는 중인 대화(같은 대화에 두 답이 겹치지 않게, 문서를 지우면 그 문서의 답을 모두 멈추게)
  const chatting = new Map<string, { abort: AbortController; workspace: string; source: string }>();
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const r = authenticate(c.req.raw, c.env, config.hostToken);
    if (!r.ok) return fail(c, r.status, r.code, r.error);
    c.set("who", r.identity);
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((e, c) => {
    if (e instanceof BodyTooLarge) return fail(c, 413, "too_large", "request body is too large");
    (opts.log ?? console.error)(`[module] ${c.req.method} ${c.req.path}: ${redact(String(e?.stack ?? e), config)}`);
    return fail(c, 500, "internal", "internal server error");
  });
  app.notFound((c) => fail(c, 404, "not_found", "not found"));

  // JSON 본문(64KB 한도). 모양이 틀리면 null, 너무 크면 413
  async function jsonBody(c: Ctx): Promise<Record<string, unknown> | null> {
    const raw = new TextDecoder().decode(await readBodyLimited(c.req.raw, JSON_LIMIT));
    try {
      const v: unknown = JSON.parse(raw || "{}");
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch { return null; }
  }

  const statusOf = (who: Identity): ModuleStatus => ({
    configured: isConfigured(config), issue: isConfigured(config) ? null : config.issue ?? "no model API key is configured on the server",
    provider: config.provider, model: config.model, mode: who.mode, limits: config.limits,
    capabilities: {
      generation: isConfigured(config), chat: isConfigured(config), streaming: true, vision: config.vision,
      lectureSources: who.mode === "local" && !!opts.catalog, hostAuth: !!config.hostToken,
    },
  });

  app.get("/status", (c) => c.json(statusOf(c.get("who"))));

  // ── 문서 ──
  app.get("/documents", (c) => c.json({ documents: store.documents(c.get("who")) }));

  app.post("/documents", async (c) => {
    const who = c.get("who");
    const ctype = c.req.header("content-type") ?? "";
    if (!ctype.startsWith("multipart/form-data")) return fail(c, 415, "invalid_request", "send multipart/form-data with a file field");
    // 요청 전체를 한도 안에서만 읽은 뒤 해석함(chunked 업로드나 덧붙인 큰 부분도 막힘)
    const raw = await readBodyLimited(c.req.raw, config.limits.maxFileBytes + MULTIPART_SLACK);
    let form: FormData;
    try { form = await new Response(raw, { headers: { "content-type": ctype } }).formData(); }
    catch { return fail(c, 400, "invalid_request", "could not read the upload"); }
    const fields = [...form.keys()];
    if (fields.some((k) => k !== "file" && k !== "title") || fields.filter((k) => k === "file").length !== 1 || fields.filter((k) => k === "title").length > 1) {
      return fail(c, 400, "invalid_request", "send exactly one file field and an optional title field");
    }
    const file = form.get("file");
    if (!(file instanceof File)) return fail(c, 400, "invalid_request", "file field is required");
    if (file.size === 0) return fail(c, 400, "invalid_request", "file is empty");
    if (file.size > config.limits.maxFileBytes) return fail(c, 413, "too_large", `PDF must be at most ${config.limits.maxFileBytes} bytes`);
    const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    if (!new TextDecoder("latin1").decode(head).includes("%PDF-")) return fail(c, 400, "invalid_request", "file is not a PDF");
    const fileName = cleanName(file.name || "document.pdf", 200) || "document.pdf";
    const rawTitle = form.get("title");
    const title = (typeof rawTitle === "string" ? cleanName(rawTitle, 200) : "") || fileName.replace(/\.pdf$/i, "") || "문서";

    const id = newId();
    const dir = documentDir(config.dataDir, id);
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, "source.pdf"), file);
    const document = store.createDocument(who, { id, title, fileName, bytes: file.size });
    workers.enqueueExtraction(id);
    return c.json({ document }, 201);
  });

  function docOr404(c: Ctx) {
    const id = c.req.param("id") ?? "";
    return isId(id) ? store.document(c.get("who"), id) : null;
  }

  function manifestOf(id: string) {
    try { return generation.readManifest(extractDir(config.dataDir, id)); }
    catch { return null; }
  }

  app.get("/documents/:id", (c) => {
    const document = docOr404(c);
    if (!document) return fail(c, 404, "not_found", "document not found");
    const manifest = document.status === "ready" ? manifestOf(document.id) : null;
    const pages: ModulePage[] = manifest?.pages.map((p) => ({ page: p.page, text: p.text, imageUrl: `/api/module/documents/${document.id}/pages/${p.page}/image` })) ?? [];
    const published = readPublished(config.dataDir, document.id);
    return c.json<ModuleDocumentDetail>({ document, pages, pack: published?.pack ?? null, review: published?.review ?? {} });
  });

  app.delete("/documents/:id", (c) => {
    const who = c.get("who");
    const document = docOr404(c);
    if (!document) return fail(c, 404, "not_found", "document not found");
    // 이 문서를 읽고 있는 답(누구 것이든)을 먼저 멈춘 뒤 지움. 지운 자료로 모델을 더 부르지 않게 함
    const key = sourceKey({ kind: "document", documentId: document.id });
    for (const chat of chatting.values()) if (chat.workspace === who.workspace && chat.source === key) chat.abort.abort("deleted");
    workers.removeDocument(document.id, store.jobIdsForDocument(who.workspace, document.id));
    store.deleteConversationsFor(who.workspace, { kind: "document", documentId: document.id });
    store.deleteDocument(who, document.id);
    return c.json({ ok: true });
  });

  app.get("/documents/:id/pages/:page/image", (c) => {
    const document = docOr404(c);
    if (!document || document.status !== "ready") return fail(c, 404, "not_found", "document not found");
    const n = Number(c.req.param("page"));
    const page = Number.isInteger(n) ? manifestOf(document.id)?.pages.find((p) => p.page === n) : undefined;
    const path = page && join(extractDir(config.dataDir, document.id), basename(page.image));
    if (!path || !existsSync(path)) return fail(c, 404, "not_found", "page not found");
    return new Response(Bun.file(path), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" } });
  });

  app.get("/documents/:id/progress", (c) => {
    const document = docOr404(c);
    if (!document) return fail(c, 404, "not_found", "document not found");
    return c.json({ progress: store.readerProgress(c.get("who"), document.id) });
  });

  app.put("/documents/:id/progress", async (c) => {
    const who = c.get("who");
    const document = docOr404(c);
    if (!document) return fail(c, 404, "not_found", "document not found");
    const body = await jsonBody(c);
    const max = document.pageCount ?? 0;
    const okPage = (n: unknown) => Number.isInteger(n) && Number(n) >= 1 && Number(n) <= max;
    if (!body || (body.lastPage !== undefined && body.lastPage !== null && !okPage(body.lastPage))
      || (body.seen !== undefined && (!Array.isArray(body.seen) || body.seen.length > max || !body.seen.every(okPage)))) {
      return fail(c, 400, "invalid_request", "lastPage must be a page number and seen a list of page numbers");
    }
    const cur = store.readerProgress(who, document.id);
    store.setReaderProgress(who, document.id, {
      lastPage: body.lastPage === undefined ? cur.lastPage : (body.lastPage as number | null),
      seen: body.seen === undefined ? cur.seen : [...new Set(body.seen as number[])].sort((a, b) => a - b),
    });
    return c.json({ progress: store.readerProgress(who, document.id) });
  });

  app.post("/documents/:id/publish", async (c) => {
    const who = c.get("who");
    const document = docOr404(c);
    if (!document) return fail(c, 404, "not_found", "document not found");
    const body = await jsonBody(c);
    const jobId = typeof body?.jobId === "string" && isId(body.jobId) ? body.jobId : null;
    if (!jobId) return fail(c, 400, "invalid_request", "jobId is required");
    const job = store.job(who, jobId);
    if (!job || job.documentId !== document.id) return fail(c, 404, "not_found", "job not found");
    if (job.status !== "completed" || !job.hasResult) return fail(c, 409, "invalid_state", "only a completed job with a result can be published");
    const result = publishResult(config.dataDir, job.id, document.id);
    if (!result) return fail(c, 409, "invalid_state", "job result is missing");
    store.setPublished(who, document.id, job.id, Date.now());
    return c.json({ document: store.document(who, document.id), pack: result.pack, review: result.review });
  });

  // ── 생성 작업 ──
  function startJob(c: Ctx, documentId: string, retryOf: string | null) {
    const who = c.get("who");
    const document = store.document(who, documentId);
    if (!document) return fail(c, 404, "not_found", "document not found");
    if (document.status !== "ready") return fail(c, 409, "invalid_state", "document is not ready");
    if (!provider) return fail(c, 503, "not_configured", "no model API key is configured on the server");
    const active = store.activeJobFor(who.workspace, document.id);
    if (active) {
      const mine = active.user === who.user ? store.job(who, active.id) : null;
      return c.json({ error: "a generation job is already active for this document", code: "conflict", ...(mine ? { job: mine } : {}) }, 409);
    }
    const job = store.createJob(who, document.id, retryOf);
    workers.enqueueJob(job.id);
    return c.json({ job: store.job(who, job.id) ?? job }, 202);
  }

  app.post("/jobs", async (c) => {
    const body = await jsonBody(c);
    const documentId = typeof body?.documentId === "string" && isId(body.documentId) ? body.documentId : null;
    if (!documentId) return fail(c, 400, "invalid_request", "documentId is required");
    return startJob(c, documentId, null);
  });

  app.get("/jobs", (c) => {
    const documentId = c.req.query("documentId");
    if (documentId !== undefined && !isId(documentId)) return fail(c, 400, "invalid_request", "invalid documentId");
    return c.json({ jobs: store.jobs(c.get("who"), documentId) });
  });

  function jobOr404(c: Ctx): ModuleJob | null {
    const id = c.req.param("id") ?? "";
    return isId(id) ? store.job(c.get("who"), id) : null;
  }

  app.get("/jobs/:id", (c) => {
    const job = jobOr404(c);
    return job ? c.json({ job }) : fail(c, 404, "not_found", "job not found");
  });

  app.get("/jobs/:id/result", (c) => {
    const job = jobOr404(c);
    if (!job) return fail(c, 404, "not_found", "job not found");
    const result = job.status === "completed" && job.hasResult ? readJobResult(config.dataDir, job.id) : null;
    return result ? c.json(result) : fail(c, 409, "invalid_state", "job has no result");
  });

  app.post("/jobs/:id/cancel", (c) => {
    const job = jobOr404(c);
    if (!job) return fail(c, 404, "not_found", "job not found");
    if (isTerminal(job.status) || !workers.cancelJob(job.id)) return fail(c, 409, "invalid_state", `job is already ${store.jobStatus(job.id) ?? job.status}`);
    return c.json({ job: store.job(c.get("who"), job.id) });
  });

  app.post("/jobs/:id/retry", (c) => {
    const job = jobOr404(c);
    if (!job) return fail(c, 404, "not_found", "job not found");
    if (job.status !== "failed" && job.status !== "cancelled") return fail(c, 409, "invalid_state", "only failed or cancelled jobs can be retried");
    return startJob(c, job.documentId, job.id);
  });

  // ── 학습 대화 ──
  const sourceDeps = { store, dataDir: config.dataDir, catalog: opts.catalog };

  app.get("/conversations", (c) => {
    const raw = c.req.query("source");
    let source: ModuleChatSource | undefined;
    if (raw !== undefined) {
      const parsed = parseSourceParam(raw);
      if (!parsed) return fail(c, 400, "invalid_request", "source must be document:<id> or lecture:<course>/<lecture>");
      source = parsed;
    }
    return c.json({ conversations: store.conversations(c.get("who"), source) });
  });

  app.post("/conversations", async (c) => {
    const who = c.get("who");
    const body = await jsonBody(c);
    const source = parseSourceBody(body?.source);
    if (!source) return fail(c, 400, "invalid_request", "source is required");
    const r = resolveSource(who, source, sourceDeps);
    if (!r.ok) return fail(c, r.status, r.code, r.error);
    const page = intOr(body?.page, null);
    if (page !== null && (page < 1 || page > r.data.pageCount)) return fail(c, 400, "invalid_request", "page out of range");
    if (body?.page !== undefined && body.page !== null && page === null) return fail(c, 400, "invalid_request", "page must be an integer");
    const conversation = store.createConversation(who, source, r.data.label.slice(0, 120), page);
    return c.json({ conversation }, 201);
  });

  function convOr404(c: Ctx) {
    const id = c.req.param("id") ?? "";
    return isId(id) ? store.conversation(c.get("who"), id) : null;
  }

  app.get("/conversations/:id", (c) => {
    const conversation = convOr404(c);
    if (!conversation) return fail(c, 404, "not_found", "conversation not found");
    return c.json({ conversation, messages: store.messages(c.get("who"), conversation.id) });
  });

  app.delete("/conversations/:id", (c) => {
    const conversation = convOr404(c);
    if (!conversation) return fail(c, 404, "not_found", "conversation not found");
    if (chatting.has(conversation.id)) return fail(c, 409, "busy", "conversation is answering");
    store.deleteConversation(c.get("who"), conversation.id);
    return c.json({ ok: true });
  });

  app.post("/conversations/:id/messages", async (c) => {
    const who = c.get("who");
    const conversation = convOr404(c);
    if (!conversation) return fail(c, 404, "not_found", "conversation not found");
    const body = await jsonBody(c);
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) return fail(c, 400, "invalid_request", "message is required");
    if (message.length > config.limits.maxMessageChars) return fail(c, 413, "too_large", `message must be at most ${config.limits.maxMessageChars} characters`);
    if (!provider) return fail(c, 503, "not_configured", "no model API key is configured on the server");
    const r = resolveSource(who, conversation.source, sourceDeps);
    if (!r.ok) return fail(c, r.status, r.code, r.error);
    const page = intOr(body?.page, conversation.page);
    if (page !== null && (page < 1 || page > r.data.pageCount)) return fail(c, 400, "invalid_request", "page out of range");
    if (chatting.has(conversation.id)) return fail(c, 409, "busy", "conversation is already answering");
    const abort = new AbortController();
    chatting.set(conversation.id, { abort, workspace: who.workspace, source: sourceKey(conversation.source) });

    let history: ModuleChatMessage[];
    let userMessage: ModuleChatMessage;
    try {
      history = store.messages(who, conversation.id);
      userMessage = store.addMessage(who, conversation.id, { id: newId(), role: "user", content: message, page, status: "complete" });
    } catch (e) {
      chatting.delete(conversation.id);
      throw e;
    }
    const assistantId = newId();
    const clientSignal = c.req.raw.signal;
    const onClientAbort = () => abort.abort("client");
    clientSignal.addEventListener("abort", onClientAbort, { once: true });
    const encoder = new TextEncoder();

    const body$ = new ReadableStream<Uint8Array>({
      start(ctl) {
        let open = true;
        const write = (chunk: string) => {
          if (!open) return;
          try { ctl.enqueue(encoder.encode(chunk)); } catch { open = false; }
        };
        const send = (e: ModuleChatEvent) => write(sseFrame(e.event, e.data));
        const heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
        send({ event: "meta", data: { conversationId: conversation.id, userMessageId: userMessage.id, assistantMessageId: assistantId, model: provider.model } });

        let text = "";
        (async () => {
          try {
            const out = await runChat({
              provider, config, source: r.data, history, message, page, signal: abort.signal,
              onText: (t) => { if (abort.signal.aborted) return; text += t; send({ event: "delta", data: { text: t } }); },
              onTool: (t) => send({ event: "tool", data: t }),
            });
            if (abort.signal.aborted) throw abortError();   // 끝나는 순간 취소되었으면 완료로 저장하지 않음
            if (!out.text.trim()) throw new ProviderError("protocol", "model returned an empty answer");
            const saved = store.addMessage(who, conversation.id, {
              id: assistantId, role: "assistant", content: out.text, page, citations: out.citations, status: "complete",
              error: out.truncated ? "답이 길어 중간에 잘렸습니다." : null,
            });
            send({ event: "citations", data: { citations: out.citations } });
            send({ event: "done", data: { message: saved } });
          } catch (e) {
            const cancelled = abort.signal.aborted || isAbort(e);
            const code = cancelled ? "cancelled" : e instanceof ProviderError ? e.code : "internal";
            // 저장 전에 비밀값을 지움(제공자 문구는 provider.ts 에서 이미 지웠지만 한 번 더)
            const error = redact(cancelled
              ? abort.signal.reason === "deleted" ? "자료가 삭제되어 답을 멈췄습니다." : "사용자가 답을 멈췄습니다."
              : e instanceof ProviderError ? e.message : "답을 만드는 중 서버 오류가 났습니다.", config);
            if (!cancelled && !(e instanceof ProviderError)) (opts.log ?? console.error)(`[module] chat failed: ${redact(String((e as Error)?.stack ?? e), config)}`);
            let saved;
            try {
              saved = store.addMessage(who, conversation.id, { id: assistantId, role: "assistant", content: text, page, status: cancelled ? "cancelled" : "failed", error });
            } catch { /* 그사이 대화가 지워짐 */ }
            send({ event: "error", data: { code, error, ...(saved ? { message: saved } : {}) } });
          } finally {
            clearInterval(heartbeat);
            clientSignal.removeEventListener("abort", onClientAbort);
            chatting.delete(conversation.id);
            if (open) { open = false; try { ctl.close(); } catch { /* 이미 닫힘 */ } }
          }
        })();
      },
      cancel() { abort.abort(); },
    });
    return new Response(body$, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" },
    });
  });

  return {
    app, store, workers,
    close() { workers.stop(); store.close(); },
  };
}
