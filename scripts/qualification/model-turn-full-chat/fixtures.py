import gzip, hashlib, json, pathlib, sys
BASE=pathlib.Path(sys.argv[1]).resolve()
FOLDER=BASE/'archives'/'conversation';FOLDER.mkdir(parents=True,exist_ok=True)
receipts=[];entries=[]
for mode in ['ascii','unicode','escaped','dense','wide','deep']:
    entry=dict(id=mode,conversationId='conversation',node={'nodeId':'node','nodeName':'Offline'},modelId='model',modelName='Offline',adapter='codex-cli' if mode in ['ascii','unicode','escaped'] else 'openai',operation='thread.runStreamed' if mode in ['ascii','unicode','escaped'] else 'chat.completions.create',timestamp=1,outcome='running',attempt=1,canonicalMessageCount=1,wireMessageCount=0,mediaCount=0,archiveVersion=2)
    entries.append(entry)
    header=json.dumps(dict(version=2,entry=entry,canonicalMessages=[dict(id='history',role='user',timestamp=1,content='complete '+('Ā🌍' * 200000))],genericWire=[],media=[]),separators=(',',':')).encode()[:-1]+b',"sdkRequest":'
    h=hashlib.sha256();written=0;file=FOLDER/f'{mode}.v2.json.gz'
    with gzip.open(file,'wb',compresslevel=1) as out:
        def write(data):
            global written
            out.write(data);h.update(data);written+=len(data)
        write(header)
        if mode in ['ascii','unicode','escaped']:
            write(b'{"input":"');suffix=b'","options":{"signal":"[AbortSignal]"}}}'
            unit=b'a' if mode=='ascii' else b'\xc4\x80' if mode=='unicode' else b'\\u0100'
            remaining=64*1024*1024-written-len(suffix);count=remaining//len(unit);padding=remaining-count*len(unit)
            block=unit*8192
            for _ in range(count//8192):write(block)
            write(unit*(count%8192)+b'a'*padding+suffix)
        elif mode=='dense':
            write(b'{"payload":[');suffix=b'{"a":0}]}}';unit=b'{"a":0},'
            count=(64*1024*1024-written-len(suffix))//len(unit)
            for _ in range(count//8192):write(unit*8192)
            write(unit*(count%8192)+suffix)
            write(b' '*(64*1024*1024-written))
        elif mode=='wide':
            write(b'{');suffix=b'"last":0}}';count=(64*1024*1024-written-len(suffix))//14
            for offset in range(0,count,4096):write(b''.join(f'"k{i:08d}":0,'.encode() for i in range(offset,min(count,offset+4096))))
            write(suffix);write(b' '*(64*1024*1024-written))
        else:
            write(b'{"payload":'+b'['*65000+b'true'+b']'*65000+b',"padding":"')
            suffix=b'"}}';remaining=64*1024*1024-written-len(suffix)
            for _ in range(remaining//65536):write(b'a'*65536)
            write(b'a'*(remaining%65536)+suffix)
    assert written==64*1024*1024
    receipts.append(dict(mode=mode,decodedBytes=written,sha256=h.hexdigest(),persistedSha256=hashlib.sha256(file.read_bytes()).hexdigest()))
(BASE/'fixture-receipts.json').write_text(json.dumps(receipts,indent=2));print(json.dumps(receipts))

(BASE/'timeline.json').write_text(json.dumps(entries),encoding='utf-8')
