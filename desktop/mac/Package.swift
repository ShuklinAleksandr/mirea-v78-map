// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MireaMacCore",
    platforms: [.macOS(.v14)],
    products: [.library(name: "MapCore", targets: ["MapCore"])],
    targets: [
        .target(name: "MapCore"),
        .testTarget(name: "MapCoreTests", dependencies: ["MapCore"])
    ]
)
