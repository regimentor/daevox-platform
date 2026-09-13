#!/usr/bin/env bash
set -euo pipefail
core_root="$(cd "$(dirname "$0")/.." && pwd)"
build_dir="${1:?Usage: export-options.sh /absolute/path/to/pinned/build}"
exporter="$(mktemp /tmp/daevox-options.XXXXXX)"
trap 'rm -f "$exporter"' EXIT
c++ -std=c++17 "$core_root/tools/export-options.cpp" \
  -I"$core_root/vendor/llama.cpp/common" -I"$core_root/vendor/llama.cpp/include" \
  -I"$core_root/vendor/llama.cpp/ggml/include" -I"$core_root/vendor/llama.cpp/vendor/nlohmann" \
  -L"$build_dir/bin" -Wl,-rpath,"$build_dir/bin" \
  -lllama-common -lllama -lggml -lggml-base -o "$exporter"
"$exporter" > "$core_root/resources/llama-options.json"
