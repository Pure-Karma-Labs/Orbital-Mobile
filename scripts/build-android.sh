#!/usr/bin/env bash
# Build Rust crate for Android targets and generate bindings.
# Produces .so libraries + TypeScript/C++ bindings via uniffi-bindgen-react-native.
#
# Usage: ./build-android.sh [--release]
#   --release  Build with cargo release profile (optimized, stripped, thin LTO)
#   (default)  Build with cargo dev profile (debug symbols, fast compilation)
#
# Prerequisites: Rust toolchain, Android NDK, cargo-ndk
# Targets: aarch64-linux-android (arm64-v8a), x86_64-linux-android (x86_64)

set -euo pipefail

PROFILE_SUFFIX=""
if [ "${1:-}" = "--release" ]; then
    PROFILE_SUFFIX=":release"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIBRARY_DIR="$PROJECT_ROOT/packages/orbital-signal"

# Check prerequisites
if ! command -v cargo &>/dev/null; then
    echo "Error: Rust not installed. Run: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi

if ! command -v cargo-ndk &>/dev/null; then
    echo "Installing cargo-ndk..."
    cargo install cargo-ndk
fi

if ! rustup target list --installed | grep -q aarch64-linux-android; then
    echo "Installing Android Rust targets..."
    rustup target add aarch64-linux-android x86_64-linux-android
fi

if [ -z "${ANDROID_NDK_HOME:-}" ] && [ -z "${ANDROID_HOME:-}" ]; then
    # Try common locations
    for sdk_path in "$HOME/Library/Android/sdk" "/opt/homebrew/share/android-commandlinetools"; do
        if [ -d "$sdk_path" ]; then
            export ANDROID_HOME="$sdk_path"
            # Find NDK
            NDK_DIR=$(find "$sdk_path/ndk" -maxdepth 1 -type d | sort -V | tail -1)
            if [ -n "$NDK_DIR" ] && [ "$NDK_DIR" != "$sdk_path/ndk" ]; then
                export ANDROID_NDK_HOME="$NDK_DIR"
            fi
            break
        fi
    done
fi

if [ -z "${ANDROID_NDK_HOME:-}" ]; then
    echo "Error: ANDROID_NDK_HOME not set and NDK not found. Install Android NDK."
    exit 1
fi

echo "==> Building Rust for Android${PROFILE_SUFFIX:+ (release profile)}..."
echo "    NDK: $ANDROID_NDK_HOME"
cd "$LIBRARY_DIR"
npm run "build:android${PROFILE_SUFFIX}"

echo "==> Android build complete."
echo "    Targets: arm64-v8a, x86_64"
