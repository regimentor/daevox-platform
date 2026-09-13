"""Management contract source. Emits OpenAPI; TS is generated from that document."""
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
S = {'type': 'string'}
N = {'type': 'number'}
I = {'type': 'integer'}
B = {'type': 'boolean'}
U = {}
T = {'type': 'string', 'format': 'date-time'}
def ref(name): return {'$ref': '#/components/schemas/' + name}
def arr(item): return {'type': 'array', 'items': item}
def nullable(item): return {'anyOf': [item, {'type': 'null'}]}
def enum(*items): return {'type': 'string', 'enum': list(items)}
def obj(properties, optional=()): return {'type': 'object', 'properties': properties, 'required': [k for k in properties if k not in optional]}
D = {}
def dto(name, fields, optional=()): D[name] = obj(fields, optional); return ref(name)
error = dto('CoreError', {'code': S, 'message': S, 'retryable': B, 'details': U})
dto('ManagementError', {'error': error, 'request_id': S})
instance = dto('Instance', dict(id=S, model_set_id=S, preset_id=S, applied_preset_revision=S, build_id=S, started_at=T, ready_at=nullable(T), status=S))
recovery = dto('Recovery', dict(id=S, pid=I, reason=S, allowed_actions=arr(S)), ['pid'])
runtime = dto('RuntimeSnapshot', dict(session_id=S, state=enum('empty','ready','waiting','unloading','loading','error','recovery_required'), active_instance=nullable(instance), target=nullable(ref('SwitchRequest')), current_operation_id=nullable(S), current_build_id=nullable(S), last_selected_preset_id=nullable(S), inflight_requests=I, recovery=arr(recovery), revision=I, error=nullable(error)), ['error'])
settings = dto('Settings', dict(drain_timeout_ms={'type':'integer','minimum':1}, compiler_jobs={'type':'integer','minimum':1}, revision=S))
progress = dto('Progress', dict(bytes_done=nullable(I),bytes_total=nullable(I),bytes_per_second=nullable(N),percent=nullable(N),file_id=nullable(S)))
operation = dto('Operation', dict(id=S,type=enum('build','build_apply','runtime_switch','download','build_delete','model_set_delete','recovery'),status=enum('queued','running','paused','succeeded','failed','cancelled','interrupted'),phase=S,resource_id=nullable(S),created_at=T,updated_at=T,progress=nullable(progress),error=nullable(error),allowed_actions=arr(S),cancel_requested=B,pause_requested=B,queued_at=I), ['cancel_requested','pause_requested','queued_at'])
accepted = dto('Accepted', dict(operation_id=S,model_set_id=S), ['model_set_id'])
diagnostic = dto('Diagnostic', dict(severity=enum('error','warning'),code=S,message=S,line=nullable(I),key=nullable(S)))
source = dto('PresetSource', dict(id=S,name=S,revision=S,text=S,diagnostics=arr(diagnostic)))
preset = dto('Preset', dict(id=S,source_file_id=S,model_set_id=nullable(S),saved_revision=S,applied_revision=nullable(S),can_launch=B,diagnostics=arr(diagnostic)))
catalog = dto('PresetCatalog', dict(files=arr(source),presets=arr(preset),revision=S))
role = enum('weights','shard','projector')
file = dto('ModelFile', dict(id=S,path=S,role=role,size_bytes=nullable(I),downloaded_bytes=I,availability=enum('downloading','available','missing','failed'),local_path=S,url=S,shared=B),['shared'])
model = dto('ModelSet',dict(id=S,repo_id=S,commit=S,files=arr(file),availability=enum('downloading','available','missing','failed'),download_operation_id=nullable(S),preset_ids=arr(S)))
refs = dto('ModelReferences',dict(model_set_id=S,revision=S,preset_ids=arr(S),files=arr(obj(dict(file_id=S,shared_with=arr(S),will_delete=B)))))
build = dto('Build',dict(id=S,profile=enum('cuda','cpu'),jobs=I,status=enum('building','ready','failed','cancelled','interrupted'),checks={'anyOf':[obj(dict(router_health=B,devices=S,inference=enum('not_checked','passed','failed'),driver_version=nullable(S),driver_compatibility=enum('passed','failed'),compatibility_error=nullable(S)),['driver_version','driver_compatibility','compatibility_error']),arr(U)]},current=B,previous=B,commit=S,fingerprint=S,configuration=obj(dict(commit=S,profile=S,cmake=S,compiler=S,cache=S,devices=S))),['commit','fingerprint','configuration'])
metric = dto('MetricValue',dict(value=nullable(N),unit=S,availability=enum('available','unsupported','error'),sampled_at=T,last_success_at=nullable(T),reason=nullable(S)))
gpu = dto('GpuSample',dict(id=nullable(S),uuid=nullable(S),pci=nullable(S),nvml_index=I,cuda_index=nullable(I),name=nullable(S),utilisation=metric,vram_used=metric,vram_total=metric,temperature=metric,power=metric,fan=metric))
request_metric = dto('RequestMetric',dict(request_id=S,instance_id=S,preset_id=S,applied_revision=S,build_id=S,ttft_ms=nullable(N),duration_ms=N,tokens_per_second=nullable(N),prompt_tokens=nullable(I),completion_tokens=nullable(I),source=S,timestamp=T,status=enum('succeeded','failed','cancelled')))
inference_metric = dto('InferenceMetrics',dict(succeeded=I,failed=I,cancelled=I,prompt_tokens=I,completion_tokens=I,last_request=nullable(request_metric)))
process_metric = dto('ProcessMetric',dict(pid=I,role=enum('core','owned'),cpu=metric,ram=metric,gpu_memory=arr(obj(dict(gpu_id=nullable(S),memory=metric)))))
sample = dto('MetricSample',dict(session_id=S,timestamp=T,processes=arr(process_metric),inference=inference_metric,cpu=obj(dict(total=metric,logical=arr(obj(dict(name=S,usage=metric,frequency=metric))),temperatures=arr(obj(dict(name=S,temperature=metric))))),ram=obj(dict(total=metric,used=metric,swap_total=metric,swap_used=metric)),gpus=arr(gpu),gpu_availability=enum('available','unsupported','error')))
log = dto('LogEntry',dict(id=S,source=S,stream=S,timestamp=T,level=nullable(S),build_id=nullable(S),operation_id=nullable(S),instance_id=nullable(S),message=S,truncated=B,dropped_before=I))
logs = dto('Logs',dict(entries=arr(log),segments=arr(obj(dict(id=S,size_bytes=I))),cursor=nullable(S),gap=B))
snapshot = dto('EventSnapshot',dict(runtime=runtime,settings=settings,operations=arr(operation),catalog_revisions=obj(dict(presets=nullable(S),builds=S,model_sets=S))))
catalog_revisions = dto('CatalogRevisions',dict(presets=nullable(S),builds=S,model_sets=S))
event_payloads = {'snapshot':snapshot,'runtime.changed':runtime,'operation.changed':arr(operation),'catalog.changed':{'anyOf':[settings,catalog_revisions]},'preset.changed':obj(dict(revision=nullable(S))),'build.changed':obj(dict(revision=S)),'metric.sample':sample,'log.append':log,'gap':obj(dict(reason=S))}
D['EventEnvelope']={'oneOf':[obj(dict(session_id=S,seq=I,type=enum(kind),timestamp=T,payload=payload)) for kind,payload in event_payloads.items()],'discriminator':{'propertyName':'type'}}
dto('SwitchRequest',dict(preset_id=nullable(S),preset_revision=S),['preset_revision'])
dto('BuildRequest',dict(profile=enum('cuda','cpu'),jobs={'type':'integer','minimum':1},clean=B),['clean'])
dto('CreateSource',dict(name=S,text=S))
dto('SaveSource',dict(text=S,base_revision=S,overwrite=B))
dto('RevisionRequest',dict(revision=S))
dto('DownloadRequest',dict(repo_id=S,commit=S,files=arr(obj(dict(path=S,role=role)))))
dto('RestartFileRequest',dict(file_id=S))
dto('HubModels',dict(models=arr(obj(dict(id=S,downloads=I,likes=I,tags=arr(S)),['downloads','likes','tags'])),cursor=nullable(S)))
dto('HubFiles',dict(repo_id=S,commit=S,files=arr(obj(dict(path=S,role=role,size_bytes=nullable(I))))))
paths = {}
def endpoint(path, method, name, response, body=None, status=200, query=(), media='application/json'):
    operation = {'operationId':name,'responses':{str(status):{'description':'Success','content':{media:{'schema':response}}},'default':{'description':'Management error','content':{'application/json':{'schema':ref('ManagementError')}}}}}
    params=[]
    if '{id}' in path: params.append({'name':'id','in':'path','required':True,'schema':S})
    for q in query: params.append({'name':q,'in':'query','required':False,'schema':S})
    if method!='get': params.append({'name':'Idempotency-Key','in':'header','required':True,'schema':{'type':'string','minLength':1,'maxLength':256}})
    if path=='/events': params.append({'name':'Last-Event-ID','in':'header','required':False,'schema':S})
    if params: operation['parameters']=params
    if body: operation['requestBody']={'required':True,'content':{'application/json':{'schema':body}}}
    if status==204: operation['responses'][str(status)].pop('content')
    paths.setdefault(path,{})[method]=operation
endpoint('/health','get','health',obj(dict(status=S)))
endpoint('/runtime','get','runtime',runtime)
endpoint('/settings','get','settings',settings)
endpoint('/settings','put','saveSettings',settings,settings)
endpoint('/presets','get','presets',catalog)
endpoint('/preset-files','post','createSource',source,ref('CreateSource'),201)
endpoint('/preset-files/{id}','get','source',source)
endpoint('/preset-files/{id}','put','saveSource',source,ref('SaveSource'))
endpoint('/preset-files/{id}','delete','deleteSource',{'type':'null'},ref('RevisionRequest'),204)
endpoint('/runtime/switch','post','switchPreset',accepted,ref('SwitchRequest'),202)
endpoint('/operations','get','operations',obj(dict(operations=arr(operation),cursor=nullable(S))),query=['cursor'])
endpoint('/operations/{id}','get','operation',operation)
for action in ['cancel','force']: endpoint('/operations/{id}/'+action,'post',action+'Operation',accepted,status=202)
endpoint('/builds','get','builds',obj(dict(builds=arr(build))))
endpoint('/builds','post','createBuild',accepted,ref('BuildRequest'),202)
endpoint('/builds/{id}/apply','post','applyBuild',accepted,status=202)
endpoint('/builds/{id}','delete','deleteBuild',accepted,status=202)
endpoint('/recovery/{id}/stop','post','stopRecovery',accepted,status=202)
endpoint('/hub/models','get','hubModels',ref('HubModels'),query=['q','cursor'])
endpoint('/hub/files','get','hubFiles',ref('HubFiles'),query=['repo','revision'])
endpoint('/model-sets','get','modelSets',obj(dict(model_sets=arr(model))))
endpoint('/model-sets/{id}/references','get','modelReferences',refs)
endpoint('/model-sets/{id}','delete','deleteModelSet',accepted,ref('RevisionRequest'),202)
endpoint('/downloads','post','download',accepted,ref('DownloadRequest'),202)
for action in ['pause','resume','cancel']: endpoint('/downloads/{id}/'+action,'post',action+'Download',accepted,status=202)
endpoint('/downloads/{id}/restart-file','post','restartFile',accepted,ref('RestartFileRequest'),202)
endpoint('/metrics','get','metrics',obj(dict(samples=arr(sample))),query=['from','to'])
endpoint('/logs','get','logs',logs,query=['source','query','cursor'])
endpoint('/logs/{id}/download','get','downloadLog',S,media='application/x-ndjson')
endpoint('/events','get','events',ref('EventEnvelope'),media='text/event-stream')
endpoint('/openapi.json','get','openapi',U)
api={'openapi':'3.1.0','info':{'title':'Daevox core management','version':'0.1.0'},'servers':[{'url':'/core'}],'paths':paths,'components':{'schemas':D}}
(ROOT/'resources/openapi.json').write_text(json.dumps(api,ensure_ascii=False,indent=2)+'\n')
