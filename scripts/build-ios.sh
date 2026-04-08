#!/usr/bin/env bash
# Build Rust crate for iOS targets and generate bindings.
# Produces XCFramework + TypeScript/C++ bindings via uniffi-bindgen-react-native.
#
# Prerequisites: Rust toolchain, Xcode (for xcframework), CocoaPods
# Targets: aarch64-apple-ios, aarch64-apple-ios-sim, x86_64-apple-ios

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIBRARY_DIR="$PROJECT_ROOT/packages/orbital-signal"

# Check prerequisites
if ! command -v cargo &>/dev/null; then
    echo "Error: Rust not installed. Run: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi

if ! rustup target list --installed | grep -q aarch64-apple-ios; then
    echo "Installing iOS Rust targets..."
    rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
fi

echo "==> Building Rust for iOS..."
cd "$LIBRARY_DIR"
npx ubrn build ios --config ubrn.config.yaml --and-generate

echo "==> Installing CocoaPods..."
cd "$PROJECT_ROOT/ios"
pod install

echo "==> iOS build complete."
echo "    Targets: aarch64-apple-ios, aarch64-apple-ios-sim, x86_64-apple-ios"
