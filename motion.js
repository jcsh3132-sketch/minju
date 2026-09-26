// Render a short buffered server timeline instead of chasing each arriving packet.
(function(root){
  class MotionBuffer {
    constructor(){this.reset();}
    reset(){this.frames=[];this.offset=null;this.delay=150;this.cursor=null;}
    push(state,now){
      const time=state.serverTime??state.tick*1000/30;
      const last=this.frames.at(-1);
      if(last&&time<=last.time)return;
      const offset=now-time;
      this.offset=this.offset===null?offset:Math.min(this.offset,offset);
      if(last){
        const interval=now-last.arrival;
        const target=Math.min(350,Math.max(100,interval*1.5));
        this.delay+=(target-this.delay)*(target>this.delay?.25:.02);
      }
      this.frames.push({time,arrival:now,players:state.players});
      if(this.frames.length>30)this.frames.shift();
    }
    sample(now){
      if(!this.frames.length)return [];
      // Never rewind when the jitter buffer grows.
      this.cursor=Math.max(this.cursor??-Infinity,now-this.offset-this.delay);
      while(this.frames.length>2&&this.frames[1].time<=this.cursor)this.frames.shift();
      const a=this.frames[0],b=this.frames[1]||a;
      const span=b.time-a.time;
      // Briefly extrapolate, then hold during a longer disconnection.
      const t=span?Math.max(0,Math.min(1+100/span,(this.cursor-a.time)/span)):1;
      const older=new Map(a.players.map(p=>[p.id,p]));
      return b.players.filter(p=>p.alive).map(p=>{
        const old=older.get(p.id);
        if(!old?.alive||!span||Math.hypot(p.body[0].x-old.body[0].x,p.body[0].y-old.body[0].y)>180)return {...p,body:p.body.map(b=>({...b}))};
        const angle=old.angle+Math.atan2(Math.sin(p.angle-old.angle),Math.cos(p.angle-old.angle))*Math.min(t,1);
        return {...p,angle,body:p.body.map((point,i)=>{
          const previous=old.body[i]||point;
          return {x:Math.max(12,Math.min(1428,previous.x+(point.x-previous.x)*t)),
            y:Math.max(12,Math.min(888,previous.y+(point.y-previous.y)*t))};
        })};
      });
    }
  }
  if(typeof module!=='undefined')module.exports={MotionBuffer};
  else root.MotionBuffer=MotionBuffer;
})(globalThis);
