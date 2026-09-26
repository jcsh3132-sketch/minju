const {test}=require('node:test');
const assert=require('node:assert/strict');
const {MotionBuffer}=require('../motion');
const state=(time,x,angle=0)=>({serverTime:time,players:[{id:'a',alive:true,angle,body:[{x,y:200}]}]});
test('buffered movement keeps constant speed between packets',()=>{
  const motion=new MotionBuffer();
  motion.push(state(1000,100),0);motion.push(state(1100,110),100);motion.push(state(1200,120),200);
  const positions=[200,216,232,248].map(now=>motion.sample(now)[0].body[0].x);
  for(let i=1;i<positions.length;i++)assert.ok(Math.abs(positions[i]-positions[i-1]-1.6)<.001);
});
test('late packets never rewind timeline and prediction stops after 100ms',()=>{
  const motion=new MotionBuffer();motion.push(state(1000,100),0);motion.push(state(1100,110),100);
  const before=motion.sample(250)[0].body[0].x;
  motion.push(state(1200,120),260);
  assert.ok(motion.sample(260)[0].body[0].x>=before);
  assert.equal(motion.sample(2000)[0].body[0].x,130);
  assert.equal(motion.sample(3000)[0].body[0].x,130);
  motion.reset();assert.deepEqual(motion.sample(4000),[]);
});
test('turns interpolate across the angle wrap using the shortest arc',()=>{
  const motion=new MotionBuffer();motion.push(state(1000,100,3.1),0);motion.push(state(1100,110,-3.1),100);
  assert.ok(Math.abs(motion.sample(200)[0].angle-Math.PI)<.001);
});
