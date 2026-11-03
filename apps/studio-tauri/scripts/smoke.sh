#!/bin/zsh
# End-to-end run of the real editor in a hidden WKWebView (test build). Needs:
#   VITE_TEST_PAGES=1 pnpm build:web && cargo build --features webkit-tests  (in src-tauri)
# Usage: smoke.sh <scratch-dir> [debug|release] [timeout-secs]
# Throwaway data dir, a test-only Keychain service, a mock for every provider. Never opens a visible
# window. Deletes all generated media at the end.
set -o pipefail
HERE=${0:A:h}
ROOT=$HERE/../../..
SCRATCH=$1
PROFILE=${2:-debug}
LIMIT=${3:-900}
RUN=$SCRATCH/smoke
FF=$ROOT/apps/desktop/node_modules/ffmpeg-static/ffmpeg
FFP=$ROOT/apps/desktop/node_modules/ffprobe-static/bin/darwin/x64/ffprobe
SERVICE=studio.frontstage.test.smoke-$$
rm -rf $RUN; mkdir -p $RUN/media $RUN/out $RUN/electron

# Top half red, bottom half blue, so a flipped or blank frame can't pass; a 440 Hz tone.
SRC=(-f lavfi -i "color=c=0xC81E1E:s=320x180:r=30:d=1.5,drawbox=x=0:y=90:w=320:h=90:color=0x1E1EC8:t=fill" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=1.5")
gen() { name=$1; shift; $FF -y -v error $SRC "$@" -shortest $RUN/media/$name </dev/null; }
gen plain.mp4 -c:v libx264 -pix_fmt yuv420p -c:a aac
gen h264-10bit.mp4 -c:v libx264 -profile:v high10 -pix_fmt yuv420p10le -c:a aac
gen h264-444.mp4 -c:v libx264 -profile:v high444 -pix_fmt yuv444p -c:a aac
gen hevc.mp4 -c:v libx265 -tag:v hvc1 -x265-params log-level=error -pix_fmt yuv420p -c:a aac
gen av1.mp4 -c:v libaom-av1 -cpu-used 8 -pix_fmt yuv420p -c:a aac
gen vp9-10bit.mp4 -c:v libvpx-vp9 -profile:v 2 -pix_fmt yuv420p10le -c:a aac
# Left/top crop: coded with a pad, cropped back in the SPS.
$FF -y -v error $SRC -vf "pad=336:192:8:6:0xFF00FF" -c:v libx264 -pix_fmt yuv420p -bsf:v h264_metadata=crop_left=8:crop_top=6:crop_right=8:crop_bottom=6 -c:a aac -shortest $RUN/media/h264-crop.mp4 </dev/null
print 'LUT_3D_SIZE 2' > $RUN/media/smoke.cube
cat > $RUN/media/smoke-plan.json <<JSON
{ "dir": "$RUN", "clips": [
  {"name":"plain","file":"plain.mp4","expectProxy":false,"w":320,"h":180},
  {"name":"h264_10bit","file":"h264-10bit.mp4","expectProxy":true,"w":320,"h":180},
  {"name":"h264_444","file":"h264-444.mp4","expectProxy":true,"w":320,"h":180},
  {"name":"h264_crop","file":"h264-crop.mp4","expectProxy":true,"w":320,"h":180},
  {"name":"hevc","file":"hevc.mp4","expectProxy":true,"w":320,"h":180},
  {"name":"av1","file":"av1.mp4","expectProxy":true,"w":320,"h":180},
  {"name":"vp9_10bit","file":"vp9-10bit.mp4","expectProxy":true,"w":320,"h":180}
] }
JSON
ls $RUN/media
# Legacy Electron key files, with garbage content, in the throwaway Electron folder only.
head -c 16 /dev/urandom > $RUN/electron/fal-key.bin
mkdir -p $RUN/data $RUN/cache $RUN/docs $RUN/home
ln -s $RUN/electron $RUN/electron-link 2>/dev/null

node $HERE/smoke-mock.cjs > $RUN/mock.port 2> $RUN/mock.log &
MOCK=$!
for i in {1..50}; do [ -s $RUN/mock.port ] && break; sleep 0.1; done
PORT=$(<$RUN/mock.port)
BASE=http://127.0.0.1:$PORT
echo "mock on $BASE"

export FRONTSTAGE_TEST_DIR=$RUN FRONTSTAGE_TEST_KEYCHAIN_SERVICE=$SERVICE FRONTSTAGE_TEST_MCP_PORT=19799 \
  SPIKE_DIR=$RUN/media SPIKE_OUT=$RUN/result.json \
  OPENROUTER_BASE_URL=$BASE FRONTSTAGE_TEST_ANTHROPIC_BASE=$BASE FRONTSTAGE_TEST_FAL_BASE=$BASE FRONTSTAGE_TEST_MORPHIC_URL=$BASE/mcp
$ROOT/apps/studio-tauri/src-tauri/target/$PROFILE/frontstage > $RUN/app.log 2>&1 &
APP=$!
for i in {1..$LIMIT}; do kill -0 $APP 2>/dev/null || break; sleep 1; done
if kill -0 $APP 2>/dev/null; then echo "TIMED OUT after ${LIMIT}s"; kill $APP; fi
wait $APP; echo "app exit $?"
kill $MOCK 2>/dev/null
unset FRONTSTAGE_TEST_DIR

echo '--- result'; [ -f $RUN/result.json ] && cat $RUN/result.json
echo '--- last app log'; tail -5 $RUN/app.log | cut -c1-300
echo '--- mp4 checks'
check() {
  f=$RUN/out/$1
  if [ ! -f $f ]; then echo "$1: MISSING"; return; fi
  $FFP -v error -show_entries stream=codec_name,codec_type,width,height,nb_frames,pix_fmt,sample_rate,channels -of compact=p=0:nk=1 $f
  # The first frame's mean colour in the top and bottom bands.
  for band in "crop=320:60:0:10" "crop=320:60:0:110"; do
    $FF -v error -i $f -frames:v 1 -vf "$band,scale=1:1" -f rawvideo -pix_fmt rgb24 pipe:1 </dev/null | xxd -p | tr '\n' ' '
  done
  echo " <- $1 top bottom (want c81e1e, 1e1ec8)"
}
for c in plain h264-10bit h264-444 h264-crop hevc av1 vp9-10bit; do check $c.mp4; done
echo '--- original project files unchanged in the project'
ls $RUN/project/media 2>/dev/null | head
echo '--- flow pack'; ls $RUN/out/Pack 2>/dev/null
echo '--- skills exported to the throwaway home'; ls $RUN/home/.claude/skills 2>/dev/null
echo '--- proxies cached'; ls $RUN/cache/proxies 2>/dev/null | wc -l
security find-generic-password -s $SERVICE >/dev/null 2>&1 && echo "KEYCHAIN LEFTOVERS under $SERVICE" || echo "no Keychain entries left under $SERVICE"
# Everything generated here is throwaway.
cp $RUN/result.json $SCRATCH/smoke-result.json 2>/dev/null
rm -rf $RUN
