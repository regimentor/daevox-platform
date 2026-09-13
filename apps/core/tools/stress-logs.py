import os,pathlib,tempfile,subprocess,json,time,urllib.request,urllib.error,shutil
repo=pathlib.Path(__file__).resolve().parents[3]
root=pathlib.Path(tempfile.mkdtemp(prefix='daevox-log-stress-'))
(root/'vendor').mkdir();(root/'vendor/llama.cpp').symlink_to(repo/'apps/core/vendor/llama.cpp',target_is_directory=True)
(root/'tools').mkdir();compiler=root/'tools/cmake'
compiler.write_text('''#!/usr/bin/python3
import sys,time
print('rotation-start-sentinel',flush=True)
line='x'*8191+'\\n'
for i in range(230*128):
 sys.stdout.write(line);sys.stdout.flush();time.sleep(0.002)
print('rotation-end-sentinel',flush=True)
sys.exit(1)
''');compiler.chmod(0o755)
env=dict(os.environ,CORE_PORT='0',CORE_AUTO_BUILD='0',CORE_APP_DIR=str(root),CORE_WEB_ORIGIN='http://localhost:5173',PATH=str(root/'tools')+':'+os.environ['PATH'])
core=subprocess.Popen([str(repo/'apps/core/target/debug/core')],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
def api(path,body=None):
 req=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json','Idempotency-Key':'log-stress'})
 with urllib.request.urlopen(req,timeout=30) as response:return json.load(response)
try:
 line=core.stderr.readline();assert line.startswith('Core listening on '),line;base=line.strip().split('Core listening on ')[1]
 operation=api('/builds',{'profile':'cpu','jobs':8,'clean':False})['operation_id']
 first=None
 for i in range(100):
  logs=api('/logs?source=build')
  if logs['entries']:first=logs;break
  time.sleep(.02)
 assert first
 print(json.dumps({'stage':'running','root':str(root),'url':base,'first_segment':first['segments'][0]['id']}),flush=True)
 started=time.time()
 while time.time()-started<110:
  status=api('/operations/'+operation)['status']
  if status in ['failed','succeeded']:break
  time.sleep(.5)
 assert status=='failed',status
 time.sleep(1)
 logs=api('/logs?cursor='+first['cursor'])
 total=sum(segment['size_bytes'] for segment in logs['segments'])
 assert total<=200*1024*1024,total
 assert total>=190*1024*1024,total
 assert logs['gap'] is True
 assert any('rotation-end-sentinel' in entry['message'] for entry in logs['entries'])
 try:urllib.request.urlopen(base+'/logs/'+first['segments'][0]['id']+'/download');raise AssertionError('Old segment remained available')
 except urllib.error.HTTPError as error:assert error.code==404,error.code
 assert api('/health')['status']=='ok'
 print(json.dumps({'stage':'passed','elapsed_seconds':round(time.time()-started,2),'available_log_bytes':total,'segments':len(logs['segments']),'gap':logs['gap'],'old_segment_http':404,'health':'ok'}),flush=True)
finally:
 core.terminate()
 try:core.wait(timeout=10)
 except subprocess.TimeoutExpired:core.kill();core.wait()
 shutil.rmtree(root)
