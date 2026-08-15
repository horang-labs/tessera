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

# The PTY opener is a deliberate punch-in: it keeps the real header toggle and
# populated terminal conversation large while excluding the CLI status line.
# The cut to Chat View widens to include the real composer. No pixels are added.
ffmpeg -hide_banner -loglevel error -y -i "$pty_input" \
  -filter_complex \
  '[0:v]split[pre][post];[pre]trim=end=2.4,setpts=PTS-STARTPTS,crop=1120:700:60:0,scale=1280:800:flags=lanczos,setsar=1[preout];[post]trim=start=2.4,setpts=PTS-STARTPTS,crop=1346:841:54:0,scale=1280:800:flags=lanczos,setsar=1[postout];[preout][postout]concat=n=2:v=1:a=0,fps=12,split[v0][v1];[v0]palettegen=max_colors=128:stats_mode=diff[p];[v1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle' \
  -loop 0 "$output_dir/pty-chatview.gif"

ffmpeg -hide_banner -loglevel error -y -i "$git_input" \
  -filter_complex \
  '[0:v]crop=1346:841:54:0,scale=1280:800:flags=lanczos,setsar=1,fps=12,split[v0][v1];[v0]palettegen=max_colors=128:stats_mode=diff[p];[v1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle' \
  -loop 0 "$output_dir/file-git-workflow.gif"

for asset in pty-chatview file-git-workflow; do
  ffprobe -v error \
    -show_entries format=filename,duration,size \
    -show_entries stream=width,height,r_frame_rate,nb_frames \
    -of json "$output_dir/$asset.gif"
done
