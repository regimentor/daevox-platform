"""Generate browser DTOs and methods exclusively from the published OpenAPI."""
import json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
api=json.loads((root/'resources/openapi.json').read_text())
def typ(schema):
    if '$ref' in schema:return schema['$ref'].split('/')[-1]
    if 'enum' in schema:return ' | '.join(json.dumps(v) for v in schema['enum'])
    for union in ['anyOf','oneOf']:
        if union in schema:return '('+' | '.join(typ(s) for s in schema[union])+')'
    t=schema.get('type')
    if t=='null':return 'null'
    if t=='string':return 'string'
    if t in ['integer','number']:return 'number'
    if t=='boolean':return 'boolean'
    if t=='array':return 'Array<'+typ(schema['items'])+'>'
    if t=='object':return '{ '+'; '.join(json.dumps(k)+('' if k in schema.get('required',[]) else '?')+': '+typ(v) for k,v in schema.get('properties',{}).items())+' }'
    return 'unknown'
lines=['// Generated from resources/openapi.json. Run npm run contract --workspace @daevox/core.']
for name,schema in api['components']['schemas'].items():lines.append('export type '+name+' = '+typ(schema)+';')
lines += ['''export class CoreApiError extends Error {
  constructor(public status: number, public body: ManagementError) { super(body.error.message); }
}
export class CoreClient {
  constructor(public baseUrl = '/core') {}
  private async request<T>(path: string, method: string, body?: unknown, key?: string): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      method, headers: { ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...(method === 'GET' ? {} : {'Idempotency-Key': key ?? crypto.randomUUID()}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const fallback: ManagementError = {error:{code:'network_error',message:response.statusText,retryable:true,details:null},request_id:''};
      const error: ManagementError = await response.json().catch(() => fallback);
      throw new CoreApiError(response.status, error);
    }
    return (response.status === 204 ? null : await response.json()) as T;
  }
''']
for path,methods in api['paths'].items():
    for method,operation in methods.items():
        name=operation['operationId']
        if name in ['events','downloadLog']:continue
        params=operation.get('parameters',[])
        args=[]; pathparams=[p for p in params if p['in']=='path'];queryparams=[p for p in params if p['in']=='query']
        for p in pathparams:args.append(p['name']+': string')
        schema=operation.get('requestBody',{}).get('content',{}).get('application/json',{}).get('schema')
        if schema:args.append('body: '+typ(schema))
        if queryparams:args.append('query: { '+ '; '.join(p['name']+'?: string' for p in queryparams)+' } = {}')
        if method!='get':args.append('key?: string')
        response=next(v for k,v in operation['responses'].items() if k!='default')
        result=response.get('content',{}).get('application/json',{}).get('schema',{'type':'null'})
        route=path
        for p in pathparams:route=route.replace('{'+p['name']+'}','${encodeURIComponent('+p['name']+')}')
        route='`'+route+'`'
        if queryparams:route+=' + "?" + new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined))'
        lines.append('  '+name+'('+', '.join(args)+'): Promise<'+typ(result)+'> { return this.request('+route+', '+json.dumps(method.upper())+', '+('body' if schema else 'undefined')+', '+('key' if method!='get' else 'undefined')+'); }')
lines.append('}')
(root/'generated').mkdir(exist_ok=True)
(root/'generated/client.ts').write_text('\n'.join(lines)+'\n')
