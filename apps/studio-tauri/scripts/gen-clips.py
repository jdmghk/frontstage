# Test media for src/phase1.ts: real encoded clips with known markers, ffmpeg-decoded references
# (frame 15, rgb24), and the audio timing clips. Usage: gen-clips.py <ffmpeg> <out-dir>
# parity-ref.json comes from the parity spec with PARITY_REF_OUT set.
import json, subprocess, os, sys
FF=sys.argv[1]
OUT=sys.argv[2]
def even(v): return int(v)//2*2
def picture(W,H,ox=0,oy=0,cw=None,ch=None):
    cw=cw or W; ch=ch or H
    boxes=[(ox,oy,W,H,"0x282828")]
    mk=(even(W*.10),even(H*.15),even(W*.10),even(H*.15))
    boxes.append((ox+mk[0],oy+mk[1],mk[2],mk[3],"white"))
    patches={}
    for i,(name,col) in enumerate([("red","0xC81E1E"),("green","0x1EC81E"),("blue","0x1E1EC8"),("grey","0x808080")]):
        x,y,w,h=even(W*(.30+.15*i)),even(H*.15),even(W*.10),even(H*.15)
        boxes.append((ox+x,oy+y,w,h,col)); patches[name]=[x+w//2,y+h//2]
    ramp=[]
    for i in range(8):
        v=20+i*30
        x,y,w,h=even(W*(.05+.11*i)),even(H*.60),even(W*.10),even(H*.20)
        boxes.append((ox+x,oy+y,w,h,"0x%02X%02X%02X"%(v,v,v))); patches["ramp%d"%v]=[x+w//2,y+h//2]
    vf=",".join("drawbox=x=%d:y=%d:w=%d:h=%d:color=%s:t=fill"%b for b in boxes)
    # The color source rounds odd sizes down, so build bigger and scale to the odd size.
    src="color=c=0xFF00FF:s=%dx%d:r=30:d=1"%(cw+(cw&1),ch+(ch&1))
    if cw&1 or ch&1: vf="scale=%d:%d:flags=neighbor,"%(cw,ch)+vf
    return src,vf,list(mk),patches
def run(args):
    return subprocess.run([FF,"-y","-v","error"]+args,capture_output=True,text=True)
clips=[]
TAG709=["-colorspace","bt709","-color_primaries","bt709","-color_trc","bt709","-color_range","tv"]
TAG2020=["-colorspace","bt2020nc","-color_primaries","bt2020","-color_trc","bt709","-color_range","tv"]
TAGPQ=["-colorspace","bt2020nc","-color_primaries","bt2020","-color_trc","smpte2084","-color_range","tv"]
TAGHLG=["-colorspace","bt2020nc","-color_primaries","bt2020","-color_trc","arib-std-b67","-color_range","tv"]
UNTAGGED=[]
TAG601=["-colorspace","smpte170m","-color_primaries","smpte170m","-color_trc","smpte170m","-color_range","tv"]
X264=["-c:v","libx264","-preset","veryfast","-crf","10","-g","10","-bf","2"]
def add(name,W,H,enc,pix,tags,matrix,ox=0,oy=0,cw=None,ch=None,group="",tonemap=False):
    src,vf,mk,patches=picture(W,H,ox,oy,cw,ch)
    f=name+".mp4"; tmp=os.path.join(OUT,name+".tmp.mp4"); out=os.path.join(OUT,f)
    r=run(["-f","lavfi","-i",src,"-vf","format=yuv444p,"+vf+",format="+pix]+enc+["-pix_fmt",pix]+tags+["-movflags","+faststart",tmp])
    entry=dict(name=name,group=group,W=W,H=H,marker=mk,patches=patches,pix=pix,matrix=matrix)
    if r.returncode:
        entry["encodeError"]=r.stderr.strip()[-300:]; clips.append(entry); print(name,"ENCODE FAILED",entry["encodeError"][:200]); return
    # A plain remux, as any real tool's output would be: track dims from the parsed SPS.
    r2=run(["-i",tmp,"-c","copy","-movflags","+faststart",out]); os.remove(tmp)
    entry["file"]=f
    ref=name+".rgb"
    sc="scale=in_color_matrix=%s:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int+bicubic"%matrix
    r3=run(["-flags","unaligned","-i",out,"-vf","select=eq(n\\,15),"+sc+",format=rgb24","-vframes","1","-f","rawvideo",os.path.join(OUT,ref)])
    if r3.returncode: entry["refError"]=r3.stderr.strip()[-300:]
    entry["ref"]=ref
    if tonemap:
        tm=name+".tm.rgb"
        trc={"pq":"smpte2084","hlg":"arib-std-b67"}[tonemap]
        chain=f"select=eq(n\\,15),zscale=tin={trc}:min=2020_ncl:pin=2020:rin=limited:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=full,format=rgb24"
        r4=run(["-flags","unaligned","-i",out,"-vf",chain,"-vframes","1","-f","rawvideo",os.path.join(OUT,tm)])
        if r4.returncode: entry["tmError"]=r4.stderr.strip()[-200:]
        else: entry["tonemapRef"]=tm
    clips.append(entry); print(name,os.path.getsize(out),os.path.getsize(os.path.join(OUT,ref)))
add("control_h264_709",640,360,X264,"yuv420p",TAG709,"bt709",group="control")
add("sd_h264_601",640,480,X264,"yuv420p",TAG601,"bt601",group="control")
add("sd_h264_untagged",640,480,X264,"yuv420p",UNTAGGED,"bt601",group="control")
VP9=["-c:v","libvpx-vp9","-crf","20","-b:v","0","-cpu-used","8","-row-mt","1","-g","10"]
add("vp9_8bit_709",640,360,VP9,"yuv420p",TAG709,"bt709",group="control")
# (a) SPS crop with left/top offsets
add("crop_h264_small",640,360,X264+["-x264-params","crop-rect=8,6,8,10"],"yuv420p",TAG709,"bt709",ox=8,oy=6,cw=656,ch=376,group="crop")
add("crop_h264_large",640,360,X264+["-x264-params","crop-rect=64,48,0,0"],"yuv420p",TAG709,"bt709",ox=64,oy=48,cw=704,ch=408,group="crop")
# (c) odd sizes. 4:2:0 H.264 can't signal odd crop (crop units are 2), so x264 should refuse.
add("odd_h264_420_853x481",853,481,X264,"yuv420p",TAG709,"bt709",group="odd")
add("odd_h264_444_853x481",853,481,X264,"yuv444p",TAG709,"bt709",group="odd")
add("odd_vp9_420_853x481",853,481,VP9,"yuv420p",TAG709,"bt709",group="odd")
add("near_odd_h264_420_854x482",854,482,X264,"yuv420p",TAG709,"bt709",group="odd")
# (b) 10-bit and BT.2020/HDR tags
add("h264_10bit_709",640,360,X264,"yuv420p10le",TAG709,"bt709",group="hdr")
add("h264_8bit_2020_sdr",640,360,X264,"yuv420p",TAG2020,"bt2020",group="hdr")
add("h264_10bit_2020_pq",640,360,X264,"yuv420p10le",TAGPQ,"bt2020",group="hdr",tonemap="pq")
add("h264_10bit_2020_hlg",640,360,X264,"yuv420p10le",TAGHLG,"bt2020",group="hdr",tonemap="hlg")
X265=["-c:v","libx265","-preset","veryfast","-crf","12","-tag:v","hvc1","-x265-params","log-level=error:keyint=10"]
add("hevc_8bit_709",640,360,X265,"yuv420p",TAG709,"bt709",group="hdr")
add("hevc_10bit_2020_pq",640,360,X265,"yuv420p10le",TAGPQ,"bt2020",group="hdr",tonemap="pq")
add("vp9_10bit_2020_pq",640,360,["-c:v","libvpx-vp9","-profile:v","2","-crf","20","-b:v","0","-cpu-used","8","-row-mt","1","-g","10"],"yuv420p10le",TAGPQ,"bt2020",group="hdr",tonemap="pq")
add("av1_8bit_709",640,360,["-c:v","libaom-av1","-crf","25","-b:v","0","-cpu-used","8","-row-mt","1","-g","10"],"yuv420p",TAG709,"bt709",group="hdr")
json.dump(clips,open(os.path.join(OUT,"clips.json"),"w"))

def base():
    o=lambda n: os.path.join(OUT,n)
    run(["-f","lavfi","-i","testsrc2=s=1920x1080:r=30:d=10","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=10","-c:v","libx264","-preset","veryfast","-pix_fmt","yuv420p","-g","30","-c:a","aac","-ac","2","-b:a","128k","-shortest",o("clip1080.mp4")])
    run(["-f","lavfi","-i","testsrc2=s=960x540:r=30:d=10","-an","-c:v","libx264","-preset","veryfast","-pix_fmt","yuv420p","-g","30",o("clip540.mp4")])
    burst="if(lt(mod(t\\,1)\\,0.1)*gt(t\\,0.5)\\,0.5*sin(2*PI*1000*t)\\,0)"
    for rate,ch,name in [(44100,"1","timing44"),(48000,"2","timing48")]:
        run(["-f","lavfi","-i","aevalsrc=%s:s=%d:d=4"%(burst,rate),"-f","lavfi","-i","testsrc2=s=320x240:r=30:d=4","-c:a","aac","-ac",ch,"-b:a","128k","-c:v","libx264","-preset","veryfast","-pix_fmt","yuv420p",o(name+".mp4")])
        run(["-i",o(name+".mp4"),"-vn","-f","f32le","-ac","1",o(name+".pcm")])
    run(["-i",o("clip1080.mp4"),"-vn","-f","f32le","-ac","2","-ar","48000",o("clip1080.pcm")])
    run(["-i",o("clip1080.mp4"),"-vf","select=eq(n\\,30),scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int+bicubic,format=rgb24","-vframes","1","-f","rawvideo",o("frame30.rgb")])
base()
