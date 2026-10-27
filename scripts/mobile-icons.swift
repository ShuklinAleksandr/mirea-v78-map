// Rebuild native assets from the same geometric cube mark used by src/ui/icons.js.
// Run on macOS: swift scripts/mobile-icons.swift
import AppKit

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
func render(_ size: Int, splash: Bool = false, transparent: Bool = false) -> Data {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: transparent ? 4 : 3, hasAlpha: transparent, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSGraphicsContext.current?.imageInterpolation = .high
    let rect = NSRect(x: 0, y: 0, width: size, height: size)
    if !transparent {
        (splash ? NSColor(red: 0.957, green: 0.961, blue: 0.969, alpha: 1)
                : NSColor(red: 0.15, green: 0.36, blue: 0.91, alpha: 1)).setFill()
        NSBezierPath(rect: rect).fill()
    }
    let scale = CGFloat(size) * (splash ? 0.075 : 0.52) / 24
    let origin = CGFloat(size) / 2 - 12 * scale
    func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
        NSPoint(x: origin + x * scale, y: CGFloat(size) - origin - y * scale)
    }
    let p = NSBezierPath()
    p.move(to: point(12, 2)); p.line(to: point(21, 7)); p.line(to: point(21, 17))
    p.line(to: point(12, 22)); p.line(to: point(3, 17)); p.line(to: point(3, 7)); p.close()
    p.move(to: point(3, 7)); p.line(to: point(12, 12)); p.line(to: point(21, 7))
    p.move(to: point(12, 12)); p.line(to: point(12, 22))
    p.lineWidth = 1.45 * scale
    p.lineJoinStyle = .round
    p.lineCapStyle = .round
    (splash ? NSColor(red: 0.15, green: 0.36, blue: 0.91, alpha: 1) : .white).setStroke()
    p.stroke()
    NSGraphicsContext.restoreGraphicsState()
    return bitmap.representation(using: .png, properties: [:])!
}
func write(_ path: String, _ size: Int, splash: Bool = false, transparent: Bool = false) throws {
    try render(size, splash: splash, transparent: transparent).write(to: root.appendingPathComponent(path))
}
try write("ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png", 1024)
for name in ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"] {
    try write("ios/App/App/Assets.xcassets/Splash.imageset/\(name)", 2732, splash: true)
}
for (density, size, foregroundSize) in [("mdpi",48,108), ("hdpi",72,162), ("xhdpi",96,216), ("xxhdpi",144,324), ("xxxhdpi",192,432)] {
    let folder = "android/app/src/main/res/mipmap-\(density)"
    try write("\(folder)/ic_launcher.png", size)
    try write("\(folder)/ic_launcher_round.png", size)
    try write("\(folder)/ic_launcher_foreground.png", foregroundSize, transparent: true)
}
let resources = root.appendingPathComponent("android/app/src/main/res")
for folder in try FileManager.default.contentsOfDirectory(atPath: resources.path) where folder.hasPrefix("drawable") {
    let candidate = "android/app/src/main/res/\(folder)/splash.png"
    if FileManager.default.fileExists(atPath: root.appendingPathComponent(candidate).path) {
        try write(candidate, 512, splash: true)
    }
}
print("Native cube icons and launch screens regenerated.")
