#!/bin/sh
# 编译并安装采集 helper 到 ~/.dsh/meeting-memo/bin/asr-helper。
#
# 为什么必须重签名：macOS 按路径缓存代码签名，替换后的二进制如果签名不同，
# 直接运行会被 SIGKILL（exit 137）。这里统一用临时签名（-）重签一遍。
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
home="${DSH_HOME:-$HOME/.dsh}/meeting-memo"
bin="$home/bin/asr-helper"
tmp="$(mktemp -t asr-helper).bin"

mkdir -p "$home/bin"

echo "[build-native] compiling"
RUNTIME="$home/runtimes/sherpa-onnx-v2.0.1-osx-arm64-shared-no-tts"

# 声纹要用 sherpa-onnx 的 C API；rpath 写死运行时目录，插件拉起时不需要 DYLD_LIBRARY_PATH。
swiftc -O -import-objc-header "$repo/native/bridge.h" -o "$tmp" \
  "$repo/native/asr-helper.swift" \
  -I "$RUNTIME/include" -L "$RUNTIME/lib" -lsherpa-onnx-c-api \
  -Xlinker -rpath -Xlinker "$RUNTIME/lib" \
  -framework AVFoundation \
  -framework CoreAudio \
  -framework CoreML \
  -framework ScreenCaptureKit \
  -framework CoreMedia

echo "[build-native] signing"
codesign --force --sign - "$tmp" >/dev/null 2>&1

if [ -f "$bin" ]; then
  cp "$bin" "$bin.bak-$(date +%s)"
fi
cp "$tmp" "$bin"
chmod +x "$bin"
codesign --force --sign - "$bin" >/dev/null 2>&1
rm -f "$tmp"

echo "[build-native] building embed tool"
RUNTIME="$home/runtimes/sherpa-onnx-v2.0.1-osx-arm64-shared-no-tts"
if [ -d "$RUNTIME" ]; then
  swiftc -O -import-objc-header "$repo/native/bridge.h" "$repo/native/embed.swift" \
    -I "$RUNTIME/include" -L "$RUNTIME/lib" -lsherpa-onnx-c-api \
    -Xlinker -rpath -Xlinker "$RUNTIME/lib" -o "$home/bin/embed"
  codesign --force --sign - "$home/bin/embed" >/dev/null 2>&1
  echo "[build-native] installed $home/bin/embed"
fi
echo "[build-native] installed $bin"
"$bin" inputs 2>/dev/null | head -1
