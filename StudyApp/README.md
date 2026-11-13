# LessonViewer (StudyApp)

강의 PDF를 슬라이드별 해설과 "문제 → 해결 → trade-off" 흐름으로 읽는 학습 앱. 기존 로컬 학습 기능에 더해, 서버 API key로 문서 해설을 생성하고 근거 쪽을 찾아 대화하는 독립 모듈을 제공한다. 구독 계정 OAuth나 코딩 에이전트 CLI를 사용하지 않는다.

## 실행

Spotlight에서 **LessonViewer**를 열면 된다(`~/Applications/LessonViewer.app`). 서버가 꺼져 있으면 앱이 바뀐 PDF를 렌더하고 화면을 빌드한 뒤 서버를 띄우고, 앱을 끌 때 같이 끈다. 앱 로그는 `~/Library/Logs/LessonViewer.log`에 남는다.

```sh
./scripts/build-mac-app.sh     # 앱 다시 만들기 (macos/main.swift, 아이콘을 바꿨을 때)
../.venv/bin/python scripts/make-icon.py   # 아이콘 다시 그리기
./scripts/launch.sh serve      # 앱 없이 서버만 띄우기 → http://localhost:5178
bun run dev                    # 개발: Vite(5179) + API 서버(5178)
```

## API 에이전트와 자료 관리

- 사이드바 **자료 관리**(`#/library`)에서 PDF를 등록한다. 최대 50MB·200쪽이며, 원본은 그대로 보존한다.
- **해설 생성 → 해설 검토 → 이 해설 게시하기** 순서로 진행한다. 생성한 후보가 기존 게시본을 자동으로 덮어쓰지 않는다. 실패·취소된 작업은 명시적으로 재시도하며 완료한 쪽은 체크포인트에서 이어받는다.
- 원본과 게시된 해설을 읽으면서 **이 쪽 질문하기**로 대화한다. 기존 강의에서도 도구줄의 **학습 에이전트**를 사용할 수 있다. 답에는 실제 조회한 근거 쪽으로 이동하는 버튼이 붙는다. 모델 답변의 정확성 자체를 보증하는 기능은 아니다.
- API 미설정 상태에서도 PDF 등록·원본 읽기는 가능하다. 생성과 대화에는 서버 설정이 필요하며, 브라우저는 키를 저장하지 않는다.
- `.env.example`을 참고해 `LESSONVIEWER_PROVIDER`, `LESSONVIEWER_MODEL`, `LESSONVIEWER_API_KEY`를 설정한다. 로컬에서는 키 대신 `LESSONVIEWER_KEY_REF=api.anthropic.key`로 PrivateKeyHub를 참조할 수 있다. `.env`는 Git에서 제외한다. 설정 변경 뒤에는 서버를 재시작한다.
- 문서·대화·생성 작업은 `data/module/`에 저장된다. 기존 `data/study.db`의 필기·진도와 원본 강의 JSON은 이 과정에서 수정하지 않는다. 모듈 자료의 읽기 위치는 사용자별로 저장된다.
- 새로 생성한 해설 속 코드는 자동 실행하지 않는다. 기존 강의의 Python/SQL 실습은 로컬 접근 제한을 유지한다.

## 다른 서비스에 편입

호스트 백엔드가 사용자 인증을 담당하고, LessonViewer에는 **호스트 토큰 + workspace/user 식별자**를 전달한다. 모델 API key와 호스트 토큰은 서버에만 둔다. 문서는 workspace 단위로 공유하고, 대화·생성 작업·읽기 위치는 사용자별로 분리한다.

- API 계약·환경변수·인증·SSE·프록시 예시: [모듈 API 문서](server/module/README.md)
- TypeScript 계약: `shared/agent.ts`
- UI 임베드: `<iframe src="/lessonviewer/?embed=1#/library">`. 호스트의 인증 프록시가 `/lessonviewer/` 아래 정적 파일과 `/lessonviewer/api/module/`을 함께 전달해야 한다. 프런트엔드가 하위 경로에 맞춰 API와 이미지 주소를 해석한다.
- 기본 서버는 루프백에만 바인딩한다. 외부 서비스에서는 방화벽으로 호스트 백엔드만 접근하게 하고 `LESSONVIEWER_HOST_TOKEN`을 설정한다. 기존 개인용 강의·필기·실습 API는 호스트에 공개하지 않는다.

## 검증

```sh
bun run typecheck
bun run test       # 모듈 소유권·작업 상태·스트림·생성 검증, 실제 모델 과금 없음
bun run validate   # 기존 해설 pack 검증
bun run build
```

실제 API 검증 시 `LESSONVIEWER_DATA_DIR`와 `LESSONVIEWER_STUDY_DB`를 임시 경로로 지정한다. UI 설계 기준과 확인한 범위는 [DESIGN.md](DESIGN.md)에 기록한다.


## 화면

- **강의 화면**: 슬라이드 원본과 해설을 나란히 보여 준다. 빨간 실 위의 번호가 강의의 스토리 beat다. 해설이 길면 슬라이드가 따라온다.
- **너비 조절**: 슬라이드와 해설 사이 경계를 끌면 모든 줄의 비율이 바뀐다. 더블클릭하면 처음 비율로 돌아간다.
- **강의 목록**: 도구줄 왼쪽 버튼이나 `[`로 숨긴다. 좁은 화면에서는 서랍처럼 열린다.
- **도구줄**: 지금 읽는 이야기를 보여 주고, 누르면 이야기 목차로 이동한다. 아래 빨간 막대가 강의 진행도다.
- **보기 방식**: `핵심만`, `기본`(배경·표지를 접음), `전체` 중에서 고른다.
- **검색**: `/` 또는 `⌘K`. 해설, 스토리, 슬라이드 원문을 함께 찾는다. `tab`으로 이 과목과 모든 과목을 오간다.
- **크게 보기**: 슬라이드를 누르면 커지고 `←` `→`로 넘긴다. 닫으면 마지막에 본 쪽으로 이동한다.
- **내 필기**: pdfnote로 필기한 쪽은 필기본 이미지를 보여 준다. 앱에서 직접 쓴 필기도 슬라이드 위에 겹쳐 보인다. `i` 키로 둘 다 켜고 끈다.
- **앱에서 필기하기**: 쪽 왼쪽의 펜 단추, `d`, 또는 크게 보기 아래 막대의 펜 단추로 필기 모드를 연다. 펜(빨강·파랑·검정)·형광펜(노랑·초록·분홍, Shift를 누르고 그으면 곧은 줄)·지우개(닿은 획을 통째로)와 굵기 세 가지를 고르고, `⌘Z`/`⇧⌘Z`로 되돌린다. `←` `→`로 넘기며 계속 쓸 수 있고, 쓰는 대로 저장된다. Apple Pencil이 한 번 닿으면 손가락 터치는 그리지 않는다. 작년 자료 이미지 위에 쓴 필기는 작년 이미지에서만 보인다. 필기가 있는 쪽은 펜 단추에 빨간 점이 붙는다.
- **별표**: 쪽 왼쪽 책갈피 아래 별을 누르거나 `s`를 누르면 빨간 별이 된다. 책갈피·별표를 한 쪽은 보기 방식과 상관없이 펼쳐 둔다.
- **모아 보기**: 책갈피(`f`)를 누른 슬라이드와 확인 필요 슬라이드를 탭으로 나눠 강의를 가로질러 모아 본다.
- **첫 화면**: 마지막에 보던 강의로 바로 이어 보고, 과목마다 읽은 정도와 책갈피·확인 필요 수를 본다.
- **작년 자료**: 컴퓨터보안은 내용이 같은 쪽을 작년 슬라이드로 보여 준다(도구줄 "작년 자료" 또는 `p`). 올해 바뀐 쪽도 작년 슬라이드가 기본이고 "올해 달라진 점"이 붙는다. 작년에 없던 올해 새 쪽만 올해 원본을 보여 주고 "확인 필요"가 붙는다. 쪽 왼쪽의 "작년/올해" 버튼으로 그 쪽만 바꿔 볼 수 있다.
- **전체 흐름**: 과목 전체의 큰 이야기(`content/<course>/course.json`), 이어 보기, 강의별 스토리 목차를 보여 준다.
- **과목 전환**: 사이드바 맨 위 과목 이름을 누른다. 마지막에 보던 과목을 기억한다.
- **확인 필요**: 해설을 쓰면서 확신이 낮았던 쪽(그래프 눈대중, 읽기 힘든 필기, 슬라이드 오타 등)에 붙는다. 누르면 이유가 보인다.
- **수식**: relational algebra와 계산식은 KaTeX(LaTeX)로 그린다. 표기 규칙은 `content/GUIDE.md`의 "수식 (LaTeX)" 절에 있다.
- **코드 실행**: Database·Machine Learning 해설 속 코드 블록 아래 "실행"을 누르면 결과표·출력·그림이 바로 보인다. "고쳐 보기"로 코드를 바꿔 돌려 볼 수 있고, 강의 머리의 "노트북으로 열기"는 같은 내용을 VS Code Jupyter 노트북으로 연다. 모든 노트북 만들기: `bun scripts/notebooks.ts`
- **밝기**: 도구줄의 해·달 버튼이나 `t`로 밝은 화면과 어두운 화면을 바꾼다. 앱에서는 보기 > 화면 밝기 메뉴로도 바꾸고, 창 제목줄도 같이 바뀐다.
- **보기 설정**: 해설 글자 크기, 밝기(시스템, 밝게, 어둡게). `?`로 단축키를 본다.
- 진도(읽은 슬라이드, 책갈피, 별표, 마지막 위치)와 앱에서 쓴 필기는 `data/study.db`(SQLite)에 저장된다.
- **시험 요약**: 사이드바 맨 위 "시험 요약"은 과목을 A4 몇 쪽으로 압축한 PDF다(고웹프·Database·Blockchain·Cybersecurity). 원고 `content/<course>/summary.md`를 고친 뒤 `../.venv/bin/python scripts/summary-pdf.py <course>` → `bun run extract`로 다시 만든다.
- **Blockchain 추가 자료**: 9주차 비대칭키 자료와 7주차 RSA·CRT 실습을 강의 목록에서 볼 수 있다. 9주차는 기존 193쪽 비대칭키 강의의 143쪽 편집본이라 빠진 hash 상세 내용은 6주차 자료에 남아 있다.

## 구조

| 경로 | 내용 |
|---|---|
| `courses.json` | 과목과 강의 목록. 강의 PDF 파일 이름(확장자 제외)을 적는다 |
| `scripts/extract.py` | PDF를 슬라이드 이미지(원본·필기본)와 페이지 텍스트로 뽑는다 |
| `content/GUIDE.md` | 해설 pack 스키마와 작성 규칙 |
| `content/<course>/<lecture>.json` | 해설 pack. 강의마다 하나 |
| `content/<course>/course.json` | 과목 전체 스토리 |
| `scripts/validate.ts` | pack 스키마 검사 (`bun run validate`) |
| `scripts/summary-pdf.py` | `content/<course>/summary.md`를 A4 PDF `../<과목 폴더>/시험대비 요약.pdf`로 만든다 |
| `server/` | Hono API + 정적 파일 서버, SQLite 진도 저장 |
| `macos/` | 네이티브 앱 래퍼(Swift, WKWebView), Info.plist, 아이콘 |
| `scripts/launch.sh` | 준비(렌더·빌드)와 서버 실행. 앱과 `공부 앱.command`가 씀 |
| `web/` | React 화면 |

## 강의 추가하기

1. `courses.json`에 강의를 추가한다.
2. `bun run extract`로 이미지와 텍스트를 뽑는다.
3. 유미에게 `content/GUIDE.md` 기준으로 해설 pack을 만들어 달라고 한다.
4. `bun run validate`로 검사한다.
