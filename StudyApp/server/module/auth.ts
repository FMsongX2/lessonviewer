// 요청이 누구 것인지 정함.
//  - local: 이 컴퓨터의 앱 화면. 루프백 주소 + localhost Host + 프록시 흔적 없음. 신원은 local/local 로 고정
//  - host: 외부 서비스의 서버. Authorization: Bearer <LESSONVIEWER_HOST_TOKEN> 을 먼저 확인한 뒤에만
//    X-LessonViewer-Workspace / X-LessonViewer-User 헤더를 믿음
// 브라우저가 보낸 신원 헤더는 토큰 없이는 절대 쓰지 않음.

import { createHash, timingSafeEqual } from "node:crypto";
import type { ModuleMode } from "../../shared/agent";

export interface Identity { workspace: string; user: string; mode: ModuleMode }
export const LOCAL_IDENTITY: Identity = { workspace: "local", user: "local", mode: "local" };

export type AuthResult = { ok: true; identity: Identity } | { ok: false; status: 401 | 403; code: string; error: string };

type RequestIP = (r: Request) => { address: string } | null;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
// 같은 컴퓨터의 리버스 프록시를 거쳐 들어온 요청은 루프백처럼 보이므로 이 헤더가 있으면 로컬로 보지 않음
const FORWARDED = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "via"];

function peerAddress(req: Request, env: unknown): string {
  const requestIP = (env as { requestIP?: RequestIP } | undefined)?.requestIP;
  try { return typeof requestIP === "function" ? requestIP.call(env, req)?.address ?? "" : ""; }
  catch { return ""; }
}

// 기존 강의·진도·실습 API에도 쓰는 판정: 이 컴퓨터에서 직접 온 요청인지
export function isLocalRequest(req: Request, env: unknown): boolean {
  if (!LOOPBACK.has(peerAddress(req, env))) return false;
  if (!LOCAL_HOST.test(req.headers.get("host") ?? "")) return false;     // DNS rebinding 차단
  if (FORWARDED.some((h) => req.headers.has(h))) return false;
  if (req.headers.get("sec-fetch-site") === "cross-site") return false;   // 다른 웹사이트가 띄운 요청
  return true;
}

const digest = (s: string) => createHash("sha256").update(s).digest();
export function tokenMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

export function authenticate(req: Request, env: unknown, hostToken: string | null): AuthResult {
  const auth = req.headers.get("authorization");
  if (auth !== null) {
    if (!hostToken) return { ok: false, status: 403, code: "forbidden", error: "host access is not enabled on this server" };
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    if (!m || !tokenMatches(m[1], hostToken)) return { ok: false, status: 401, code: "unauthorized", error: "invalid host token" };
    const workspace = req.headers.get("x-lessonviewer-workspace") ?? "";
    const user = req.headers.get("x-lessonviewer-user") ?? "";
    if (!NAME.test(workspace) || !NAME.test(user)) {
      return { ok: false, status: 401, code: "unauthorized", error: "X-LessonViewer-Workspace and X-LessonViewer-User must be 1-128 chars [A-Za-z0-9._:@-]" };
    }
    // 호스트 신원이 로컬 신원과 섞이지 않게 접두사를 붙여 저장 공간을 나눔
    return { ok: true, identity: { workspace: `h:${workspace}`, user, mode: "host" } };
  }
  if (!isLocalRequest(req, env)) return { ok: false, status: 403, code: "forbidden", error: "this API is only available locally or to an authenticated host" };
  // 로컬 화면의 변경 요청은 사용자 정의 헤더가 있어야 함. 다른 출처의 웹페이지는 사전 요청에서 막힘
  if (req.method !== "GET" && req.method !== "HEAD" && req.headers.get("x-studyapp") !== "1") {
    return { ok: false, status: 403, code: "forbidden", error: "missing X-StudyApp header" };
  }
  return { ok: true, identity: LOCAL_IDENTITY };
}
