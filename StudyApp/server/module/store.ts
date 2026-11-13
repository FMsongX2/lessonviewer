// 모듈 상태 저장소(<LESSONVIEWER_DATA_DIR>/module.db). 기존 data/study.db 와 완전히 따로 둠.
// 문서는 workspace 단위, 작업·대화·읽기 진도는 workspace+user 단위로 나뉨. 모든 조회가 범위 조건을 같이 받음.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ModuleChatMessage, ModuleChatSource, ModuleCitation, ModuleConversation, ModuleDocument, ModuleDocumentStatus,
  ModuleJob, ModuleJobErrorCode, ModuleJobStage, ModuleJobStatus, ModuleMessageStatus, ModuleReaderProgress,
} from "../../shared/agent";
import type { Identity } from "./auth";

export const newId = () => crypto.randomUUID();
export const isId = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);

// 작업 상태 전이표. 끝난 상태(completed/failed/cancelled)에서는 어디로도 못 감. 재시도는 새 작업을 만듦
const TRANSITIONS: Record<ModuleJobStatus, ModuleJobStatus[]> = {
  queued: ["running", "cancelled", "failed"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};
export const canTransition = (from: ModuleJobStatus, to: ModuleJobStatus) => TRANSITIONS[from].includes(to);
export const isTerminal = (s: ModuleJobStatus) => TRANSITIONS[s].length === 0;

export class JobTransitionError extends Error {
  constructor(readonly from: ModuleJobStatus, readonly to: ModuleJobStatus) { super(`job cannot go from ${from} to ${to}`); }
}

export const sourceKey = (s: ModuleChatSource) => s.kind === "lecture" ? `lecture:${s.course}/${s.lecture}` : `document:${s.documentId}`;

type DocRow = {
  id: string; workspace: string; title: string; file_name: string; bytes: number; page_count: number | null; aspect: number | null;
  status: ModuleDocumentStatus; error: string | null; created_at: number; updated_at: number; published_job: string | null; published_at: number | null;
};
type JobRow = {
  id: string; workspace: string; user: string; document_id: string; status: ModuleJobStatus; stage: ModuleJobStage; pages_done: number;
  pages_total: number; message: string; usage: string; error_code: ModuleJobErrorCode | null; error_message: string | null; warnings: string;
  retry_of: string | null; has_result: number; published_at: number | null; created_at: number; started_at: number | null; finished_at: number | null;
};
type ConvRow = { id: string; source: string; title: string; page: number | null; created_at: number; updated_at: number };
type MsgRow = { id: string; role: "user" | "assistant"; content: string; page: number | null; citations: string; status: ModuleMessageStatus; error: string | null; created_at: number };

const toDoc = (r: DocRow): ModuleDocument => ({
  id: r.id, title: r.title, fileName: r.file_name, bytes: r.bytes, pageCount: r.page_count, aspect: r.aspect, status: r.status,
  error: r.error, createdAt: r.created_at, updatedAt: r.updated_at,
  published: r.published_job && r.published_at ? { jobId: r.published_job, at: r.published_at } : null,
});
const toJob = (r: JobRow): ModuleJob => ({
  id: r.id, documentId: r.document_id, status: r.status,
  progress: { stage: r.stage, pagesDone: r.pages_done, pagesTotal: r.pages_total, message: r.message },
  usage: JSON.parse(r.usage), error: r.error_code ? { code: r.error_code, message: r.error_message ?? "" } : null,
  warnings: JSON.parse(r.warnings), retryOf: r.retry_of, hasResult: !!r.has_result, publishedAt: r.published_at,
  createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
});
const toConv = (r: ConvRow): ModuleConversation => ({
  id: r.id, source: JSON.parse(r.source), title: r.title, page: r.page, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toMsg = (r: MsgRow): ModuleChatMessage => ({
  id: r.id, role: r.role, content: r.content, page: r.page, citations: JSON.parse(r.citations), status: r.status, error: r.error, createdAt: r.created_at,
});

export type ModuleStore = ReturnType<typeof openModuleStore>;

export function openModuleStore(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, workspace TEXT NOT NULL, created_by TEXT NOT NULL, title TEXT NOT NULL, file_name TEXT NOT NULL,
    bytes INTEGER NOT NULL, page_count INTEGER, aspect REAL, status TEXT NOT NULL, error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_job TEXT, published_at INTEGER)`);
  db.run("CREATE INDEX IF NOT EXISTS documents_ws ON documents (workspace, created_at)");
  db.run(`CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, workspace TEXT NOT NULL, user TEXT NOT NULL, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    status TEXT NOT NULL, stage TEXT NOT NULL, pages_done INTEGER NOT NULL DEFAULT 0, pages_total INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '', usage TEXT NOT NULL, error_code TEXT, error_message TEXT, warnings TEXT NOT NULL DEFAULT '[]',
    retry_of TEXT, has_result INTEGER NOT NULL DEFAULT 0, published_at INTEGER,
    created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER)`);
  db.run("CREATE INDEX IF NOT EXISTS jobs_owner ON jobs (workspace, user, created_at)");
  db.run(`CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, workspace TEXT NOT NULL, user TEXT NOT NULL, source_key TEXT NOT NULL, source TEXT NOT NULL,
    title TEXT NOT NULL, page INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  db.run("CREATE INDEX IF NOT EXISTS conversations_owner ON conversations (workspace, user, source_key, updated_at)");
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL,
    content TEXT NOT NULL, page INTEGER, citations TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL)`);
  db.run("CREATE INDEX IF NOT EXISTS messages_conv ON messages (conversation_id, created_at)");
  db.run(`CREATE TABLE IF NOT EXISTS reader_progress (
    workspace TEXT NOT NULL, user TEXT NOT NULL, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    last_page INTEGER, seen TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL, PRIMARY KEY (workspace, user, document_id))`);

  const getDoc = db.prepare("SELECT * FROM documents WHERE id = $id AND workspace = $workspace");
  const getJob = db.prepare("SELECT * FROM jobs WHERE id = $id AND workspace = $workspace AND user = $user");
  const getConv = db.prepare("SELECT * FROM conversations WHERE id = $id AND workspace = $workspace AND user = $user");

  const store = {
    close: () => db.close(),

    // ── 문서 ──
    createDocument(who: Identity, d: { id: string; title: string; fileName: string; bytes: number }): ModuleDocument {
      const now = Date.now();
      db.prepare(`INSERT INTO documents (id, workspace, created_by, title, file_name, bytes, status, created_at, updated_at)
        VALUES ($id, $workspace, $user, $title, $fileName, $bytes, 'processing', $now, $now)`)
        .run({ ...d, workspace: who.workspace, user: who.user, now });
      return store.document(who, d.id)!;
    },
    document(who: Identity, id: string): ModuleDocument | null {
      const r = getDoc.get({ id, workspace: who.workspace }) as DocRow | null;
      return r ? toDoc(r) : null;
    },
    documents(who: Identity): ModuleDocument[] {
      return (db.prepare("SELECT * FROM documents WHERE workspace = $workspace ORDER BY created_at DESC").all({ workspace: who.workspace }) as DocRow[]).map(toDoc);
    },
    // 서버 내부용(추출 작업). 범위 확인은 이미 끝난 id만 넘어옴
    documentById(id: string): (ModuleDocument & { workspace: string }) | null {
      const r = db.prepare("SELECT * FROM documents WHERE id = $id").get({ id }) as DocRow | null;
      return r ? { ...toDoc(r), workspace: r.workspace } : null;
    },
    processingDocuments(): string[] {
      return (db.prepare("SELECT id FROM documents WHERE status = 'processing'").all() as { id: string }[]).map((r) => r.id);
    },
    finishExtraction(id: string, r: { ok: true; pageCount: number; aspect: number } | { ok: false; error: string }) {
      db.prepare(`UPDATE documents SET status = $status, page_count = $pages, aspect = $aspect, error = $error, updated_at = $now
        WHERE id = $id AND status = 'processing'`).run({
        id, now: Date.now(), status: r.ok ? "ready" : "failed",
        pages: r.ok ? r.pageCount : null, aspect: r.ok ? r.aspect : null, error: r.ok ? null : r.error,
      });
    },
    setPublished(who: Identity, documentId: string, jobId: string, at: number) {
      db.transaction(() => {
        db.prepare("UPDATE documents SET published_job = $jobId, published_at = $at, updated_at = $at WHERE id = $documentId AND workspace = $workspace")
          .run({ documentId, jobId, at, workspace: who.workspace });
        db.prepare("UPDATE jobs SET published_at = $at WHERE id = $jobId AND workspace = $workspace").run({ jobId, at, workspace: who.workspace });
      })();
    },
    deleteDocument(who: Identity, id: string) {
      db.prepare("DELETE FROM documents WHERE id = $id AND workspace = $workspace").run({ id, workspace: who.workspace });
    },

    // ── 생성 작업 ──
    createJob(who: Identity, documentId: string, retryOf: string | null): ModuleJob {
      const id = newId();
      db.prepare(`INSERT INTO jobs (id, workspace, user, document_id, status, stage, usage, retry_of, created_at)
        VALUES ($id, $workspace, $user, $documentId, 'queued', 'queued', $usage, $retryOf, $now)`).run({
        id, workspace: who.workspace, user: who.user, documentId, retryOf,
        usage: JSON.stringify({ inputTokens: 0, outputTokens: 0, calls: 0 }), now: Date.now(),
      });
      return store.job(who, id)!;
    },
    job(who: Identity, id: string): ModuleJob | null {
      const r = getJob.get({ id, workspace: who.workspace, user: who.user }) as JobRow | null;
      return r ? toJob(r) : null;
    },
    jobs(who: Identity, documentId?: string): ModuleJob[] {
      const rows = documentId
        ? db.prepare("SELECT * FROM jobs WHERE workspace = $workspace AND user = $user AND document_id = $documentId ORDER BY created_at DESC")
          .all({ workspace: who.workspace, user: who.user, documentId })
        : db.prepare("SELECT * FROM jobs WHERE workspace = $workspace AND user = $user ORDER BY created_at DESC LIMIT 200")
          .all({ workspace: who.workspace, user: who.user });
      return (rows as JobRow[]).map(toJob);
    },
    // 같은 문서에 아직 끝나지 않은 작업(누가 걸었든). 중복 비용을 막는 데 씀
    activeJobFor(workspace: string, documentId: string): { id: string; user: string } | null {
      return db.prepare("SELECT id, user FROM jobs WHERE workspace = $workspace AND document_id = $documentId AND status IN ('queued','running') LIMIT 1")
        .get({ workspace, documentId }) as { id: string; user: string } | null;
    },
    jobOwner(id: string): (Identity & { documentId: string; status: ModuleJobStatus }) | null {
      const r = db.prepare("SELECT workspace, user, document_id, status FROM jobs WHERE id = $id").get({ id }) as
        { workspace: string; user: string; document_id: string; status: ModuleJobStatus } | null;
      return r ? { workspace: r.workspace, user: r.user, mode: r.workspace.startsWith("h:") ? "host" : "local", documentId: r.document_id, status: r.status } : null;
    },
    jobStatus(id: string): ModuleJobStatus | null {
      return (db.prepare("SELECT status FROM jobs WHERE id = $id").get({ id }) as { status: ModuleJobStatus } | null)?.status ?? null;
    },
    jobIdsForDocument(workspace: string, documentId: string): string[] {
      return (db.prepare("SELECT id FROM jobs WHERE workspace = $workspace AND document_id = $documentId").all({ workspace, documentId }) as { id: string }[]).map((r) => r.id);
    },
    // 상태를 바꿈. 지금 상태가 from 이 아니면(다른 쪽이 먼저 바꿈) false
    transition(id: string, to: ModuleJobStatus, patch: { error?: { code: ModuleJobErrorCode; message: string }; hasResult?: boolean; warnings?: string[] } = {}): boolean {
      const from = store.jobStatus(id);
      if (!from) return false;
      if (!canTransition(from, to)) throw new JobTransitionError(from, to);
      const now = Date.now();
      const res = db.prepare(`UPDATE jobs SET status = $to,
          started_at = CASE WHEN $to = 'running' THEN $now ELSE started_at END,
          finished_at = CASE WHEN $to IN ('completed','failed','cancelled') THEN $now ELSE finished_at END,
          stage = CASE WHEN $to = 'completed' THEN 'done' ELSE stage END,
          error_code = $code, error_message = $msg,
          has_result = $hasResult, warnings = COALESCE($warnings, warnings)
        WHERE id = $id AND status = $from`).run({
        id, from, to, now, code: patch.error?.code ?? null, msg: patch.error?.message ?? null,
        hasResult: patch.hasResult ? 1 : 0, warnings: patch.warnings ? JSON.stringify(patch.warnings) : null,
      });
      return res.changes === 1;
    },
    progress(id: string, p: { stage: ModuleJobStage; pagesDone: number; pagesTotal: number; message: string; usage: ModuleJob["usage"] }) {
      db.prepare(`UPDATE jobs SET stage = $stage, pages_done = $pagesDone, pages_total = $pagesTotal, message = $message, usage = $usage
        WHERE id = $id AND status = 'running'`).run({ id, ...p, usage: JSON.stringify(p.usage) });
    },
    // 서버가 다시 켜졌을 때: 끝나지 않은 작업은 자동으로 다시 돌리지 않고 interrupted 로 실패 처리
    failInterruptedJobs(): number {
      return db.prepare(`UPDATE jobs SET status = 'failed', error_code = 'interrupted', finished_at = $now,
          error_message = '서버가 작업 도중 다시 시작되어 중단되었습니다. 필요하면 다시 시도하세요.'
        WHERE status IN ('queued','running')`).run({ now: Date.now() }).changes;
    },

    // ── 대화 ──
    createConversation(who: Identity, source: ModuleChatSource, title: string, page: number | null): ModuleConversation {
      const id = newId(), now = Date.now();
      db.prepare(`INSERT INTO conversations (id, workspace, user, source_key, source, title, page, created_at, updated_at)
        VALUES ($id, $workspace, $user, $key, $source, $title, $page, $now, $now)`).run({
        id, workspace: who.workspace, user: who.user, key: sourceKey(source), source: JSON.stringify(source), title, page, now,
      });
      return store.conversation(who, id)!;
    },
    conversation(who: Identity, id: string): ModuleConversation | null {
      const r = getConv.get({ id, workspace: who.workspace, user: who.user }) as ConvRow | null;
      return r ? toConv(r) : null;
    },
    conversations(who: Identity, source?: ModuleChatSource): ModuleConversation[] {
      const rows = source
        ? db.prepare("SELECT * FROM conversations WHERE workspace = $workspace AND user = $user AND source_key = $key ORDER BY updated_at DESC")
          .all({ workspace: who.workspace, user: who.user, key: sourceKey(source) })
        : db.prepare("SELECT * FROM conversations WHERE workspace = $workspace AND user = $user ORDER BY updated_at DESC LIMIT 200")
          .all({ workspace: who.workspace, user: who.user });
      return (rows as ConvRow[]).map(toConv);
    },
    messages(who: Identity, conversationId: string): ModuleChatMessage[] {
      if (!store.conversation(who, conversationId)) return [];
      return (db.prepare("SELECT * FROM messages WHERE conversation_id = $conversationId ORDER BY created_at, rowid").all({ conversationId }) as MsgRow[]).map(toMsg);
    },
    addMessage(who: Identity, conversationId: string, m: { id: string; role: "user" | "assistant"; content: string; page: number | null; citations?: ModuleCitation[]; status: ModuleMessageStatus; error?: string | null }): ModuleChatMessage {
      const now = Date.now();
      db.transaction(() => {
        const ok = db.prepare("UPDATE conversations SET updated_at = $now WHERE id = $conversationId AND workspace = $workspace AND user = $user")
          .run({ now, conversationId, workspace: who.workspace, user: who.user }).changes;
        if (!ok) throw new Error("conversation not found");
        db.prepare(`INSERT INTO messages (id, conversation_id, role, content, page, citations, status, error, created_at)
          VALUES ($id, $conversationId, $role, $content, $page, $citations, $status, $error, $now)`).run({
          id: m.id, conversationId, role: m.role, content: m.content, page: m.page, citations: JSON.stringify(m.citations ?? []),
          status: m.status, error: m.error ?? null, now,
        });
      })();
      return toMsg(db.prepare("SELECT * FROM messages WHERE id = $id").get({ id: m.id }) as MsgRow);
    },
    deleteConversation(who: Identity, id: string): boolean {
      return db.prepare("DELETE FROM conversations WHERE id = $id AND workspace = $workspace AND user = $user").run({ id, workspace: who.workspace, user: who.user }).changes === 1;
    },
    // 문서가 지워지면 그 문서를 출처로 한 대화도 지움(모든 사용자)
    deleteConversationsFor(workspace: string, source: ModuleChatSource) {
      db.prepare("DELETE FROM conversations WHERE workspace = $workspace AND source_key = $key").run({ workspace, key: sourceKey(source) });
    },

    // ── 문서 읽기 진도 ──
    readerProgress(who: Identity, documentId: string): ModuleReaderProgress {
      const r = db.prepare("SELECT last_page, seen, updated_at FROM reader_progress WHERE workspace = $workspace AND user = $user AND document_id = $documentId")
        .get({ workspace: who.workspace, user: who.user, documentId }) as { last_page: number | null; seen: string; updated_at: number } | null;
      return r ? { lastPage: r.last_page, seen: JSON.parse(r.seen), updatedAt: r.updated_at } : { lastPage: null, seen: [], updatedAt: null };
    },
    setReaderProgress(who: Identity, documentId: string, p: { lastPage: number | null; seen: number[] }) {
      db.prepare(`INSERT INTO reader_progress (workspace, user, document_id, last_page, seen, updated_at) VALUES ($workspace, $user, $documentId, $lastPage, $seen, $now)
        ON CONFLICT (workspace, user, document_id) DO UPDATE SET last_page = excluded.last_page, seen = excluded.seen, updated_at = excluded.updated_at`)
        .run({ workspace: who.workspace, user: who.user, documentId, lastPage: p.lastPage, seen: JSON.stringify(p.seen), now: Date.now() });
    },
  };
  return store;
}
