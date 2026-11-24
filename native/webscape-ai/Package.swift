// swift-tools-version: 6.0
import PackageDescription

// webscape-ai: the browser's built-in AI helper. It ships inside the app and talks
// to the browser over stdin/stdout (JSON lines). There is no server and no port.
// AI runs through the LocalLM Lab SDK (public binary release, Apache-2.0).
let package = Package(
    name: "webscape-ai",
    platforms: [.macOS("26.0")],
    targets: [
        .binaryTarget(
            name: "LocalLMLabSDKCore",
            url: "https://github.com/ancientcomputing/locallm/releases/download/v3.0.0-GA/LocalLMLabSDKCore-3.0.0-GA.xcframework.zip",
            // From LocalLMLabSDKCore-3.0.0-GA.xcframework.zip.sha256 on that release.
            checksum: "2b286cfecae1f6596c64255d72550a30f6f3cfe8323e4aa2a5176a4275699451"
        ),
        .executableTarget(
            name: "webscape-ai",
            dependencies: ["LocalLMLabSDKCore"],
            // The SDK framework is shipped next to the executable.
            linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path"])]
        ),
    ]
)
