#!/usr/bin/env python3
import argparse,re,unicodedata
from difflib import SequenceMatcher
from pathlib import Path
from faster_whisper import WhisperModel

def norm(s):
    s=unicodedata.normalize("NFKD",s)
    s="".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^\w\u0590-\u05ff]+","",s.lower(),flags=re.UNICODE)

def fmt(t):
    t=max(0.0,float(t)); m=int(t//60); s=t-m*60
    return f"{m:02d}:{s:05.2f}"

def parse(text):
    lines=[x.strip() for x in text.splitlines() if x.strip()]
    words=[]; owners=[]
    for i,line in enumerate(lines):
        for w in line.split():
            words.append(w); owners.append(i)
    return lines,words,owners

def transcribe(audio,model_name,language):
    model=WhisperModel(model_name,device="cpu",compute_type="int8")
    segs,info=model.transcribe(
        audio,
        language=None if language=="auto" else language,
        word_timestamps=True,
        vad_filter=True,
        beam_size=5
    )
    segments=[]; words=[]
    for seg in segs:
        seg_words=[]
        for w in (seg.words or []):
            if w.start is None: continue
            item={"text":w.word.strip(),"start":float(w.start),"end":float(w.end or w.start)}
            words.append(item); seg_words.append(item)
        text=(seg.text or "").strip()
        if text or seg_words:
            segments.append({
                "text":text or " ".join(x["text"] for x in seg_words),
                "start":float(seg.start),
                "end":float(seg.end),
                "words":seg_words
            })
    return segments,words,getattr(info,"language",language)

def align(lyrics,heard):
    a=[norm(x) for x in lyrics]; b=[norm(x["text"]) for x in heard]
    sm=SequenceMatcher(a=a,b=b,autojunk=False); mp={}
    for block in sm.get_matching_blocks():
        for k in range(block.size): mp[block.a+k]=block.b+k
    matched=sorted(mp)
    for i in range(len(a)):
        if i in mp: continue
        left=max((x for x in matched if x<i),default=None)
        right=min((x for x in matched if x>i),default=None)
        if left is not None and right is not None:
            frac=(i-left)/max(1,right-left)
            guess=round(mp[left]+frac*(mp[right]-mp[left]))
        elif left is not None:
            guess=mp[left]+(i-left)
        elif right is not None:
            guess=mp[right]-(right-i)
        else:
            guess=i
        if b: mp[i]=max(0,min(len(b)-1,guess))
    prev=0
    for i in range(len(a)):
        if i in mp:
            mp[i]=max(prev,mp[i]); prev=mp[i]
    return mp

def write_aligned(lines,lw,owners,heard,mp,out,enhanced):
    groups={i:[] for i in range(len(lines))}
    for wi,li in enumerate(owners):
        t=heard[mp[wi]]["start"] if heard and wi in mp else 0.0
        groups[li].append((lw[wi],t))
    rows=["[by:UserSync Web]"]; last=0.0
    for li,line in enumerate(lines):
        arr=groups[li]
        start=arr[0][1] if arr else last
        start=max(last,start); last=start
        if enhanced and arr:
            rows.append(f"[{fmt(start)}] "+" ".join(f"<{fmt(t)}>{w}" for w,t in arr))
        else:
            rows.append(f"[{fmt(start)}]{line}")
    Path(out).write_text("\n".join(rows)+"\n",encoding="utf-8")

def write_transcript(segments,out,enhanced):
    rows=["[by:UserSync Web]"]
    for seg in segments:
        text=seg["text"].strip()
        if not text: continue
        start=seg["words"][0]["start"] if seg["words"] else seg["start"]
        if enhanced and seg["words"]:
            body=" ".join(f"<{fmt(w['start'])}>{w['text']}" for w in seg["words"] if w["text"])
            rows.append(f"[{fmt(start)}] {body}")
        else:
            rows.append(f"[{fmt(start)}]{text}")
    Path(out).write_text("\n".join(rows)+"\n",encoding="utf-8")

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--audio",required=True)
    ap.add_argument("--lyrics")
    ap.add_argument("--output",required=True)
    ap.add_argument("--language",default="he")
    ap.add_argument("--model",default="medium")
    ap.add_argument("--enhanced",action="store_true")
    a=ap.parse_args()

    print("Transcribing audio...",flush=True)
    segments,heard,lang=transcribe(a.audio,a.model,a.language)
    if not heard and not segments:
        raise SystemExit("No speech detected")
    print(f"Detected {len(heard)} words in {len(segments)} segments; language={lang}",flush=True)

    lyrics_text=""
    if a.lyrics and Path(a.lyrics).exists():
        lyrics_text=Path(a.lyrics).read_text(encoding="utf-8").strip()

    if lyrics_text:
        lines,lw,owners=parse(lyrics_text)
        print("Using supplied text for forced sequence alignment...",flush=True)
        write_aligned(lines,lw,owners,heard,align(lw,heard),a.output,a.enhanced)
    else:
        print("No supplied text; generating LRC directly from transcription...",flush=True)
        write_transcript(segments,a.output,a.enhanced)

    print(f"Wrote {a.output}",flush=True)

if __name__=="__main__":
    main()
