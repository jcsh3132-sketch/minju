const test=require('node:test');
const assert=require('node:assert/strict');
const {World}=require('../world');
function world(){let seed=19;return new World(()=>{seed=(seed*16807)%2147483647;return(seed-1)/2147483646;});}
function place(p,x,y,angle=0){p.angle=angle;p.target=angle;p.body=Array.from({length:27},(_,i)=>({x:x-Math.cos(angle)*i*6,y:y-Math.sin(angle)*i*6}));}

test('food grows a worm and updates its authoritative score',()=>{
  const w=world(),p=w.spawn('a','Alice');place(p,400,400);
  w.food=[{id:1,x:404,y:400,color:0}];w.step(1/30);
  assert.equal(p.score,10);assert.equal(p.body.length,30);assert.equal(w.food.length,130);
  assert.ok(p.body[0].x>400);assert.equal(w.snapshot('TEST').players[0].score,10);
});
test('wall collision kills even during spawn protection and leaves seeds',()=>{
  const w=world(),p=w.spawn('a','Alice');place(p,1428,400);const count=w.food.length;w.step(1/30);
  assert.equal(p.alive,false);assert.equal(p.body.length,0);assert.ok(w.food.length>count);
});
test('head-on collision is symmetric and self crossing is allowed',()=>{
  const w=world(),a=w.spawn('a','Alice'),b=w.spawn('b','Bob');
  place(a,500,400);place(b,522,400,Math.PI);a.shield=b.shield=0;w.step(1/30);
  assert.equal(a.alive,false);assert.equal(b.alive,false);
  const single=world(),p=single.spawn('p','Player');place(p,400,400);p.shield=0;
  p.body[20]={x:404,y:400};single.step(1/30);assert.equal(p.alive,true);
});
test('spawn shield protects both players from player collisions',()=>{
  const w=world(),a=w.spawn('a','Alice'),b=w.spawn('b','Bob');
  place(a,500,400);place(b,522,400,Math.PI);a.shield=0;b.shield=3;w.step(1/30);
  assert.equal(a.alive,true);assert.equal(b.alive,true);
});
test('invalid input is ignored and boost consumes regenerating energy',()=>{
  const w=world(),p=w.spawn('p','Player');place(p,400,400);w.food=[];
  w.input('p',NaN,true);assert.equal(p.boosting,false);assert.equal(p.target,0);
  w.input('p',Infinity,true);assert.equal(p.target,0);
  w.input('p',0,true);w.step(1/30);assert.ok(p.body[0].x-400>6);assert.ok(p.energy<100);
  const energy=p.energy;w.input('p',0,false);w.step(1/30);assert.ok(p.energy>energy);
});
