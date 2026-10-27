import UIKit
import Capacitor
import CoreLocation

/** A physical compass observation; never the course of a GPS location. */
@objc(HeadingPlugin)
public class HeadingPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "HeadingPlugin"
    public let jsName = "Heading"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]
    private var manager: CLLocationManager?
    private var activeId: String?
    private var backgroundToken: NSObjectProtocol?

    public override func load() {
        backgroundToken = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.emitError("Компас остановлен в фоне.", code: "HEADING_ABORTED", fatal: true)
            self?.cleanup()
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { call.reject("Компас недоступен.", "HEADING_UNAVAILABLE"); return }
            guard UIApplication.shared.applicationState == .active else { call.reject("Компас доступен при открытом приложении.", "HEADING_ABORTED"); return }
            guard let id = call.getString("id"), !id.isEmpty else { call.reject("Не указан наблюдатель компаса.", "HEADING_INVALID_ID"); return }
            guard CLLocationManager.headingAvailable() else { call.reject("На устройстве нет компаса.", "HEADING_UNAVAILABLE"); return }
            self.cleanup()
            self.activeId = id
            let manager = CLLocationManager()
            self.manager = manager
            manager.delegate = self
            manager.headingFilter = kCLHeadingFilterNone
            self.updateOrientation()
            // Magnetic heading needs no separate motion permission. True north is
            // used only when Core Location actually supplies a valid trueHeading.
            manager.startUpdatingHeading()
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            if self?.activeId == call.getString("id") { self?.cleanup() }
            call.resolve()
        }
    }

    fileprivate func updateOrientation() {
        let orientation = bridge?.viewController?.view.window?.windowScene?.interfaceOrientation ?? .portrait
        switch orientation {
        case .portraitUpsideDown: manager?.headingOrientation = .portraitUpsideDown
        case .landscapeLeft: manager?.headingOrientation = .landscapeRight
        case .landscapeRight: manager?.headingOrientation = .landscapeLeft
        default: manager?.headingOrientation = .portrait
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateHeading heading: CLHeading) {
        guard let id = activeId, UIApplication.shared.applicationState == .active else { return }
        guard heading.headingAccuracy >= 0, heading.headingAccuracy <= 60 else {
            emitError("Компас пока неточен. Уберите телефон от металла и повторите позже.", code: "HEADING_UNRELIABLE", fatal: false)
            return
        }
        let trueNorth = heading.trueHeading >= 0
        let degrees = trueNorth ? heading.trueHeading : heading.magneticHeading
        guard degrees.isFinite, degrees >= 0, degrees <= 360 else { return }
        notifyListeners("heading", data: [
            "id": id,
            "degrees": degrees,
            "timestamp": heading.timestamp.timeIntervalSince1970 * 1000,
            "accuracyDegrees": heading.headingAccuracy,
            "reference": trueNorth ? "true" : "magnetic"
        ])
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        emitError("Не удалось получить направление телефона.", code: "HEADING_UNAVAILABLE", fatal: true)
        cleanup()
    }

    public func locationManagerShouldDisplayHeadingCalibration(_ manager: CLLocationManager) -> Bool { false }

    private func emitError(_ message: String, code: String, fatal: Bool) {
        guard let id = activeId else { return }
        notifyListeners("heading", data: ["id": id, "error": ["message": message, "code": code, "fatal": fatal]])
    }

    private func cleanup() {
        manager?.stopUpdatingHeading()
        manager?.delegate = nil
        manager = nil
        activeId = nil
    }

    deinit {
        if let backgroundToken { NotificationCenter.default.removeObserver(backgroundToken) }
        manager?.stopUpdatingHeading()
    }
}

class HeadingBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(HeadingPlugin())
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        coordinator.animate(alongsideTransition: nil) { [weak self] _ in
            (self?.bridge?.plugin(withName: "Heading") as? HeadingPlugin)?.updateOrientation()
        }
    }
}
