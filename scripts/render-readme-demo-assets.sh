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

# Preserve every pixel of the 1400x900 masters. Captions describe the current
# action without reframing the UI, and setpts makes the demonstrations 1.6x
# faster while keeping the first and final states readable.
readonly font_file="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
readonly caption_style="fontfile=${font_file}:fontcolor=white:fontsize=25:box=1:boxcolor=0x111827CC:boxborderw=12:x=(w-text_w)/2:y=h-76"

pty_captions="drawtext=${caption_style}:text='Work in the live PTY':enable='between(t,0,1.5)',drawtext=${caption_style}:text='Switch to Chat View':enable='between(t,1.5,2.8)',drawtext=${caption_style}:text='Continue the same conversation':enable='between(t,2.8,4.2)',drawtext=${caption_style}:text='Send a follow-up and watch it run':enable='between(t,4.2,8.4)'"
git_captions="drawtext=${caption_style}:text='Edit and save a project file':enable='between(t,0,2.0)',drawtext=${caption_style}:text='Open the Git panel':enable='between(t,2.0,3.1)',drawtext=${caption_style}:text='Review the diff':enable='between(t,3.1,4.2)',drawtext=${caption_style}:text='Select changes and write a commit message':enable='between(t,4.2,6.2)',drawtext=${caption_style}:text='Choose the next Git action':enable='between(t,6.2,7.8)'"

render_gif() {
  local asset=$1
  local captions=$2
  ffmpeg -hide_banner -loglevel error -y -i "$staging_dir/$asset.webm" \
    -filter_complex \
    "[0:v]setpts=PTS/1.6,scale=1280:-1:flags=lanczos,setsar=1,fps=12,${captions},split[v0][v1];[v0]palettegen=max_colors=128:stats_mode=diff[p];[v1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
    -loop 0 "$output_dir/$asset.gif"
}

render_gif pty-chatview "$pty_captions"
render_gif file-git-workflow "$git_captions"

for asset in pty-chatview file-git-workflow; do
  ffprobe -v error \
    -show_entries format=filename,duration,size \
    -show_entries stream=width,height,r_frame_rate,nb_frames \
    -of json "$output_dir/$asset.gif"
done
