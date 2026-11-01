import Foundation
import Capacitor

/** Writes only generated GPS JSON files inside the application's temporary directory. */
@objc(GpsCalibrationExportPlugin)
public class GpsCalibrationExportPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GpsCalibrationExportPlugin"
    public let jsName = "GpsCalibrationExport"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "exportSurvey", returnType: CAPPluginReturnPromise)
    ]
    private let maxExportBytes = 4 * 1024 * 1024

    @objc func exportSurvey(_ call: CAPPluginCall) {
        guard let json = call.getString("json"), !json.isEmpty,
              json.utf8.count <= maxExportBytes,
              let data = json.data(using: .utf8) else {
            call.reject("Файл GPS-замеров пустой или слишком большой (не больше 4 МБ).", "EXPORT_INVALID")
            return
        }
        do {
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  object["campusId"] as? String == "v-78" else {
                call.reject("Это не файл GPS-замеров Вернадского, 78.", "EXPORT_INVALID")
                return
            }
        } catch {
            call.reject("Файл GPS-замеров содержит некорректный JSON.", "EXPORT_INVALID")
            return
        }
        // Validation deliberately does not rewrite the records or their timestamps.
        do {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("gps-calibration", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let filename = "MIREA-V78-GPS-\(UUID().uuidString).json"
            let file = directory.appendingPathComponent(filename, isDirectory: false)
            try data.write(to: file, options: .atomic)
            call.resolve(["uri": file.absoluteString, "filename": filename])
        } catch {
            call.reject("Не удалось создать файл GPS-замеров. Проверьте свободное место.", "EXPORT_FAILED")
        }
    }
}
