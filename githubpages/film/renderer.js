// Every frame is a pure function of time. No timers, random values, or audio.
export const DURATION = 60;
export const SCENES = Object.freeze([
  { start: 0, end: 5, title: 'An idea worth sharing', text: 'Prepare a small coffee workshop. Start with an idea and a little help.' },
  { start: 5, end: 11, title: 'Connect a useful tool', text: 'Install zcaceres/fetch-mcp from its GitHub repository, then connect the app to Coffee workshop helper. Installation and a separate build are required; the full guide explains the setup correction.' },
  { start: 11, end: 18, title: 'Ask with a source', text: 'Coffee workshop helper reads the full public AboutCoffee.org guide using fetch_readable. The corrected checklist separates source advice from workshop planning choices. The guide gives a coffee-to-water ratio of 1:13 to 1:16.' },
  { start: 18, end: 23, title: 'Something you can use', text: 'The recorded answer suggests brewers, paper filters, kettles, scales, and three shared stations. Review its source advice and planning choices before using them.' },
  { start: 23, end: 29, title: 'Day 1 · Give Maya a goal', text: 'In the first compressed demonstration session, experimental persona Maya works on a 90-minute beginner workshop for six people. The demo operator pauses the run after one round and reviews and accepts two suggested memories.' },
  { start: 29, end: 36, title: 'Day 2 · Pick up the thread', text: 'The workshop grows from six people to eight. The operator reviews the saved details and continues the goal. Maya updates the plan, invitation draft and shopping list. Nothing is sent.' },
  { start: 36, end: 43, title: 'Day 3 · Bring it together', text: 'The operator reviews quantities, saves final approval as important context, and continues the goal. The app then marks the goal complete after four work sessions across three compressed demonstration sessions. These are not elapsed days or evidence of unattended reliability.' },
  { start: 43, end: 49, title: 'Ready for your review', text: 'The workshop materials come together: a plan, an invitation draft, a shopping list, and a run sheet.' },
  { start: 49, end: 54, title: 'A little help, more possibility', text: 'Connect a tool. Make a useful helper. Keep working toward your idea.' },
  { start: 54, end: 60, title: 'Make your first helper', text: 'Start with FLUJO at flujo.com.co/start. Runs locally; connected providers and tools may receive data and charge separately.' },
]);

const C = { paper:'#f5f1e8', ink:'#1c392f', soft:'#485e4e', coral:'#ed825b', orange:'#c95530', mint:'#ccdec9', lilac:'#d8cee9', white:'#fffdf7', coffee:'#613d29' };
const clamp = (v,a=0,b=1) => Math.max(a,Math.min(b,v));
const ease = t => 1-Math.pow(1-clamp(t),3);
const serif = 'Georgia, "Times New Roman", serif';
const sans = '"Segoe UI", Arial, sans-serif';
let ctx, W, H, P, T, U, gentle, palette;

function rr(x,y,w,h,r=22,fill=C.white,stroke=null){
  ctx.beginPath();ctx.roundRect(x,y,w,h,r);if(fill){ctx.fillStyle=fill;ctx.fill()}if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=2;ctx.stroke()}
}
function text(s,x,y,size=32,color=palette.ink,weight=500,font=sans,align='left',maxWidth){
  ctx.fillStyle=color;ctx.textBaseline='alphabetic';ctx.textAlign=align;ctx.font=`${weight} ${size}px ${font}`;
  if(maxWidth && ctx.measureText(s).width>maxWidth){ctx.font=`${weight} ${size*maxWidth/ctx.measureText(s).width}px ${font}`}
  ctx.fillText(s,x,y);
}
function lines(words,x,y,size=64,color=palette.ink,{gap=1.12,weight=500,font=serif,align='left',maxWidth}={}){
  words.forEach((s,i)=>text(s,x,y+i*size*gap,size,color,weight,font,align,maxWidth));
}
function line(x1,y1,x2,y2,color=palette.ink,width=2){ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke()}
function circle(x,y,r,fill,stroke=null,width=2){ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);if(fill){ctx.fillStyle=fill;ctx.fill()}if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=width;ctx.stroke()}}
function pill(s,x,y,{fill=C.ink,color=C.paper,size=22,pad=20,h=44}={}){
  ctx.font=`600 ${size}px ${sans}`;const w=ctx.measureText(s).width+pad*2;rr(x,y,w,h,h/2,fill);text(s,x+pad,y+h*.67,size,color,600);return w;
}
function check(x,y,scale=1,color=C.ink){ctx.beginPath();ctx.moveTo(x-9*scale,y);ctx.lineTo(x-2*scale,y+7*scale);ctx.lineTo(x+12*scale,y-10*scale);ctx.lineCap='round';ctx.lineJoin='round';ctx.lineWidth=4*scale;ctx.strokeStyle=color;ctx.stroke()}
function arrow(x,y,len=80,color=C.ink){line(x,y,x+len,y,color,3);line(x+len-12,y-10,x+len,y,color,3);line(x+len-12,y+10,x+len,y,color,3)}
// Content remains readable at a scene's exact start, including paused chapter links.
function reveal(delay,draw){const p=gentle||T===0?1:ease((U-delay)/.65);ctx.save();ctx.translate(0,(1-p)*30);draw();ctx.restore()}
function paper(x,y,w,h,angle,draw){ctx.save();ctx.translate(x,y);ctx.rotate(angle);ctx.shadowColor='#162f2524';ctx.shadowBlur=28;ctx.shadowOffsetY=13;rr(-w/2,-h/2,w,h,18,C.white);ctx.shadowColor='transparent';draw(-w/2,-h/2,w,h);ctx.restore()}
function star(x,y,r,color=C.orange){ctx.save();ctx.translate(x,y);ctx.rotate(gentle?0:T*.07);ctx.beginPath();for(let i=0;i<24;i++){const a=i*Math.PI/12,rad=i%2?r*.63:r;ctx.lineTo(Math.cos(a)*rad,Math.sin(a)*rad)}ctx.closePath();ctx.fillStyle=color;ctx.fill();ctx.restore()}
function cup(x,y,s=1){
  ctx.save();ctx.translate(x,y);ctx.scale(s,s);ctx.rotate(gentle?-.15:-.15+Math.sin(T*.65)*.035);
  circle(0,20,202,'#213e3510');circle(0,0,192,C.white);circle(0,0,162,C.mint);
  ctx.lineWidth=33;ctx.strokeStyle=C.coral;ctx.beginPath();ctx.ellipse(166,0,42,59,0,0,Math.PI*2);ctx.stroke();
  circle(0,0,150,C.coral);circle(0,0,126,C.paper);circle(0,0,113,C.coffee);
  ctx.strokeStyle='#b1845e';ctx.lineWidth=3;for(let i=0;i<3;i++){ctx.beginPath();ctx.arc(0,0,79-i*17,.5+i*.15,Math.PI*1.6);ctx.stroke()}
  ctx.strokeStyle='#e0b98a';ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(-25,-40);ctx.bezierCurveTo(33,-15,-40,25,17,44);ctx.stroke();ctx.restore();
}
function bean(x,y,scale=1,angle=0,color=C.coffee){ctx.save();ctx.translate(x,y);ctx.rotate(angle);ctx.fillStyle=color;ctx.beginPath();ctx.ellipse(0,0,12*scale,20*scale,0,0,Math.PI*2);ctx.fill();ctx.strokeStyle=C.paper;ctx.lineWidth=1.5*scale;ctx.beginPath();ctx.moveTo(0,-15*scale);ctx.bezierCurveTo(-8*scale,0,8*scale,0,0,15*scale);ctx.stroke();ctx.restore()}
function sheetIcon(x,y,type,color=C.ink){
  rr(x,y,52,64,5,null,color);line(x+13,y+18,x+37,y+18,color,3);
  if(type==='list'){for(let i=0;i<3;i++){check(x+15,y+31+i*10,.3,color);line(x+25,y+31+i*10,x+40,y+31+i*10,color,2)}}
  else if(type==='mail'){line(x+10,y+31,x+26,y+43,color,2);line(x+42,y+31,x+26,y+43,color,2);rr(x+8,y+29,36,23,2,null,color)}
  else{line(x+13,y+31,x+37,y+31,color,2);line(x+13,y+43,x+31,y+43,color,2)}
}
function caption(s){
  if(!P){text(s,65,H-43,20,palette.muted,450,sans,'left',W-130);return}
  ctx.font=`450 24px ${sans}`;const rows=[''];
  for(const word of s.split(' ')){const i=rows.length-1,trial=rows[i]?`${rows[i]} ${word}`:word;if(ctx.measureText(trial).width>W-130&&rows[i])rows.push(word);else rows[i]=trial}
  rows.slice(0,2).forEach((row,i)=>text(row,65,H-(rows.length>1?46:34)+i*30,24,palette.muted,450));
}
function header(index){
  circle(80,65,20,palette.ink);text('f',79,76,36,palette.bg,700,serif,'center');text('FLUJO',116,75,25,palette.ink,750,sans);
  text(`${String(index+1).padStart(2,'0')} / 10`,W-66,75,20,palette.muted,500,sans,'right');
  line(65,H-78,W-65,H-78,palette.line,1);line(65,H-78,65+(W-130)*T/60,H-78,palette.ink,3);
}
function subtleGrid(){ctx.save();ctx.globalAlpha=.14;for(let x=65;x<W;x+=48){for(let y=120;y<H-80;y+=48)circle(x,y,1,palette.ink)}ctx.restore()}
function shot(images,key,x,y,w,h,{caption:label='Recorded · FLUJO 3.46.2',fit='contain'}={}){
  const img=images[key];if(!img)return false;
  ctx.save();const progress=gentle?1:ease(U/.65);ctx.translate(0,(1-progress)*20);
  rr(x-8,y-8,w+16,h+16,20,C.white);ctx.save();ctx.beginPath();ctx.roundRect(x,y,w,h,13);ctx.clip();ctx.fillStyle=C.white;ctx.fillRect(x,y,w,h);
  const source=(P&&img.mobileImage)||img.image;
  const crop=(P&&img.mobileCrop)||img.crop||[0,0,source.width,source.height];const scale=fit==='cover'?Math.max(w/crop[2],h/crop[3]):Math.min(w/crop[2],h/crop[3]);const dw=crop[2]*scale,dh=crop[3]*scale;
  ctx.drawImage(source,...crop,x+(w-dw)/2,y+(h-dh)/2,dw,dh);ctx.restore();
  pill(label,x,y-53,{fill:C.paper,color:C.ink,size:P?24:17,h:P?42:34,pad:13});ctx.restore();return true;
}

function idea(){
  subtleGrid();const x=P?65:95;
  reveal(0,()=>{pill('LET’S MAKE SOMETHING',x,P?165:180,{fill:C.mint,color:C.ink,size:P?22:21});lines(['A small idea.','A lovely afternoon.'],x,P?302:338,P?72:86,C.ink,{maxWidth:P?W-115:880});text('A coffee workshop.',x,P?485:575,P?31:33,C.soft)});
  reveal(.3,()=>{cup(P?450:1190,P?777:415,P?1.18:1.16);bean(P?188:982,P?725:238,1.2,.6);bean(P?703:1417,P?938:617,1,-.7);bean(P?688:1457,P?627:242,.8,.4)});
  reveal(.8,()=>{pill('One good idea',P?335:1080,P?994:689,{fill:C.coral,color:C.ink,size:23});star(P?732:1470,P?507:159,42)});
  caption('A small workshop. A little help.');
}

function connect(images){
  reveal(0,()=>{text('01 / CONNECT',65,178,22,C.soft,700);lines(['Give your helper','a useful tool.'],65,P?274:294,P?70:77,C.ink,{maxWidth:P?770:770})});
  const key=U<3||!images.helper?'install':'helper';
  const has=shot(images,key,P?65:884,P?531:185,P?770:650,P?419:430);
  if(!has){
    reveal(.3,()=>paper(P?450:1174,P?721:388,P?742:624,P?356:360,-.025,(x,y,w)=>{
      pill('GITHUB → FLUJO',x+34,y+30,{fill:C.mint,color:C.ink,size:20});text('fetch-mcp',x+34,y+132,P?52:54,C.ink,650);text('Read a public web guide',x+34,y+187,27,C.soft);line(x+34,y+221,x+w-34,y+221,'#dbe1d7');text('Install tool',x+34,y+276,26,C.ink,600);arrow(x+w-113,y+267,64);text('Explanatory graphic',x+34,y+323,17,C.soft)
    }));
  }
  reveal(1,()=>{const yy=P?1007:574;const xx=65;pill('GitHub repository',xx,yy,{fill:C.white,color:C.ink,size:P?23:22});arrow(xx+(P?279:266),yy+22,P?67:75);pill('Coffee workshop helper',xx+(P?375:383),yy,{fill:C.ink,color:C.paper,size:P?23:22})});
  caption('Install a web-reading tool. Enable it for your helper.');
}

function ask(images){
  reveal(0,()=>{text('02 / ASK',65,175,22,C.mint,700);lines(['Start with','a good source.'],65,P?270:290,P?76:85,C.paper,{maxWidth:P?760:740})});
  const sx=P?65:803,sy=P?541:179,sw=P?770:732,sh=P&&images.answer?144:P?380:470;
  if(!shot(images,'answer',sx,sy,sw,sh)){
    reveal(.3,()=>paper(P?450:1170,P?733:407,P?750:677,P?375:441,.025,(x,y,w)=>{
      text('A PUBLIC COFFEE GUIDE',x+36,y+51,19,C.soft,700);lines(['“Help me prepare','a small coffee','workshop.”'],x+36,y+125,P?47:49,C.ink,{font:serif});line(x+36,y+284,x+w-36,y+284,'#d8ddd1');text('Read → summarize → make a checklist',x+36,y+330,P?23:24,C.ink,500,sans,'left',w-72);text('Illustrated request',x+36,y+369,17,C.soft)
    }));
  }
  if(P&&images.answer)reveal(.5,()=>{text('1:13–1:16',65,846,112,C.paper,500,serif);text('Coffee : water, from the guide.',65,904,29,C.mint)});
  reveal(.6,()=>{pill('Read the guide',65,P?976:605,{fill:C.coral,color:C.ink,size:26,h:52});text('Turn it into something practical.',65,P?1067:710,P?27:29,C.mint,450,sans,'left',W-130)});
  caption('Your question + a connected tool + a source.');
}

function checklist(images){
  reveal(0,()=>{text('03 / USE THE ANSWER',65,173,22,C.soft,700);lines(['Less blank page.','More getting ready.'],65,P?271:306,P?66:79,C.ink,{maxWidth:P?770:920})});
  const tasks=['Brewers + paper filters','Kettles + scales','Three shared stations'];
  reveal(.2,()=>paper(P?450:1199,P?771:463,P?745:582,P?456:490,.025,(x,y,w)=>{
    text('WORKSHOP CHECKLIST',x+38,y+58,22,C.soft,700);tasks.forEach((s,i)=>{const yy=y+145+i*100;circle(x+58,yy-10,22,C.mint);if(U>.35+i*.4||gentle)check(x+58,yy-9,.9);text(s,x+104,yy,P?30:28,C.ink,550,sans,'left',w-140);if(i<2)line(x+38,yy+39,x+w-38,yy+39,'#e0e5db')});text('Summary of the recorded answer',x+38,y+426,P?24:17,C.soft,450,sans,'left',w-76)
  }));
  reveal(.65,()=>{pill('Read it. Check it. Make it yours.',65,P?1039:632,{fill:C.coral,color:C.ink,size:P?25:26,h:52})});
  caption('Source advice and planning choices, clearly separated.');
}

function dayTag(day){pill(`DAY ${day}`,65,152,{fill:palette.ink,color:palette.bg,size:P?30:23,h:P?54:48});pill('COMPRESSED DEMO SESSION',P?244:233,152,{fill:palette.tag,color:palette.ink,size:P?25:19,h:P?54:48,pad:18})}
function dayTrail(day){
  const y=H-132,step=P?117:112,x=67;
  for(let i=0;i<2;i++)line(x+i*step+(P?90:82),y,x+(i+1)*step-15,y,palette.line,2);
  for(let i=0;i<3;i++){circle(x+i*step,y,i===day-1?9:5,i<day?palette.ink:palette.line);text(`Day ${i+1}`,x+i*step+17,y+7,P?23:19,palette.muted,450)}
}
function mayaSeal(x,y,r=78){circle(x,y,r,C.ink);text('M',x,y+25,r*.9,C.paper,500,serif,'center');circle(x,y,r+13,null,C.ink,1);circle(x+r*.83,y+r*.65,16,C.coral)}

function dayOne(images){
  dayTag(1);reveal(0,()=>{lines(['Meet Maya.','Give her the goal.'],65,P?299:302,P?68:80,C.ink,{maxWidth:P?770:820});text('Give her context. Then review the work.',65,P?474:516,P?29:29,C.ink,450,sans,'left',P?770:820)});
  if(!shot(images,'mayaGoal',P?65:916,P?587:280,P?770:617,P?186:310)){
    reveal(.25,()=>{mayaSeal(P?450:1251,P?693:369,P?109:115);paper(P?450:1217,P?925:606,P?697:583,180,-.035,(x,y,w)=>{text('THE GOAL',x+29,y+47,18,C.soft,700);text('Prepare a small coffee workshop.',x+29,y+101,P?31:29,C.ink,550,sans,'left',w-58);text('Illustrated goal card',x+29,y+149,17,C.soft)})});
  }
  if(P&&images.mayaGoal)reveal(.6,()=>{text('90 minutes',65,918,94,C.ink,500,serif);text('Six people. Three shared stations.',65,990,29,C.soft)});
  dayTrail(1);
  caption('Experimental personas · Review and guide their work.');
}

function dayTwo(images){
  dayTag(2);reveal(0,()=>{lines(P?['Pick up','the thread.']:['Pick up the thread.'],65,P?310:316,P?85:98,C.ink);text('Now eight guests. Update the details.',65,P?527:398,30,C.soft)});
  if(!shot(images,'mayaContinue',P?65:65,P?616:496,P?770:1470,P?195:224)){
    reveal(.25,()=>paper(P?450:1177,P?806:445,P?741:645,P?377:411,.028,(x,y,w)=>{
      pill('INVITATION DRAFT',x+33,y+31,{fill:C.lilac,color:C.ink,size:20});lines(['Coffee, together.','Come learn, brew,','and taste.'],x+33,y+135,P?49:48,C.ink);line(x+33,y+283,x+w-33,y+283,'#d8ddd1');text('A draft for you to review. Nothing sent.',x+33,y+333,P?25:23,C.soft,500,sans,'left',w-66);text('Illustrative invitation wording',x+33,y+376,17,C.soft)
    }));
  }
  if(P&&images.mayaContinue)reveal(.6,()=>{text('6 → 8',65,956,112,C.ink,500,serif);text('guests, with the plan updated.',365,954,28,C.soft,450,sans,'left',470)});
  dayTrail(2);
  caption('Operator-reviewed context · The operator resumed the goal.');
}

function dayThree(images){
  dayTag(3);reveal(0,()=>{lines(['Bring the','details together.'],65,P?303:300,P?76:87,C.paper,{maxWidth:P?770:1340});text('You review. You approve. Check the result.',P?65:460,P?510:776,29,C.mint,450,sans,'left',P?W-130:W-525)});
  const key=U<4||!images.completed?'mayaResult':'completed';
  const completePhone=P&&key==='completed';
  if(!shot(images,key,completePhone?240:65,P?(completePhone?649:614):487,P?(completePhone?420:770):1470,P?(completePhone?140:195):229)){
    reveal(.25,()=>paper(P?450:1217,P?805:440,P?735:547,P?397:461,-.025,(x,y,w)=>{
      text('THE WORKSHOP, IN ORDER',x+30,y+51,P?23:20,C.soft,700);const items=['Set up','Welcome everyone','Brew & taste','Wrap up'];items.forEach((s,i)=>{const yy=y+120+i*73;circle(x+48,yy-10,17,C.mint);text(String(i+1),x+48,yy-3,19,C.ink,650,sans,'center');text(s,x+86,yy,P?29:26,C.ink,550)});text('Illustrative run sheet',x+30,y+(P?371:426),17,C.soft)
    }));
  }
  if(P&&images.mayaResult)reveal(.6,()=>{text(key==='completed'?'Ready to review.':'A 90-minute plan.',65,955,key==='completed'?67:65,C.paper,500,serif,'left',W-130)});
  dayTrail(3);
  caption('Reviewed work · Four work sessions, three compressed demos.');
}

function materials(){
  reveal(0,()=>{text('FROM AN IDEA TO A STARTING POINT',65,171,P?21:22,C.soft,700);lines(['Ready for your review.'],65,P?284:291,P?61:86,C.ink,{maxWidth:W-130})});
  const cards=[['Workshop','plan','plan',C.mint],['Invitation','draft','mail',C.lilac],['Shopping','list','list',C.coral],['Workshop','run sheet','list',C.mint]];
  cards.forEach(([a,b,icon,tint],i)=>reveal(.25+i*.14,()=>{
    const w=P?348:326,h=P?287:350,x=P?265+(i%2)*370:266+i*359,y=P?531+Math.floor(i/2)*311:520;
    const angle=gentle?0:Math.sin(i*2+1)*.025;
    paper(x,y,w,h,angle,(xx,yy)=>{rr(xx+25,yy+25,w-50,71,12,tint);sheetIcon(xx+44,yy+33,icon);text(a,xx+25,yy+(P?167:193),P?35:36,C.ink,500,serif);text(b,xx+25,yy+(P?211:240),P?35:36,C.ink,500,serif);circle(xx+w-43,yy+h-38,15,C.ink);check(xx+w-43,yy+h-38,.6,C.paper)})
  }));
  caption('Illustrated materials · You decide what is ready to use.');
}

function benefits(){
  const labels=['Connect a tool.','Make a helper.','Keep going.'];
  labels.forEach((s,i)=>reveal(i*.45,()=>{const yy=P?348+i*220:293+i*163;circle(P?101:112,yy-24,34,C.ink);text(String(i+1),P?101:112,yy-12,30,C.paper,650,sans,'center');text(s,P?171:198,yy,P?66:91,C.ink,500,serif,'left',W-(P?216:280))}));
  reveal(1.5,()=>star(P?738:1419,P?965:239,P?66:107,C.ink));caption('Start small. Put it to work.');
}

function closing(){
  ctx.save();ctx.globalAlpha=.15;circle(P?800:1450,P?173:306,P?304:398,null,C.mint,1);circle(P?800:1450,P?173:306,P?255:330,null,C.mint,1);circle(P?800:1450,P?173:306,P?209:265,null,C.mint,1);ctx.restore();
  reveal(0,()=>{text('YOUR IDEA IS A GOOD PLACE TO START.',65,P?240:207,P?21:22,C.mint,650,sans,'left',W-130);lines(['Make your','first helper.'],65,P?397:372,P?105:125,C.paper,{maxWidth:W-130});rr(65,P?709:637,P?671:650,92,46,C.coral);text('flujo.com.co/start',103,P?768:696,P?43:44,C.ink,600);arrow(P?635:625,P?754:680,P?51:50,C.ink)});
  reveal(.35,()=>{text('FLUJO',65,P?971:802,P?45:39,C.paper,800);if(P)text('A little help for your next idea.',65,1031,28,C.mint)});
  caption('Runs locally. Connected providers may receive data and charge separately.');
}

export function sceneAt(time){const t=clamp(Number.isFinite(time)?time:0,0,DURATION);const index=SCENES.findIndex(s=>t>=s.start&&t<s.end);return index<0?SCENES.length-1:index}

export function drawFilm(context,time,width,height,options={}){
  ctx=context;T=clamp(Number.isFinite(time)?time:0,0,DURATION);P=width/height<1.15;W=P?900:1600;H=P?1200:900;gentle=Boolean(options.reducedMotion);
  const index=sceneAt(T);U=T-SCENES[index].start;
  const backgrounds=[C.paper,C.mint,C.ink,C.paper,C.lilac,C.paper,C.ink,C.paper,C.coral,C.ink];
  const dark=index===2||index===6||index===9;
  palette={bg:backgrounds[index],ink:dark?C.paper:C.ink,muted:dark?C.mint:index===8?C.ink:C.soft,line:dark?'#52695b':'#213e352c',tag:dark?'#3a594c':'#ffffff66'};
  ctx.resetTransform();ctx.globalAlpha=1;ctx.fillStyle=palette.bg;ctx.fillRect(0,0,width,height);
  const scale=Math.min(width/W,height/H);ctx.translate((width-W*scale)/2,(height-H*scale)/2);ctx.scale(scale,scale);ctx.save();ctx.beginPath();ctx.rect(0,0,W,H);ctx.clip();
  header(index);
  const renderers=[idea,connect,ask,checklist,dayOne,dayTwo,dayThree,materials,benefits,closing];
  renderers[index](options.images||{});
  ctx.restore();ctx.resetTransform();
  return {index,portrait:P,width:W,height:H};
}
