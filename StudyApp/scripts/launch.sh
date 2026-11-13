#!/bin/sh
# LessonViewer 준비·실행.
#   prepare  바뀐 강의 PDF를 렌더하고(바뀐 것만), 화면 코드가 dist보다 새로우면 다시 빌드
#   run      서버만 실행(앞에서 계속 돎)
#   serve    prepare 뒤 run
set -e
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

prepare() {
  ../.venv/bin/python scripts/extract.py >/dev/null
  if [ ! -f dist/index.html ] || [ -n "$(find web shared vite.config.ts package.json -type f -newer dist/index.html 2>/dev/null | head -1)" ]; then
    bun run build >/dev/null
  fi
}

case "${1:-serve}" in
  prepare) prepare ;;
  run) exec bun server/index.ts ;;
  serve) prepare; exec bun server/index.ts ;;
  *) echo "사용법: scripts/launch.sh [prepare|run|serve]" >&2; exit 1 ;;
esac
