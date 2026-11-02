import AppKit
import WebKit
import UniformTypeIdentifiers

final class MapApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: AssetServer?
    private var origin: URL?
    private var pendingHash: String?
    private let location = NativeLocation()
    private let defaults = UserDefaults.standard

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        createMenu()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController.add(self, name: "mirea")
        if let file = Bundle.main.url(forResource: "native-bridge", withExtension: "js"),
           let script = try? String(contentsOf: file, encoding: .utf8) {
            configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        window = NSWindow(contentRect: phoneFrame(), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Карта МИРЭА · Вернадского, 78"
        window.minSize = NSSize(width: 360, height: 560)
        window.maxSize = NSSize(width: 680, height: 1100)
        window.contentView = webView
        window.delegate = self
        window.setFrameAutosaveName("MireaMapPhoneWindow")
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        location.deliver = { [weak self] id, value in self?.reply(id, payload: value) }
        startServer(preferred: UInt16(exactly: defaults.integer(forKey: "assetPort")) ?? 0)
    }

    private func phoneFrame() -> NSRect {
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 900)
        return NSRect(x: 0, y: 0, width: min(430, screen.width - 48), height: min(820, screen.height - 64))
    }

    private func startServer(preferred: UInt16) {
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("public", isDirectory: true) else { return }
        let service = AssetServer(root: root)
        server = service
        service.start(port: preferred) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let port):
                    self.defaults.set(Int(port), forKey: "assetPort")
                    let base = URL(string: "http://127.0.0.1:\(port)/")!
                    self.origin = base
                    let hash = self.pendingHash ?? self.defaults.string(forKey: "viewHash").flatMap(MapPolicy.viewHash) ?? ""
                    self.webView.load(URLRequest(url: URL(string: base.absoluteString + hash)!))
                case .failure:
                    service.stop()
                    if preferred != 0 { self.startServer(preferred: 0) }
                    else {
                        let alert = NSAlert()
                        alert.messageText = "Не удалось открыть карту"
                        alert.informativeText = "Закройте приложение и откройте его снова. Файлы карты находятся внутри приложения."
                        alert.beginSheetModal(for: self.window)
                    }
                }
            }
        }
    }

    private func ownOrigin(_ url: URL?) -> Bool {
        guard let url, let origin else { return false }
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == origin.port && url.user == nil && url.password == nil
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, ownOrigin(message.frameInfo.request.url),
              let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        if action == "remember" {
            if let value = body["hash"] as? String, let safe = MapPolicy.viewHash(value) { defaults.set(safe, forKey: "viewHash") }
            return
        }
        guard let id = body["id"] as? String, id.count < 80 else { return }
        switch action {
        case "geo-watch": location.watch(id)
        case "geo-clear": location.clear(id)
        case "share":
            guard let value = body["url"] as? String, let hash = MapPolicy.viewHash(value),
                  let url = URL(string: "mireamap://map" + hash) else { reject(id, "Некорректная ссылка карты."); return }
            let picker = NSSharingServicePicker(items: [url])
            picker.show(relativeTo: NSRect(x: webView.bounds.midX, y: webView.bounds.maxY - 40, width: 1, height: 1), of: webView, preferredEdge: .minY)
            reply(id, payload: ["value": ["method": "share"]])
        case "export-gps":
            guard let json = body["json"] as? String, MapPolicy.validGPSExport(json) else { reject(id, "Некорректный файл GPS-уточнений."); return }
            let panel = NSSavePanel()
            panel.title = "Сохранить GPS-уточнения"
            panel.allowedContentTypes = [.json]
            let date = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
            panel.nameFieldStringValue = "MIREA-V78-GPS-\(date).json"
            panel.beginSheetModal(for: window) { [weak self] response in
                guard let self else { return }
                guard response == .OK, let url = panel.url else { self.reject(id, "Отменено", name: "AbortError"); return }
                do {
                    try Data(json.utf8).write(to: url, options: .atomic)
                    self.reply(id, payload: ["value": ["method": "download", "filename": url.lastPathComponent]])
                } catch { self.reject(id, "Не удалось сохранить файл. Выберите другую папку.") }
            }
        default: reject(id, "Неизвестное действие.")
        }
    }

    private func reply(_ id: String, payload: [String: Any]) {
        Task { @MainActor in
            _ = try? await webView.callAsyncJavaScript("window.__mireaDesktopReply(id, payload)", arguments: ["id": id, "payload": payload], in: nil, contentWorld: .page)
        }
    }
    private func reject(_ id: String, _ message: String, name: String = "Error") {
        reply(id, payload: ["error": ["name": name, "message": message]])
    }
    private func lifecycle(_ active: Bool) {
        if !active { location.stop() }
        Task { @MainActor in
            _ = try? await webView.callAsyncJavaScript("document.documentElement.dataset.appActive = String(active); window.dispatchEvent(new CustomEvent('atlas:app-state', { detail: { isActive: active } }));", arguments: ["active": active], in: nil, contentWorld: .page)
        }
    }
    func windowDidMiniaturize(_ notification: Notification) { lifecycle(false) }
    func windowDidDeminiaturize(_ notification: Notification) { lifecycle(true) }
    func applicationDidHide(_ notification: Notification) { lifecycle(false) }
    func applicationDidUnhide(_ notification: Notification) { lifecycle(true) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) {
        location.stop()
        server?.stop()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "mirea")
    }
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let hash = urls.first.flatMap({ MapPolicy.viewHash($0.absoluteString) }) else { return }
        pendingHash = hash
        if let origin { webView.load(URLRequest(url: URL(string: origin.absoluteString + hash)!)) }
        window?.makeKeyAndOrderFront(nil)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if ownOrigin(navigationAction.request.url) { decisionHandler(.allow); return }
        if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url, url.scheme == "https" {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme == "https", navigationAction.navigationType == .linkActivated { NSWorkspace.shared.open(url) }
        return nil
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    private func createMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "О Карте МИРЭА", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Скрыть Карту МИРЭА", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Завершить Карту МИРЭА", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem(title: "Правка", action: nil, keyEquivalent: "")
        let edit = NSMenu(title: "Правка")
        for (title, selector, key) in [("Отменить", "undo:", "z"), ("Вырезать", "cut:", "x"), ("Копировать", "copy:", "c"), ("Вставить", "paste:", "v"), ("Выбрать всё", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: NSSelectorFromString(selector), keyEquivalent: key)
        }
        editItem.submenu = edit
        menu.addItem(editItem)
        let windowItem = NSMenuItem(title: "Окно", action: nil, keyEquivalent: "")
        let windows = NSMenu(title: "Окно")
        windows.addItem(withTitle: "Свернуть", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        let reset = NSMenuItem(title: "Формат телефона", action: #selector(resetWindow), keyEquivalent: "0")
        reset.target = self
        windows.addItem(reset)
        windows.addItem(withTitle: "Закрыть", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windows
        menu.addItem(windowItem)
        NSApp.mainMenu = menu
        NSApp.windowsMenu = windows
    }
    @objc private func resetWindow() { window.setContentSize(phoneFrame().size); window.center() }
}

@main
enum MireaMapMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = MapApp()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
