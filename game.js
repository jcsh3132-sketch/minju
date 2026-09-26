(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const canvas=$('board'),ctx=canvas.getContext('2d');
  const W=1440,H=900;
  const storage={get(key,fallback){try{return localStorage.getItem(key)??fallback;}catch{return fallback;}},set(key,value){try{localStorage.setItem(key,value);}catch{}}};
  let best=Number(storage.get('worm-garden-best','0'))||0;
  $('best').textContent=best;
  $('nickname').value=storage.get('worm-garden-name','말랑이');
  const requestedRoom=new URLSearchParams(location.search).get('room')?.toUpperCase();
  $('roomInput').value=/^[A-Z0-9-]{3,12}$/.test(requestedRoom||'')?requestedRoom:'GARDEN';
  $('roomLabel').textContent=$('roomInput').value;
  let socket,id=null,joined=false,alive=false,pending=false,ready=false,retry=0;
  let snapshot={players:[],food:[]},rendered=new Map(),heading=null,boost=false,pointer=null;
  const keys=new Set();
  const pickups=[];let previousScore=0,cameraReady=false;
  const touchView=()=>matchMedia('(pointer:coarse),(max-width:999px)').matches;
  const motion=new MotionBuffer();
  let joystickPointer=null,joystickAngle=null,wakeLock=null,lastJoin=null;
  let recovery=null;try{recovery=JSON.parse(sessionStorage.getItem('worm-session')||'null');}catch{}
  function saveRecovery(value){recovery=value;try{value?sessionStorage.setItem('worm-session',JSON.stringify(value)):sessionStorage.removeItem('worm-session');}catch{}}
  function playingMode(active){
    document.body.classList.toggle('playing',active);$('joystick').classList.toggle('hidden',!active);
    if(!active){joystickPointer=null;joystickAngle=null;$('joystickKnob').style.transform='';wakeLock?.release().catch(()=>{});wakeLock=null;}
    else if(navigator.wakeLock)navigator.wakeLock.request('screen').then(lock=>{wakeLock=lock;}).catch(()=>{});
    requestAnimationFrame(resize);
  }
  let view={x:0,y:0,scale:1,width:900,height:562},lastFrame=0,toastTimer,shareBase=location.origin;
  const decorations=Array.from({length:210},(_,i)=>({x:(i*197+43)%W,y:(i*317+71)%H,r:1+(i%3)}));
  const previewFood=Array.from({length:95},(_,i)=>({id:i,x:40+(i*173)%(W-80),y:40+(i*239)%(H-80),color:i%3}));
  function send(data){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(data));}
  function button(text,disabled=false){$('startButton').textContent=text+' ↗';$('startButton').disabled=disabled;}
  function connection(text,state){$('connectionText').textContent=text;$('connectionDot').className='dot '+state;}
  function showLobby(title='정원에 놀러 오세요',description='플레이를 누르면 친구들이 있는 정원에 자동으로 합류해요.',badge='HELLO, LITTLE WORM'){
    playingMode(false);
    $('overlayTitle').textContent=title;$('overlayText').textContent=description;$('statusBadge').textContent=badge;
    $('overlay').classList.remove('hidden');$('boostButton').classList.add('hidden');$('spawnNotice').classList.add('hidden');
    button(joined?'다시 자라기':'바로 플레이',!ready);boost=false;pointer=null;keys.clear();heading=null;
  }
  function resetSession(){joined=false;alive=false;pending=false;snapshot={players:[],food:[]};rendered.clear();motion.reset();cameraReady=false;previousScore=0;pickups.length=0;$('leaveButton').disabled=true;$('score').textContent='0';$('energy').value=100;updateRanking();}
  function connect(){
    if(location.protocol==='file:'){
      connection('서버 실행이 필요해요','offline');
      showLobby('정원을 먼저 열어 주세요','C:\\min에서 npm start 실행 후 localhost:3000으로 접속해 주세요.','SERVER REQUIRED');
      button('서버 연결을 기다리는 중',true);return;
    }
    connection(retry?'다시 연결하는 중':'정원에 연결 중','');
    socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/play`);
    socket.addEventListener('message',event=>{
      let data;try{data=JSON.parse(event.data);}catch{return;}
      if(data.type==='hello'){
        id=data.id;ready=true;retry=0;connection('정원에 연결됨','online');button('바로 플레이');
        $('formError').textContent='';
        if(recovery){pending=true;button('이전 산책 이어가는 중…',true);send({type:'resume',...recovery});}
      }else if(data.type==='joined'){
        if(data.id)id=data.id;
        if(data.token)saveRecovery({room:data.room,id,token:data.token});
        joined=true;alive=true;pending=false;heading=null;pointer=null;keys.clear();boost=false;rendered.clear();motion.reset();cameraReady=false;previousScore=0;pickups.length=0;
        $('overlay').classList.add('hidden');$('boostButton').classList.remove('hidden');$('leaveButton').disabled=false;
        $('roomLabel').textContent=data.room;$('roomInput').value=data.room;
        history.replaceState(null,'',`?room=${encodeURIComponent(data.room)}`);
        canvas.focus({preventScroll:true});
        document.activeElement?.blur();playingMode(true);
      }else if(data.type==='state'){
        snapshot=data;motion.push(data,performance.now());
        const me=data.players.find(p=>p.id===id);
        if(me){
          if(me.score>previousScore&&alive){const head=rendered.get(id)?.body[0]||me.body[0];if(head)pickups.push({...head,points:me.score-previousScore,born:performance.now()});}
          previousScore=me.score;
          $('score').textContent=me.score;$('energy').value=me.energy;
          if(me.score>best){best=me.score;$('best').textContent=best;storage.set('worm-garden-best',best);}
          if(alive&&!me.alive){alive=false;showLobby('다시 자라볼까요?',`이번 산책에서 ${me.score}점을 모았어요.`,'NICE LITTLE ADVENTURE');}
          $('spawnNotice').classList.toggle('hidden',!me.alive||!me.shield);
          if(heading===null&&me.alive)heading=me.angle;
        }
        updateRanking();
      }else if(data.type==='error'){
        if(data.code==='RESUME_EXPIRED')saveRecovery(null);
        pending=false;$('formError').textContent=data.message;button(joined?'다시 자라기':'바로 플레이',!ready);
      }else if(data.type==='left'){saveRecovery(null);resetSession();showLobby();}
    });
    socket.addEventListener('close',()=>{
      ready=false;resetSession();connection('연결이 끊겼어요','offline');
      showLobby('잠시 연결이 끊겼어요','서버가 열려 있으면 자동으로 다시 연결합니다.','RECONNECTING');button('다시 연결하는 중…',true);
      setTimeout(connect,Math.min(5000,700*2**retry++));
    });
    socket.addEventListener('error',()=>{});
  }
  let rankSignature='';
  function updateRanking(){
    const signature=JSON.stringify(snapshot.players.map(p=>[p.id,p.name,p.color,p.score,p.alive]));
    if(signature===rankSignature)return;rankSignature=signature;
    $('playerCount').textContent=snapshot.players.length;
    const list=$('leaderboard');list.replaceChildren();
    const sorted=[...snapshot.players].sort((a,b)=>b.score-a.score).slice(0,6);
    if(!sorted.length){const li=document.createElement('li');li.className='empty-rank';li.textContent='첫 번째 친구가 되어 주세요 🌱';list.append(li);}
    sorted.forEach((p,i)=>{
      const row=document.createElement('li');if(p.id===id)row.className='mine';
      const rank=document.createElement('span');rank.className='rank-number';rank.textContent=String(i+1).padStart(2,'0');
      const swatch=document.createElement('span');swatch.className='rank-color';swatch.style.backgroundColor=p.color;
      const name=document.createElement('span');name.className='rank-name';name.textContent=p.name+(p.id===id?' · 나':'')+(!p.alive?' · 쉬는 중':'');
      const points=document.createElement('strong');points.className='rank-score';points.textContent=p.score;
      row.append(rank,swatch,name,points);list.append(row);
    });
  }
  $('joinForm').addEventListener('submit',event=>{
    event.preventDefault();if(!ready||pending)return;
    pending=true;$('formError').textContent='';button('함께할 정원 찾는 중…',true);
    storage.set('worm-garden-name',$('nickname').value);
    lastJoin={type:'match',name:$('nickname').value,color:Number(document.querySelector('input[name="color"]:checked').value)};
    send(lastJoin);
  });
  $('roomInput').addEventListener('input',()=>{if(!joined)$('roomLabel').textContent=$('roomInput').value.toUpperCase();});
  $('newRoomButton').addEventListener('click',()=>{
    $('roomInput').value='G-'+crypto.getRandomValues(new Uint32Array(1))[0].toString(36).slice(0,5).toUpperCase();
    if(!joined)$('roomLabel').textContent=$('roomInput').value;
    toast('새 방 코드를 만들었어요. 입장 후 친구를 초대하세요.');
  });
  $('leaveButton').addEventListener('click',()=>{saveRecovery(null);send({type:'leave'});resetSession();showLobby();});
  function toast(text){clearTimeout(toastTimer);$('toast').textContent=text;$('toast').classList.remove('hidden');toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),4000);}
  $('inviteButton').addEventListener('click',async()=>{
    if(location.protocol==='file:'){toast('서버를 실행한 뒤 초대 링크를 만들 수 있어요.');return;}
    const url=new URL(shareBase);
    if(navigator.share&&matchMedia('(pointer:coarse)').matches){
      try{await navigator.share({title:'지렁이 정원',text:'지렁이 정원에서 같이 놀아요!',url:url.href});return;}
      catch(error){if(error.name==='AbortError')return;}
    }
    try{
      if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(url.href);
      else{
        const field=document.createElement('textarea');field.value=url.href;field.style.position='fixed';field.style.opacity='0';document.body.append(field);field.select();
        const copied=document.execCommand('copy');field.remove();if(!copied)throw new Error('clipboard');
      }
      toast('초대 링크를 복사했어요. 친구에게 보내 주세요.');
    }catch{$('inviteNote').textContent='이 주소를 복사해 주세요: '+url.href;toast('초대 카드에서 주소를 직접 복사해 주세요.');}
  });
  const keyCodes=['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyW','KeyA','KeyS','KeyD'];
  document.addEventListener('keydown',e=>{
    if(!alive||e.target.closest('input,button'))return;
    if(keyCodes.includes(e.code)){e.preventDefault();keys.add(e.code);pointer=null;}
    if(e.code==='Space'){e.preventDefault();boost=true;}
  });
  document.addEventListener('keyup',e=>{keys.delete(e.code);if(e.code==='Space')boost=false;});
  window.addEventListener('blur',()=>{keys.clear();boost=false;sendInput();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){keys.clear();boost=false;sendInput();}});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&alive&&navigator.wakeLock)navigator.wakeLock.request('screen').then(lock=>{wakeLock=lock;}).catch(()=>{});});
  function aim(e){if(!alive)return;const rect=canvas.getBoundingClientRect();pointer={x:e.clientX-rect.left,y:e.clientY-rect.top};}
  canvas.addEventListener('pointermove',e=>{if(e.pointerType==='mouse'||e.buttons)aim(e);});
  canvas.addEventListener('pointerdown',e=>{e.preventDefault();canvas.focus({preventScroll:true});canvas.setPointerCapture(e.pointerId);aim(e);});
  canvas.addEventListener('pointerleave',e=>{if(e.pointerType==='mouse')pointer=null;});
  canvas.addEventListener('pointercancel',()=>{pointer=null;});
  const joystick=$('joystick');
  function steerJoystick(e){
    if(!alive||e.pointerId!==joystickPointer)return;
    const rect=joystick.getBoundingClientRect(),x=e.clientX-rect.left-rect.width/2,y=e.clientY-rect.top-rect.height/2;
    const distance=Math.hypot(x,y),limit=rect.width*.3,ratio=distance>limit?limit/distance:1;
    $('joystickKnob').style.transform=`translate(${x*ratio}px,${y*ratio}px)`;
    if(distance>7){joystickAngle=Math.atan2(y,x);heading=joystickAngle;pointer=null;keys.clear();sendInput();}
  }
  joystick.addEventListener('pointerdown',e=>{if(joystickPointer!==null)return;e.preventDefault();joystickPointer=e.pointerId;joystick.setPointerCapture(e.pointerId);steerJoystick(e);});
  joystick.addEventListener('pointermove',steerJoystick);
  for(const event of ['pointerup','pointercancel','lostpointercapture'])joystick.addEventListener(event,e=>{if(e.pointerId===joystickPointer){joystickPointer=null;joystickAngle=null;$('joystickKnob').style.transform='';}});
  $('boostButton').addEventListener('pointerdown',e=>{e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);boost=true;});
  for(const event of ['pointerup','pointercancel','lostpointercapture'])$('boostButton').addEventListener(event,()=>{boost=false;});
  function sendInput(){
    if(!alive)return;
    const dx=(keys.has('ArrowRight')||keys.has('KeyD')?1:0)-(keys.has('ArrowLeft')||keys.has('KeyA')?1:0);
    const dy=(keys.has('ArrowDown')||keys.has('KeyS')?1:0)-(keys.has('ArrowUp')||keys.has('KeyW')?1:0);
    if(joystickAngle!==null)heading=joystickAngle;
    else if(dx||dy)heading=Math.atan2(dy,dx);
    else if(pointer){
      const head=rendered.get(id)?.body[0];
      if(head){const x=pointer.x/view.scale+view.x-head.x,y=pointer.y/view.scale+view.y-head.y;if(Math.hypot(x,y)>12)heading=Math.atan2(y,x);}
    }
    if(heading!==null)send({type:'input',angle:heading,boost});
  }
  setInterval(sendInput,50);
  function resize(){
    const rect=canvas.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2);
    view.width=rect.width;view.height=rect.height;
    canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);
    view.scale=Math.max(rect.width/W,rect.height/H,alive&&touchView()?(rect.width<rect.height?1.05:.9):0);
  }
  new ResizeObserver(resize).observe(canvas);
  function circle(x,y,r,color){ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
  function terrain(){
    ctx.fillStyle='#2e4b36';ctx.fillRect(0,0,W,H);
    ctx.strokeStyle='#3e5b4038';ctx.lineWidth=1;
    for(let x=0;x<W;x+=60){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
    for(let y=0;y<H;y+=60){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
    for(const d of decorations){circle(d.x,d.y,d.r,'#52704a45');}
    for(let i=0;i<36;i++){
      const x=30+(i*193)%(W-60),y=25+(i*269)%(H-50);
      ctx.save();ctx.translate(x,y);ctx.rotate(i*1.3);ctx.fillStyle='#52734a55';
      ctx.beginPath();ctx.ellipse(-5,0,9,4,-.6,0,Math.PI*2);ctx.ellipse(5,-5,8,4,.6,0,Math.PI*2);ctx.fill();ctx.restore();
    }
    ctx.strokeStyle='#91a16866';ctx.lineWidth=6;ctx.strokeRect(8,8,W-16,H-16);
    ctx.strokeStyle='#b6ba8140';ctx.lineWidth=1;ctx.setLineDash([6,10]);ctx.strokeRect(21,21,W-42,H-42);ctx.setLineDash([]);
  }
  function foodDraw(food,time){
    const colors=['#ffc658','#ff799b','#bce968'];
    for(const f of food){
      if(f.x<view.x-24||f.y<view.y-24||f.x>view.x+view.width/view.scale+24||f.y>view.y+view.height/view.scale+24)continue;
      const pulse=1+Math.sin(time*2.2+f.id)*.045;
      ctx.save();ctx.translate(f.x,f.y);ctx.scale(pulse,pulse);
      circle(0,2,19,colors[f.color]+'18');circle(0,3,11,'#10291c70');
      ctx.fillStyle=colors[f.color];ctx.strokeStyle='#fff1c7';ctx.lineWidth=1.2;
      ctx.beginPath();
      if(f.color===1){ctx.moveTo(0,11);ctx.bezierCurveTo(-18,-1,-10,-14,0,-8);ctx.bezierCurveTo(10,-14,18,-1,0,11);}
      else ctx.ellipse(0,0,9.5,11,f.color===0?-.35:.35,0,Math.PI*2);
      ctx.fill();ctx.stroke();
      ctx.fillStyle='#74b866';ctx.beginPath();ctx.ellipse(4,-11,6,2.8,-.5,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#fff9dfb8';ctx.beginPath();ctx.ellipse(-3,-3,2.2,3.6,.4,0,Math.PI*2);ctx.fill();
      if(f.color===1){for(const [x,y] of [[-4,2],[3,1],[0,6]])circle(x,y,1,'#ffe7ae');}
      ctx.restore();
    }
  }
  function pickupDraw(now){
    for(let i=pickups.length-1;i>=0;i--){
      const p=pickups[i],age=(now-p.born)/850;if(age>=1){pickups.splice(i,1);continue;}
      ctx.save();ctx.globalAlpha=1-age;ctx.strokeStyle='#ffe49a';ctx.lineWidth=2;
      ctx.beginPath();ctx.arc(p.x,p.y,12+age*32,0,Math.PI*2);ctx.stroke();
      ctx.font='bold 20px "Malgun Gothic",sans-serif';ctx.textAlign='center';ctx.lineWidth=4;
      ctx.strokeStyle='#213d2b';ctx.strokeText('+'+p.points,p.x,p.y-22-age*35);
      ctx.fillStyle='#fff3b5';ctx.fillText('+'+p.points,p.x,p.y-22-age*35);ctx.restore();
    }
  }
  function minimap(){
    if(!alive||!touchView())return;
    const width=96,height=60,x=view.width-width-12,y=12;
    ctx.save();const dpr=canvas.width/view.width;ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.fillStyle='#122b24d9';ctx.strokeStyle='#c8ddb66b';ctx.lineWidth=1;
    ctx.fillRect(x,y,width,height);ctx.strokeRect(x,y,width,height);
    ctx.strokeStyle='#f5f5d294';ctx.strokeRect(x+view.x/W*width,y+view.y/H*height,view.width/view.scale/W*width,view.height/view.scale/H*height);
    for(const p of rendered.values()){const h=p.body[0];if(h)circle(x+h.x/W*width,y+h.y/H*height,p.id===id?3.5:2,p.id===id?'#fff2b3':p.color);}
    ctx.restore();
  }
  function wormDraw(p,time){
    if(!p.body.length)return;
    ctx.save();
    if(p.shield)ctx.globalAlpha=.78+Math.sin(time*8)*.15;
    const body=p.body.map((b,i)=>{
      const n=p.body[Math.max(0,i-1)],a=i?Math.atan2(n.y-b.y,n.x-b.x):p.angle;
      const wiggle=i?Math.sin(time*5-i*.43)*Math.min(i/5,1)*1.3:0;
      return {x:b.x-Math.sin(a)*wiggle,y:b.y+Math.cos(a)*wiggle,a};
    });
    ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();ctx.moveTo(body[0].x,body[0].y+4);
    for(const b of body)ctx.lineTo(b.x,b.y+4);
    ctx.strokeStyle='#12291955';ctx.lineWidth=26;ctx.stroke();
    for(let i=body.length-1;i>=0;i--){
      const b=body[i],taper=Math.min(1,(body.length-i+2)/10),r=(11+Math.sin(time*5-i*.35)*.4)*taper;
      circle(b.x,b.y,r,p.color);
      circle(b.x-2,b.y-3,r*.6,'#fff8ec0b');
    }
    // Draw the rings after the body so overlapping segments do not hide them.
    for(let i=3;i<body.length-2;i+=3){
      const b=body[i],r=11*Math.min(1,(body.length-i+2)/10);
      ctx.save();ctx.translate(b.x,b.y);ctx.rotate(b.a);
      ctx.strokeStyle='#653e5359';ctx.lineWidth=1.35;ctx.beginPath();ctx.moveTo(0,-r*.84);ctx.quadraticCurveTo(4,0,0,r*.84);ctx.stroke();ctx.restore();
    }
    // The pale, slightly thicker saddle is characteristic of an earthworm.
    for(let i=Math.min(12,body.length-1);i>=8;i--){const b=body[i];circle(b.x,b.y,12.1,p.color);circle(b.x,b.y,12.1,'#fff1d82b');}
    const head=body[0];ctx.save();ctx.translate(head.x,head.y);ctx.rotate(p.angle);
    ctx.fillStyle=p.color;ctx.beginPath();ctx.ellipse(1,0,14,11.8,0,0,Math.PI*2);ctx.fill();
    for(const side of [-1,1]){circle(5,side*6,4.3,'#fff7e8');circle(6.3,side*6,2.2,'#382d38');circle(6.8,side*6-.5,.7,'#ffffff');circle(-1,side*9,2.2,'#e66b873a');}
    ctx.strokeStyle='#7e455d';ctx.lineWidth=1.3;ctx.beginPath();ctx.arc(7.5,0,3,-.8,.8);ctx.stroke();ctx.restore();
    if(p.id===id){ctx.strokeStyle='#e7edc680';ctx.lineWidth=1.5;ctx.setLineDash([3,4]);ctx.beginPath();ctx.arc(head.x,head.y,21,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);}
    if(p.name){ctx.font='600 14px "Malgun Gothic",sans-serif';ctx.textAlign='center';ctx.lineWidth=4;ctx.strokeStyle='#243e2ad0';const name=p.name+(p.id===id?' · 나':'');ctx.strokeText(name,head.x,head.y-28);ctx.fillStyle='#f0f0d9';ctx.fillText(name,head.x,head.y-28);}
    ctx.restore();
  }
  function preview(time){
    const colors=['#f49aaf','#a9a0ed','#efc16e'];
    return colors.map((color,j)=>{
      const body=Array.from({length:43},(_,i)=>({x:250+j*440-i*5.4,y:270+j%2*340+Math.sin(i*.14+time*.65+j)*35}));
      return {id:'preview'+j,name:'',color,body,angle:Math.atan2(body[0].y-body[1].y,body[0].x-body[1].x)};
    });
  }
  function frame(now){
    const dt=Math.min((now-lastFrame)/1000||.016,.1);lastFrame=now;
    const time=now/1000;
    rendered=new Map(motion.sample(now).map(p=>[p.id,p]));
    const me=rendered.get(id)?.body[0];
    const viewportW=view.width/view.scale,viewportH=view.height/view.scale;
    const desiredX=Math.max(0,Math.min(W-viewportW,(me?.x??W/2)-viewportW/2));
    const desiredY=Math.max(0,Math.min(H-viewportH,(me?.y??H/2)-viewportH*(alive&&touchView()?.42:.5)));
    if(me&&!cameraReady){view.x=desiredX;view.y=desiredY;cameraReady=true;}
    view.x+=(desiredX-view.x)*(1-Math.exp(-6*dt));view.y+=(desiredY-view.y)*(1-Math.exp(-6*dt));
    const dpr=canvas.width/view.width;
    ctx.setTransform(dpr*view.scale,0,0,dpr*view.scale,-view.x*dpr*view.scale,-view.y*dpr*view.scale);
    terrain();foodDraw(joined?snapshot.food:previewFood,time);
    for(const p of joined?[...rendered.values()]:preview(time))wormDraw(p,time);
    pickupDraw(now);minimap();
    requestAnimationFrame(frame);
  }
  if(['localhost','127.0.0.1','[::1]'].includes(location.hostname)){
    fetch('/connection').then(r=>r.json()).then(data=>{
      if(data.lanHosts?.length){shareBase=`${location.protocol}//${data.lanHosts[0]}:${location.port||'3000'}`;$('inviteNote').textContent='같은 Wi-Fi의 친구에게 보낼 접속 주소가 자동으로 복사돼요.';}
    }).catch(()=>{});
  }
  resize();requestAnimationFrame(frame);connect();
})();
