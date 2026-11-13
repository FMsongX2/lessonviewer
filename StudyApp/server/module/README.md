# LessonViewer 모듈 API (`/api/module`)

PDF를 올려 쪽별 해설(Pack)을 만들고, 자료에 근거한 학습 대화를 하는 독립 모듈입니다.
로컬 앱 화면과 외부 호스트 서비스가 **같은 핸들러**를 씁니다. 응답 타입은 `shared/agent.ts`.

- 저장 위치: `LESSONVIEWER_DATA_DIR`(기본 `data/module/`) — `module.db`, `documents/<id>/{source.pdf,extract/,published/}`, `jobs/<id>/{work/,result/}`
- 기존 강의 자료(`content/`, `data/slides/`)와 진도 DB(`data/study.db`)는 건드리지 않습니다. 기존 강의는 **로컬에서만** 대화 출처로 읽습니다.
- 모델 키는 서버에만 있습니다. 응답·로그·오류 문구에 키와 호스트 토큰이 나가지 않게 지웁니다.

## 설정

`.env.example` 을 `.env` 로 복사합니다(bun 이 자동으로 읽음). 설정은 서버 시작 때 한 번만 읽습니다.

| 변수 | 뜻 |
|---|---|
| `LESSONVIEWER_PROVIDER` | `anthropic`(기본, 네이티브 Messages API) 또는 `openai-compatible` |
| `LESSONVIEWER_MODEL` | 모델 이름. openai-compatible 은 필수 |
| `LESSONVIEWER_API_BASE_URL` | 제공자 주소. 잘못되면 키를 버리고 모듈을 끔(다른 주소로 대신 보내지 않음) |
| `LESSONVIEWER_API_KEY` | API 키(서비스 배포용) |
| `LESSONVIEWER_KEY_REF` | 이 컴퓨터용: 시작 때 `pkh get <ref>` 로 키를 읽음. `API_KEY` 가 우선 |
| `LESSONVIEWER_HOST_TOKEN` | 외부 호스트 인증 토큰(32자 이상). 없으면 로컬 전용 |
| `LESSONVIEWER_BIND` | 듣는 주소. 기본 `127.0.0.1` + `::1` |
| `LESSONVIEWER_DATA_DIR` / `LESSONVIEWER_STUDY_DB` / `LESSONVIEWER_PYTHON` | 모듈 데이터 / 기존 진도 DB / 추출용 파이썬 |
| `LESSONVIEWER_MAX_FILE_BYTES` | 업로드 상한을 50MB 보다 낮출 때 |

요청 본문은 읽으면서 바이트를 셉니다(Content-Length 가 없어도): JSON 64KB, 업로드 multipart 전체 `maxFileBytes + 1MB`, 필드는 `file` 하나와 `title` 하나만. 서버 전체 상한은 52MB(`Bun.serve maxRequestBodySize`).

키가 없거나 설정이 잘못되면 `GET /status` 가 `configured:false` 와 `issue`(비밀 없는 이유)를 돌려주고, 생성·대화 요청은 `503 not_configured` 입니다. 대신 지어낸 답을 주지 않습니다.

## 신원과 접근 경계

| 요청 | 조건 | 신원 |
|---|---|---|
| 로컬 화면 | 루프백 IP + `Host: localhost/127.0.0.1/[::1]` + 프록시 헤더(`X-Forwarded-*`, `Forwarded`, `Via`, `X-Real-IP`) 없음 + `Sec-Fetch-Site` 가 cross-site 아님. **GET 이 아닌 요청은 `X-StudyApp: 1` 필수** | `local/local` |
| 외부 호스트 | `Authorization: Bearer <LESSONVIEWER_HOST_TOKEN>` 를 먼저 확인한 뒤에만 `X-LessonViewer-Workspace`, `X-LessonViewer-User`(1–128자 `[A-Za-z0-9._:@-]`)를 믿음 | `h:<workspace>/<user>` |

- 문서는 workspace 단위, 생성 작업·대화·읽기 진도는 workspace+user 단위로 나뉩니다. 남의 것은 `404` 입니다.
- 호스트 신원은 로컬 신원과 저장 공간이 섞이지 않습니다. 호스트는 기존 강의 자료를 출처로 쓸 수 없습니다(`403`).
- `/api/module` 밖의 기존 API(`/api/courses`, 진도, 필기, 실습)와 `/slides` 는 로컬 요청만 받습니다. 빌드된 화면 파일은 로컬 또는 유효한 호스트 토큰이 있는 요청에 줍니다.

## 엔드포인트

오류는 항상 `{error, code}` 입니다. `code`: `invalid_request`(400), `unauthorized`(401), `forbidden`(403), `not_found`(404), `conflict`·`invalid_state`·`busy`(409), `too_large`(413), `not_configured`(503), `internal`(500).

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `GET /status` | | `ModuleStatus` |
| `GET /documents` | | `{documents}` |
| `POST /documents` | multipart `file`(PDF ≤50MB, ≤200쪽), `title?` | `201 {document}` (`status:"processing"` → 추출 끝나면 `ready`/`failed`) |
| `GET /documents/:id` | | `{document, pages:[{page,text,imageUrl}], pack, review}` (게시된 해설만) |
| `DELETE /documents/:id` | | `{ok:true}` 추출·작업을 멈추고 파일·대화를 지움 |
| `GET /documents/:id/pages/:n/image` | | JPEG (`imageUrl` 그대로 `<img src>` 가능) |
| `GET`·`PUT /documents/:id/progress` | `{lastPage?, seen?}` | `{progress}` |
| `POST /documents/:id/publish` | `{jobId}` | `{document, pack, review}` 완료된 내 작업만 게시 |
| `POST /jobs` | `{documentId}` | `202 {job}` / 같은 문서에 진행 중 작업이 있으면 `409 conflict` |
| `GET /jobs?documentId=` · `GET /jobs/:id` | | `{jobs}` · `{job}` |
| `GET /jobs/:id/result` | | `{pack, review}` (후보 해설, 완료된 작업만) |
| `POST /jobs/:id/cancel` | | `{job}` 모델 요청까지 끊고, 결과를 남기지 않음 |
| `POST /jobs/:id/retry` | | `202 {job}` 실패·취소된 작업만, 새 작업(`retryOf`). 끝난 쪽은 이어받아 다시 돈을 쓰지 않음 |
| `GET /conversations?source=` | `document:<id>` 또는 `lecture:<course>/<lecture>` | `{conversations}` |
| `POST /conversations` | `{source, page?}` | `201 {conversation}` |
| `GET /conversations/:id` · `DELETE` | | `{conversation, messages}` · `{ok}` |
| `POST /conversations/:id/messages` | `{message(≤4000자), page?}` | **SSE** |

### 작업 상태

`queued → running → completed | failed | cancelled`, `queued → cancelled | failed`. 끝난 상태에서는 바뀌지 않습니다.
서버가 작업 중에 다시 켜지면 `queued`/`running` 작업은 `failed` + `error.code:"interrupted"` 가 되고 **자동으로 다시 돌지 않습니다**(재시도는 명시적으로). 업로드 직후 추출은 비용이 없어 다시 돌립니다.
생성 결과는 작업 폴더에만 저장되고, `publish` 를 불러야 문서의 해설이 됩니다.

### 대화 SSE

`event:` 이름과 JSON `data:`. 15초마다 `: ping` 주석이 옵니다.

```
meta      {conversationId, userMessageId, assistantMessageId, model}
tool      {name:"search_source", query} | {name:"read_page", page}
delta     {text}
citations {citations:[{page,title,quote?}]}
done      {message}
error     {code, error, message?}   # code: auth|rate_limit|bad_request|server|network|protocol|internal|cancelled
```

- 모델은 `search_source`/`read_page` 도구로 자료를 찾아 읽습니다. 답 하나에 요청 라운드 최대 `LESSONVIEWER_CHAT_MAX_STEPS`, 도구 호출 총 `2×STEPS` 개(한 번에 여러 개를 불러도 넘는 것은 오류 결과), 이미지 4장, 보내는 글 총 60,000자. 같은 쪽은 다시 붙이지 않고, 마지막 요청은 도구 없이 답을 마무리합니다. 보고 있는 쪽(`page`)은 글+이미지로 먼저 넣습니다.
- 자료 글은 신뢰하지 않는 데이터로 다룹니다(안의 지시를 따르지 않도록 지시).
- 답의 `[p.N]` 표시 중 **그 출처에 있고 이번 답에서 모델이 실제로 본 쪽만** 인용으로 남깁니다. `quote` 는 그 쪽 글에 그대로 있을 때만 붙습니다.
- 연결을 끊으면(fetch abort) 모델 요청도 끊기고, 그때까지의 답이 `status:"cancelled"` 로 저장됩니다. 실패는 `status:"failed"` 로 저장됩니다(오류 문구는 비밀값을 지운 뒤 저장). 문서를 지우면 그 문서를 읽는 답은 누구 것이든 바로 멈춥니다.
- 같은 대화에서 답이 진행 중이면 새 메시지는 `409 busy`.

## 호스트 연동

**원칙: 토큰과 모델 키는 브라우저에 두지 않습니다.** 호스트의 백엔드가 자기 로그인 세션으로 사용자를 확인한 뒤, 서버끼리 LessonViewer를 부릅니다.

```
브라우저 ──(호스트 쿠키)──▶ 호스트 백엔드 /lessonviewer/* ──(Bearer + workspace/user 헤더)──▶ LessonViewer /api/module/*
```

### 프록시 규칙(권장)

1. 호스트 경로 `/lessonviewer/api/module/*` 만 `http://<lessonviewer>:5178/api/module/*` 로 넘깁니다. 다른 경로(`/api/courses`, `/slides` 등)는 넘기지 않습니다(넘겨도 403).
2. 브라우저가 보낸 `Authorization`, `X-LessonViewer-*`, `Cookie` 헤더는 **지우고**, 호스트 세션에서 정한 값으로 새로 붙입니다:
   `Authorization: Bearer $LESSONVIEWER_HOST_TOKEN`, `X-LessonViewer-Workspace: <조직 id>`, `X-LessonViewer-User: <사용자 id>`.
3. SSE 응답은 버퍼링하지 않습니다(nginx: `proxy_buffering off; proxy_read_timeout 300s;`). 브라우저 연결이 끊기면 위쪽 요청도 끊어야 취소가 전달됩니다.
4. 업로드 크기 한도를 51MB 이상으로 둡니다(`client_max_body_size 51m`).
5. 이미지(`imageUrl`)도 같은 프록시 경로로 받습니다: `/api/module/...` 앞에 호스트 접두사를 붙입니다.
6. LessonViewer 포트를 인터넷에 직접 열지 않습니다. 같은 컴퓨터의 리버스 프록시라도 `X-Forwarded-For` 를 붙이므로 로컬로 오인되지 않습니다(빼지 마세요).

```ts
// 예: 호스트 백엔드(Hono)
app.all("/lessonviewer/api/module/*", requireLogin, async (c) => {
  const url = new URL(c.req.url);
  const target = `${process.env.LESSONVIEWER_URL}${url.pathname.replace(/^\/lessonviewer/, "")}${url.search}`;
  const headers = new Headers(c.req.raw.headers);
  for (const h of ["authorization", "cookie", "x-lessonviewer-workspace", "x-lessonviewer-user", "host"]) headers.delete(h);
  headers.set("authorization", `Bearer ${process.env.LESSONVIEWER_HOST_TOKEN}`);
  headers.set("x-lessonviewer-workspace", c.get("session").orgId);
  headers.set("x-lessonviewer-user", c.get("session").userId);
  headers.set("x-forwarded-for", c.req.header("x-forwarded-for") ?? "host");
  return fetch(target, { method: c.req.method, headers, body: c.req.raw.body, signal: c.req.raw.signal, duplex: "half" } as RequestInit);
});
```

### 임베드

- **권장:** 호스트가 자기 화면에서 위 API 를 직접 씁니다(타입은 `shared/agent.ts`).
- **LessonViewer 화면을 그대로 넣을 때:** 호스트 프록시가 화면 파일(`/`, `/assets/*`)과 `/api/module/*` 를 같은 접두사로 넘기고(같은 Bearer 를 붙임), `<iframe src="/lessonviewer/?embed=1#/library">` 로 띄웁니다. 이때 화면은 호스트 모드로 동작하고 기존 강의·진도·실습 API 는 403 이 됩니다.
- iframe 에도 토큰을 넘기지 않습니다. 인증은 언제나 프록시가 붙입니다.

### 서버 실행(호스트 모드)

```sh
LESSONVIEWER_BIND=0.0.0.0 LESSONVIEWER_HOST_TOKEN=$(openssl rand -hex 32) \
LESSONVIEWER_PROVIDER=anthropic LESSONVIEWER_MODEL=claude-haiku-5-5 LESSONVIEWER_API_KEY=... \
bun server/index.ts
```

방화벽으로 호스트 백엔드에서만 5178 에 닿게 하세요.

## 명령

```sh
bun run test                  # bun test server (모듈·생성 테스트, 실제 모델 호출 없음)
bun run typecheck
bun server/index.ts           # 로컬 실행(.env 읽음)
```

### 실제 키로 확인하기(로컬)

```sh
# 진도 DB·모듈 데이터를 임시 위치로 돌려 실제 데이터를 건드리지 않음
export LESSONVIEWER_STUDY_DB=/tmp/lv-smoke/legacy.db LESSONVIEWER_DATA_DIR=/tmp/lv-smoke/module PORT=5188
bun server/index.ts &
H='-H X-StudyApp:1'
curl -s localhost:5188/api/module/status
DOC=$(curl -s $H -F file=@sample.pdf -F title=샘플 localhost:5188/api/module/documents | jq -r .document.id)
curl -s localhost:5188/api/module/documents/$DOC | jq '.document.status,.document.pageCount'   # ready 될 때까지
JOB=$(curl -s $H -H content-type:application/json -d "{\"documentId\":\"$DOC\"}" localhost:5188/api/module/jobs | jq -r .job.id)
curl -s localhost:5188/api/module/jobs/$JOB | jq .job.status,.job.progress                     # completed 될 때까지
curl -s localhost:5188/api/module/jobs/$JOB/result | jq '.pack.slides|length'
curl -s $H -H content-type:application/json -d "{\"jobId\":\"$JOB\"}" localhost:5188/api/module/documents/$DOC/publish | jq .document.published
CONV=$(curl -s $H -H content-type:application/json -d "{\"source\":{\"kind\":\"document\",\"documentId\":\"$DOC\"},\"page\":1}" localhost:5188/api/module/conversations | jq -r .conversation.id)
curl -N $H -H content-type:application/json -d '{"message":"이 자료의 핵심을 쪽 번호와 함께 설명해 줘"}' localhost:5188/api/module/conversations/$CONV/messages
```
