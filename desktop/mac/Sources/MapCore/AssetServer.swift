import Foundation
import Network

/// Serves only the packaged, read-only map over loopback. No Node or external server.
public final class AssetServer {
    public let root: URL
    private let queue = DispatchQueue(label: "ru.mirea.spatialatlas.assets")
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    public private(set) var port: UInt16 = 0

    public init(root: URL) { self.root = root.standardizedFileURL.resolvingSymlinksInPath() }

    public static func assetURL(target: String, root: URL) -> URL? {
        guard target.hasPrefix("/"), !target.hasPrefix("//"),
              let decoded = target.components(separatedBy: "?")[0].removingPercentEncoding,
              !decoded.contains("\\"), !decoded.contains("\0"),
              !decoded.split(separator: "/").contains(where: { $0 == ".." || $0 == "." }) else { return nil }
        let relative = decoded == "/" ? "index.html" : String(decoded.dropFirst())
        let base = root.standardizedFileURL.resolvingSymlinksInPath()
        let file = base.appendingPathComponent(relative).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path.hasPrefix(base.path + "/") else { return nil }
        return file
    }

    public static func contentType(_ file: URL) -> String {
        switch file.pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "woff2": return "font/woff2"
        default: return "application/octet-stream"
        }
    }

    public func start(port: UInt16 = 0, completion: @escaping (Result<UInt16, Error>) -> Void) {
        do {
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
            let listener = try NWListener(using: parameters)
            self.listener = listener
            var completed = false
            listener.stateUpdateHandler = { [weak self] state in
                guard !completed else { return }
                switch state {
                case .ready:
                    completed = true
                    let actual = listener.port!.rawValue
                    self?.port = actual
                    completion(.success(actual))
                case .failed(let error):
                    completed = true
                    completion(.failure(error))
                default: break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
            listener.start(queue: queue)
        } catch { completion(.failure(error)) }
    }

    public func stop() {
        queue.async {
            self.listener?.cancel()
            for connection in self.connections.values { connection.cancel() }
            self.connections.removeAll()
        }
    }

    private func accept(_ connection: NWConnection) {
        guard connections.count < 32 else { connection.cancel(); return }
        let id = ObjectIdentifier(connection)
        connections[id] = connection
        connection.stateUpdateHandler = { [weak self] state in
            if case .cancelled = state { self?.connections.removeValue(forKey: id) }
            if case .failed = state { self?.connections.removeValue(forKey: id) }
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 15) { [weak connection] in connection?.cancel() }
        receive(connection, buffered: Data())
    }

    private func receive(_ connection: NWConnection, buffered: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, complete, error in
            guard let self else { connection.cancel(); return }
            var request = buffered
            if let data { request.append(data) }
            guard request.count <= 16_384, error == nil else { connection.cancel(); return }
            if request.range(of: Data("\r\n\r\n".utf8)) != nil { self.respond(connection, request: request) }
            else if complete { connection.cancel() }
            else { self.receive(connection, buffered: request) }
        }
    }

    private func respond(_ connection: NWConnection, request: Data) {
        let parts = String(decoding: request, as: UTF8.self).components(separatedBy: "\r\n")[0].split(separator: " ")
        guard parts.count == 3, parts[0] == "GET" || parts[0] == "HEAD" else {
            send(connection, status: "405 Method Not Allowed", body: Data()); return
        }
        guard let file = Self.assetURL(target: String(parts[1]), root: root),
              let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
              values.isRegularFile == true, (values.fileSize ?? Int.max) <= 16 * 1024 * 1024,
              let data = try? Data(contentsOf: file) else {
            send(connection, status: "404 Not Found", body: Data()); return
        }
        send(connection, status: "200 OK", body: data, type: Self.contentType(file), head: parts[0] == "HEAD")
    }

    private func send(_ connection: NWConnection, status: String, body: Data, type: String = "text/plain", head: Bool = false) {
        let csp = "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'"
        var result = Data("HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nConnection: close\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: \(csp)\r\n\r\n".utf8)
        if !head { result.append(body) }
        connection.send(content: result, completion: .contentProcessed { _ in connection.cancel() })
    }
}
