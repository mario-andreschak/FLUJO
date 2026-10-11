// Deterministic product-film choreography. Source UI pixels are never reconstructed.
export const DURATION = 60;
export const SCENES = Object.freeze([
  { start:0, end:5, title:'Your AI workspace', text:'FLUJO brings your AI connections, tools, reusable agents and conversations into one local workspace.' },
  { start:5, end:12, title:'Choose your AI', text:'Connect the AI provider and model you want to use. The recorded OpenRouter connection passes its model and tool round-trip tests.' },
  { start:12, end:20, title:'Connect your tools', text:'Bring an MCP tool in from GitHub, install and build it, then test the connection. The recorded fetch-mcp server exposes six tools. Setup is condensed; the guide includes the required install-command correction.' },
  { start:20, end:32, title:'Build a reusable agent', text:'Give an agent instructions, choose its AI and attach a connected app in the visual editor. Save the agent and try it. The recorded example binds the complete fetch-mcp app.' },
  { start:32, end:43, title:'Run it. Inspect the work.', text:'Ask the agent to read a public guide and make a checklist. Inspect the conversation and source before using its answer. The shown checklist was corrected after a complete source read, not a correct first reply.' },
  { start:43, end:54, title:'Keep a goal moving', text:'Experimental Personas can continue a saved goal with reviewed memory. In this condensed demonstration, the operator reviews memories, resumes work and approves the final details. The goal completes after four work sessions; this is not a claim of unattended reliability.' },
  { start:54, end:60, title:'Build your first agent', text:'Choose your AI. Connect your tools. Build your first agent in FLUJO at flujo.com.co/start. FLUJO runs locally; connected providers and tools may receive data and charge separately.' },
]);

const C={bg:'#080c17',panel:'#111827',line:'#273249',white:'#f5f7ff',muted:'#a9b7cc',teal:'#36e0c4',violet:'#a493ff'};
const sans='"Segoe UI", Arial, sans-serif';
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const smooth=v=>{v=clamp(v);return v*v*(3-2*v)};
const mix=(a,b,v)=>a+(b-a)*v;
let ctx,W,H,P,T,U,gentle,images,scene;
function box(x,y,w,h,r=18,fill=C.panel,stroke){ctx.beginPath();ctx.roundRect(x,y,w,h,r);if(fill){ctx.fillStyle=fill;ctx.fill()}if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=1.5;ctx.stroke()}}
function text(value,x,y,size=32,color=C.white,weight=500,align='left',maxWidth){ctx.font=`${weight} ${size}px ${sans}`;if(maxWidth&&ctx.measureText(value).width>maxWidth)ctx.font=`${weight} ${size*maxWidth/ctx.measureText(value).width}px ${sans}`;ctx.fillStyle=color;ctx.textBaseline='alphabetic';ctx.textAlign=align;ctx.fillText(value,x,y)}
function line(x1,y1,x2,y2,color=C.line,width=2){ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke()}
function dot(x,y,r,color){ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fillStyle=color;ctx.fill()}
function label(value,x,y,{color=C.teal,size=21}={}){text(value.toUpperCase(),x,y,size,color,700)}
function logo(x,y,size=42){const image=images.brand?.image;if(!image)return;ctx.save();ctx.beginPath();ctx.roundRect(x,y,size,size,size*.24);ctx.clip();ctx.drawImage(image,x,y,size,size);ctx.restore()}
function brand(x=42,y=25,scale=1){logo(x,y,44*scale);text('FLUJO',x+58*scale,y+33*scale,30*scale,C.white,800)}
function background(){ctx.fillStyle=C.bg;ctx.fillRect(0,0,W,H);const g=ctx.createRadialGradient(W*.75,H*.4,0,W*.75,H*.4,W*.7);g.addColorStop(0,'#28205377');g.addColorStop(.5,'#10353b44');g.addColorStop(1,'#080c1700');ctx.fillStyle=g;ctx.fillRect(0,0,W,H);ctx.save();ctx.globalAlpha=.13;for(let x=40;x<W;x+=45)for(let y=130;y<H;y+=45)dot(x,y,.8,C.muted);ctx.restore()}
function title(kicker,headline,subline){
  const value=Array.isArray(headline)?headline.join(' '):headline;
  if(P)text(value,36,149,55,C.white,700,'left',W-72);
  else text(value,285,63,45,C.white,700,'left',W-329);
}
function rail(active){const names=['AI','TOOLS','AGENT','RUN','PERSONA'];const x=P?62:64,y=H-53,step=P?157:175;for(let i=0;i<5;i++){const color=i<=active?C.teal:C.muted;dot(x+i*step,y-7,i===active?6:3,color);text(names[i],x+17+i*step,y,P?20:18,color,i===active?750:500);if(i<4)line(x+105+i*step,y-7,x+step-17+i*step,y-7,i<active?C.teal:C.line,1.5)}line(0,H-2,W*T/60,H-2,C.teal,3)}
function caption(main,secondary){const y=P?1032:853;text(main,P?36:44,y,P?34:32,C.white,600,'left',W-(P?72:88));if(secondary)text(secondary,P?36:44,y+39,P?25:21,C.muted,450,'left',W-(P?72:88))}
function phase(start,end){return gentle?.6:smooth((U-start)/(end-start))}
function cropBetween(a,b,start,end){const p=phase(start,end);return a.map((n,i)=>mix(n,b[i],p))}
function frameRect(){return P?[30,196,840,766]:[38,104,1524,693]}
// Frame crops are editorial camera moves over genuine captured pixels, never fake UI actions.
function screen(key,crop,rect=frameRect(),{accent=C.teal,tilt=0,focus=null}={}){
  const entry=images[key];if(!entry)return;
  const source=entry.video||entry.image;
  let [x,y,w,h]=rect;
  // The product window follows its true aspect ratio; no fabricated UI padding.
  const scale=Math.min(w/crop[2],h/crop[3]);
  const dw=crop[2]*scale,dh=crop[3]*scale;
  x+=(w-dw)/2;y+=(h-dh)/2;w=dw;h=dh;
  ctx.save();ctx.translate(x+w/2,y+h/2);ctx.rotate(gentle?0:tilt);ctx.shadowColor='#00000099';ctx.shadowBlur=55;ctx.shadowOffsetY=18;box(-w/2-1,-h/2-1,w+2,h+2,17,'#dfe2ed',C.line);ctx.shadowColor='transparent';
  ctx.beginPath();ctx.roundRect(-w/2,-h/2,w,h,16);ctx.clip();
  ctx.drawImage(source,...crop,-w/2,-h/2,w,h);
  if(focus){const [fx,fy,fw,fh]=focus;ctx.strokeStyle=accent;ctx.lineWidth=3;ctx.strokeRect(-w/2+(fx-crop[0])*scale,-h/2+(fy-crop[1])*scale,fw*scale,fh*scale)}
  ctx.restore();
  // The travelling edge marks the camera focus; it is outside the product screenshot.
  const p=gentle?.5:(T*.12)%1;const g=ctx.createLinearGradient(x,y,x+w,y);g.addColorStop(0,'#36e0c400');g.addColorStop(Math.max(.001,p-.08),'#36e0c400');g.addColorStop(p,accent);g.addColorStop(Math.min(.999,p+.08),'#36e0c400');g.addColorStop(1,'#36e0c400');line(x+18,y-2,x+w-18,y-2,g,2);
}
function connection(x1,y1,x2,y2,p,color=C.teal){ctx.save();ctx.strokeStyle=C.line;ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x1,y1);ctx.bezierCurveTo(x1+(x2-x1)*.5,y1,x1+(x2-x1)*.5,y2,x2,y2);ctx.stroke();ctx.strokeStyle=color;ctx.setLineDash([Math.max(1,p)*Math.hypot(x2-x1,y2-y1),4000]);ctx.stroke();ctx.setLineDash([]);const q=gentle?.7:(T*.3)%1;dot(mix(x1,x2,q),mix(y1,y2,smooth(q)),5,color);ctx.restore()}
function intro(){
  brand();title('','Build AI assistants.');
  const crop=P?cropBetween([393,465,400,422],[738,492,390,333],0,5):cropBetween([239,125,1343,850],[364,340,1204,556],0,5);
  screen('expert',crop,frameRect());
  caption('Your AI + your tools, in one visual workflow.');
}
function ai(){
  title('','Choose your AI.');
  const choosing=U<3.5;
  const crop=choosing?(P?[377,321,290,290]:[370,307,848,312]):(P?[522,305,554,118]:[512,299,574,199]);
  screen(choosing?'provider':'ai',crop,frameRect(),{accent:C.violet});
  caption(choosing?'Choose the connection that fits your work.':'Connected and tested. Ready for your assistant.');
}
function toolsScene(){
  title('02 / CONNECT','Bring your tools.','Connect a tool from a GitHub link.');
  const tested=U>=3.6;
  const crop=tested?(P?cropBetween([1048,299,493,508],[1070,509,444,255],4,7.2):cropBetween([1048,299,493,508],[1067,498,457,278],4,7.2)):(P?cropBetween([41,324,697,468],[57,409,546,228],.2,2.8):cropBetween([40,326,696,467],[59,439,559,157],.2,3));
  screen(tested?'tool':'github',crop,frameRect());
  caption(tested?'The agent can now read a web page.':'Let your assistant read web pages.','Setup condensed');
}
function build(){
  title('','Build it visually.');
  const part=U<2?0:U<7.5?1:2;
  const key=part===0?'easy':part===1?'agentSwitch':'agentInspect';
  const crop=part===0?(P?[1266,305,290,305]:[289,305,1285,590]):part===1?(P?cropBetween([509,126,533,400],[242,212,1000,765],4.2,6.7):cropBetween([503,126,601,286],[242,212,1000,765],4.2,6.7)):(P?[1265,748,293,193]:[301,299,1270,643]);
  screen(key,crop,frameRect(),{accent:C.violet});
  caption(part===0?'Give clear instructions.':part===1?'Start simple. Open the workflow when you need it.':'Your AI and tools, attached to this assistant.');
}
function run(){
  title('','Read a guide. Make a checklist.');
  const inspecting=U<7;
  const key=inspecting?(images.fetchMotion?'fetchMotion':'fetchResult'):'answer';
  // Show the tool record and checked sections of the saved answer. The original
  // unsupported temperature/rest instruction is outside these answer crops.
  const crop=inspecting?(U<2?(P?[341,384,336,149]:[338,380,435,156]):(P?[352,414,383,211]:[342,380,1199,432])):U<9?(P?[350,402,430,70]:[347,360,710,111]):(P?[349,594,525,165]:[347,593,710,162]);
  screen(key,crop,frameRect(),{accent:C.teal});
  caption(inspecting?'See what your assistant read.':'Turn the source into a checklist you can review.');
}
function persona(){
  const part=U<3.5?0:U<7?1:2;
  title('05 / CONTINUE',P?['Keep a goal','moving.']:'Keep a goal moving.',part===0?'Give a Persona a goal and context.':part===1?'Review what it remembers.':'Resume work. Review the outcome.');
  const key=part===0?'goal':part===1?'memory':'completed';
  let crop;
  if(part===0)crop=P?cropBetween([69,408,563,176],[71,445,338,133],.5,2.3):cropBetween([64,371,950,214],[69,415,742,165],.5,2.3);
  else if(part===1)crop=P?cropBetween([75,564,492,234],[85,632,376,166],4.2,5.5):cropBetween([73,477,1444,331],[78,632,670,176],4.2,5.5);
  else crop=P?cropBetween([80,232,704,245],[440,236,345,115],7,10.5):cropBetween([58,238,1467,467],[71,237,742,142],7,10.5);
  const rect=frameRect();
  screen(key,crop,rect);
  caption(part===0?'Pick up where you left off.':part===1?'Memory you can review, correct or forget.':'Reviewed work. A completed goal.','Personas · experimental · condensed demonstration');
}
function closing(){
  const center=W/2;const y=P?259:242;logo(center-36,y-170,72);text('FLUJO',center,y+77,P?114:140,C.white,850,'center');
  text('Your AI. Your tools. One workspace.',center,y+160,P?38:44,C.muted,500,'center',W-100);
  const yy=P?658:599;const labels=['CHOOSE','CONNECT','BUILD'];const span=P?235:310,start=center-span;
  labels.forEach((s,i)=>{dot(start+i*span,yy-60,8,i===1?C.violet:C.teal);if(i<2)connection(start+i*span+16,yy-60,start+(i+1)*span-16,yy-60,phase(0,2));text(s,start+i*span,yy,P?28:25,C.white,650,'center')});
  text('Build your first agent.',center,P?817:737,P?49:49,C.white,700,'center');
  text('flujo.com.co/start',center,P?900:806,P?41:36,C.teal,650,'center');
  text('Runs locally. Providers may receive data and charge separately.',center,H-64,P?23:21,C.muted,450,'center',W-100);
}
export function sceneAt(time){const t=clamp(Number.isFinite(time)?time:0,0,DURATION);const found=SCENES.findIndex(s=>t>=s.start&&t<s.end);return found<0?SCENES.length-1:found}
export function drawFilm(context,time,width,height,options={}){
  ctx=context;T=clamp(Number.isFinite(time)?time:0,0,DURATION);P=width/height<1.15;W=P?900:1600;H=P?1200:900;gentle=Boolean(options.reducedMotion);images=options.images||{};scene=sceneAt(T);U=T-SCENES[scene].start;
  ctx.save();ctx.setTransform(width/W,0,0,height/H,0,0);background();if(scene>0&&scene<6)brand();
  [intro,ai,toolsScene,build,run,persona,closing][scene]();
  // A brief directional wipe connects chapters; no fade-to-black interrupts paused chapter starts.
  if(!gentle&&scene>0&&U>0&&U<.32){const q=U/.32;ctx.save();ctx.globalAlpha=(1-q)*.6;const x=W*(q*1.4-.2);ctx.fillStyle=C.teal;ctx.beginPath();ctx.moveTo(x-150,0);ctx.lineTo(x+30,0);ctx.lineTo(x-160,H);ctx.lineTo(x-340,H);ctx.fill();ctx.restore()}
  ctx.restore();
}
