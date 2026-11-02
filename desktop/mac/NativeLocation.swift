import Foundation
import CoreLocation

final class NativeLocation: NSObject, CLLocationManagerDelegate {
    private lazy var manager: CLLocationManager = {
        let value = CLLocationManager()
        value.delegate = self
        value.desiredAccuracy = kCLLocationAccuracyBest
        value.distanceFilter = kCLDistanceFilterNone
        return value
    }()
    private var watchers = Set<String>()
    var deliver: ((String, [String: Any]) -> Void)?

    func watch(_ id: String) {
        guard id.hasPrefix("geo-"), id.count < 80 else { return }
        watchers.insert(id)
        updateAuthorization()
    }
    func clear(_ id: String) {
        watchers.remove(id)
        if watchers.isEmpty { manager.stopUpdatingLocation() }
    }
    func stop() {
        watchers.removeAll()
        manager.stopUpdatingLocation()
    }
    private func updateAuthorization() {
        guard !watchers.isEmpty else { return }
        guard CLLocationManager.locationServicesEnabled() else {
            fail(1, "Геопозиция выключена в настройках macOS."); return
        }
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse: manager.startUpdatingLocation()
        case .denied, .restricted: fail(1, "Разрешите геопозицию в настройках macOS или укажите точку вручную.")
        @unknown default: fail(2, "Геопозиция macOS недоступна.")
        }
    }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { updateAuthorization() }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last, location.horizontalAccuracy > 0 else { return }
        let value: [String: Any] = [
            "coords": ["latitude": location.coordinate.latitude, "longitude": location.coordinate.longitude, "accuracy": location.horizontalAccuracy],
            "timestamp": location.timestamp.timeIntervalSince1970 * 1000
        ]
        for id in watchers { deliver?(id, value) }
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if (error as? CLError)?.code == .locationUnknown { return }
        fail((error as? CLError)?.code == .denied ? 1 : 2, "macOS не смогла определить положение. Укажите точку на карте.")
    }
    private func fail(_ code: Int, _ message: String) {
        for id in watchers { deliver?(id, ["error": ["code": code, "message": message]]) }
        stop()
    }
}
