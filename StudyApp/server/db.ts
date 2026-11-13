// 학습 진도(읽은 슬라이드, 다시 볼 슬라이드, 별표, 마지막 위치)와 앱에서 쓴 필기를 data/study.db 에 저장함.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { InkStrokes, LectureProgress } from "../shared/types";

export function openDb(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE IF NOT EXISTS slide_state (
    course TEXT NOT NULL, lecture TEXT NOT NULL, page INTEGER NOT NULL,
    seen_at INTEGER, flagged INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (course, lecture, page))`);
  db.run(`CREATE TABLE IF NOT EXISTS lecture_state (
    course TEXT NOT NULL, lecture TEXT NOT NULL, last_page INTEGER, updated_at INTEGER,
    PRIMARY KEY (course, lecture))`);
  // 별표: 책갈피(다시 볼 슬라이드)와 따로, 오빠가 중요하다고 찍어 두는 표시. 옛 DB에는 열을 더함
  if (!(db.query("PRAGMA table_info(slide_state)").all() as { name: string }[]).some((c) => c.name === "starred")) {
    db.run("ALTER TABLE slide_state ADD COLUMN starred INTEGER NOT NULL DEFAULT 0");
  }
  // 앱에서 슬라이드 위에 직접 쓴 필기. base는 그 필기를 쓴 이미지(올해 원본 clean, 작년 자료 prev)
  db.run(`CREATE TABLE IF NOT EXISTS ink (
    course TEXT NOT NULL, lecture TEXT NOT NULL, page INTEGER NOT NULL, base TEXT NOT NULL,
    strokes TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (course, lecture, page, base))`);

  const markSeen = db.prepare(`INSERT INTO slide_state (course, lecture, page, seen_at) VALUES ($course, $lecture, $page, $now)
    ON CONFLICT (course, lecture, page) DO UPDATE SET seen_at = COALESCE(seen_at, excluded.seen_at)`);
  const setFlag = db.prepare(`INSERT INTO slide_state (course, lecture, page, flagged) VALUES ($course, $lecture, $page, $flagged)
    ON CONFLICT (course, lecture, page) DO UPDATE SET flagged = excluded.flagged`);
  const setLast = db.prepare(`INSERT INTO lecture_state (course, lecture, last_page, updated_at) VALUES ($course, $lecture, $page, $now)
    ON CONFLICT (course, lecture) DO UPDATE SET last_page = excluded.last_page, updated_at = excluded.updated_at`);
  const setStar = db.prepare(`INSERT INTO slide_state (course, lecture, page, starred) VALUES ($course, $lecture, $page, $starred)
    ON CONFLICT (course, lecture, page) DO UPDATE SET starred = excluded.starred`);
  const slides = db.prepare(`SELECT lecture, page, seen_at, flagged, starred FROM slide_state WHERE course = $course ORDER BY lecture, page`);
  const lectures = db.prepare(`SELECT lecture, last_page, updated_at FROM lecture_state WHERE course = $course`);
  const inkOf = db.prepare(`SELECT page, base, strokes FROM ink WHERE course = $course AND lecture = $lecture`);
  const putInk = db.prepare(`INSERT INTO ink (course, lecture, page, base, strokes, updated_at) VALUES ($course, $lecture, $page, $base, $strokes, $now)
    ON CONFLICT (course, lecture, page, base) DO UPDATE SET strokes = excluded.strokes, updated_at = excluded.updated_at`);
  const dropInk = db.prepare(`DELETE FROM ink WHERE course = $course AND lecture = $lecture AND page = $page AND base = $base`);

  return {
    progress(course: string): Record<string, LectureProgress> {
      const out: Record<string, LectureProgress> = {};
      const get = (id: string) => (out[id] ??= { lastPage: null, seen: [], flagged: [], starred: [] });
      for (const r of lectures.all({ course }) as { lecture: string; last_page: number | null; updated_at: number | null }[]) {
        Object.assign(get(r.lecture), { lastPage: r.last_page, updatedAt: r.updated_at });
      }
      for (const r of slides.all({ course }) as { lecture: string; page: number; seen_at: number | null; flagged: number; starred: number }[]) {
        if (r.seen_at) get(r.lecture).seen.push(r.page);
        if (r.flagged) get(r.lecture).flagged.push(r.page);
        if (r.starred) get(r.lecture).starred.push(r.page);
      }
      return out;
    },
    markSeen: db.transaction((course: string, lecture: string, pages: number[]) => {
      const now = Date.now();
      for (const page of pages) markSeen.run({ course, lecture, page, now });
    }),
    setFlag(course: string, lecture: string, page: number, flagged: boolean) {
      setFlag.run({ course, lecture, page, flagged: flagged ? 1 : 0 });
    },
    setStar(course: string, lecture: string, page: number, starred: boolean) {
      setStar.run({ course, lecture, page, starred: starred ? 1 : 0 });
    },
    setLast(course: string, lecture: string, page: number) {
      setLast.run({ course, lecture, page, now: Date.now() });
    },
    // "<쪽>:<base>" → 획 목록
    ink(course: string, lecture: string): Record<string, InkStrokes> {
      const out: Record<string, InkStrokes> = {};
      for (const r of inkOf.all({ course, lecture }) as { page: number; base: string; strokes: string }[]) out[`${r.page}:${r.base}`] = JSON.parse(r.strokes);
      return out;
    },
    setInk(course: string, lecture: string, page: number, base: string, strokes: InkStrokes) {
      if (strokes.length) putInk.run({ course, lecture, page, base, strokes: JSON.stringify(strokes), now: Date.now() });
      else dropInk.run({ course, lecture, page, base });
    },
  };
}
