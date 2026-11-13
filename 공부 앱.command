#!/bin/sh
# 시험공부 앱 LessonViewer를 엶. 앱이 없으면(예: 다른 맥) 서버를 직접 띄우고 브라우저로 엶.
APP="$HOME/Applications/LessonViewer.app"
if [ -d "$APP" ]; then exec open "$APP"; fi
cd "$(dirname "$0")/StudyApp" || exit 1
(sleep 2; open http://localhost:5178) &
exec ./scripts/launch.sh serve
