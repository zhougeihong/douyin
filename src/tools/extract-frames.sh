#!/bin/bash
# 用法: ./tools/extract-frames.sh <视频路径> <输出组名> [fps]
set -e
VIDEO=$1
NAME=$2
FPS=${3:-8}
OUT="src/images/frames/$NAME"
mkdir -p "$OUT"
ffmpeg -y -i "$VIDEO" -vf "fps=$FPS,scale=254:800" -start_number 1 "$OUT/frame%03d.png"
echo "完成: $OUT （帧间隔=$(echo "scale=0; 1000/$FPS" | bc)ms，记得同步修改 index.vue 里的 interval）"
