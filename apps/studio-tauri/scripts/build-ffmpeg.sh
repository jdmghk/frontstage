#!/bin/bash
# Builds the trimmed ffmpeg the Tauri app ships, on macOS, from pinned sources. No binary is committed.
# Usage: build-ffmpeg.sh <x86_64-apple-darwin|aarch64-apple-darwin> [work-dir]
# Output: src-tauri/binaries/ffmpeg-<triple>, and binaries/ffmpeg-sources.tar.xz with SOURCE_ARCHIVE=1 (the
# corresponding source a release must publish). The work dir is deleted at the end unless KEEP_WORK=1, and a
# kept one can be reused: libraries already built there are skipped.
# Needs: clang (Command Line Tools), nasm, meson, ninja, autoconf, automake, libtool (brew's glibtool), pkg-config, git.
#
# Licence: --enable-gpl with libx264 makes this binary GPL. Whoever distributes it must also offer
# the exact sources pinned below. See src-tauri/licenses/THIRD-PARTY-NOTICES.txt.
set -euo pipefail

TRIPLE=${1:?usage: build-ffmpeg.sh <target-triple> [work-dir]}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT_DIR=$HERE/../src-tauri/binaries
WORK=${2:-$(mktemp -d -t frontstage-ffmpeg)}
JOBS=${JOBS:-2}
MACOS_MIN=${MACOS_MIN:-13.0}

# Git pins are full commit hashes, checked after the fetch. Tarball pins are SHA-256.
FFMPEG_VERSION=7.1.5
FFMPEG_URL=https://github.com/FFmpeg/FFmpeg.git
FFMPEG_COMMIT=3a0867c2bfda4a4d4309ca1a8cbdc6175e67f587
X264_URL=https://code.videolan.org/videolan/x264.git
X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
DAV1D_VERSION=1.5.4
DAV1D_URL=https://downloads.videolan.org/pub/videolan/dav1d/$DAV1D_VERSION/dav1d-$DAV1D_VERSION.tar.xz
DAV1D_SHA256=686616b7c69eb88d44459391ab25cac13b6647a3b288835c5784e71c1514a5c5
ZIMG_VERSION=3.0.6
ZIMG_URL=https://github.com/sekrit-twc/zimg/archive/refs/tags/release-$ZIMG_VERSION.tar.gz
ZIMG_SHA256=be89390f13a5c9b2388ce0f44a5e89364a20c1c57ce46d382b1fcc3967057577

# What the app runs (export.rs, proxy.rs, media.rs, frames.rs) and what users can feed it. Native
# decoders cost little, so this covers more than the import allowlist: the file picker accepts
# video/* and frames.rs takes mkv, webm, avi and mpg.
ENCODERS=libx264,aac,prores_ks,movtext,pcm_s16le,mjpeg
DECODERS=h264,hevc,libdav1d,vp8,vp9,prores,dnxhd,cfhd,dvvideo,mjpeg,mjpegb,mpeg1video,mpeg2video,mpeg4,msmpeg4v1,msmpeg4v2,msmpeg4v3,flv,h261,h263,h263p,vc1,wmv1,wmv2,wmv3,theora,qtrle,rpza,smc,cinepak,svq1,svq3,rawvideo,v210,v410,r210,r10k,png,tiff,bmp,gif,webp
DECODERS=$DECODERS,aac,aac_latm,mp1,mp2,mp3,ac3,eac3,dca,truehd,mlp,alac,flac,opus,vorbis,wmav1,wmav2,wmapro,amrnb,amrwb,gsm,gsm_ms,mace3,mace6,qdm2,qdmc,adpcm_ima_qt,adpcm_ima_wav,adpcm_ms,adpcm_g722,adpcm_g726
DECODERS=$DECODERS,pcm_alaw,pcm_mulaw,pcm_s8,pcm_u8,pcm_s16le,pcm_s16be,pcm_s16le_planar,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_s64le,pcm_s64be,pcm_f16le,pcm_f24le,pcm_f32le,pcm_f32be,pcm_f64le,pcm_f64be,pcm_bluray,pcm_dvd
DECODERS=$DECODERS,subrip,srt,webvtt,movtext,text
DEMUXERS=mov,matroska,avi,mpegps,mpegts,mpegvideo,m4v,h264,hevc,obu,ogg,asf,flv,mxf,mp3,aac,wav,w64,aiff,flac,caf,ac3,eac3,dts,truehd,amr,rawvideo,pcm_f32le,srt,webvtt,image_png_pipe,image_jpeg_pipe,image_tiff_pipe,image_bmp_pipe,image_webp_pipe,gif
MUXERS=mp4,mov,wav,image2pipe
PARSERS=aac,aac_latm,ac3,av1,dca,dirac,dnxhd,dvbsub,dvdsub,flac,gsm,h261,h263,h264,hevc,mjpeg,mlp,mpeg4video,mpegaudio,mpegvideo,opus,png,vc1,vorbis,vp8,vp9,webp
BSFS=aac_adtstoasc,av1_frame_merge,av1_frame_split,dca_core,eac3_core,extract_extradata,h264_mp4toannexb,hevc_mp4toannexb,mov2textsub,mpeg4_unpack_bframes,text2movsub,vp9_superframe,vp9_superframe_split
FILTERS=scale,setparams,format,crop,fps,zscale,tonemap,null,anull,aresample,aformat,hflip,vflip,transpose

case $TRIPLE in
  x86_64-apple-darwin) ARCH=x86_64; FFARCH=x86_64; CPU_FAMILY=x86_64 ;;
  aarch64-apple-darwin) ARCH=arm64; FFARCH=arm64; CPU_FAMILY=aarch64 ;;
  *) echo "unsupported target: $TRIPLE (this script is macOS only)" >&2; exit 2 ;;
esac
HOST_ARCH=$(uname -m)
[ "$HOST_ARCH" = "$ARCH" ] && CROSS=0 || CROSS=1

cleanup() { [ "${KEEP_WORK:-0}" = 1 ] || rm -rf "$WORK"; }
trap cleanup EXIT

PREFIX=$WORK/prefix
mkdir -p "$PREFIX" "$OUT_DIR" "$WORK/src"
export PKG_CONFIG_PATH=$PREFIX/lib/pkgconfig
export MACOSX_DEPLOYMENT_TARGET=$MACOS_MIN
ARCH_FLAGS="-arch $ARCH -mmacosx-version-min=$MACOS_MIN"
stamp() { echo "== $(date '+%H:%M:%S') $*"; }

fetch_git() { # dir url commit
  mkdir -p "$1"
  git -C "$1" init -q
  git -C "$1" fetch -q --depth 1 "$2" "$3"
  git -C "$1" -c advice.detachedHead=false checkout -q FETCH_HEAD
  [ "$(git -C "$1" rev-parse HEAD)" = "$3" ] || { echo "$1: commit mismatch" >&2; exit 1; }
}

fetch_tar() { # dir url sha256
  local tarball
  tarball=$WORK/src/$(basename "$2")
  curl -fsSL --retry 3 -o "$tarball" "$2"
  echo "$3  $tarball" | shasum -a 256 -c - >/dev/null || { echo "$2: checksum mismatch" >&2; exit 1; }
  mkdir -p "$1"
  tar xf "$tarball" -C "$1" --strip-components=1
}

[ -f "$PREFIX/lib/libx264.a" ] || (
  stamp "x264 $X264_COMMIT"
  fetch_git "$WORK/src/x264" "$X264_URL" "$X264_COMMIT"
  cd "$WORK/src/x264"
  HOST_FLAG=()
  [ "$CROSS" = 1 ] && HOST_FLAG=(--host="$CPU_FAMILY-apple-darwin")
  # The app only encodes 8-bit 4:2:0.
  CC=clang ./configure --prefix="$PREFIX" --enable-static --enable-pic --disable-cli --disable-opencl --disable-avs --disable-swscale --disable-lavf --disable-ffms --disable-gpac --disable-lsmash --bit-depth=8 --chroma-format=420 --extra-cflags="$ARCH_FLAGS" --extra-ldflags="$ARCH_FLAGS" ${HOST_FLAG[@]+"${HOST_FLAG[@]}"}
  nice -n 10 make -j"$JOBS"
  make install-lib-static
)

[ -f "$PREFIX/lib/libdav1d.a" ] || (
  stamp "dav1d $DAV1D_VERSION"
  fetch_tar "$WORK/src/dav1d" "$DAV1D_URL" "$DAV1D_SHA256"
  cd "$WORK/src/dav1d"
  CROSS_FILE=()
  if [ "$CROSS" = 1 ]; then
    cat > cross.ini <<INI
[binaries]
c = 'clang'
cpp = 'clang++'
ar = 'ar'
strip = 'strip'
[built-in options]
c_args = ['-arch', '$ARCH', '-mmacosx-version-min=$MACOS_MIN']
c_link_args = ['-arch', '$ARCH', '-mmacosx-version-min=$MACOS_MIN']
[host_machine]
system = 'darwin'
cpu_family = '$CPU_FAMILY'
cpu = '$CPU_FAMILY'
endian = 'little'
INI
    CROSS_FILE=(--cross-file cross.ini)
  fi
  CFLAGS="$ARCH_FLAGS" LDFLAGS="$ARCH_FLAGS" meson setup build --prefix="$PREFIX" --libdir=lib --buildtype=release --default-library=static -Denable_tools=false -Denable_tests=false -Dbitdepths=8,16 ${CROSS_FILE[@]+"${CROSS_FILE[@]}"}
  nice -n 10 ninja -C build -j"$JOBS"
  ninja -C build install
)

[ -f "$PREFIX/lib/libzimg.a" ] || (
  stamp "zimg $ZIMG_VERSION"
  fetch_tar "$WORK/src/zimg" "$ZIMG_URL" "$ZIMG_SHA256"
  cd "$WORK/src/zimg"
  ./autogen.sh
  HOST_FLAG=()
  [ "$CROSS" = 1 ] && HOST_FLAG=(--host="$CPU_FAMILY-apple-darwin")
  CFLAGS="$ARCH_FLAGS -O2" CXXFLAGS="$ARCH_FLAGS -O2" LDFLAGS="$ARCH_FLAGS" ./configure --prefix="$PREFIX" --enable-static --disable-shared ${HOST_FLAG[@]+"${HOST_FLAG[@]}"}
  nice -n 10 make -j"$JOBS"
  make install
)

stamp "ffmpeg $FFMPEG_VERSION"
[ -f "$WORK/src/ffmpeg/configure" ] || fetch_git "$WORK/src/ffmpeg" "$FFMPEG_URL" "$FFMPEG_COMMIT"
(
  cd "$WORK/src/ffmpeg"
  CROSS_ARGS=()
  [ "$CROSS" = 1 ] && CROSS_ARGS=(--enable-cross-compile --target-os=darwin --arch="$FFARCH" --cc="clang -arch $ARCH" --cxx="clang++ -arch $ARCH")
  ./configure --prefix="$PREFIX" --pkg-config-flags=--static --extra-version=frontstage \
    --extra-cflags="$ARCH_FLAGS -I$PREFIX/include" --extra-ldflags="$ARCH_FLAGS -L$PREFIX/lib -Wl,-dead_strip" --extra-libs=-lc++ \
    --enable-gpl --enable-libx264 --enable-libdav1d --enable-libzimg --enable-zlib \
    --disable-everything --disable-autodetect --disable-network --disable-doc --disable-debug \
    --disable-ffplay --disable-ffprobe --disable-avdevice --disable-postproc \
    --enable-encoder="$ENCODERS" --enable-decoder="$DECODERS" --enable-demuxer="$DEMUXERS" --enable-muxer="$MUXERS" \
    --enable-parser="$PARSERS" --enable-bsf="$BSFS" --enable-filter="$FILTERS" --enable-protocol=file,pipe \
    ${CROSS_ARGS[@]+"${CROSS_ARGS[@]}"}
  # configure silently ignores a name it doesn't know (the encoder is "movtext", not "mov_text").
  missing=0
  require() { # kind (as in CONFIG_X_KIND) comma-list
    for name in $(echo "$2" | tr ',' ' '); do
      grep -q "CONFIG_$(echo "$name" | tr 'a-z' 'A-Z')_$1 1" config_components.h || { echo "not enabled: $name ($1)" >&2; missing=1; }
    done
  }
  require ENCODER "$ENCODERS"; require DECODER "$DECODERS"; require DEMUXER "$DEMUXERS"; require MUXER "$MUXERS"
  require PARSER "$PARSERS"; require BSF "$BSFS"; require FILTER "$FILTERS"; require PROTOCOL file,pipe
  [ "$missing" = 0 ] || exit 1
  nice -n 10 make -j"$JOBS"
  strip ffmpeg
  # Apple Silicon refuses to run a binary whose signature strip invalidated. "-" is ad-hoc: no identity.
  codesign --force --sign - ffmpeg
)

DEST=$OUT_DIR/ffmpeg-$TRIPLE
cp "$WORK/src/ffmpeg/ffmpeg" "$DEST"
if [ "${SOURCE_ARCHIVE:-0}" = 1 ]; then
  cp "$0" "$WORK/src/build-ffmpeg.sh"
  # Only the sources: the object files of the build are not corresponding source.
  (cd "$WORK/src/ffmpeg" && make distclean >/dev/null)
  tar -C "$WORK/src" --exclude .git --exclude build --exclude '*.o' --exclude '*.a' -cJf "$OUT_DIR/ffmpeg-sources.tar.xz" build-ffmpeg.sh ffmpeg x264 dav1d zimg
fi
stamp "built $DEST: $(stat -f %z "$DEST") bytes, $(shasum -a 256 "$DEST" | cut -d' ' -f1)"
otool -L "$DEST"
otool -l "$DEST" | grep -A3 -E 'LC_BUILD_VERSION|LC_VERSION_MIN' || true
[ "$CROSS" = 1 ] || "$DEST" -hide_banner -version | head -2
