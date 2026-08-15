#!/usr/bin/env bash
set -euo pipefail

readonly DEFAULT_CHECKPOINT_ROOT="/home/work/tmp/tessera-cli-ad-1105/checkpoint"
readonly DEFAULT_OUTPUT="docs/assets/readme/tessera-cli-orchestration.gif"
readonly CHECKPOINT_ROOT="${1:-$DEFAULT_CHECKPOINT_ROOT}"
readonly OUTPUT="${2:-$DEFAULT_OUTPUT}"
readonly KEYFRAME_DIR="$CHECKPOINT_ROOT/keyframes"

for command_name in convert gifsicle identify sha256sum; do
  command -v "$command_name" >/dev/null || {
    echo "Missing required command: $command_name" >&2
    exit 1
  }
done

declare -A expected_sha256=(
  ["keyframes/01-prompt-ready.png"]="a794763568631217bad5c544f25677077fb4c1d4cee90ffc87130efe59263e25"
  ["keyframes/02-cli-success.png"]="5afa1085e21d252c5e37e0627f7245625647e7e49673be854d043984cac3faa0"
  ["keyframes/03-board-three.png"]="7df899bc751d60b8673f70f3c76c573936c348a0418403f652d3040573837b07"
  ["keyframes/04-child-result.png"]="704ab37887e989bf7a13c56fb5a9b95896f59e329d92e7a1d6ea6cf0d8aac180"
  ["keyframes/05-board-final.png"]="c2923650bb9226646ef74f48675c059a6fb96fadf0e4b32de9df8eae75f4043e"
  ["cli/session-1.json"]="04f4d4dda024242e63c4bf436cb0e1efb4fe1c04b4ff76adcbe3952182d902a0"
  ["cli/session-2.json"]="7ebad8ec692eeb12b17862220b0f709ee5fe4bb90bd6282f4c9f061413f79e88"
  ["cli/session-3.json"]="209c2b53900c37ae51a430d03200b7909969aef0d5a3057a75a0e4cc01d50665"
  ["cli/worktrees.json"]="0a1155e7ca83978a3059dc58f4eb3d1604f311c62f6d2aaf7b660d6d971e1660"
)

for relative_path in "${!expected_sha256[@]}"; do
  absolute_path="$CHECKPOINT_ROOT/$relative_path"
  actual_sha256="$(sha256sum "$absolute_path" | awk '{print $1}')"
  if [[ "$actual_sha256" != "${expected_sha256[$relative_path]}" ]]; then
    echo "Source hash mismatch: $absolute_path" >&2
    exit 1
  fi
done

readonly TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

keyframes=(
  "01-prompt-ready.png"
  "02-cli-success.png"
  "03-board-three.png"
  "04-child-result.png"
  "05-board-final.png"
)

for index in "${!keyframes[@]}"; do
  source_path="$KEYFRAME_DIR/${keyframes[$index]}"
  source_geometry="$(identify -format '%wx%h' "$source_path")"
  if [[ "$source_geometry" != "2100x1350" ]]; then
    echo "Unexpected source geometry: $source_path ($source_geometry)" >&2
    exit 1
  fi

  convert "$source_path" \
    -filter Lanczos \
    -resize 1280x \
    -strip \
    "$TMP_DIR/scene-$index.png"

  output_geometry="$(identify -format '%wx%h' "$TMP_DIR/scene-$index.png")"
  if [[ "$output_geometry" != "1280x823" ]]; then
    echo "Unexpected scaled geometry: $output_geometry" >&2
    exit 1
  fi
done

# Four 200 ms crossfades, split into five equal frames. The scene holds total
# 11 seconds, so the complete loop is 11.8 seconds.
for transition in 0 1 2 3; do
  next_scene=$((transition + 1))
  for blend in 17 33 50 67 83; do
    convert "$TMP_DIR/scene-$transition.png" "$TMP_DIR/scene-$next_scene.png" \
      -define compose:args="$blend" \
      -compose blend \
      -composite \
      -strip \
      "$TMP_DIR/transition-$transition-$blend.png"
  done
done

gif_args=(
  -delay 220 "$TMP_DIR/scene-0.png"
)
for transition in 0 1 2 3; do
  for blend in 17 33 50 67 83; do
    gif_args+=( -delay 4 "$TMP_DIR/transition-$transition-$blend.png" )
  done
  gif_args+=( -delay 220 "$TMP_DIR/scene-$((transition + 1)).png" )
done

mkdir -p "$(dirname "$OUTPUT")"
convert "${gif_args[@]}" \
  -loop 0 \
  -dither FloydSteinberg \
  -colors 128 \
  -layers Optimize \
  "$TMP_DIR/unoptimized.gif"

gifsicle -O3 --colors 128 "$TMP_DIR/unoptimized.gif" -o "$OUTPUT"

geometry="$(identify -format '%wx%h\n' "$OUTPUT" | sort -u)"
frame_count="$(identify "$OUTPUT" | wc -l | tr -d ' ')"
if [[ "$geometry" != "1280x823" || "$frame_count" != "25" ]]; then
  echo "Unexpected GIF metadata: geometry=$geometry frames=$frame_count" >&2
  exit 1
fi

sha256sum "$OUTPUT"
