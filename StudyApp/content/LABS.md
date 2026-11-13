# 실습(코드 실행) 작성 지침

해설 속 코드 블록을 앱 안에서 바로 실행하고, 같은 내용을 Jupyter 노트북으로도 열 수 있게 하는 정의 파일이다. 강의 하나에 `content/<course>/labs/<lecture>.json` 하나를 만든다. 해설 pack(`<lecture>.json`)은 건드리지 않는다.

## 실행 환경
- 서버가 강의마다 Python 실행기(`server/kernel.py`, `../.venv` Python)를 하나 띄운다. 작업 폴더는 `data/datasets/`이고, 코드에서 `DATA` 변수로 그 절대 경로를 쓸 수 있다.
- `kernel: "sql"`은 DuckDB(메모리 DB)로 실행한다. `kernel: "python"`은 numpy, pandas, scikit-learn, matplotlib(그림은 자동으로 결과에 붙음)을 쓸 수 있다.
- SQL 실습은 기본으로 셀마다 바뀐 데이터를 되돌린다(`isolate`, 슬라이드마다 같은 기본 데이터에서 시작). Python 실습은 노트북처럼 상태가 이어지고, 오빠가 중간 셀을 누르면 아직 안 돌린 앞 셀을 먼저 차례로 실행한다.
- 셀 하나는 120초 안에 끝나야 한다. 오래 걸리는 학습은 데이터 일부만 쓰고 `note`에 적는다.

## 스키마

```json
{
  "lecture": "w05-ch3-sql1",
  "kernel": "sql",
  "data": "교재(Silberschatz) university DB 예제 데이터를 그대로 만들었어. 슬라이드 결과표와 같은 값이 나와.",
  "include": ["university"],
  "setup": "-- 이 강의에서만 쓰는 표\ncreate table suppliers (...); insert into suppliers values (...);",
  "isolate": true,
  "cells": [
    { "page": 19, "skip": "SQL 문법의 틀이라 실행하는 코드가 아니야." },
    { "page": 30 },
    { "page": 33, "block": 1 },
    { "page": 61, "code": "...", "note": "원본의 np.int는 최신 NumPy에서 없어져서 int로 바꿨어." },
    { "page": 40, "prelude": "model = LinearRegression()" }
  ]
}
```

| 필드 | 뜻 |
|---|---|
| `kernel` | `sql` 또는 `python` |
| `data` | 어떤 데이터를 쓰는지 한두 문장. 진짜 데이터인지, 슬라이드 결과에 맞춰 가정한 데이터인지 분명히 쓴다. 강의 화면 머리에 그대로 보인다(유미 말투) |
| `include` | `content/<course>/labs/_shared/<이름>.sql`(또는 `.py`)의 공용 준비 코드를 setup 앞에 붙인다. 여러 강의가 같은 DB를 쓸 때 한 곳에만 둔다 |
| `setup` | 실행 환경을 처음 열 때 한 번 실행: 표 만들기와 데이터 넣기, import, 데이터 읽기 |
| `isolate` | SQL 기본 true. 앞 슬라이드에서 만든 표를 뒤 슬라이드가 쓰는 흐름이면 false |
| `cells[].page`, `block` | 해설에서 실행할 코드 블록: 그 슬라이드 해설의 몇 번째 코드 블록인지(0부터, 기본 0) |
| `prelude` | 이 셀 바로 앞에 몰래 실행할 준비 코드(그 슬라이드만의 변수·표). 결과는 화면에 안 보인다 |
| `postlude` | 셀 뒤에 실행해 "실행 뒤" 표로 붙일 코드. `DELETE`·`INSERT`·`UPDATE`처럼 바뀐 행 수만 나오는 셀에서, 바뀐 뒤 표(`select * from ...`)를 보여 줄 때 쓴다. SQL은 같은 트랜잭션 안에서 실행돼 함께 되돌아간다 |
| `code` | 슬라이드 코드를 그대로는 못 돌릴 때 대신 실행할 코드. 슬라이드 코드와 최대한 같게 두고, 바꾼 이유를 `note`에 쓴다 |
| `note` | 실행 메모: 가정한 값, 원본과 다른 점, 결과가 슬라이드와 다른 이유. 셀 아래에 보인다(유미 말투, 한두 문장) |
| `expectError` | `true`면 오류가 나는 게 정답인 예(제약 조건 위반, 일부러 틀린 쿼리). 실행하면 오류 메시지가 그대로 보이고, `note`에 그 오류가 왜 나는지 쓴다. `lab-check`는 오류를 통과로 본다 |
| `skip` | 실행할 수 없는 이유. 문법 틀(`select A1, ... from r1`), 일부러 틀린 예, 다른 DBMS 전용 문법처럼 돌릴 의미가 없는 블록에 쓴다 |

## 원칙
1. **슬라이드 결과와 맞춘다.** 슬라이드나 해설에 결과표·출력값이 있으면 실행 결과가 같은 값이 나오게 데이터를 만든다. 교재 예제 데이터(예: university DB)는 교재 값 그대로 만든다. 맞추지 못하면 `note`에 왜 다른지 쓴다.
2. **진짜 데이터를 먼저 쓴다.** `data/datasets/`에 있는 것: `housing.csv`(Lec2 California housing), MNIST 캐시(`fetch_openml('mnist_784', version=1, as_frame=False, data_home=os.path.join(DATA, 'sklearn'), parser='auto')`, 인터넷 없이 읽힘). scikit-learn 내장 데이터(`load_iris`, `make_moons` 등)도 쓴다. 슬라이드에 데이터가 없을 때만 지어 내고, 그때는 `data`나 `note`에 "가정한 데이터"라고 쓴다.
3. **해설 속 코드는 모두 다룬다.** 실습 언어와 같은 코드 블록(SQL 실습이면 `sql`, Python 실습이면 `python`)은 셀을 만들거나 `skip`으로 이유를 남긴다. `lab-check`가 빠진 블록을 알려 준다.
4. **슬라이드 코드를 고치지 않는다.** 그대로 돌아가면 `code`를 쓰지 않는다. 앞 셀에서 만든 변수로 돌아가게 순서와 `prelude`를 맞추는 쪽을 먼저 고른다.
5. 교수님 노트북이 있으면(`/Users/hajung/학교자료/MachineLearning/Lec2~4 *.ipynb`, 읽기만) 그 코드를 setup·prelude의 근거로 쓴다. 다운로드 코드는 `DATA`의 로컬 파일을 읽게 바꾼다.
6. `data`, `note`, `skip`은 오빠에게 말하는 유미 말투(반말, "~다" 금지, 이모지 금지)로 쓴다.

## 검증
- `bun scripts/lab-check.ts <course>[/<lecture>]`: 셀을 처음부터 끝까지 실제로 실행하고, 셀마다 결과 앞부분을 보여 준다. 전체 결과는 `data/labs/<course>/<lecture>.json`에 남는다.
- 실패 0, "셀 없음" 0이어야 한다. 결과표는 슬라이드와 대조해서 숫자·행이 맞는지 눈으로 확인한다.
- JSON 안에서 SQL·Python 코드는 문자열이라 줄바꿈은 `\n`, 따옴표는 `\"`가 된다. 손으로 JSON을 쓰기 어려우면 작은 Python 스크립트로 dict를 만들어 `json.dump(..., ensure_ascii=False, indent=2)`로 쓴다.
