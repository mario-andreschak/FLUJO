import ctypes, ctypes.wintypes as w, hashlib, json, pathlib, subprocess, time, sys
BASE=pathlib.Path(sys.argv[2]).resolve()
ROOT=pathlib.Path(sys.argv[1]).resolve()
NODE=r'C:\Users\Moe\.codex\visualizations\2026\10\04\01a104bf-7f72-79e1-bc69-79d9feea3560\phase1-78-68c86e2c\node-v22.23.3\node.exe'
paths=['src/frontend/components/Chat/ModelTurnInspector.tsx', 'src/frontend/components/Chat/ModelTurnJsonPreview.tsx', 'src/frontend/components/Chat/modelTurnJsonPage.ts', 'src/frontend/components/Chat/modelTurnDetailCache.ts', 'src/frontend/services/chat/index.ts', 'src/frontend/services/chat/modelTurnInspection.ts', 'src/frontend/components/Chat/index.tsx', 'src/backend/execution/flow/modelTurnSnapshotChunks.ts', 'src/backend/execution/flow/modelTurnSnapshotResponse.ts', 'src/backend/execution/flow/modelTurnArchive.ts', 'src/app/v1/chat/conversations/[conversationId]/model-turns/[dispatchId]/route.ts']
hashes={p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in paths}
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
assert subprocess.check_output(['git','status','--porcelain'],cwd=ROOT,text=True).strip()==''
manifest=json.loads((BASE/'bundle-source.json').read_text())
assert manifest['head']==head and manifest['sourceHashes']==hashes
assert hashlib.sha256((BASE/'bundle.js').read_bytes()).hexdigest()==manifest['bundleSha256']
class Counters(ctypes.Structure):
    _fields_=[('cb',w.DWORD),('PageFaultCount',w.DWORD)]+[(n,ctypes.c_size_t) for n in ['PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage','QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage']]
kernel=ctypes.WinDLL('kernel32',use_last_error=True);psapi=ctypes.WinDLL('psapi',use_last_error=True)
kernel.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];kernel.OpenProcess.restype=w.HANDLE;kernel.CloseHandle.argtypes=[w.HANDLE]
psapi.GetProcessMemoryInfo.argtypes=[w.HANDLE,ctypes.POINTER(Counters),w.DWORD]
kernel.TerminateProcess.argtypes=[w.HANDLE,w.UINT]
pidfile=BASE/'browser-pids.json'
if pidfile.exists():pidfile.unlink()
start=time.monotonic();peak_renderer=0;peak_backend=0;peak_browser_total=0;stopped=None;owned=set()
with open(BASE/'stdout-supervised.log','wb') as out,open(BASE/'stderr-supervised.log','wb') as err:
    child=subprocess.Popen([NODE,'--max-old-space-size=128',str(pathlib.Path(__file__).resolve().parent/'run.cjs'),str(ROOT),str(BASE)],stdout=out,stderr=err,creationflags=subprocess.CREATE_NO_WINDOW)
    while child.poll() is None:
        try:processes=json.loads(pidfile.read_text())
        except (OSError,json.JSONDecodeError):processes=[]
        total=0
        for process in processes:
            handle=kernel.OpenProcess(0x0400|0x0010,False,process['id'])
            if not handle:continue
            try:
                c=Counters();c.cb=ctypes.sizeof(c)
                if psapi.GetProcessMemoryInfo(handle,ctypes.byref(c),c.cb):
                    if process['type']=='backend':peak_backend=max(peak_backend,c.PeakWorkingSetSize,c.WorkingSetSize)
                    else:total+=c.WorkingSetSize
                    owned.add(process['id'])
                    if process['type']=='renderer':peak_renderer=max(peak_renderer,c.PeakWorkingSetSize,c.WorkingSetSize)
            finally:kernel.CloseHandle(handle)
        peak_browser_total=max(peak_browser_total,total)
        if peak_renderer>512*1024*1024:stopped='renderer-512MiB-ceiling'
        if peak_backend>512*1024*1024:stopped='backend-512MiB-ceiling'
        if time.monotonic()-start>180:stopped='180-second-six-case-ceiling'
        if stopped:
            for pid in owned:
                handle=kernel.OpenProcess(0x0001,False,pid)
                if handle:
                    try:kernel.TerminateProcess(handle,1)
                    finally:kernel.CloseHandle(handle)
            child.kill();break
        time.sleep(.02)
    child.wait(timeout=10)
result=dict(head=head,sourceHashes=hashes,rendererHeapMiB=128,rendererRssCeilingMiB=512,explicitGC=False,exit=child.returncode,stopped=stopped,peakRendererRss=peak_renderer,backendHeapMiB=384,backendRssCeilingMiB=512,peakBackendRss=peak_backend,peakAllBrowserProcessRss=peak_browser_total,elapsedSeconds=round(time.monotonic()-start,3),stdout=(BASE/'stdout-supervised.log').read_text(errors='replace'),stderr=(BASE/'stderr-supervised.log').read_text(errors='replace'))
(BASE/'supervised-result.json').write_text(json.dumps(result,indent=2))
assert child.returncode==0 and stopped is None,result
assert all(hashlib.sha256((ROOT/p).read_bytes()).hexdigest()==hashes[p] for p in paths)
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()==head
assert subprocess.check_output(['git','status','--porcelain'],cwd=ROOT,text=True).strip()==''
print(json.dumps(result))
