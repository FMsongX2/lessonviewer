# 학교자료 + LessonViewer

강의 PDF를 슬라이드별 해설과 함께 읽는 macOS용 학습 환경이다. 실제로 쓰는 구성을 그대로 공개하고, 강의 자료(PDF)와 그 자료로 만든 해설·요약만 뺐다.

| 경로 | 내용 |
|---|---|
| `StudyApp/` | LessonViewer 본체(React 화면 + Bun 서버 + macOS WKWebView 앱). 자세한 기능은 [StudyApp/README.md](StudyApp/README.md) |
| `pdfnote.py` | 과목 폴더의 PDF·PPTX를 연속 스크롤로 보며 페이지 위에 글자 상자(FreeText 주석)로 필기하는 Tk 앱. 첫 저장 때 원본을 `*.orig.pdf`로 남긴다. LessonViewer의 "내 필기"가 이 필기본을 보여 준다 |
| `eclass_sort.py` | `~/Downloads`에 받은 eClass 자료를 과목 폴더로 옮기고 ppt를 PDF로 바꾼다 |
| `공부 앱.command`, `PDF 메모.command` | Finder에서 더블클릭으로 여는 실행 파일 |

빠진 것: 과목 폴더와 강의 PDF, `StudyApp/content/<과목>/`(해설 pack·과목 이야기·시험 요약 원고·실습 정의), `StudyApp/notebooks/`, `StudyApp/data/`(렌더 이미지와 진도 DB).

## 준비

macOS, [Bun](https://bun.sh), Python 3.14(Tk 포함), Xcode Command Line Tools(`swiftc`)가 필요하다.

```sh
git clone https://github.com/FMsongX2/lessonviewer.git 학교자료
cd 학교자료
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cd StudyApp && bun install
./scripts/build-mac-app.sh      # ~/Applications/LessonViewer.app 생성. Spotlight에서 LessonViewer로 연다
```

앱 없이 쓰려면 `./scripts/launch.sh serve` 뒤 http://localhost:5178 을 연다.

## 과목 추가

1. 저장소 루트에 과목 폴더를 만들고 강의 PDF를 넣는다(예: `Database/Week 2 (Chapter 1 - Introduction).pdf`).
2. `StudyApp/courses.json`의 `courses`에 과목과 강의를 적는다. `file`은 확장자를 뺀 PDF 파일 이름이다.

   ```json
   {
     "materialsRoot": "..",
     "courses": [
       {
         "id": "database",
         "title": "Database",
         "dir": "Database",
         "lectures": [
           { "id": "w02-ch1", "group": "lecture", "week": "Week 2", "title": "Ch.1 Introduction", "file": "Week 2 (Chapter 1 - Introduction)" }
         ]
       }
     ]
   }
   ```

3. `cd StudyApp && bun run extract`로 슬라이드 이미지와 텍스트를 뽑는다. 앱을 열 때도 바뀐 PDF만 자동으로 다시 뽑는다.
4. 해설은 둘 중 하나로 만든다.
   - 코딩 에이전트(Claude Code 등)에게 `StudyApp/content/GUIDE.md` 기준으로 `content/<과목>/<강의>.json` pack을 써 달라고 하고 `bun run validate`로 검사한다. `StudyApp/AGENTS.md`가 에이전트용 작업 지침이다.
   - 앱의 **자료 관리**(`#/library`)에 PDF를 올리고 API 에이전트로 생성한다. `StudyApp/.env.example`을 `.env`로 복사해 모델과 API 키를 넣는다.

## eClass 자동 정리

`eclass_sort.py`의 `COURSES`에 eClass 과목 키(`ky=`)와 과목 폴더 이름을 적는다. 키는 받은 파일에서 `xattr -p com.apple.metadata:kMDItemWhereFroms <파일>`로 확인한다. ppt 변환에는 LibreOffice가 필요하다. `.venv/bin/python eclass_sort.py`로 직접 돌리거나 `~/Downloads` 변경 때 실행되게 launchd에 등록한다.
