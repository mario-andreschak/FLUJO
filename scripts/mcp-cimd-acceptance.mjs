import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {fork,execFileSync} from 'node:child_process';
import {createWriteStream,promises as fs} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root=process.cwd();
assert(process.env.CIMD_ACCEPTANCE_RUN_DIR,'Set a private, task-owned CIMD_ACCEPTANCE_RUN_DIR');
const run=path.resolve(process.env.CIMD_ACCEPTANCE_RUN_DIR);
const require=createRequire(path.join(root,'package.json'));
const {chromium,expect}=require('@playwright/test');
const helper=await import(pathToFileURL(path.join(root,'scripts/feature-surface-acceptance/browser-environment.mjs')));
const {provisionOwnerBootstrap}=await import(pathToFileURL(path.join(root,'scripts/owner-bootstrap.mjs')));
const metadata=JSON.parse(await fs.readFile(path.join(root,'githubpages/oauth/client-metadata.json'),'utf8'));
const attempt=Date.now().toString();
const base='http://127.0.0.1:4200',profile=path.join(run,'journey-profile-'+attempt),authority=path.join(run,'journey-authority-'+attempt);
await helper.inspectCandidateRoot(root);
const candidateTree=execFileSync('git',['write-tree']).toString().trim();
const inputs={candidateTree,applicationSourceTree:execFileSync('git',['rev-parse',candidateTree+':src']).toString().trim()};
const receipt={startedUtc:new Date().toISOString(),head:execFileSync('git',['rev-parse','HEAD']).toString().trim(),candidateTree:inputs.candidateTree,applicationSourceTree:inputs.applicationSourceTree,buildId:(await fs.readFile(path.join(root,'.next/BUILD_ID'),'utf8')).trim(),cases:[],epochs:[],tokenExchanges:[],browserErrors:[],providerCalls:0,limitations:['Controlled local authorization server validates the committed client metadata; no third-party OAuth account, installed application or release-matrix acceptance. Public document bytes must be verified after normal Pages publication.']};
receipt.refreshExchanges=[];
let child,owned,browser,log,asOrigin,ownerToken='',cookie='';
const codes=new Map();let nextCode=0,registrationRequests=0;
function check(value,label){assert(value,label);receipt.cases.push(label);console.log(label);}
const digest=text=>createHash('sha256').update(text).digest('base64url');
function reply(res,status,data){res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(data));}
const fixture=createServer(async(req,res)=>{try{
  const url=new URL(req.url,asOrigin);
  if(url.pathname==='/disabled-telemetry'){req.resume();res.writeHead(204).end();return;}
  if(url.pathname.includes('oauth-protected-resource')){reply(res,200,{resource:asOrigin+'/mcp',authorization_servers:[asOrigin],scopes_supported:['read']});return;}
  if(url.pathname.includes('oauth-authorization-server')||url.pathname.includes('openid-configuration')){reply(res,200,{issuer:asOrigin,authorization_endpoint:asOrigin+'/authorize',token_endpoint:asOrigin+'/token',response_types_supported:['code'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],client_id_metadata_document_supported:true,authorization_response_iss_parameter_supported:true});return;}
  if(url.pathname==='/register'){registrationRequests++;reply(res,400,{error:'DCR intentionally unavailable'});return;}
  if(url.pathname==='/authorize'||url.pathname==='/approve'){
    const params=url.searchParams;
    assert.equal(params.get('client_id'),metadata.client_id);assert(metadata.redirect_uris.includes(params.get('redirect_uri')));assert.equal(params.get('code_challenge_method'),'S256');assert(params.get('state'));
    if(url.pathname==='/authorize'){
      res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<!doctype html><html><body><h1>Connect the local test app</h1><p>This consent page belongs to the controlled acceptance server.</p><form action="/approve">'+[...params].map(([key,value])=>'<input type="hidden" name="'+key+'" value="'+value.replaceAll('&','&amp;').replaceAll('"','&quot;')+'">').join('')+'<button type="submit">Allow</button></form></body></html>');return;
    }
    const code='controlled-code-'+(++nextCode);codes.set(code,{challenge:params.get('code_challenge'),redirect:params.get('redirect_uri')});
    const callback=new URL(params.get('redirect_uri'));callback.searchParams.set('code',code);callback.searchParams.set('state',params.get('state'));callback.searchParams.set('iss',asOrigin);
    res.writeHead(302,{location:callback.href}).end();return;
  }
  if(url.pathname==='/token'){
    let body='';for await(const bytes of req)body+=bytes;
    const params=new URLSearchParams(body);
    if(params.get('grant_type')==='refresh_token'){
      assert.equal(params.get('refresh_token'),'controlled-test-refresh');assert.equal(params.get('client_id'),metadata.client_id);assert(!params.has('client_secret'));assert(!req.headers.authorization);
      receipt.refreshExchanges.push({clientIdMatches:true,storedRefreshTokenVerified:true,clientSecretAbsent:true});reply(res,200,{access_token:'controlled-test-access-refreshed',refresh_token:'controlled-test-refresh',token_type:'bearer',expires_in:3600});return;
    }
    const code=codes.get(params.get('code'));
    assert(code,'A token exchange must use an issued, unconsumed code');assert.equal(params.get('grant_type'),'authorization_code');assert.equal(params.get('client_id'),metadata.client_id);assert.equal(params.get('redirect_uri'),code.redirect);assert.equal(digest(params.get('code_verifier')),code.challenge);assert(!params.has('client_secret'));assert(!req.headers.authorization);
    codes.delete(params.get('code'));receipt.tokenExchanges.push({clientIdMatches:true,stableRedirect:true,pkceVerified:true,clientSecretAbsent:true});
    reply(res,200,{access_token:'controlled-test-access-'+nextCode,refresh_token:'controlled-test-refresh',token_type:'bearer',expires_in:3600});return;
  }
  if(url.pathname==='/mcp'){
    if(!req.headers.authorization){res.writeHead(401,{'www-authenticate':'Bearer resource_metadata="'+asOrigin+'/.well-known/oauth-protected-resource"'}).end();return;}
    if(req.method!=='POST'){res.writeHead(req.method==='DELETE'?204:405).end();return;}
    let body='';for await(const bytes of req)body+=bytes;const rpc=JSON.parse(body);
    if(rpc.id===undefined){res.writeHead(202).end();return;}
    const result=rpc.method==='initialize'?{protocolVersion:rpc.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'Controlled CIMD acceptance',version:'1.0'}}:rpc.method==='tools/list'?{tools:[]}:rpc.method==='resources/list'?{resources:[]}:rpc.method==='resources/templates/list'?{resourceTemplates:[]}:{prompts:[]};
    reply(res,200,{jsonrpc:'2.0',id:rpc.id,result});return;
  }
  reply(res,404,{error:'Unknown controlled fixture route'});
}catch(error){receipt.fixtureError=error.message;reply(res,400,{error:'Controlled fixture rejected invalid OAuth input'});}});
async function request(route,body,{workspace='team-a',method,expected=[200],token=ownerToken}={}){
  const url=new URL(route,base);if(workspace)url.searchParams.set('workspace',workspace);
  const res=await fetch(url,{method:method??(body===undefined?'GET':'POST'),headers:{origin:base,'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...(cookie?{cookie}: {})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
  const raw=await res.text();let data;try{data=JSON.parse(raw);}catch{data={};}
  assert(expected.includes(res.status),route+' HTTP '+res.status+' '+JSON.stringify(data).slice(0,250));
  const savedCookie=res.headers.get('set-cookie');if(savedCookie)cookie=savedCookie.split(';')[0];return data;
}
async function start(config){
  const env=helper.fixtureRuntimeEnvironment({dataDir:profile,baseURL:base,fixtureUrl:asOrigin,sandboxPort:4201});
  Object.assign(env,{FLUJO_APP_ROOT:root,FLUJO_OWNER_AUTH_FILE:config.policyFile,FLUJO_OWNER_BOOTSTRAP_FILE:config.bootstrapFile,FLUJO_OWNER_BROWSER_ORIGIN:base,FLUJO_ENCRYPTION_SECRET_FILE:config.secretFile});
  child=fork(path.join(root,'scripts/persona-browser-acceptance/next-process.cjs'),['4200'],{cwd:root,env,silent:true,windowsHide:true});owned=helper.observeOwnedCandidate(child);receipt.epochs.push(owned.epoch);child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Owned app startup timeout')),60000);child.on('message',m=>{if(m?.type==='journey-server-ready'&&m.pid===child.pid){clearTimeout(timer);resolve();}});child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);reject(Error('Owned app exited '+code));});});
  if(!ownerToken){await request('/api/owner/bootstrap',undefined,{workspace:null});return;}
  for(let attempt=0;attempt<100;attempt++){
    const status=await request('/api/workspaces',undefined,{workspace:null,expected:[200,503]});
    if(status.code!=='WORKSPACE_LAYOUT_PREPARING'){assert(Array.isArray(status.workspaces),'Workspace readiness must return the actual stored namespaces');return;}
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  throw Error('Workspace migration did not finish within the startup deadline');
}
async function initiate(name){const result=await request('/api/oauth/initiate',{serverName:name});assert(result.authorizationUrl);return new URL(result.authorizationUrl);}
async function authorize(url){url.pathname='/approve';const res=await fetch(url,{redirect:'manual'});assert.equal(res.status,302);return new URL(res.headers.get('location'));}
async function callback(url,{method='GET',workspace,issuer}={}){
  if(workspace)url.searchParams.set('workspace',workspace);if(issuer!==undefined){if(issuer===null)url.searchParams.delete('iss');else url.searchParams.set('iss',issuer);}
  const res=await fetch(method==='POST'?base+'/api/oauth/callback':url,{method,redirect:'manual',headers:method==='POST'?{'content-type':'application/x-www-form-urlencoded',origin:asOrigin}:{},...(method==='POST'?{body:url.searchParams}:{}),signal:AbortSignal.timeout(30000)});
  assert.equal(res.status,307);return new URL(res.headers.get('location'));
}
try{
  await fs.mkdir(profile);const config=provisionOwnerBootstrap(authority,'cimd-pr1186-acceptance');config.secretFile=path.join(authority,'operator-secret');await fs.writeFile(config.secretFile,randomBytes(32).toString('base64url'),{flag:'wx',mode:0o600});
  await new Promise((resolve,reject)=>{fixture.once('error',reject);fixture.listen(0,'127.0.0.1',resolve);});asOrigin='http://127.0.0.1:'+fixture.address().port;
  log=createWriteStream(path.join(run,'journey-app-'+attempt+'.log'));await start(config);
  const pairing=(await fs.readFile(config.pairingTokenFile,'utf8')).trim();const enrolled=await request('/api/owner/bootstrap',{confirmOwnerEnrollment:true},{workspace:null,token:pairing,expected:[201]});ownerToken=enrolled.ownerToken;assert(ownerToken);check(cookie.startsWith('flujo-owner-local='),'Normal owner enrollment establishes the browser session');
  await request('/api/encryption/secure',{action:'initialize_default'},{workspace:'default-workspace'});await request('/api/workspaces',{name:'team-a'},{workspace:null,expected:[201]});await request('/api/encryption/secure',{action:'initialize_default'});await request('/api/init');
  for(const server of await request('/api/mcp/servers'))await request('/api/mcp/servers/'+encodeURIComponent(server.name),{disabled:true},{method:'PUT'});
  const settings=await request('/api/storage?key=speech_settings');await request('/api/storage',{key:'speech_settings',value:{...settings.value,telemetry:{enabled:false,notifyDaily:false},onboarding:{completed:true}}});
  await request('/api/mcp/servers',{name:'CIMD acceptance',transport:'streamable',serverUrl:asOrigin+'/mcp',headers:{},env:{},disabled:true,rootPath:'',_buildCommand:'',_installCommand:''},{expected:[201]});
  const first=await initiate('CIMD acceptance');check(first.searchParams.get('client_id')===metadata.client_id&&!first.searchParams.get('redirect_uri').includes('workspace'),'Built initiation selects CIMD with the published stable callback');
  const before=receipt.tokenExchanges.length;const changed=await authorize(new URL(first));changed.searchParams.set('state',changed.searchParams.get('state').replace('team-a','team-b'));
  const missingWorkspace=await fetch(changed,{redirect:'manual'});check(missingWorkspace.status===404&&receipt.tokenExchanges.length===before,'Unknown workspace state cannot create storage or exchange a token');
  const wrongIssuer=await callback(await authorize(new URL(first)),{issuer:asOrigin+'/wrong'});check(wrongIssuer.searchParams.get('oauth_error')==='invalid_issuer'&&receipt.tokenExchanges.length===before,'Issuer mismatch is refused before token exchange');
  const omittedIssuer=await callback(await authorize(new URL(first)),{issuer:null});check(omittedIssuer.searchParams.get('oauth_error')==='invalid_issuer','Required issuer omission is refused');
  const crossed=await callback(await authorize(new URL(first)),{workspace:'default-workspace'});check(crossed.searchParams.get('oauth_error')==='invalid_state'&&receipt.tokenExchanges.length===before,'Explicit conflicting workspace is refused without token exchange');
  const getCode=await authorize(new URL(first));const getResult=await callback(new URL(getCode));check(getResult.searchParams.get('oauth_success')==='CIMD acceptance'&&getResult.searchParams.get('workspace')==='team-a','GET callback returns success in the selected workspace');
  const replay=await callback(new URL(getCode));check(replay.searchParams.get('oauth_error')==='invalid_state'&&receipt.tokenExchanges.length===before+1,'Replayed GET callback makes no second token exchange');
  await request('/api/oauth/reset',{serverName:'CIMD acceptance'});
  const postCode=await authorize(await initiate('CIMD acceptance'));const postResult=await callback(new URL(postCode),{method:'POST'});check(postResult.searchParams.get('oauth_success')==='CIMD acceptance','Cross-origin form POST callback preserves the body and workspace');
  const postReplay=await callback(new URL(postCode),{method:'POST'});check(postReplay.searchParams.get('oauth_error')==='invalid_state'&&receipt.tokenExchanges.length===before+2,'Replayed POST callback makes no second token exchange');
  await helper.stopOwnedCandidate(owned);await start(config);const resumed=await request('/api/oauth/initiate',{serverName:'CIMD acceptance'});check(resumed.alreadyAuthorized===true,'Stored CIMD credentials survive application restart without new consent');
  const saved=await request('/api/storage?key=mcp_servers');const credentials=saved.value['CIMD acceptance'];check(credentials.oauthClientInformation?.ciphertext?.startsWith('v2:')&&credentials.oauthTokens?.ciphertext?.startsWith('v2:')&&!credentials.oauthState,'CIMD client and tokens persist encrypted with consumed state cleared');
  await request('/api/oauth/reset',{serverName:'CIMD acceptance'});const browserAuthorization=await initiate('CIMD acceptance');
  browser=await chromium.launch({headless:true,channel:'msedge'});receipt.browserVersion=browser.version();
  for(const width of [320,390]){
    const context=await browser.newContext({viewport:{width,height:844},locale:'en-US',timezoneId:'America/Bogota',reducedMotion:'reduce'});const [name,value]=cookie.split('=');await context.addCookies([{name,value,url:base}]);await context.addInitScript(()=>localStorage.setItem('flujo.locale','en'));const page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>receipt.browserErrors.push(e.message));
    await page.goto(width===320?browserAuthorization.href:base+'/mcp?workspace=team-a');
    if(width===320){await page.getByRole('button',{name:'Allow',exact:true}).click();await page.waitForURL(url=>url.origin===base&&url.pathname==='/mcp');await expect(page.getByText('CIMD acceptance',{exact:true}).first()).toBeVisible();check(true,'Real browser consent reaches the built callback and saved app');}
    await expect(page.getByText('CIMD acceptance',{exact:true}).first()).toBeVisible();check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),width+'px MCP page fits the viewport after sign-in');await page.screenshot({path:path.join(run,'cimd-'+width+'.png'),fullPage:true});await context.close();
  }
  check(registrationRequests===0,'CIMD-only authorization never attempts DCR');check(!receipt.fixtureError&&receipt.browserErrors.length===0,'Controlled protocol and phone journeys have no unexpected errors');receipt.passed=true;
}catch(error){receipt.passed=false;receipt.error=error.message;console.error(error);process.exitCode=1;}
finally{
  await browser?.close();if(owned&&!owned.epoch.completedAt)try{await helper.stopOwnedCandidate(owned);}catch(error){receipt.shutdownError=error.message;receipt.passed=false;process.exitCode=1;}
  await new Promise(resolve=>fixture.close(resolve));if(log)await new Promise(resolve=>log.end(resolve));receipt.finishedUtc=new Date().toISOString();receipt.elapsedSeconds=(Date.parse(receipt.finishedUtc)-Date.parse(receipt.startedUtc))/1000;receipt.registrationRequests=registrationRequests;receipt.cleanupTargets=[profile,authority,path.join(run,'journey-app-'+attempt+'.log')];await fs.writeFile(path.join(run,'journey-'+attempt+'.json'),JSON.stringify(receipt,null,2));await fs.writeFile(path.join(run,'journey.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({passed:receipt.passed,cases:receipt.cases.length,exchanges:receipt.tokenExchanges.length,error:receipt.error,epochs:receipt.epochs}));
}

