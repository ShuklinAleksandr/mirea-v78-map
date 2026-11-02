import XCTest
@testable import MapCore

final class MapCoreTests: XCTestCase {
    private func temporary() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory
    }
    func testAssetPathsCannotEscapePackagedMap() throws {
        let root = try temporary()
        for target in ["/../secret", "/%2e%2e/secret", "/%2E%2E%2Fsecret", "//etc/passwd", "/x\\secret", "/%00secret", "https://remote.test/"] {
            XCTAssertNil(AssetServer.assetURL(target: target, root: root), target)
        }
        XCTAssertEqual(AssetServer.assetURL(target: "/", root: root)?.lastPathComponent, "index.html")
    }
    func testSymlinksCannotReadOutsideTheBundle() throws {
        let root = try temporary(), outside = try temporary()
        let secret = outside.appendingPathComponent("private.json")
        try Data("private".utf8).write(to: secret)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("link"), withDestinationURL: outside)
        XCTAssertNil(AssetServer.assetURL(target: "/link/private.json", root: root))
    }
    func testUnicodeAssetNamesAndScriptMimeTypes() throws {
        let root = try temporary()
        XCTAssertEqual(AssetServer.assetURL(target: "/data/%D0%93-%D0%9B%D0%9A2.jpg?version=1", root: root)?.lastPathComponent, "Г-ЛК2.jpg")
        XCTAssertEqual(AssetServer.contentType(URL(fileURLWithPath: "/x/worker.js")), "text/javascript; charset=utf-8")
        XCTAssertEqual(AssetServer.contentType(URL(fileURLWithPath: "/x/plan.svg")), "image/svg+xml")
    }
    func testOnlyKnownMapLinkFieldsAreRestored() {
        XCTAssertNil(MapPolicy.viewHash("https://evil.test/#room=x"))
        XCTAssertNil(MapPolicy.viewHash("mireamap://evil#room=x"))
        XCTAssertNil(MapPolicy.viewHash("mireamap://user@map/#room=x"))
        XCTAssertNil(MapPolicy.viewHash("mireamap://map/elsewhere#room=x"))
        let hash = MapPolicy.viewHash("mireamap://map#campus=v-78&room=abc&script=bad&url=https://evil.test")!
        XCTAssertTrue(hash.contains("campus=v-78"))
        XCTAssertTrue(hash.contains("room=abc"))
        XCTAssertFalse(hash.contains("script"))
        XCTAssertFalse(hash.contains("evil"))
    }
    func testSavedFragmentsAreValidatedLikeIncomingLinks() {
        XCTAssertNotNil(MapPolicy.viewHash("#building=%D0%93&floor=v-78-floor1&projection=2d"))
        XCTAssertNil(MapPolicy.viewHash("#room=" + String(repeating: "a", count: 201)))
        XCTAssertNil(MapPolicy.viewHash("#script=unknown"))
    }
    func testExportAcceptsOnlyBoundedV78JSON() {
        XCTAssertTrue(MapPolicy.validGPSExport("{\"campusId\":\"v-78\",\"records\":[]}"))
        for json in ["", "not-json", "[]", "{\"campusId\":\"other\"}", String(repeating: "x", count: 4 * 1024 * 1024 + 1)] {
            XCTAssertFalse(MapPolicy.validGPSExport(json))
        }
    }
    func testLoopbackServesActualPackagedBytesAndBlocksWrites() async throws {
        let root = try temporary()
        let expected = Data("<!doctype html><title>Map test</title>".utf8)
        try expected.write(to: root.appendingPathComponent("index.html"))
        let server = AssetServer(root: root)
        let port = try await withCheckedThrowingContinuation { continuation in
            server.start { continuation.resume(with: $0) }
        }
        defer { server.stop() }
        let url = URL(string: "http://127.0.0.1:\(port)/")!
        let (data, response) = try await URLSession.shared.data(from: url)
        XCTAssertEqual(data, expected)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertTrue((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Security-Policy")?.contains("script-src 'self'") == true)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        let (_, blocked) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((blocked as? HTTPURLResponse)?.statusCode, 405)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("index.html")), expected)
    }
}
