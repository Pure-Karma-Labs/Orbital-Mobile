#!/usr/bin/env bash
# Build Rust crate for iOS targets and generate bindings.
# Produces XCFramework + TypeScript/C++ bindings via uniffi-bindgen-react-native.
#
# Usage: ./build-ios.sh [--release]
#   --release  Build with cargo release profile (optimized, stripped, thin LTO)
#   (default)  Build with cargo dev profile (debug symbols, fast compilation)
#
# Prerequisites: Rust toolchain, Xcode (for xcframework), CocoaPods
# Targets: aarch64-apple-ios, aarch64-apple-ios-sim, x86_64-apple-ios

set -euo pipefail

PROFILE_SUFFIX=""
if [ "${1:-}" = "--release" ]; then
    PROFILE_SUFFIX=":release"
elif [ $# -gt 0 ]; then
    echo "Unknown argument: $1. Usage: $0 [--release]" >&2
    exit 1
fi

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

echo "==> Building Rust for iOS${PROFILE_SUFFIX:+ (release profile)}..."
cd "$LIBRARY_DIR"
npm run "build:ios${PROFILE_SUFFIX}"

echo "==> Installing CocoaPods..."
cd "$PROJECT_ROOT/ios"
pod install

echo "==> iOS build complete."
echo "    Targets: aarch64-apple-ios, aarch64-apple-ios-sim, x86_64-apple-ios"
