#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <directory-containing-webm-masters>" >&2
  exit 64
fi

staging_dir=$1
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
output_dir="$repo_root/docs/assets/readme"

pty_input="$staging_dir/pty-chatview.webm"
git_input="$staging_dir/file-git-workflow.webm"
[[ -f "$pty_input" ]] || { echo "Missing master: $pty_input" >&2; exit 66; }
[[ -f "$git_input" ]] || { echo "Missing master: $git_input" >&2; exit 66; }

# Preserve every pixel of the 1400x900 masters. The width-only scale computes
# the output height from the source aspect ratio; no crop, pad, or reframing is
# permitted for these final full-frame advertisements.
for asset in pty-chatview file-git-workflow; do
  ffmpeg -hide_banner -loglevel error -y -i "$staging_dir/$asset.webm" \
    -filter_complex \
    '[0:v]scale=1280:-1:flags=lanczos,setsar=1,fps=12,split[v0][v1];[v0]palettegen=max_colors=128:stats_mode=diff[p];[v1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle' \
    -loop 0 "$output_dir/$asset.gif"
done

for asset in pty-chatview file-git-workflow; do
  ffprobe -v error \
    -show_entries format=filename,duration,size \
    -show_entries stream=width,height,r_frame_rate,nb_frames \
    -of json "$output_dir/$asset.gif"
done
