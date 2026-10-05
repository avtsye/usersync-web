(() => {
  const OWNER="avtsye", REPO="usersync-web", BRANCH="main", WORKFLOW="process-lrc.yml";
  const $=id=>document.getElementById(id);
  const token=$("token"), audio=$("audio"), lyrics=$("lyrics"), start=$("start"), log=$("log");
  const TOKEN_KEY="usersync_web_github_pat_v1";
  let file=null, activeRelease=null, activeJobRef=null;

  const savedToken=localStorage.getItem(TOKEN_KEY);
  if(savedToken){token.value=savedToken; $("rememberToken").checked=true; setTimeout(()=>setStatus("טוקן שמור נטען מהמכשיר ✓"),0);}

  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  function api(path, opts={}) {
    const t=token.value.trim();
    const headers={Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28",...(opts.headers||{})};
    if(t) headers.Authorization="Bearer "+t;
    return fetch("https://api.github.com"+path,{...opts,headers});
  }
  async function apiJson(path,opts={}){
    const r=await api(path,opts);
    if(!r.ok){
      let msg=r.status+" "+r.statusText;
      try{const j=await r.json(); if(j.message) msg=j.message}catch{}
      throw new Error(msg);
    }
    if(r.status===204) return null;
    return r.json();
  }
  function setStatus(msg,ok=true){$("authStatus").textContent=msg;$("authStatus").className="status "+(ok?"ok":"err")}
  function setProgress(p,msg){$("progressWrap").classList.remove("hidden");$("bar").style.width=p+"%";$("progressText").textContent=msg}
  function addLog(s){log.classList.remove("hidden");log.textContent+=(log.textContent?"\n":"")+s;log.scrollTop=log.scrollHeight}
  function fail(e){addLog("ERROR: "+e.message);$("progressText").textContent="נכשל: "+e.message;start.disabled=false}
  function jobId(){return "lrc-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,9)}

  async function checkToken(){
    try{
      if(!token.value.trim()) throw new Error("יש להזין טוקן");
      const r=await apiJson("/repos/"+OWNER+"/"+REPO);
      if(!r.permissions || !r.permissions.push) throw new Error("לטוקן אין הרשאת כתיבה למאגר");
      setStatus("החיבור תקין ✓");
      return true;
    }catch(e){setStatus(e.message,false); throw e}
  }

  function choose(f){
    if(!f) return;
    if(f.size>30*1024*1024){alert("בגרסה הנוכחית גודל הקובץ המקסימלי הוא 30MB");return}
    file=f;$("fileName").textContent=f.name+" · "+(f.size/1024/1024).toFixed(1)+"MB";
  }
  audio.addEventListener("change",()=>choose(audio.files[0]));
  const dz=$("dropzone");
  ["dragenter","dragover"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add("drag")}));
  ["dragleave","drop"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove("drag")}));
  dz.addEventListener("drop",e=>choose(e.dataTransfer.files[0]));

  $("checkToken").addEventListener("click",async()=>{
    try{
      await checkToken();
      if($("rememberToken").checked && token.value.trim()){
        localStorage.setItem(TOKEN_KEY,token.value.trim());
        setStatus("החיבור תקין והטוקן נשמר במכשיר ✓");
      }else{
        localStorage.removeItem(TOKEN_KEY);
      }
    }catch{}
  });
  $("rememberToken").addEventListener("change",()=>{
    if($("rememberToken").checked && token.value.trim()) localStorage.setItem(TOKEN_KEY,token.value.trim());
    else if(!$("rememberToken").checked) localStorage.removeItem(TOKEN_KEY);
  });
  $("forgetToken").addEventListener("click",()=>{
    localStorage.removeItem(TOKEN_KEY); token.value=""; $("rememberToken").checked=false; setStatus("הטוקן נמחק מהמכשיר ✓");
  });

  function bytesToBase64(bytes){
    let binary="", chunk=0x8000;
    for(let i=0;i<bytes.length;i+=chunk){
      binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+chunk,bytes.length)));
    }
    return btoa(binary);
  }

  async function createBlobFromFile(f){
    const buf=new Uint8Array(await f.arrayBuffer());
    return apiJson("/repos/"+OWNER+"/"+REPO+"/git/blobs",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({content:bytesToBase64(buf),encoding:"base64"})
    });
  }

  async function createTextBlob(text){
    return apiJson("/repos/"+OWNER+"/"+REPO+"/git/blobs",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({content:text,encoding:"utf-8"})
    });
  }

  async function createTempBranch(id){
    const ref=await apiJson("/repos/"+OWNER+"/"+REPO+"/git/ref/heads/"+BRANCH);
    const commit=await apiJson("/repos/"+OWNER+"/"+REPO+"/git/commits/"+ref.object.sha);
    setProgress(18,"מעלה את השיר ל-GitHub…");
    const audioBlob=await createBlobFromFile(file);
    let lyricsBlob=null;
    if(lyrics.value.trim()){
      setProgress(30,"מעלה את הטקסט שסיפקת…");
      lyricsBlob=await createTextBlob(lyrics.value);
    }
    const treeEntries=[
      {path:"job/audio",mode:"100644",type:"blob",sha:audioBlob.sha}
    ];
    if(lyricsBlob) treeEntries.push({path:"job/lyrics.txt",mode:"100644",type:"blob",sha:lyricsBlob.sha});
    const tree=await apiJson("/repos/"+OWNER+"/"+REPO+"/git/trees",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({base_tree:commit.tree.sha,tree:treeEntries})
    });
    const jobCommit=await apiJson("/repos/"+OWNER+"/"+REPO+"/git/commits",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({message:"Temporary UserSync job "+id,tree:tree.sha,parents:[ref.object.sha]})
    });
    const branch="jobs/"+id;
    await apiJson("/repos/"+OWNER+"/"+REPO+"/git/refs",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ref:"refs/heads/"+branch,sha:jobCommit.sha})
    });
    activeJobRef=branch;
    return {branch,hasLyrics:!!lyricsBlob};
  }

  async function createRelease(id){
    addLog("Creating temporary draft release "+id);
    return apiJson("/repos/"+OWNER+"/"+REPO+"/releases",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({tag_name:id,target_commitish:BRANCH,name:id,body:"Temporary UserSync Web processing job",draft:true,prerelease:false})
    });
  }

  async function dispatch(release,job){
    const body={ref:BRANCH,inputs:{
      release_id:String(release.id),
      job_ref:job.branch,
      has_lyrics:job.hasLyrics?"true":"false",
      model:$("model").value,
      language:$("language").value,
      enhanced:$("enhanced").checked?"true":"false"
    }};
    const r=await api("/repos/"+OWNER+"/"+REPO+"/actions/workflows/"+WORKFLOW+"/dispatches",{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)
    });
    if(!r.ok){let x={};try{x=await r.json()}catch{};throw new Error(x.message||("Workflow dispatch failed: "+r.status))}
  }

  async function getRelease(id){return apiJson("/repos/"+OWNER+"/"+REPO+"/releases/"+id)}
  async function downloadAsset(asset,filename){
    const r=await api("/repos/"+OWNER+"/"+REPO+"/releases/assets/"+asset.id,{headers:{Accept:"application/octet-stream"}});
    if(!r.ok) throw new Error("לא ניתן להוריד את הפלט");
    const blob=await r.blob(), url=URL.createObjectURL(blob), a=document.createElement("a");
    a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  async function cleanupRelease(){
    if(!activeRelease) return;
    try{await api("/repos/"+OWNER+"/"+REPO+"/releases/"+activeRelease.id,{method:"DELETE"})}catch{}
    activeRelease=null;
  }
  async function waitForResult(id){
    for(let i=0;i<180;i++){
      await sleep(10000);
      const r=await getRelease(id), assets=r.assets||[];
      const result=assets.find(x=>x.name==="result.lrc"), err=assets.find(x=>x.name==="error.txt");
      if(result) return {result,release:r};
      if(err){
        let text="העיבוד נכשל. פתח את GitHub Actions לפרטים.";
        try{const rr=await api("/repos/"+OWNER+"/"+REPO+"/releases/assets/"+err.id,{headers:{Accept:"application/octet-stream"}});text=await rr.text()}catch{}
        throw new Error(text);
      }
      const p=Math.min(94,50+i/180*44);
      setProgress(p,"GitHub Actions מעבד את השיר…");
      if(i%3===0) addLog("Waiting for processing result...");
    }
    throw new Error("פג זמן ההמתנה לתוצאה");
  }

  start.addEventListener("click",async()=>{
    try{
      $("result").classList.add("hidden");log.textContent="";
      if(!token.value.trim()) throw new Error("יש להזין GitHub token");
      if(!file) throw new Error("יש לבחור קובץ שמע");
      start.disabled=true;setProgress(5,"בודק חיבור…");
      await checkToken();
      const id=jobId();
      setProgress(10,"יוצר יעד תוצאה זמני…");activeRelease=await createRelease(id);
      const job=await createTempBranch(id);
      setProgress(46,"מפעיל GitHub Actions…");await dispatch(activeRelease,job);addLog("Workflow dispatched.");
      const got=await waitForResult(activeRelease.id);
      setProgress(100,"ה־LRC מוכן ✓");
      const box=$("result");box.classList.remove("hidden");box.innerHTML="<b>הקובץ מוכן.</b><br><button id='downloadResult' class='primary'>הורד LRC</button> <button id='deleteJob' class='ghost'>מחק תוצאה זמנית</button>";
      $("downloadResult").onclick=async()=>{await downloadAsset(got.result,(file.name.replace(/\.[^.]+$/,"")||"result")+".lrc")};
      $("deleteJob").onclick=async()=>{await cleanupRelease();box.innerHTML="<b>התוצאה הזמנית נמחקה.</b>"};
    }catch(e){fail(e)}
    finally{start.disabled=false}
  });

  $("reset").addEventListener("click",()=>{
    file=null;audio.value="";lyrics.value="";$("fileName").textContent="";
    $("result").classList.add("hidden");$("progressWrap").classList.add("hidden");
    log.classList.add("hidden");log.textContent="";
  });
})();