import Foundation

public enum MapPolicy {
    public static func viewHash(_ value: String) -> String? {
        let text = value.hasPrefix("#") ? "mireamap://map" + value : value
        guard let url = URLComponents(string: text), url.scheme == "mireamap", url.host == "map",
              url.user == nil, url.password == nil, url.port == nil,
              url.path.isEmpty || url.path == "/",
              let query = url.percentEncodedFragment ?? url.percentEncodedQuery,
              let items = URLComponents(string: "?" + query)?.queryItems else { return nil }
        let keys: Set<String> = ["campus", "building", "floor", "view", "projection", "room", "from", "to"]
        let safe = items.filter { keys.contains($0.name) && ($0.value?.count ?? 0) <= 200 }
        guard !safe.isEmpty else { return nil }
        var result = URLComponents()
        result.queryItems = safe
        return result.percentEncodedQuery.map { "#" + $0 }
    }

    public static func validGPSExport(_ json: String) -> Bool {
        guard let data = json.data(using: .utf8), !data.isEmpty, data.count <= 4 * 1024 * 1024,
              let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
        return value["campusId"] as? String == "v-78"
    }
}
