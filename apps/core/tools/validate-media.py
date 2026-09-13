import os,sys,subprocess,json
base={'llm_base_url':os.environ['CORE_VALIDATION_URL'],'llm_model':os.environ['CORE_VALIDATION_MODEL']}
for mode,body in [('context',{'source_transcript':{'segments':[{'text':'Hello, my name is Alex.'}]}}),('translation',{'phrases':[{'id':'p1','text':'Hello!'}]})]:
 env=dict(os.environ,PYTHONPATH='apps/transcription-backend/src')
 result=subprocess.run([sys.executable,'-m','transcription.voice_worker',mode],input=json.dumps({**base,**body})+'\n',text=True,capture_output=True,env=env,timeout=60)
 events=[json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
 responses=[event for event in events if event.get('event')=='llm.response']
 print(json.dumps({'mode':mode,'exit_code':result.returncode,'llm_responses':len(responses),'events':[{'kind':event.get('kind'),'event':event.get('event'),'code':event.get('code')} for event in events], 'responses':[{'object':json.loads(event['raw']).get('object'),'finish_reason':json.loads(event['raw'])['choices'][0]['finish_reason'],'usage':json.loads(event['raw']).get('usage')} for event in responses]},ensure_ascii=False,indent=2))
 assert responses and all(json.loads(event['raw'])['choices'] for event in responses)
 assert result.returncode==0,result.stderr
