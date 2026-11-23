// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "FloatingLyrics",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "FloatingLyrics",
            path: "Sources/FloatingLyrics"
        )
    ]
)
