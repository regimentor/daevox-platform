import os,pathlib,tempfile,subprocess,json,time,urllib.request,socket,shutil
repo=pathlib.Path(__file__).resolve().parents[3];root=pathlib.Path(tempfile.mkdtemp(prefix='daevox-sse-stress-'))
(root/'vendor').mkdir();(root/'vendor/llama.cpp').symlink_to(repo/'apps/core/vendor/llama.cpp',target_is_directory=True)
(root/'tools').mkdir();compiler=root/'tools/cmake';compiler.write_text("#!/usr/bin/python3\nimport sys,time\nfor i in range(6000):\n print('x'*8190,flush=True);time.sleep(.001)\nprint('slow-consumer-end',flush=True)\nsys.exit(1)\n");compiler.chmod(0o755)
env=dict(os.environ,CORE_PORT='0',CORE_AUTO_BUILD='0',CORE_APP_DIR=str(root),CORE_WEB_ORIGIN='http://localhost:5173',PATH=str(root/'tools')+':'+os.environ['PATH'])
core=subprocess.Popen([str(repo/'apps/core/target/debug/core')],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
def api(path,body=None):
 req=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json','Idempotency-Key':'sse-stress'})
 with urllib.request.urlopen(req,timeout=15) as r:return json.load(r)
try:
 line=core.stderr.readline();assert line.startswith('Core listening on '),line;base=line.strip().split('Core listening on ')[1];port=int(base.rsplit(':',1)[1])
 slow=socket.socket();slow.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,1024);slow.settimeout(15);slow.connect(('127.0.0.1',port));slow.sendall(f'GET /events HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: text/event-stream\r\n\r\n'.encode())
 start=b''
 while b'event: snapshot' not in start:start+=slow.recv(4096)
 op=api('/builds',{'profile':'cpu','jobs':2,'clean':False})['operation_id']
 time.sleep(5)
 began=time.monotonic();assert api('/health')['status']=='ok';health_ms=(time.monotonic()-began)*1000
 assert health_ms<1000,health_ms
 slow.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,2*1024*1024)
 received=b'';deadline=time.monotonic()+20
 while b'event: gap' not in received and time.monotonic()<deadline:
  received=(received+slow.recv(65536))[-4*1024*1024:]
 assert b'event: gap' in received,'Slow consumer must receive an explicit gap'
 gap=received.index(b'event: gap');after=received[gap:]
 while b'event: snapshot' not in after:after+=slow.recv(65536)
 slow.close()
 for i in range(100):
  operation=api('/operations/'+op)
  if operation['status']=='failed':break
  time.sleep(.1)
 assert operation['status']=='failed',operation
 logs=api('/logs?query=slow-consumer-end');assert logs['entries']
 print(json.dumps({'result':'passed','health_latency_ms':round(health_ms,2),'slow_consumer':'gap then snapshot','producer':'completed despite unread socket','persistent_log':'end marker retained'}))
finally:
 core.terminate()
 try:core.wait(timeout=10)
 except subprocess.TimeoutExpired:core.kill();core.wait()
 shutil.rmtree(root)
