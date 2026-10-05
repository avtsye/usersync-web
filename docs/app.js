(() => {
  const OWNER="avtsye", REPO="usersync-web", BRANCH="main", WORKFLOW="process-lrc.yml";
  const $=id=>document.getElementById(id);
  const token=$("token"), audio=$("audio"), lyrics=$("lyrics"), start=$("start"), log=$("log");
  let file=null, activeRelease=null;
  const TOKEN_KEY="usersync_web_github_pat_v1";
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
    }catch(e){setStatus(e.message,false)}
  }

  function choose(f){
    if(!f) return;
    if(f.size>45*1024*1024){alert("הקובץ גדול מ-45MB");return}
    file=f;$("fileName").textContent=f.name+" · "+(f.size/1024/1024).toFixed(1)+"MB";
  }
  audio.addEventListener("change",()=>choose(audio.files[0]));
  const dz=$("dropzone");
  ["dragenter","dragover"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add("drag")}));
  ["dragleave","drop"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove("drag")}));
  dz.addEventListener("drop",e=>choose(e.dataTransfer.files[0]));
  $("checkToken").addEventListener("click",async()=>{
    await checkToken();
    if($("rememberToken").checked && token.value.trim()){
      localStorage.setItem(TOKEN_KEY,token.value.trim());
      setStatus("החיבור תקין והטוקן נשמר במכשיר ✓");
    }else{
      localStorage.removeItem(TOKEN_KEY);
    }
  });
  $("rememberToken").addEventListener("change",()=>{
    if($("rememberToken").checked && token.value.trim()) localStorage.setItem(TOKEN_KEY,token.value.trim());
    else if(!$("rememberToken").checked) localStorage.removeItem(TOKEN_KEY);
  });
  $("forgetToken").addEventListener("click",()=>{
    localStorage.removeItem(TOKEN_KEY);
    token.value="";
    $("rememberToken").checked=false;
    setStatus("הטוקן נמחק מהמכשיר ✓");
  });

  async function createRelease(id){
    addLog("Creating temporary draft release "+id);
    return apiJson("/repos/"+OWNER+"/"+REPO+"/releases",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({tag_name:id,target_commitish:BRANCH,name:id,body:"Temporary UserSync Web processing job",draft:true,prerelease:false})
    });
  }
  async function uploadAsset(release,blob,name,contentType){
    const base=release.upload_url.replace(/\{.*$/,"");
    const r=await fetch(base+"?name="+encodeURIComponent(name),{
      method:"POST",
      headers:{Authorization:"Bearer "+token.value.trim(),"Content-Type":contentType||"application/octet-stream","X-GitHub-Api-Version":"2022-11-28"},
      body:blob
    });
    if(!r.ok){let x={};try{x=await r.json()}catch{};throw new Error(x.message||("Asset upload failed: "+r.status))}
    return r.json();
  }
  async function dispatch(release,a,l){
    const body={ref:BRANCH,inputs:{
      release_id:String(release.id),audio_asset_id:String(a.id),lyrics_asset_id:l?String(l.id):"",
      model:$("model").value,language:$("language").value,enhanced:$("enhanced").checked?"true":"false"
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
  async function cleanup(){
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
      const p=Math.min(92,48+i/180*44);
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
      setProgress(12,"יוצר עבודה זמנית…");activeRelease=await createRelease(id);
      setProgress(22,"מעלה את השיר…");const aa=await uploadAsset(activeRelease,file,"audio"+((file.name.match(/\.[^.]+$/)||[""])[0]),file.type||"application/octet-stream");
      let la=null;
      if(lyrics.value.trim()){
        setProgress(36,"מעלה את הטקסט שסיפקת…");
        la=await uploadAsset(activeRelease,new Blob([lyrics.value],{type:"text/plain;charset=utf-8"}),"lyrics.txt","text/plain;charset=utf-8");
      } else {
        setProgress(36,"לא סופק טקסט — המערכת תזהה אותו מהשמע…");
      }
      setProgress(47,"מפעיל GitHub Actions…");await dispatch(activeRelease,aa,la);addLog("Workflow dispatched.");
      const got=await waitForResult(activeRelease.id);
      setProgress(100,"ה־LRC מוכן ✓");
      const box=$("result");box.classList.remove("hidden");box.innerHTML="<b>הקובץ מוכן.</b><br><button id='downloadResult' class='primary'>הורד LRC</button> <button id='deleteJob' class='ghost'>מחק עבודה זמנית</button>";
      $("downloadResult").onclick=async()=>{await downloadAsset(got.result,(file.name.replace(/\.[^.]+$/,"")||"result")+".lrc")};
      $("deleteJob").onclick=async()=>{await cleanup();box.innerHTML="<b>העבודה הזמנית נמחקה.</b>"};
    }catch(e){fail(e)}
    finally{start.disabled=false}
  });

  $("reset").addEventListener("click",()=>{file=null;audio.value="";lyrics.value="";$("fileName").textContent="";$("result").classList.add("hidden");$("progressWrap").classList.add("hidden");log.classList.add("hidden");log.textContent=""});
  window.addEventListener("beforeunload",()=>{});
})();