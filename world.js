const WIDTH = 1440, HEIGHT = 900, RADIUS = 11, SPACING = 6;
const COLORS = ['#f49aaf', '#a9a0ed', '#80cbb8', '#efc16e', '#83b6ef', '#ee9b74'];
class World {
  constructor(random = Math.random) {
    this.random = random; this.players = new Map(); this.food = []; this.nextFoodId = 0; this.tick = 0;
    while (this.food.length < 130) this.addFood();
  }
  addFood(point) {
    if (this.food.length >= 260) return;
    this.food.push({id:++this.nextFoodId, x:point?.x ?? 35+this.random()*(WIDTH-70),
      y:point?.y ?? 35+this.random()*(HEIGHT-70), color:Math.floor(this.random()*3)});
  }
  spawn(id, name, color = 0) {
    let x, y;
    for (let tries=0;tries<60;tries++) {
      x=180+this.random()*(WIDTH-360); y=180+this.random()*(HEIGHT-360);
      if (![...this.players.values()].some(p=>p.alive && p.body.some(b=>Math.hypot(b.x-x,b.y-y)<170))) break;
    }
    const angle=Math.atan2(HEIGHT/2-y,WIDTH/2-x);
    const player={id,name,color:COLORS[color]||COLORS[0],alive:true,score:0,angle,target:angle,
      boosting:false,energy:100,shield:5,length:27,
      body:Array.from({length:27},(_,i)=>({x:x-Math.cos(angle)*i*SPACING,y:y-Math.sin(angle)*i*SPACING}))};
    this.players.set(id,player); return player;
  }
  input(id, angle, boost) {
    const p=this.players.get(id);
    if (!p?.alive || typeof angle!=='number' || !Number.isFinite(angle)) return;
    p.target=Math.atan2(Math.sin(angle),Math.cos(angle)); p.boosting=boost===true;
  }
  step(dt) {
    this.tick++;
    const alive=[...this.players.values()].filter(p=>p.alive);
    for(const p of alive) {
      p.shield=Math.max(0,p.shield-dt);
      const delta=Math.atan2(Math.sin(p.target-p.angle),Math.cos(p.target-p.angle));
      p.angle+=Math.max(-4.5*dt,Math.min(4.5*dt,delta));
      const boost=p.boosting && p.energy>=2;
      p.energy=Math.max(0,Math.min(100,p.energy+(boost?-35:20)*dt));
      const speed=boost?180:100;
      p.body[0]={x:p.body[0].x+Math.cos(p.angle)*speed*dt,y:p.body[0].y+Math.sin(p.angle)*speed*dt};
      for(let i=1;i<p.body.length;i++) {
        const a=p.body[i-1],b=p.body[i],distance=Math.hypot(a.x-b.x,a.y-b.y);
        if(distance>SPACING){b.x=a.x+(b.x-a.x)*SPACING/distance;b.y=a.y+(b.y-a.y)*SPACING/distance;}
      }
    }
    // Resolve collisions together so head-on impacts affect both players equally.
    const deaths=new Set();
    for(const p of alive) {
      const h=p.body[0];
      if(h.x<RADIUS || h.y<RADIUS || h.x>WIDTH-RADIUS || h.y>HEIGHT-RADIUS) deaths.add(p);
      if(p.shield>0) continue;
      for(const other of alive) {
        if(other===p || other.shield>0) continue;
        if(other.body.some(b=>Math.hypot(h.x-b.x,h.y-b.y)<RADIUS*1.7)){deaths.add(p);break;}
      }
    }
    for(const p of deaths) {
      p.alive=false;p.boosting=false;
      for(let i=0;i<p.body.length;i+=4){const b=p.body[i];if(b.x>20&&b.y>20&&b.x<WIDTH-20&&b.y<HEIGHT-20)this.addFood(b);}
      p.body=[];
    }
    for(const p of alive) {
      if(!p.alive) continue;
      for(let i=this.food.length-1;i>=0;i--) {
        if(Math.hypot(p.body[0].x-this.food[i].x,p.body[0].y-this.food[i].y)<RADIUS+11) {
          p.score+=10;p.length=Math.min(180,p.length+1);this.food.splice(i,1);
          while(p.body.length<p.length)p.body.push({...p.body.at(-1)});
        }
      }
    }
    while(this.food.length<130)this.addFood();
  }
  snapshot(room) {
    return {type:'state',room,tick:this.tick,width:WIDTH,height:HEIGHT,food:this.food,
      players:[...this.players.values()].map(p=>({id:p.id,name:p.name,color:p.color,alive:p.alive,
        score:p.score,angle:p.angle,energy:Math.round(p.energy),shield:p.shield>0,
        body:p.body.map(b=>({x:Math.round(b.x*10)/10,y:Math.round(b.y*10)/10}))}))};
  }
}
module.exports={World,WIDTH,HEIGHT,COLORS};
