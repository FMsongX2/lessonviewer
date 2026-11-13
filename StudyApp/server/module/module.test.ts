// 모듈 경계 동작 테스트: 신원·범위 격리, 작업 상태 전이, SSE/제공자 프로토콜 해석, 인용 검증.
// 실제 모델·PDF 렌더러는 쓰지 않음(fetch 와 추출·생성 함수를 바꿔 끼움). 실행: bun test server/module

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleChatMessage, ModuleDocument, ModuleJob } from "../../shared/agent";
import type { GenerateInput } from "../generation";
import { authenticate } from "./auth";
import { extractCitations, searchPages } from "./chat";
import { loadModuleConfig, type ModuleConfig } from "./config";
import { createModule, type ModuleInstance } from "./index";
import { createProvider, ProviderError, readAnthropicStream, readOpenAIStream, type FetchLike } from "./provider";
import type { ChatSourceData, SourcePage } from "./sources";
import { parseSSE } from "./sse";
import { canTransition, JobTransitionError, openModuleStore } from "./store";

const TOKEN = "t".repeat(40);
const API_KEY = "sk-ant-test-SECRET-0123456789";
const LOCAL_ENV = { requestIP: () => ({ address: "127.0.0.1" }) };
const REMOTE_ENV = { requestIP: () => ({ address: "203.0.113.9" }) };

const streamOf = (...chunks: string[]) => new ReadableStream<Uint8Array>({
  start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close(); },
});
const sse = (events: [string, unknown][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");

// ── 테스트용 모듈 ──
const dirs: string[] = [];
const instances: ModuleInstance[] = [];
afterEach(() => {
  for (const m of instances.splice(0)) m.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function configFor(dataDir: string, extra: Record<string, string> = {}): ModuleConfig {
  return loadModuleConfig({ LESSONVIEWER_API_KEY: API_KEY, LESSONVIEWER_HOST_TOKEN: TOKEN, LESSONVIEWER_DATA_DIR: dataDir, LESSONVIEWER_MODEL: "test-model", ...extra }, "/nonexistent", () => null);
}

function fakeGen() {
  const gen = {
    calls: [] as GenerateInput[],
    release: null as null | (() => void),
    started: Promise.withResolvers<void>(),
    async extractPdf(o: { outDir: string }) {
      mkdirSync(join(o.outDir, "model"), { recursive: true });
      const pages = [1, 2, 3].map((page) => {
        const image = `${String(page).padStart(3, "0")}.jpg`;
        writeFileSync(join(o.outDir, image), "jpg");
        writeFileSync(join(o.outDir, "model", image), "jpg");
        return { page, text: page === 2 ? "Merkle tree hashes pairs of leaves" : `page ${page} text`, textTruncated: false, image, modelImage: `model/${image}`, width: 100, height: 75, imageBytes: 3, modelImageBytes: 3 };
      });
      const m = { version: 1 as const, pageCount: 3, sha256: "x", bytes: 10, title: null, width: 100, height: 75, pages };
      writeFileSync(join(o.outDir, "extract.json"), JSON.stringify(m));
      return m;
    },
    // release() 를 부를 때까지 기다려서 취소 시점을 시험할 수 있게 함
    async generatePack(i: GenerateInput) {
      gen.calls.push(i);
      gen.started.resolve();
      await new Promise<void>((resolve, reject) => {
        gen.release = resolve;
        i.signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "GenerationError", code: "cancelled" })), { once: true });
      });
      return {
        pack: { lecture: i.lecture, question: "Q?", story: [], slides: [1, 2, 3].map((page) => ({ page, tag: "core" as const, title: `t${page}`, explain: "e" })) },
        review: { "2": "check" }, usage: { inputTokens: 1, outputTokens: 1, calls: 1 }, warnings: [],
      };
    },
  };
  return gen;
}

function setup(fetchImpl?: FetchLike, extra?: Record<string, string>) {
  const dataDir = mkdtempSync(join(tmpdir(), "lv-module-"));
  dirs.push(dataDir);
  const gen = fakeGen();
  const mod = createModule({ config: configFor(dataDir, extra), catalog: null, gen: gen as never, fetch: fetchImpl, log: () => {} });
  instances.push(mod);
  return { mod, gen, dataDir };
}

const host = (ws: string, user: string, init: RequestInit = {}): RequestInit => ({
  ...init, headers: { authorization: `Bearer ${TOKEN}`, "x-lessonviewer-workspace": ws, "x-lessonviewer-user": user, ...(init.headers as Record<string, string>) },
});
const json = (body: unknown, init: RequestInit = {}): RequestInit => ({
  ...init, method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
});

async function upload(mod: ModuleInstance, init: (i: RequestInit) => RequestInit): Promise<ModuleDocument> {
  const form = new FormData();
  form.append("file", new File(["%PDF-1.7\n..."], "/Users/someone/secret/notes.pdf", { type: "application/pdf" }));
  const res = await mod.app.request("/documents", init({ method: "POST", body: form }), REMOTE_ENV);
  expect(res.status).toBe(201);
  const { document } = await res.json() as { document: ModuleDocument };
  await mod.workers.idle();
  return document;
}

// ── 신원 ──
describe("authenticate", () => {
  const req = (headers: Record<string, string>, method = "GET") => new Request("http://localhost:5178/api/module/status", { method, headers });
  test("remote request without token is refused", () => {
    expect(authenticate(req({ host: "localhost:5178" }), REMOTE_ENV, TOKEN)).toMatchObject({ ok: false, status: 403 });
  });
  test("identity headers are ignored without a valid token", () => {
    expect(authenticate(req({ authorization: "Bearer wrong", "x-lessonviewer-workspace": "a", "x-lessonviewer-user": "u" }), REMOTE_ENV, TOKEN)).toMatchObject({ ok: false, status: 401 });
    expect(authenticate(req({ authorization: `Bearer ${TOKEN}`, "x-lessonviewer-workspace": "a", "x-lessonviewer-user": "u" }), REMOTE_ENV, null)).toMatchObject({ ok: false, status: 403 });
  });
  test("valid token yields a namespaced host identity", () => {
    expect(authenticate(req({ authorization: `Bearer ${TOKEN}`, "x-lessonviewer-workspace": "acme", "x-lessonviewer-user": "u1" }), REMOTE_ENV, TOKEN))
      .toEqual({ ok: true, identity: { workspace: "h:acme", user: "u1", mode: "host" } });
    expect(authenticate(req({ authorization: `Bearer ${TOKEN}`, "x-lessonviewer-workspace": "../x", "x-lessonviewer-user": "u1" }), REMOTE_ENV, TOKEN).ok).toBe(false);
  });
  test("local requires loopback, local Host, no proxy headers, and X-StudyApp for writes", () => {
    expect(authenticate(req({ host: "localhost:5178" }), LOCAL_ENV, null)).toMatchObject({ ok: true, identity: { mode: "local" } });
    expect(authenticate(req({ host: "evil.example:5178" }), LOCAL_ENV, null).ok).toBe(false);
    expect(authenticate(req({ host: "localhost:5178", "x-forwarded-for": "1.2.3.4" }), LOCAL_ENV, null).ok).toBe(false);
    expect(authenticate(req({ host: "localhost:5178", "sec-fetch-site": "cross-site" }), LOCAL_ENV, null).ok).toBe(false);
    expect(authenticate(req({ host: "localhost:5178" }, "POST"), LOCAL_ENV, null).ok).toBe(false);
    expect(authenticate(req({ host: "localhost:5178", "x-studyapp": "1" }, "POST"), LOCAL_ENV, null).ok).toBe(true);
  });
});

describe("config", () => {
  test("invalid base URL fails closed and never resolves the key reference", () => {
    let asked = false;
    const c = loadModuleConfig({ LESSONVIEWER_API_BASE_URL: "https://user:pw@example.com/v1", LESSONVIEWER_KEY_REF: "api.x" }, "/r", () => { asked = true; return "k"; });
    expect(c.apiKey).toBeNull();
    expect(asked).toBe(false);
    expect(c.issue).toContain("LESSONVIEWER_API_BASE_URL");
  });
  test("env key wins over reference; failed reference leaves module unconfigured without leaking the ref", () => {
    expect(loadModuleConfig({ LESSONVIEWER_API_KEY: "a", LESSONVIEWER_KEY_REF: "r" }, "/r", () => "b").apiKey).toBe("a");
    const c = loadModuleConfig({ LESSONVIEWER_KEY_REF: "api.anthropic.key" }, "/r", () => null);
    expect(c.apiKey).toBeNull();
    expect(c.issue).not.toContain("api.anthropic.key");
  });
});

// ── 범위 격리 ──
describe("ownership isolation", () => {
  test("documents are per workspace, jobs and conversations per user", async () => {
    const { mod, gen } = setup();
    const doc = await upload(mod, (i) => host("acme", "alice", i));
    expect(doc.fileName).toBe("notes.pdf");   // 경로가 남지 않음
    expect(doc.title).toBe("notes");

    // 다른 workspace 에서는 보이지도 않음
    expect((await (await mod.app.request("/documents", host("other", "alice"), REMOTE_ENV)).json()).documents).toEqual([]);
    expect((await mod.app.request(`/documents/${doc.id}`, host("other", "alice"), REMOTE_ENV)).status).toBe(404);
    expect((await mod.app.request(`/documents/${doc.id}/pages/1/image`, host("other", "alice"), REMOTE_ENV)).status).toBe(404);
    // 로컬 신원도 호스트 문서를 볼 수 없음
    expect((await (await mod.app.request("/documents", { headers: { host: "localhost:5178" } }, LOCAL_ENV)).json()).documents).toEqual([]);

    // 같은 workspace 의 다른 사용자: 문서는 보이지만 작업은 남의 것
    expect((await mod.app.request(`/documents/${doc.id}`, host("acme", "bob"), REMOTE_ENV)).status).toBe(200);
    const started = await mod.app.request("/jobs", json({ documentId: doc.id }, host("acme", "alice")), REMOTE_ENV);
    expect(started.status).toBe(202);
    const { job } = await started.json() as { job: ModuleJob };
    expect((await mod.app.request(`/jobs/${job.id}`, host("acme", "bob"), REMOTE_ENV)).status).toBe(404);
    expect((await mod.app.request(`/jobs/${job.id}/cancel`, json({}, host("acme", "bob")), REMOTE_ENV)).status).toBe(404);
    // 같은 문서에 두 번째 작업은 중복 비용이라 거절
    expect((await mod.app.request("/jobs", json({ documentId: doc.id }, host("acme", "bob")), REMOTE_ENV)).status).toBe(409);

    const conv = await mod.app.request("/conversations", json({ source: { kind: "document", documentId: doc.id } }, host("acme", "alice")), REMOTE_ENV);
    expect(conv.status).toBe(201);
    const { conversation } = await conv.json() as { conversation: { id: string } };
    expect((await mod.app.request(`/conversations/${conversation.id}`, host("acme", "bob"), REMOTE_ENV)).status).toBe(404);
    expect((await (await mod.app.request(`/conversations?source=document:${doc.id}`, host("acme", "bob"), REMOTE_ENV)).json()).conversations).toEqual([]);

    // 호스트는 기존 강의 자료를 출처로 쓸 수 없음
    expect((await mod.app.request("/conversations", json({ source: { kind: "lecture", course: "database", lecture: "w01" } }, host("acme", "alice")), REMOTE_ENV)).status).toBe(403);
    gen.release?.();
    await mod.workers.idle();
  });
});

// ── 작업 상태 ──
describe("job transitions", () => {
  test("transition table forbids leaving terminal states", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "completed")).toBe(true);
    for (const t of ["completed", "failed", "cancelled"] as const) for (const to of ["queued", "running", "completed", "failed", "cancelled"] as const) expect(canTransition(t, to)).toBe(false);
    expect(canTransition("queued", "completed")).toBe(false);
  });

  test("store refuses invalid transitions", () => {
    const store = openModuleStore(":memory:");
    const who = { workspace: "w", user: "u", mode: "local" as const };
    store.createDocument(who, { id: crypto.randomUUID(), title: "t", fileName: "f.pdf", bytes: 1 });
    const docId = store.documents(who)[0].id;
    const job = store.createJob(who, docId, null);
    expect(() => store.transition(job.id, "completed")).toThrow(JobTransitionError);
    expect(store.transition(job.id, "running")).toBe(true);
    expect(store.transition(job.id, "completed", { hasResult: true })).toBe(true);
    expect(() => store.transition(job.id, "cancelled")).toThrow(JobTransitionError);
    store.close();
  });

  test("complete → publish; cancel, retry and publish guard their states", async () => {
    const { mod, gen } = setup();
    const doc = await upload(mod, (i) => host("acme", "alice", i));
    const h = (i: RequestInit = {}) => host("acme", "alice", i);
    const { job } = await (await mod.app.request("/jobs", json({ documentId: doc.id }, h()), REMOTE_ENV)).json() as { job: ModuleJob };
    expect((await mod.app.request(`/documents/${doc.id}/publish`, json({ jobId: job.id }, h()), REMOTE_ENV)).status).toBe(409);
    expect((await mod.app.request(`/jobs/${job.id}/retry`, json({}, h()), REMOTE_ENV)).status).toBe(409);
    gen.release?.();
    await mod.workers.idle();
    const done = (await (await mod.app.request(`/jobs/${job.id}`, h(), REMOTE_ENV)).json()).job as ModuleJob;
    expect(done.status).toBe("completed");
    expect((await mod.app.request(`/jobs/${job.id}/cancel`, json({}, h()), REMOTE_ENV)).status).toBe(409);
    // 게시 전에는 문서에 해설이 없음
    expect((await (await mod.app.request(`/documents/${doc.id}`, h(), REMOTE_ENV)).json()).pack).toBeNull();
    expect((await mod.app.request(`/documents/${doc.id}/publish`, json({ jobId: job.id }, h()), REMOTE_ENV)).status).toBe(200);
    const detail = await (await mod.app.request(`/documents/${doc.id}`, h(), REMOTE_ENV)).json();
    expect(detail.pack.slides).toHaveLength(3);
    expect(detail.review).toEqual({ "2": "check" });
    expect(detail.document.published.jobId).toBe(job.id);
  });

  test("cancel aborts a running job and leaves no result; retry is explicit", async () => {
    const { mod, gen } = setup();
    const doc = await upload(mod, (i) => host("acme", "alice", i));
    const h = (i: RequestInit = {}) => host("acme", "alice", i);
    const { job } = await (await mod.app.request("/jobs", json({ documentId: doc.id }, h()), REMOTE_ENV)).json() as { job: ModuleJob };
    await gen.started.promise;   // 작업이 실제로 generatePack 안에 들어간 뒤 취소함
    const res = await mod.app.request(`/jobs/${job.id}/cancel`, json({}, h()), REMOTE_ENV);
    expect(res.status).toBe(200);
    expect(gen.calls[0].signal.aborted).toBe(true);
    await mod.workers.idle();
    const after = (await (await mod.app.request(`/jobs/${job.id}`, h(), REMOTE_ENV)).json()).job as ModuleJob;
    expect(after.status).toBe("cancelled");
    expect(after.hasResult).toBe(false);
    expect((await mod.app.request(`/jobs/${job.id}/result`, h(), REMOTE_ENV)).status).toBe(409);
    const retry = await mod.app.request(`/jobs/${job.id}/retry`, json({}, h()), REMOTE_ENV);
    expect(retry.status).toBe(202);
    expect(((await retry.json()).job as ModuleJob).retryOf).toBe(job.id);
    gen.release?.();
    await mod.workers.idle();
  });

  test("restart marks unfinished jobs interrupted instead of re-running them", async () => {
    const { mod, dataDir } = setup();
    const doc = await upload(mod, (i) => host("acme", "alice", i));
    const { job } = await (await mod.app.request("/jobs", json({ documentId: doc.id }, host("acme", "alice")), REMOTE_ENV)).json() as { job: ModuleJob };
    mod.workers.stop();
    mod.store.close();
    instances.splice(instances.indexOf(mod), 1);
    const gen2 = fakeGen();
    const again = createModule({ config: configFor(dataDir), catalog: null, gen: gen2 as never, log: () => {} });
    instances.push(again);
    const j = (await (await again.app.request(`/jobs/${job.id}`, host("acme", "alice"), REMOTE_ENV)).json()).job as ModuleJob;
    expect(j.status).toBe("failed");
    expect(j.error?.code).toBe("interrupted");
    expect(gen2.calls).toHaveLength(0);
  });

  test("missing key: job and chat report not_configured", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lv-module-"));
    dirs.push(dataDir);
    const mod = createModule({ config: loadModuleConfig({ LESSONVIEWER_HOST_TOKEN: TOKEN, LESSONVIEWER_DATA_DIR: dataDir }, "/r", () => null), catalog: null, gen: fakeGen() as never, log: () => {} });
    instances.push(mod);
    const status = await (await mod.app.request("/status", host("a", "u"), REMOTE_ENV)).json();
    expect(status.configured).toBe(false);
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    const doc = await upload(mod, (i) => host("a", "u", i));
    const r = await mod.app.request("/jobs", json({ documentId: doc.id }, host("a", "u")), REMOTE_ENV);
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe("not_configured");
  });
});

// ── SSE / 제공자 ──
describe("parseSSE", () => {
  test("handles split chunks, CRLF, comments, multi-line data and a final unterminated event", async () => {
    const out = [];
    for await (const e of parseSSE(streamOf(": hi\r\nevent: a\r", "\ndata: 1\r\ndata: 2\r\n\r\n", "data: {\"x\"", ":3}"))) out.push(e);
    expect(out).toEqual([{ event: "a", data: "1\n2" }, { event: "message", data: '{"x":3}' }]);
  });
});

describe("provider protocol", () => {
  test("anthropic stream: text deltas and tool_use with partial JSON", async () => {
    const texts: string[] = [];
    const turn = await readAnthropicStream(streamOf(sse([
      ["message_start", { type: "message_start", message: { usage: { input_tokens: 11, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "찾아" } }],
      ["ping", { type: "ping" }],
      ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "read_page", input: {} } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"pa' } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'ge":2}' } }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }],
      ["message_stop", { type: "message_stop" }],
    ])), (t) => texts.push(t));
    expect(turn).toEqual({ text: "찾아", toolCalls: [{ id: "tu_1", name: "read_page", input: { page: 2 } }], stopReason: "tool_use", usage: { inputTokens: 11, outputTokens: 7 } });
    expect(texts).toEqual(["찾아"]);
  });

  test("anthropic stream: error event and truncated stream are errors, not answers", async () => {
    const overloaded = readAnthropicStream(streamOf(sse([["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]])));
    await expect(overloaded).rejects.toMatchObject({ code: "server" });
    const cut = readAnthropicStream(streamOf(sse([["message_start", { type: "message_start", message: { usage: {} } }]])));
    await expect(cut).rejects.toMatchObject({ code: "network" });
  });

  test("openai-compatible stream: split tool call arguments and usage", async () => {
    const chunk = (d: unknown) => `data: ${JSON.stringify(d)}\n\n`;
    const turn = await readOpenAIStream(streamOf(
      chunk({ choices: [{ delta: { content: "음" } }] }),
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "search_source", arguments: '{"que' } }] } }] }),
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"merkle"}' } }] }, finish_reason: "tool_calls" }] }),
      chunk({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } }),
      "data: [DONE]\n\n",
    ));
    expect(turn).toEqual({ text: "음", toolCalls: [{ id: "c1", name: "search_source", input: { query: "merkle" } }], stopReason: "tool_use", usage: { inputTokens: 5, outputTokens: 3 } });
  });

  test("malformed tool arguments are a protocol error", async () => {
    const chunk = (d: unknown) => `data: ${JSON.stringify(d)}\n\n`;
    await expect(readOpenAIStream(streamOf(chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "read_page", arguments: "{bad" } }] }, finish_reason: "tool_calls" }] }), "data: [DONE]\n\n")))
      .rejects.toMatchObject({ code: "protocol" });
  });

  test("HTTP errors map to codes and never echo the key; requests use native headers", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ error: { message: `invalid x-api-key ${API_KEY}` } }), { status: 401, headers: { "content-type": "application/json" } });
    };
    const p = createProvider(configFor("/tmp/unused"), fetchImpl)!;
    const err = await p.stream({ system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], maxTokens: 10, signal: new AbortController().signal }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("auth");
    expect(err.message).not.toContain(API_KEY);
    expect(seen).toHaveLength(1);   // 인증 오류는 다시 시도하지 않음
    expect(seen[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0].headers["x-api-key"]).toBe(API_KEY);
    expect(seen[0].headers["anthropic-version"]).toBe("2023-06-01");
  });

  test("non-streaming response is rejected instead of being parsed as an answer", async () => {
    const p = createProvider(configFor("/tmp/unused"), async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))!;
    await expect(p.callModel({ purpose: "pages", system: "s", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }], maxTokens: 10, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "protocol" });
  });
});

// ── 인용 ──
describe("citations", () => {
  const pages: SourcePage[] = [1, 2, 3].map((page) => ({ page, text: page === 2 ? "A Merkle  tree hashes pairs." : `p${page}`, title: `T${page}`, explain: null, imagePath: null }));
  const source: ChatSourceData = { label: "doc", pageCount: 3, page: (n) => pages[n - 1] ?? null, pages: () => pages };

  test("keeps only consulted, existing pages and verified quotes", () => {
    const text = '설명 [p.2 "Merkle tree hashes"] 그리고 [p.3] 또 [p.9] 그리고 [p.1 "invented quote"]';
    expect(extractCitations(text, source, new Set([1, 2]))).toEqual([{ page: 1, title: "T1" }, { page: 2, title: "T2", quote: "Merkle tree hashes" }]);
  });

  test("search ranks matching pages", () => {
    expect(searchPages(source, "merkle")[0].page).toBe(2);
    expect(searchPages(source, "zzz")).toEqual([]);
  });
});

// ── 대화 흐름(가짜 Anthropic 서버) ──
describe("chat SSE", () => {
  test("tool step, streamed answer, validated citations, persisted turns", async () => {
    const bodies: { tools?: { name: string }[]; messages: { content: { type: string }[] }[] }[] = [];
    const turns = [
      sse([
        ["message_start", { type: "message_start", message: { usage: { input_tokens: 10 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "read_page", input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"page":2}' } }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } }],
        ["message_stop", { type: "message_stop" }],
      ]),
      sse([
        ["message_start", { type: "message_start", message: { usage: { input_tokens: 20 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "머클 트리는 [p.2]" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " 입니다 [p.3]." } }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }],
        ["message_stop", { type: "message_stop" }],
      ]),
    ];
    const fetchImpl: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(turns.shift()!, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const { mod } = setup(fetchImpl);
    const doc = await upload(mod, (i) => host("acme", "alice", i));
    const { conversation } = await (await mod.app.request("/conversations", json({ source: { kind: "document", documentId: doc.id } }, host("acme", "alice")), REMOTE_ENV)).json();
    const res = await mod.app.request(`/conversations/${conversation.id}/messages`, json({ message: "머클 트리가 뭐예요?" }, host("acme", "alice")), REMOTE_ENV);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = [];
    for await (const e of parseSSE(res.body!)) events.push({ event: e.event, data: JSON.parse(e.data) });
    expect(events.map((e) => e.event)).toEqual(["meta", "tool", "delta", "delta", "citations", "done"]);
    // 3쪽은 이번 답에서 보지 않았으므로 인용으로 인정하지 않음
    expect(events[4].data.citations).toEqual([{ page: 2, title: "Merkle tree hashes pairs of leaves" }]);
    const { messages } = await (await mod.app.request(`/conversations/${conversation.id}`, host("acme", "alice"), REMOTE_ENV)).json() as { messages: ModuleChatMessage[] };
    expect(messages.map((m) => [m.role, m.status])).toEqual([["user", "complete"], ["assistant", "complete"]]);
    expect(messages[1].content).toBe("머클 트리는 [p.2] 입니다 [p.3].");
  });

  test("provider failure is reported as an SSE error and persisted as failed", async () => {
    const { mod } = setup(async () => new Response("{}", { status: 400, headers: { "content-type": "application/json" } }));
    const doc = await upload(mod, (i) => host("acme", "alice", i));
    const { conversation } = await (await mod.app.request("/conversations", json({ source: { kind: "document", documentId: doc.id } }, host("acme", "alice")), REMOTE_ENV)).json();
    const res = await mod.app.request(`/conversations/${conversation.id}/messages`, json({ message: "hi" }, host("acme", "alice")), REMOTE_ENV);
    const events = [];
    for await (const e of parseSSE(res.body!)) events.push(e.event);
    expect(events).toEqual(["meta", "error"]);
    const { messages } = await (await mod.app.request(`/conversations/${conversation.id}`, host("acme", "alice"), REMOTE_ENV)).json() as { messages: ModuleChatMessage[] };
    expect(messages[1].status).toBe("failed");
  });
});

// ── 보안 검토 반영 ──
const SSE_HEADERS = { "content-type": "text/event-stream" };
const textTurn = (s: string) => sse([
  ["message_start", { type: "message_start", message: { usage: { input_tokens: 1 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s } }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
  ["message_stop", { type: "message_stop" }],
]);

async function startConversation(mod: ModuleInstance) {
  const doc = await upload(mod, (i) => host("acme", "alice", i));
  const { conversation } = await (await mod.app.request("/conversations", json({ source: { kind: "document", documentId: doc.id } }, host("acme", "alice")), REMOTE_ENV)).json();
  return { doc, conversationId: conversation.id as string };
}

describe("secret redaction", () => {
  test("streamed provider error text is redacted before it is persisted or sent", async () => {
    const leak = sse([["error", { type: "error", error: { type: "invalid_request_error", message: `bad key ${API_KEY}` } }]]);
    const { mod } = setup(async () => new Response(leak, { status: 200, headers: SSE_HEADERS }));
    const { conversationId } = await startConversation(mod);
    const res = await mod.app.request(`/conversations/${conversationId}/messages`, json({ message: "hi" }, host("acme", "alice")), REMOTE_ENV);
    expect(await res.text()).not.toContain(API_KEY);
    const stored = await (await mod.app.request(`/conversations/${conversationId}`, host("acme", "alice"), REMOTE_ENV)).text();
    expect(stored).not.toContain(API_KEY);
    expect(stored).toContain("[redacted]");
  });
});

describe("document deletion", () => {
  test("stops answers that are reading the deleted document", async () => {
    let calls = 0;
    let providerSignal: AbortSignal | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      calls++;
      providerSignal = init.signal ?? undefined;
      const first = textTurn("부분").split("event: message_delta")[0];   // 끝나지 않는 스트림
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(first));
          init.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: SSE_HEADERS });
    };
    const { mod } = setup(fetchImpl);
    const { doc, conversationId } = await startConversation(mod);
    const res = await mod.app.request(`/conversations/${conversationId}/messages`, json({ message: "설명해 줘" }, host("acme", "alice")), REMOTE_ENV);
    const it = parseSSE(res.body!)[Symbol.asyncIterator]();
    const seen: string[] = [];
    for (;;) {
      const { value } = await it.next();
      seen.push(value!.event);
      if (value!.event === "delta") break;
    }
    // 같은 workspace 의 다른 사용자가 지워도 멈춤
    expect((await mod.app.request(`/documents/${doc.id}`, host("acme", "bob", { method: "DELETE" }), REMOTE_ENV)).status).toBe(200);
    const rest = [];
    for (let r = await it.next(); !r.done; r = await it.next()) rest.push({ event: r.value.event, data: JSON.parse(r.value.data) });
    expect(seen).toEqual(["meta", "delta"]);
    expect(rest.map((e) => e.event)).toEqual(["error"]);
    expect(rest[0].data.code).toBe("cancelled");
    expect(providerSignal?.aborted).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("chat budgets", () => {
  test("a batch of many tool calls is capped, deduplicated and answered protocol-correctly", async () => {
    const bodies: { messages: { role: string; content: { type: string; is_error?: boolean; content?: { type: string; text?: string }[] }[] }[] }[] = [];
    const calls = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, page: (i % 3) + 1 }));
    const turns = [
      sse([
        ["message_start", { type: "message_start", message: { usage: { input_tokens: 1 } } }],
        ...calls.flatMap((c, i): [string, unknown][] => [
          ["content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: c.id, name: "read_page", input: {} } }],
          ["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify({ page: c.page }) } }],
        ]),
        ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ]),
      textTurn("끝 [p.1]"),
    ];
    const { mod } = setup(async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(turns.shift()!, { status: 200, headers: SSE_HEADERS });
    });
    const { conversationId } = await startConversation(mod);
    const res = await mod.app.request(`/conversations/${conversationId}/messages`, json({ message: "모든 쪽 다 읽어" }, host("acme", "alice")), REMOTE_ENV);
    await res.text();
    expect(bodies).toHaveLength(2);
    const results = bodies[1].messages.at(-1)!.content.filter((b) => b.type === "tool_result");
    expect(results).toHaveLength(20);                              // tool_use 마다 결과 하나
    const errors = results.filter((r) => r.is_error);
    expect(errors).toHaveLength(20 - 8);                           // maxToolCalls(4) = 8
    const images = results.flatMap((r) => r.content ?? []).filter((p) => p.type === "image");
    expect(images).toHaveLength(3);                                // 같은 쪽은 다시 붙이지 않음
    expect(results.filter((r) => r.content?.some((p) => p.text?.includes("이미 받았음")))).toHaveLength(5);
  });
});

describe("request body limits", () => {
  const chunked = (bytes: number) => new ReadableStream<Uint8Array>({
    start(c) { for (let left = bytes; left > 0; left -= 16_384) c.enqueue(new Uint8Array(Math.min(16_384, left)).fill(32)); c.close(); },
  });

  test("oversized JSON without Content-Length is refused while reading", async () => {
    const { mod } = setup();
    const res = await mod.app.request("/jobs", host("acme", "alice", { method: "POST", body: chunked(200_000), headers: { "content-type": "application/json" }, duplex: "half" } as RequestInit), REMOTE_ENV);
    expect(res.status).toBe(413);
  });

  test("multipart total size and extra parts are enforced", async () => {
    const { mod } = setup(undefined, { LESSONVIEWER_MAX_FILE_BYTES: "2048" });
    const extra = new FormData();
    extra.append("file", new File(["%PDF-1.7\n"], "a.pdf"));
    extra.append("junk", "x");
    expect((await mod.app.request("/documents", host("acme", "alice", { method: "POST", body: extra }), REMOTE_ENV)).status).toBe(400);

    const big = new FormData();
    big.append("file", new File(["%PDF-1.7\n"], "a.pdf"));
    big.append("title", "t".repeat(2 * 1024 * 1024));
    const raw = new Request("http://x/", { method: "POST", body: big });
    const res = await mod.app.request("/documents", host("acme", "alice", {
      method: "POST", body: raw.body, headers: { "content-type": raw.headers.get("content-type")! }, duplex: "half",
    } as RequestInit), REMOTE_ENV);
    expect(res.status).toBe(413);
  });
});
