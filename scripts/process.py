#!/usr/bin/env python3
import argparse, math, re, subprocess, sys, tempfile, unicodedata
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

def make_wav(src, dst):
    subprocess.run([
        "ffmpeg","-y","-hide_banner","-loglevel","error",
        "-i",str(src),"-ac","2","-ar","44100",str(dst)
    ],check=True)

def separate_vocals(audio, work):
    src=Path(work)/"input.wav"
    make_wav(audio,src)
    out=Path(work)/"separated"
    cmd=[
        sys.executable,"-m","demucs.separate",
        "--two-stems","vocals","-n","htdemucs",
        "--device","cpu","--out",str(out),str(src)
    ]
    print("Separating vocals with Demucs...",flush=True)
    subprocess.run(cmd,check=True)
    vocals=out/"htdemucs"/"input"/"vocals.wav"
    if not vocals.exists():
        raise FileNotFoundError(f"Demucs vocals output not found: {vocals}")
    return vocals

def transcribe_with_model(model,audio,language,label):
    print(f"Transcribing {label}...",flush=True)
    segs,info=model.transcribe(
        str(audio),
        language=None if language=="auto" else language,
        word_timestamps=True,
        vad_filter=False,
        beam_size=5,
        best_of=5,
        condition_on_previous_text=False,
        initial_prompt="זהו שיר בעברית. תמלל בדייקנות את כל המילים הנשמעות, כולל חזרות ושירה ממושכת."
    )
    segments=[]; words=[]; conf=[]; no_speech=[]
    for seg in segs:
        seg_words=[]
        no_speech.append(float(getattr(seg,"no_speech_prob",0.0) or 0.0))
        for w in (seg.words or []):
            if w.start is None: continue
            item={
                "text":w.word.strip(),
                "start":float(w.start),
                "end":float(w.end or w.start),
                "prob":float(getattr(w,"probability",0.0) or 0.0)
            }
            if item["text"]:
                words.append(item); seg_words.append(item); conf.append(item["prob"])
        text=(seg.text or "").strip()
        if text or seg_words:
            segments.append({
                "text":text or " ".join(x["text"] for x in seg_words),
                "start":float(seg.start),"end":float(seg.end),"words":seg_words
            })
    avg_conf=sum(conf)/len(conf) if conf else 0.0
    avg_no_speech=sum(no_speech)/len(no_speech) if no_speech else 0.0
    # Relative quality score only: confidence + reward for useful word coverage - silence penalty.
    score=avg_conf + min(0.22, math.log1p(len(words))*0.035) - min(0.18,avg_no_speech*0.18)
    lang=getattr(info,"language",language)
    print(
        f"{label}: {len(words)} words, {len(segments)} segments, "
        f"confidence={avg_conf:.3f}, no_speech={avg_no_speech:.3f}, score={score:.3f}, language={lang}",
        flush=True
    )
    return {"segments":segments,"words":words,"lang":lang,"score":score,"confidence":avg_conf}

def choose_transcript(original,vocals):
    if not vocals["words"]:
        return original,"original"
    if not original["words"]:
        return vocals,"vocals"
    # Avoid choosing a very short separation hallucination, but allow a much richer vocals result.
    enough_words=len(vocals["words"]) >= max(6,int(len(original["words"])*0.55))
    much_more=len(vocals["words"]) >= max(12,int(len(original["words"])*1.35))
    if (enough_words and vocals["score"] >= original["score"]-0.025) or much_more:
        return vocals,"vocals"
    return original,"original"

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
    ap.add_argument("--model",default="large-v3-turbo")
    ap.add_argument("--enhanced",action="store_true")
    a=ap.parse_args()

    print(f"Loading Whisper model {a.model}...",flush=True)
    model=WhisperModel(a.model,device="cpu",compute_type="int8")

    original=transcribe_with_model(model,a.audio,a.language,"original mix")
    vocals_result=None
    try:
        with tempfile.TemporaryDirectory(prefix="usersync-") as work:
            vocals=separate_vocals(a.audio,work)
            vocals_result=transcribe_with_model(model,vocals,a.language,"isolated vocals")
    except Exception as e:
        print(f"WARNING: vocal separation failed; using original mix: {e}",flush=True)

    chosen,source=choose_transcript(original,vocals_result or {"words":[]})
    print(f"Selected transcription source: {source}",flush=True)
    segments,heard,lang=chosen["segments"],chosen["words"],chosen["lang"]
    if not heard and not segments:
        raise SystemExit("No speech detected")

    lyrics_text=""
    if a.lyrics and Path(a.lyrics).exists():
        lyrics_text=Path(a.lyrics).read_text(encoding="utf-8").strip()

    if lyrics_text:
        lines,lw,owners=parse(lyrics_text)
        print("Using supplied text for sequence alignment...",flush=True)
        write_aligned(lines,lw,owners,heard,align(lw,heard),a.output,a.enhanced)
    else:
        print("No supplied text; generating LRC from the selected transcription...",flush=True)
        write_transcript(segments,a.output,a.enhanced)

    print(f"Wrote {a.output}; source={source}; words={len(heard)}; language={lang}",flush=True)

if __name__=="__main__":
    main()
