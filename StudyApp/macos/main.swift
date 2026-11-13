// LessonViewer: StudyApp 화면을 담는 macOS 네이티브 창.
// 서버(localhost:5178)가 꺼져 있으면 바뀐 PDF를 렌더하고 화면을 빌드한 뒤 띄우고, 앱을 끌 때 직접 띄운 서버만 같이 끔.
// 빌드: scripts/build-mac-app.sh  →  ~/Applications/LessonViewer.app

import Cocoa
import WebKit

let appRoot = Bundle.main.object(forInfoDictionaryKey: "StudyAppPath") as? String ?? "\(NSHomeDirectory())/학교자료/StudyApp"
let port = 5178
let homeURL = URL(string: "http://localhost:\(port)/")!
let logURL = URL(fileURLWithPath: "\(NSHomeDirectory())/Library/Logs/LessonViewer.log")

enum Boot { case ready(Process?), failed(String) }

// 앱 쪽 사건(로드 성공·실패, 종료)을 서버 로그와 같은 파일에 남김
func appLog(_ message: String) {
  let line = "[LessonViewer \(ISO8601DateFormatter().string(from: Date()))] \(message)\n"
  if let h = Server.logHandle() { h.write(line.data(using: .utf8)!); try? h.close() }
}

// 서버 준비는 화면을 막지 않게 백그라운드에서 함
enum Server {
  static func alive() -> Bool {
    var req = URLRequest(url: URL(string: "http://localhost:\(port)/api/courses")!)
    req.timeoutInterval = 1.5
    let done = DispatchSemaphore(value: 0)
    var ok = false
    URLSession.shared.dataTask(with: req) { _, resp, _ in
      ok = (resp as? HTTPURLResponse)?.statusCode == 200
      done.signal()
    }.resume()
    done.wait()
    return ok
  }

  static func logHandle() -> FileHandle? {
    if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
    let h = try? FileHandle(forWritingTo: logURL)
    h?.seekToEndOfFile()
    return h
  }

  static func process(_ args: [String]) -> Process {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = ["\(appRoot)/scripts/launch.sh"] + args
    p.currentDirectoryURL = URL(fileURLWithPath: appRoot)
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
    p.environment = env
    if let log = logHandle() { p.standardOutput = log; p.standardError = log }
    return p
  }

  static func ensure() -> Boot {
    if alive() { return .ready(nil) }
    let prep = process(["prepare"])
    do { try prep.run() } catch { return .failed("준비 스크립트를 못 돌렸어: \(error.localizedDescription)") }
    prep.waitUntilExit()
    if prep.terminationStatus != 0 { return .failed("강의 자료를 준비하다 막혔어..") }
    let server = process(["run"])
    do { try server.run() } catch { return .failed("서버를 못 띄웠어: \(error.localizedDescription)") }
    for _ in 0..<60 {
      if alive() { return .ready(server) }
      if !server.isRunning { return .failed("서버가 바로 꺼져 버렸어..") }
      usleep(200_000)
    }
    server.terminate()
    return .failed("서버가 12초 동안 대답이 없었어..")
  }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, NSMenuItemValidation {
  var window: NSWindow!
  var web: WKWebView!
  var server: Process?
  var titleWatch: NSKeyValueObservation?
  var termSignal: DispatchSourceSignal?
  var watchdog: Timer?
  var booting = false
  var misses = 0
  var resumeURL: URL?          // 서버를 다시 띄운 뒤 돌아갈 화면
  var theme = UserDefaults.standard.string(forKey: "theme") ?? "system"   // 화면이 마지막으로 알려 준 밝기

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = makeMenu()

    // kill(SIGTERM)로 꺼질 때도 정상 종료 경로를 타서, 직접 띄운 서버를 같이 끔
    signal(SIGTERM, SIG_IGN)
    termSignal = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    termSignal?.setEventHandler { NSApp.terminate(nil) }
    termSignal?.resume()
    applyAppearance()   // 준비 화면부터 지난번 밝기로

    let config = WKWebViewConfiguration()
    config.preferences.isElementFullscreenEnabled = true
    config.userContentController.add(self, name: "theme")
    web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.allowsMagnification = false   // 핀치 확대는 창보다 커져 상하좌우로 밀리고 되돌리기 어려움. 글자 크기는 ⌘+/⌘-(창 폭에 맞춰 다시 배치)로
    web.allowsBackForwardNavigationGestures = true
    web.isInspectable = true

    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 920),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "LessonViewer"
    window.minSize = NSSize(width: 720, height: 520)
    window.contentView = web
    window.isReleasedWhenClosed = false
    if !window.setFrameUsingName("LessonViewerMain") { window.center() }
    window.setFrameAutosaveName("LessonViewerMain")
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)

    // 창 제목은 지금 보는 강의 이름
    titleWatch = web.observe(\.title, options: [.new]) { [weak self] view, _ in
      Task { @MainActor in
        let t = (view.title ?? "").replacingOccurrences(of: " | LessonViewer", with: "")
        self?.window.title = t.isEmpty ? "LessonViewer" : t
      }
    }
    boot()
  }

  // 화면을 새로 빌드했을 수 있으니 켤 때 WebKit 캐시를 비움(보기 설정이 든 localStorage는 그대로)
  func clearWebCache() async {
    let types: Set<String> = [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache]
    await WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: .distantPast)
  }

  func boot() {
    booting = true
    if let url = web.url, url.host == "localhost" { resumeURL = url }
    showStatus("준비하는 중", detail: "바뀐 강의 자료가 있으면 유미가 정리하고 화면 띄워 줄게.", spinner: true)
    Task.detached {
      let result = Server.ensure()
      await MainActor.run { self.finish(result) }
    }
  }

  func finish(_ result: Boot) {
    booting = false
    switch result {
    case .ready(let p):
      if let p { server = p }
      let target = resumeURL ?? homeURL
      resumeURL = nil
      Task {
        await clearWebCache()
        web.load(URLRequest(url: target))
        window.makeFirstResponder(web)
      }
      startWatchdog()
    case .failed(let message):
      showStatus(message, detail: "로그: ~/Library/Logs/LessonViewer.log\n⌘R로 다시 해볼 수 있어.", spinner: false)
    }
  }

  // 빌려 쓰던 서버(다른 곳에서 띄운 것)가 사라지거나 서버가 죽으면, 두 번 연속 응답이 없을 때 직접 다시 띄움
  func startWatchdog() {
    watchdog?.invalidate()
    watchdog = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.checkServer() }
    }
  }

  func checkServer() {
    guard !booting else { return }
    Task.detached {
      let ok = Server.alive()
      await MainActor.run {
        if ok { self.misses = 0; return }
        self.misses += 1
        if self.misses >= 2 && !self.booting {
          self.misses = 0
          appLog("서버가 응답하지 않아 다시 띄움")
          self.boot()
        }
      }
    }
  }

  func showStatus(_ title: String, detail: String, spinner: Bool) {
    let esc = { (s: String) in s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: "\n", with: "<br>") }
    let html = """
    <!doctype html><meta charset="utf-8"><style>
    :root{color-scheme:light dark;--bg:#eef1f5;--ink:#1b2232;--ink2:#566074;--red:#e11d48}
    @media (prefers-color-scheme:dark){:root{--bg:#13171e;--ink:#e6e9ef;--ink2:#aab2c0;--red:#ff5378}}
    body{margin:0;height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font-family:"GyeonggiTitle",-apple-system,sans-serif}
    .box{text-align:center;max-width:30em;padding:0 24px}
    .thread{width:2px;height:64px;margin:0 auto 18px;background:var(--red);opacity:.5;transform-origin:top;animation:draw 1.2s ease-in-out infinite alternate}
    .thread.still{animation:none}
    h1{font-size:20px;margin:0 0 8px}p{margin:0;color:var(--ink2);font-size:14px;line-height:1.7}
    @keyframes draw{from{transform:scaleY(.15)}to{transform:scaleY(1)}}
    </style><div class="box"><div class="thread \(spinner ? "" : "still")"></div><h1>\(esc(title))</h1><p>\(esc(detail))</p></div>
    """
    web.loadHTMLString(html, baseURL: nil)
  }

  // 밖으로 나가는 링크는 기본 브라우저로, 앱 안 링크는 이 창에서
  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
    guard let url = navigationAction.request.url, let scheme = url.scheme else { return .allow }
    if scheme == "about" || url.host == "localhost" || url.host == "127.0.0.1" { return .allow }
    if scheme.hasPrefix("http") || scheme == "mailto" { NSWorkspace.shared.open(url); return .cancel }
    return .allow
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = navigationAction.request.url {
      if url.host == "localhost" { webView.load(URLRequest(url: url)) } else { NSWorkspace.shared.open(url) }
    }
    return nil
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard let url = webView.url, url.host == "localhost" else { return }
    appLog("화면 로드: \(url.absoluteString)")
    // 앱이 그린 첫 화면을 남겨 둠(문제 제보 때 어떤 화면이었는지 확인용)
    Task {
      try? await Task.sleep(nanoseconds: 1_500_000_000)
      let js = "location.hash + ' | ' + ((document.querySelector('main h1') || {}).textContent || '(제목 없음)')"
      if let seen = try? await webView.evaluateJavaScript(js) as? String { appLog("첫 화면: \(seen)") }
    }
  }

  // 서버가 중간에 꺼졌으면 안내 화면으로
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    loadFailed(error)
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    loadFailed(error)
  }

  // 새 로드가 시작되며 앞 로드가 취소된 것(-999)과 WebKit의 '프레임 로드 중단'(102)은 실패가 아님.
  // 이걸 실패로 보고 안내 화면을 띄우면, 그 안내 화면이 다시 진짜 화면 로드를 취소해 버림
  func loadFailed(_ error: Error) {
    let e = error as NSError
    if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
    if e.domain == "WebKitErrorDomain" && e.code == 102 { return }
    appLog("화면 로드 실패: \(e.domain) \(e.code) \(e.localizedDescription)")
    showStatus("화면을 못 불러왔어..", detail: "\(e.localizedDescription)\n⌘R로 다시 해볼 수 있어.", spinner: false)
  }

  // 화면을 그리던 WebKit 프로세스가 죽으면 다시 불러옴
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    appLog("화면 프로세스가 종료되어 다시 불러옴")
    webView.load(URLRequest(url: webView.url?.host == "localhost" ? webView.url! : homeURL))
  }

  // 화면에서 밝기를 바꾸면(해·달 버튼, t 키, 보기 설정) 창 제목줄·메뉴도 같은 밝기로 맞춤
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == "theme", let t = message.body as? String, ["system", "light", "dark"].contains(t) else { return }
    theme = t
    UserDefaults.standard.set(t, forKey: "theme")
    applyAppearance()
  }

  func applyAppearance() {
    NSApp.appearance = theme == "light" ? NSAppearance(named: .aqua) : theme == "dark" ? NSAppearance(named: .darkAqua) : nil
  }

  // 보기 > 화면 밝기. 고른 값은 화면이 저장하고, 화면이 다시 알려 주면 창도 따라 바뀜
  @objc func chooseTheme(_ sender: NSMenuItem) {
    guard let t = sender.representedObject as? String else { return }
    web.evaluateJavaScript("window.lessonViewer && window.lessonViewer.setTheme('\(t)')")
  }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    if item.action == #selector(chooseTheme(_:)) {
      item.state = (item.representedObject as? String) == theme ? .on : .off
      return web.url?.host == "localhost" && !booting
    }
    return true
  }

  @objc func reloadApp(_ sender: Any?) {
    if web.url?.host == "localhost" { web.reload() } else { boot() }
  }
  @objc func zoomIn(_ sender: Any?) { web.pageZoom = min(2.0, web.pageZoom + 0.1) }
  @objc func zoomOut(_ sender: Any?) { web.pageZoom = max(0.6, web.pageZoom - 0.1) }
  @objc func zoomReset(_ sender: Any?) { web.pageZoom = 1.0 }
  @objc func openLog(_ sender: Any?) { NSWorkspace.shared.open(logURL) }
  @objc func goBack(_ sender: Any?) { web.goBack() }
  @objc func goForward(_ sender: Any?) { web.goForward() }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  func applicationWillTerminate(_ notification: Notification) {
    watchdog?.invalidate()
    if let p = server, p.isRunning { p.terminate(); appLog("종료: 앱이 띄운 서버도 끔") } else { appLog("종료") }
  }

  func makeMenu() -> NSMenu {
    let main = NSMenu()
    func submenu(_ title: String, _ items: [NSMenuItem]) {
      let host = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      let menu = NSMenu(title: title)
      items.forEach { menu.addItem($0) }
      host.submenu = menu
      main.addItem(host)
    }
    func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
      i.keyEquivalentModifierMask = mods
      return i
    }
    func themeMenu() -> NSMenuItem {
      let host = NSMenuItem(title: "화면 밝기", action: nil, keyEquivalent: "")
      let menu = NSMenu(title: "화면 밝기")
      for (title, value) in [("시스템 따라가기", "system"), ("밝게", "light"), ("어둡게", "dark")] {
        let i = NSMenuItem(title: title, action: #selector(chooseTheme(_:)), keyEquivalent: "")
        i.representedObject = value
        menu.addItem(i)
      }
      host.submenu = menu
      return host
    }
    submenu("LessonViewer", [
      item("LessonViewer에 관하여", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
      .separator(),
      item("로그 열기", #selector(openLog(_:))),
      .separator(),
      item("LessonViewer 가리기", #selector(NSApplication.hide(_:)), "h"),
      item("기타 가리기", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("모두 보기", #selector(NSApplication.unhideAllApplications(_:))),
      .separator(),
      item("LessonViewer 종료", #selector(NSApplication.terminate(_:)), "q"),
    ])
    submenu("편집", [
      item("실행 취소", Selector(("undo:")), "z"),
      item("실행 복귀", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("오려두기", #selector(NSText.cut(_:)), "x"),
      item("복사하기", #selector(NSText.copy(_:)), "c"),
      item("붙여넣기", #selector(NSText.paste(_:)), "v"),
      item("전체 선택", #selector(NSText.selectAll(_:)), "a"),
    ])
    submenu("보기", [
      item("새로고침", #selector(reloadApp(_:)), "r"),
      .separator(),
      item("실제 크기", #selector(zoomReset(_:)), "0"),
      item("확대", #selector(zoomIn(_:)), "="),
      item("축소", #selector(zoomOut(_:)), "-"),
      .separator(),
      themeMenu(),
      .separator(),
      item("뒤로", #selector(goBack(_:)), "["),
      item("앞으로", #selector(goForward(_:)), "]"),
      .separator(),
      item("전체 화면", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
    ])
    submenu("윈도우", [
      item("최소화", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("확대/축소", #selector(NSWindow.performZoom(_:))),
      item("닫기", #selector(NSWindow.performClose(_:)), "w"),
    ])
    return main
  }
}

// 시작 코드는 메인 스레드에서 돎. delegate는 NSApplication이 약하게 잡으므로 run() 동안 이 지역 변수가 붙잡음
MainActor.assumeIsolated {
  let app = NSApplication.shared
  let delegate = AppDelegate()
  app.delegate = delegate
  app.setActivationPolicy(.regular)
  app.run()
}
