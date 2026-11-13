#!/bin/sh
# ~/Applications/LessonViewer.app 을 만듦: Swift 래퍼 + 아이콘 + Info.plist. 다시 실행하면 같은 앱을 새로 만듦.
# Spotlight와 LaunchServices에도 바로 등록함.
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APPDIR="$HOME/Applications/LessonViewer.app"
ID=kr.hajung.lessonviewer

# 같은 이름의 다른 앱을 지우지 않도록, 우리 앱(bundle id가 같을 때)만 교체
if [ -d "$APPDIR" ]; then
  cur=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APPDIR/Contents/Info.plist" 2>/dev/null || echo "")
  if [ "$cur" != "$ID" ]; then echo "다른 앱이 $APPDIR 에 있음. 옮기거나 지운 뒤 다시 실행" >&2; exit 1; fi
fi

# 임시 폴더에서 다 만든 뒤 한 번에 바꿔 넣음. 중간에 실패해도 반쪽 앱이 남지 않음
[ -f macos/AppIcon.icns ] || ../.venv/bin/python scripts/make-icon.py
TMP="$(mktemp -d)/LessonViewer.app"
mkdir -p "$TMP/Contents/MacOS" "$TMP/Contents/Resources"
swiftc -O -o "$TMP/Contents/MacOS/LessonViewer" macos/main.swift -framework Cocoa -framework WebKit
cp macos/AppIcon.icns "$TMP/Contents/Resources/AppIcon.icns"
sed "s#__STUDYAPP__#$ROOT#" macos/Info.plist > "$TMP/Contents/Info.plist"
plutil -lint "$TMP/Contents/Info.plist" >/dev/null
codesign --force --deep --sign - "$TMP"
[ -d "$APPDIR" ] && rm -rf "$APPDIR"
mkdir -p "$(dirname "$APPDIR")"
mv "$TMP" "$APPDIR"

LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREG" -f "$APPDIR"
touch "$APPDIR"
mdimport "$APPDIR" 2>/dev/null || true
echo "만듦: $APPDIR"
