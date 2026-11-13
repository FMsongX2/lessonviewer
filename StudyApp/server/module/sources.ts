// 대화 출처(기존 강의 자료 또는 올린 문서)를 같은 모양으로 읽음.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModuleChatSource } from "../../shared/agent";
import type { Pack } from "../../shared/types";
import { readManifest, type ExtractManifest } from "../generation";
import type { Identity } from "./auth";
import type { ModuleStore } from "./store";

export interface SourcePage { page: number; text: string; title: string; explain: string | null; imagePath: string | null }
export interface ChatSourceData { label: string; pageCount: number; page(n: number): SourcePage | null; pages(): SourcePage[] }

// 기존 강의 목록(server/index.ts 가 넘겨 줌). 로컬 신원에서만 씀
export interface LectureCatalog {
  lecture(course: string, lecture: string): {
    title: string;
    pages: { page: number; text: string }[];
    pack: Pack | null;
    imagePath(page: number): string | null;
  } | null;
}

export const documentDir = (dataDir: string, id: string) => join(dataDir, "documents", id);
export const extractDir = (dataDir: string, id: string) => join(documentDir(dataDir, id), "extract");
export const publishedDir = (dataDir: string, id: string) => join(documentDir(dataDir, id), "published");

export function readPublished(dataDir: string, id: string): { pack: Pack; review: Record<string, string> } | null {
  const dir = publishedDir(dataDir, id);
  if (!existsSync(join(dir, "pack.json"))) return null;
  try {
    return {
      pack: JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")),
      review: existsSync(join(dir, "review.json")) ? JSON.parse(readFileSync(join(dir, "review.json"), "utf8")) : {},
    };
  } catch { return null; }
}

// 쪽 제목: 해설이 있으면 해설 제목, 없으면 쪽 글의 첫 줄
function titleOf(n: number, text: string, pack: Pack | null): string {
  const s = pack?.slides.find((x) => x.page === n)?.title;
  if (s) return s;
  const first = text.split("\n").map((l) => l.trim()).find((l) => l.length > 1);
  return first ? first.slice(0, 80) : `${n}쪽`;
}

function build(label: string, pages: { page: number; text: string }[], pack: Pack | null, imagePath: (n: number) => string | null): ChatSourceData {
  const make = (p: { page: number; text: string }): SourcePage => ({
    page: p.page, text: p.text, title: titleOf(p.page, p.text, pack),
    explain: pack?.slides.find((x) => x.page === p.page)?.explain ?? null, imagePath: imagePath(p.page),
  });
  const byPage = new Map(pages.map((p) => [p.page, p]));
  return {
    label, pageCount: pages.length,
    page: (n) => { const p = byPage.get(n); return p ? make(p) : null; },
    pages: () => pages.map(make),
  };
}

export type SourceResult = { ok: true; data: ChatSourceData } | { ok: false; status: 403 | 404 | 409; code: string; error: string };

export function resolveSource(who: Identity, source: ModuleChatSource, deps: { store: ModuleStore; dataDir: string; catalog: LectureCatalog | null }): SourceResult {
  if (source.kind === "lecture") {
    // 기존 강의 자료는 이 컴퓨터의 로컬 화면에서만. 호스트에는 절대 보이지 않음
    if (who.mode !== "local" || !deps.catalog) return { ok: false, status: 403, code: "forbidden", error: "lecture sources are only available locally" };
    const lec = deps.catalog.lecture(source.course, source.lecture);
    if (!lec) return { ok: false, status: 404, code: "not_found", error: "lecture not found" };
    return { ok: true, data: build(lec.title, lec.pages, lec.pack, lec.imagePath) };
  }
  const doc = deps.store.document(who, source.documentId);
  if (!doc) return { ok: false, status: 404, code: "not_found", error: "document not found" };
  if (doc.status !== "ready") return { ok: false, status: 409, code: "invalid_state", error: "document is not ready" };
  const dir = extractDir(deps.dataDir, doc.id);
  let manifest: ExtractManifest;
  try { manifest = readManifest(dir); }
  catch { return { ok: false, status: 409, code: "invalid_state", error: "document extraction data is missing" }; }
  const files = new Map(manifest.pages.map((p) => [p.page, p.modelImage || p.image]));
  return {
    ok: true,
    data: build(doc.title, manifest.pages.map((p) => ({ page: p.page, text: p.text })), readPublished(deps.dataDir, doc.id)?.pack ?? null, (n) => {
      const f = files.get(n);
      return f ? join(dir, f) : null;
    }),
  };
}

export function parseSourceParam(raw: string): ModuleChatSource | null {
  const doc = /^document:([0-9a-f-]{36})$/.exec(raw);
  if (doc) return { kind: "document", documentId: doc[1] };
  const lec = /^lecture:([a-z0-9-]{1,64})\/([a-z0-9-]{1,64})$/.exec(raw);
  return lec ? { kind: "lecture", course: lec[1], lecture: lec[2] } : null;
}

export function parseSourceBody(raw: unknown): ModuleChatSource | null {
  if (!raw || typeof raw !== "object" || !("kind" in raw)) return null;
  if (raw.kind === "document" && "documentId" in raw && typeof raw.documentId === "string" && /^[0-9a-f-]{36}$/.test(raw.documentId)) {
    return { kind: "document", documentId: raw.documentId };
  }
  if (raw.kind === "lecture" && "course" in raw && "lecture" in raw && typeof raw.course === "string" && typeof raw.lecture === "string"
    && /^[a-z0-9-]{1,64}$/.test(raw.course) && /^[a-z0-9-]{1,64}$/.test(raw.lecture)) {
    return { kind: "lecture", course: raw.course, lecture: raw.lecture };
  }
  return null;
}
