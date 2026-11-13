// 모듈 설정. 서버가 켜질 때 한 번만 읽음.
// 비밀값(API 키, 호스트 토큰)은 환경 변수 또는 LESSONVIEWER_KEY_REF(pkh 참조)로만 받고 응답·로그에 내보내지 않음.
// 설정이 잘못돼도 서버(기존 학습 화면)는 뜨고, 모듈은 configured=false 와 issue 로 이유만 알림.

import { join } from "node:path";
import type { ModuleLimits, ModuleProviderKind } from "../../shared/agent";

export interface ModuleConfig {
  provider: ModuleProviderKind;
  model: string;
  baseUrl: string;
  apiKey: string | null;
  hostToken: string | null;
  dataDir: string;
  vision: boolean;
  limits: ModuleLimits;
  chat: { maxOutputTokens: number; maxContextChars: number; maxPageChars: number; maxImages: number };
  jobConcurrency: number;
  issue: string | null;   // 사용자에게 보여 줄 설정 문제(비밀값·참조 이름 없음)
}

// LESSONVIEWER_KEY_REF 를 `pkh get <ref>` 로 풀어 키를 얻음. 출력은 기록하지 않고, 실패하면 null
export type KeyResolver = (ref: string) => string | null;
export const pkhResolver: KeyResolver = (ref) => {
  try {
    const r = Bun.spawnSync(["pkh", "get", ref], { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 15_000 });
    if (r.exitCode !== 0) return null;
    const key = r.stdout.toString().trim();
    return key && !/\s/.test(key) ? key : null;
  } catch { return null; }   // pkh 가 설치되지 않음
};

const DEFAULT_BASE: Record<ModuleProviderKind, string> = {
  anthropic: "https://api.anthropic.com",
  "openai-compatible": "https://api.openai.com/v1",
};
// openai-compatible 은 어떤 서비스인지 모르니 모델을 반드시 지정해야 함
const DEFAULT_MODEL: Record<ModuleProviderKind, string> = { anthropic: "claude-sonnet-5-5", "openai-compatible": "" };

const int = (v: string | undefined, def: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
};

export function loadModuleConfig(env: Record<string, string | undefined>, appRoot: string, resolveKey: KeyResolver = pkhResolver): ModuleConfig {
  const issues: string[] = [];
  const rawProvider = (env.LESSONVIEWER_PROVIDER ?? "anthropic").trim();
  const providerOk = rawProvider === "anthropic" || rawProvider === "openai-compatible";
  if (!providerOk) issues.push('LESSONVIEWER_PROVIDER must be "anthropic" or "openai-compatible"');
  const provider: ModuleProviderKind = providerOk ? rawProvider : "anthropic";
  let baseUrl = (env.LESSONVIEWER_API_BASE_URL?.trim() || DEFAULT_BASE[provider]).replace(/\/+$/, "");
  let baseOk = true;
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    // 주소 안에 계정 정보·질의·조각이 있으면 거부(키가 로그에 섞이거나 엉뚱한 곳으로 가지 않게)
    if (u.username || u.password || u.search || u.hash) throw new Error();
  } catch { issues.push("LESSONVIEWER_API_BASE_URL is not a valid http(s) URL"); baseUrl = DEFAULT_BASE[provider]; baseOk = false; }
  let hostToken = env.LESSONVIEWER_HOST_TOKEN?.trim() || null;
  if (hostToken && hostToken.length < 32) { issues.push("LESSONVIEWER_HOST_TOKEN must be at least 32 characters; host access disabled"); hostToken = null; }
  let apiKey = env.LESSONVIEWER_API_KEY?.trim() || null;
  const ref = env.LESSONVIEWER_KEY_REF?.trim();
  if (!apiKey && ref && providerOk && baseOk) {   // 설정이 잘못됐으면 키체인을 건드리지 않음
    if (!/^[A-Za-z0-9._\/:-]{1,128}$/.test(ref)) issues.push("LESSONVIEWER_KEY_REF has an invalid format");
    else {
      apiKey = resolveKey(ref);
      if (!apiKey) issues.push("the API key reference could not be resolved on this server");
    }
  }
  const model = env.LESSONVIEWER_MODEL?.trim() || DEFAULT_MODEL[provider];
  if (!model) issues.push("LESSONVIEWER_MODEL is required for this provider");
  if (!apiKey && !ref) issues.push("no model API key is configured on the server");
  return {
    provider,
    model,
    baseUrl,
    apiKey: providerOk && baseOk ? apiKey : null,
    hostToken,
    dataDir: env.LESSONVIEWER_DATA_DIR?.trim() || join(appRoot, "data", "module"),
    vision: env.LESSONVIEWER_VISION !== "0",
    limits: {
      maxFileBytes: int(env.LESSONVIEWER_MAX_FILE_BYTES, 50 * 1024 * 1024, 1024, 50 * 1024 * 1024),   // 낮추기만 가능
      maxPages: 200,
      maxMessageChars: 4000,
      maxToolSteps: int(env.LESSONVIEWER_CHAT_MAX_STEPS, 4, 0, 8),
    },
    chat: {
      maxOutputTokens: int(env.LESSONVIEWER_CHAT_MAX_TOKENS, 2048, 256, 8192),
      maxContextChars: 60_000,
      maxPageChars: 6_000,
      maxImages: 4,
    },
    jobConcurrency: int(env.LESSONVIEWER_JOB_CONCURRENCY, 1, 1, 4),
    issue: issues[0] ?? null,
  };
}

export const isConfigured = (c: ModuleConfig) => !!c.apiKey && !!c.model;

// 오류 문구에 비밀값이 섞여 나가지 않게 지움
export function redact(text: string, c: Pick<ModuleConfig, "apiKey" | "hostToken">): string {
  let out = text;
  for (const secret of [c.apiKey, c.hostToken]) if (secret) out = out.split(secret).join("[redacted]");
  return out.replace(/\b(sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,})/g, "[redacted]");
}
