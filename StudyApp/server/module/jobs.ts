// 뒤에서 도는 일: PDF 추출(업로드 직후)과 해설 생성 작업.
// 생성 작업은 큐로 하나씩(LESSONVIEWER_JOB_CONCURRENCY) 돌리고, 취소하면 모델 요청까지 끊음.
// 결과는 작업 폴더에만 쓰고, 게시(publish)는 사용자가 명시적으로 요청할 때만 문서 폴더로 옮김.

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModuleJobErrorCode } from "../../shared/agent";
import type { Pack } from "../../shared/types";
import type { extractPdf as ExtractPdf, generatePack as GeneratePack } from "../generation";
import { redact, type ModuleConfig } from "./config";
import { isAbort, ProviderError, type Provider } from "./provider";
import { documentDir, extractDir, publishedDir } from "./sources";
import type { ModuleStore } from "./store";

export interface GenerationApi { extractPdf: typeof ExtractPdf; generatePack: typeof GeneratePack }

export const jobDir = (dataDir: string, id: string) => join(dataDir, "jobs", id);
const resultDir = (dataDir: string, id: string) => join(jobDir(dataDir, id), "result");

// 디렉터리를 통째로 바꿔 끼움: 다 쓴 임시 폴더를 이름만 바꿔서, 읽는 쪽이 반쯤 쓴 파일을 보지 않게 함
function writeDirAtomic(target: string, files: Record<string, string>) {
  const tmp = `${target}.tmp-${crypto.randomUUID()}`;
  mkdirSync(tmp, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(tmp, name), body);
  const old = `${target}.old-${crypto.randomUUID()}`;
  if (existsSync(target)) renameSync(target, old);
  renameSync(tmp, target);
  rmSync(old, { recursive: true, force: true });
}

export function readJobResult(dataDir: string, id: string): { pack: Pack; review: Record<string, string> } | null {
  const dir = resultDir(dataDir, id);
  try {
    return { pack: JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")), review: JSON.parse(readFileSync(join(dir, "review.json"), "utf8")) };
  } catch { return null; }
}

export function publishResult(dataDir: string, jobId: string, documentId: string): { pack: Pack; review: Record<string, string> } | null {
  const result = readJobResult(dataDir, jobId);
  if (!result) return null;
  writeDirAtomic(publishedDir(dataDir, documentId), {
    "pack.json": JSON.stringify(result.pack, null, 2),
    "review.json": JSON.stringify(result.review, null, 2),
  });
  return result;
}

export interface Workers {
  enqueueExtraction(documentId: string): void;
  enqueueJob(jobId: string): void;
  cancelJob(jobId: string): boolean;
  removeDocument(documentId: string, jobIds: string[]): void;
  idle(): Promise<void>;
  stop(): void;
}

export function createWorkers(deps: { store: ModuleStore; config: ModuleConfig; provider: Provider | null; gen: GenerationApi; log?: (msg: string) => void }): Workers {
  const { store, config, gen } = deps;
  const log = (m: string) => (deps.log ?? console.error)(`[module] ${redact(m, config)}`);
  const pdfPath = (docId: string) => join(documentDir(config.dataDir, docId), "source.pdf");

  // ── 추출 ──
  const extracting = new Map<string, AbortController>();
  const extractQueue: string[] = [];
  const pending = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => { pending.add(p); p.finally(() => pending.delete(p)); };

  function pumpExtraction() {
    if (extracting.size > 0) return;
    const id = extractQueue.shift();
    if (!id) return;
    const ctl = new AbortController();
    extracting.set(id, ctl);
    track((async () => {
      const out = extractDir(config.dataDir, id);
      try {
        rmSync(out, { recursive: true, force: true });   // 지난번에 중간에 끊긴 추출 흔적
        const m = await gen.extractPdf({ pdfPath: pdfPath(id), outDir: out, signal: ctl.signal, maxBytes: config.limits.maxFileBytes, maxPages: config.limits.maxPages });
        if (!ctl.signal.aborted) store.finishExtraction(id, { ok: true, pageCount: m.pageCount, aspect: m.height > 0 ? m.width / m.height : 1 });
      } catch (e) {
        if (ctl.signal.aborted) return;   // 문서가 지워짐
        const known = e instanceof Error && e.name === "ExtractError";
        if (!known) log(`extraction failed for ${id}: ${String((e as Error)?.stack ?? e)}`);
        store.finishExtraction(id, { ok: false, error: known ? (e as Error).message : "PDF를 읽는 중 알 수 없는 오류가 났습니다." });
      } finally {
        extracting.delete(id);
        pumpExtraction();
      }
    })());
  }

  // ── 생성 작업 ──
  const running = new Map<string, AbortController>();
  const jobQueue: string[] = [];

  function fail(id: string, code: ModuleJobErrorCode, message: string) {
    try { store.transition(id, "failed", { error: { code, message: redact(message, config).slice(0, 600) } }); }
    catch { /* 그사이 취소되어 이미 끝난 상태 */ }
  }

  function pumpJobs() {
    while (running.size < config.jobConcurrency && jobQueue.length) {
      const id = jobQueue.shift()!;
      if (store.jobStatus(id) !== "queued") continue;
      const ctl = new AbortController();
      running.set(id, ctl);
      track(runJob(id, ctl.signal)
        .catch((e) => log(`job ${id} runner error: ${String((e as Error)?.stack ?? e)}`))
        .finally(() => { running.delete(id); pumpJobs(); }));
    }
  }

  async function runJob(id: string, signal: AbortSignal) {
    const owner = store.jobOwner(id);
    const job = owner && store.job(owner, id);
    if (!owner || !job) return;
    const doc = store.document(owner, owner.documentId);
    if (!doc || doc.status !== "ready") return fail(id, "input", "문서 추출이 끝나지 않았거나 실패했습니다.");
    const provider = deps.provider;
    if (!provider) return fail(id, "not_configured", "서버에 모델 API 키가 설정되지 않았습니다.");
    if (!store.transition(id, "running")) return;

    const work = join(jobDir(config.dataDir, id), "work");
    try {
      // 명시적 재시도면 이전 작업이 이미 끝낸 쪽 결과를 이어받아 같은 요청에 돈을 다시 쓰지 않음
      if (job.retryOf && !existsSync(work)) {
        const prev = join(jobDir(config.dataDir, job.retryOf), "work");
        if (existsSync(prev)) cpSync(prev, work, { recursive: true });
      }
      mkdirSync(work, { recursive: true });
      const result = await gen.generatePack({
        lecture: `doc-${doc.id.slice(0, 8)}`, title: doc.title, extractDir: extractDir(config.dataDir, doc.id), workDir: work,
        callModel: provider.callModel, signal, vision: config.vision && provider.vision,
        onProgress: (p) => store.progress(id, { stage: p.stage, pagesDone: p.pagesDone, pagesTotal: p.pagesTotal, message: p.message, usage: p.usage }),
      });
      if (signal.aborted || store.jobStatus(id) !== "running") return;
      writeDirAtomic(resultDir(config.dataDir, id), {
        "pack.json": JSON.stringify(result.pack, null, 2),
        "review.json": JSON.stringify(result.review, null, 2),
      });
      store.progress(id, { stage: "done", pagesDone: doc.pageCount ?? 0, pagesTotal: doc.pageCount ?? 0, message: "완료", usage: result.usage });
      // 그사이 취소되었으면 결과를 남기지 않음
      let completed = false;
      try { completed = store.transition(id, "completed", { hasResult: true, warnings: result.warnings }); } catch { /* 그사이 취소됨 */ }
      if (!completed) rmSync(resultDir(config.dataDir, id), { recursive: true, force: true });
    } catch (e) {
      if (signal.aborted || store.jobStatus(id) !== "running") return;   // 취소는 cancelJob 이 이미 기록함
      const err = e as Error & { code?: string };
      if (err?.name === "GenerationError") {
        const code = err.code === "cancelled" ? "internal" : (err.code as ModuleJobErrorCode);
        fail(id, code, err.message);
      } else if (e instanceof ProviderError) {
        fail(id, "provider", e.message);
      } else if (isAbort(e)) {
        fail(id, "internal", "작업이 예상치 못하게 중단되었습니다.");
      } else {
        log(`job ${id} crashed: ${String(err?.stack ?? e)}`);
        fail(id, "internal", "해설을 만드는 중 서버 오류가 났습니다.");
      }
    }
  }

  return {
    enqueueExtraction(documentId) { extractQueue.push(documentId); pumpExtraction(); },
    enqueueJob(jobId) { jobQueue.push(jobId); pumpJobs(); },
    // 상태를 먼저 cancelled 로 바꾼 뒤 모델 요청을 끊음. 그래서 늦게 도착한 결과는 버려짐
    cancelJob(jobId) {
      let ok = false;
      try { ok = store.transition(jobId, "cancelled"); } catch { /* 그사이 이미 끝남 */ }
      if (ok) {
        running.get(jobId)?.abort();
        const i = jobQueue.indexOf(jobId);
        if (i >= 0) jobQueue.splice(i, 1);
      }
      return ok;
    },
    removeDocument(documentId, jobIds) {
      extracting.get(documentId)?.abort();
      const qi = extractQueue.indexOf(documentId);
      if (qi >= 0) extractQueue.splice(qi, 1);
      for (const j of jobIds) {
        const st = store.jobStatus(j);
        if (st === "queued" || st === "running") this.cancelJob(j);
        rmSync(jobDir(config.dataDir, j), { recursive: true, force: true });
      }
      rmSync(documentDir(config.dataDir, documentId), { recursive: true, force: true });
    },
    async idle() { while (pending.size) await Promise.allSettled([...pending]); },
    stop() {
      for (const c of extracting.values()) c.abort();
      for (const c of running.values()) c.abort();
    },
  };
}
