// LessonViewer 모듈 API(/api/module)의 요청·응답 모양. 서버(server/module)와 화면, 외부 호스트가 같이 씀.
// 문서: server/module/README.md

import type { Pack } from "./types";

export type ModuleProviderKind = "anthropic" | "openai-compatible";
export type ModuleMode = "local" | "host";

export interface ModuleLimits {
  maxFileBytes: number;      // 올릴 수 있는 PDF 크기
  maxPages: number;          // PDF 쪽 수 상한
  maxMessageChars: number;   // 대화 메시지 한 개 길이 상한
  maxToolSteps: number;      // 답 하나에 모델이 자료를 찾아보는 횟수 상한
}

// GET /api/module/status. 비밀값(키·호스트 토큰)은 절대 담지 않음
export interface ModuleStatus {
  configured: boolean;              // API 키와 모델이 서버에 설정됨
  issue: string | null;             // 설정되지 않은 이유(비밀값·키 참조 이름은 담지 않음)
  provider: ModuleProviderKind;
  model: string;
  mode: ModuleMode;                 // 이 요청이 로컬 화면에서 왔는지, 인증된 호스트에서 왔는지
  limits: ModuleLimits;
  capabilities: {
    generation: boolean;            // 문서 해설 생성 가능
    chat: boolean;                  // 학습 대화 가능
    streaming: true;                // 대화 답은 SSE로 옴
    vision: boolean;                // 모델에 쪽 이미지를 보냄
    lectureSources: boolean;        // 기존 강의 자료를 대화 출처로 쓸 수 있음(로컬 전용)
    hostAuth: boolean;              // 서버에 호스트 토큰이 설정됨
  };
}

export type ModuleDocumentStatus = "processing" | "ready" | "failed";

export interface ModuleDocument {
  id: string;
  title: string;
  fileName: string;
  bytes: number;
  pageCount: number | null;         // 추출이 끝나야 정해짐
  aspect: number | null;            // 쪽 너비 / 높이
  status: ModuleDocumentStatus;
  error: string | null;             // status=failed 일 때 사용자에게 보여 줄 이유
  createdAt: number;
  updatedAt: number;
  published: { jobId: string; at: number } | null;   // 게시된 해설의 출처 작업
}

export interface ModulePage { page: number; text: string; imageUrl: string }

// GET /api/module/documents/:id
export interface ModuleDocumentDetail {
  document: ModuleDocument;
  pages: ModulePage[];              // 추출 전이거나 실패면 빈 배열
  pack: Pack | null;                // 게시된 해설만. 후보는 /jobs/:id/result
  review: Record<string, string>;   // 쪽 번호 → 확인이 필요한 이유
}

// 문서 읽기 진도. 기존 강의 진도(study.db)와 분리되어 workspace·user 별로 저장됨
export interface ModuleReaderProgress { lastPage: number | null; seen: number[]; updatedAt: number | null }

export type ModuleJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ModuleJobStage = "queued" | "pages" | "story" | "validate" | "done";
export type ModuleJobErrorCode =
  | "interrupted"       // 서버가 작업 중에 꺼짐. 자동으로 다시 돌리지 않음
  | "not_configured" | "provider" | "invalid_output" | "budget" | "input" | "internal";

export interface ModuleJob {
  id: string;
  documentId: string;
  status: ModuleJobStatus;
  progress: { stage: ModuleJobStage; pagesDone: number; pagesTotal: number; message: string };
  usage: { inputTokens: number; outputTokens: number; calls: number };
  error: { code: ModuleJobErrorCode; message: string } | null;
  warnings: string[];
  retryOf: string | null;           // 명시적 재시도로 만든 작업이면 원래 작업
  hasResult: boolean;               // completed 이고 후보 해설이 저장됨
  publishedAt: number | null;       // 이 작업의 결과가 게시된 시각
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

// GET /api/module/jobs/:id/result
export interface ModuleJobResult { pack: Pack; review: Record<string, string> }

export type ModuleChatSource =
  | { kind: "lecture"; course: string; lecture: string }
  | { kind: "document"; documentId: string };

export interface ModuleConversation {
  id: string;
  source: ModuleChatSource;
  title: string;
  page: number | null;              // 대화를 시작한 쪽
  createdAt: number;
  updatedAt: number;
}

// 답에서 [p.N] 으로 가리킨 쪽 중 실제로 그 출처에 있고 모델이 이번 답에서 본 쪽만 남김.
// quote는 모델이 인용한 문장이 그 쪽 글에 그대로 있을 때만 붙음
export interface ModuleCitation { page: number; title: string; quote?: string }

export type ModuleMessageStatus = "complete" | "cancelled" | "failed";

export interface ModuleChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  page: number | null;
  citations: ModuleCitation[];
  status: ModuleMessageStatus;
  error: string | null;
  createdAt: number;
}

// POST /api/module/conversations/:id/messages 의 SSE 이벤트(event: 이름, data: JSON)
export type ModuleChatEvent =
  | { event: "meta"; data: { conversationId: string; userMessageId: string; assistantMessageId: string; model: string } }
  | { event: "delta"; data: { text: string } }
  | { event: "tool"; data: { name: "search_source" | "read_page"; query?: string; page?: number } }
  | { event: "citations"; data: { citations: ModuleCitation[] } }
  | { event: "done"; data: { message: ModuleChatMessage } }
  | { event: "error"; data: { code: string; error: string; message?: ModuleChatMessage } };

// 모든 오류 응답 모양
export interface ModuleError { error: string; code: string }

// 호스트 연동 헤더(서버끼리만. 브라우저에 토큰을 두지 않음)
export const MODULE_HEADERS = {
  workspace: "X-LessonViewer-Workspace",
  user: "X-LessonViewer-User",
  local: "X-StudyApp",              // 로컬 화면이 변경 요청에 붙이는 헤더(값 "1")
} as const;
