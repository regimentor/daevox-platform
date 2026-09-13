#!/usr/bin/python3
"""External llama-server fixture; core is exercised only through its HTTP API."""
import os
import configparser
import http.server
import json
import pathlib
import subprocess
import sys
import threading
import time

if '--list-devices' in sys.argv:
    print('Available devices: CPU fixture')
    raise SystemExit(0)
print('router fixture starting', flush=True)
port = int(sys.argv[sys.argv.index('--port') + 1])
ini = pathlib.Path(sys.argv[sys.argv.index('--models-preset') + 1]).read_text()
config = configparser.ConfigParser(interpolation=None)
config.read_string('\n'.join(line for line in ini.splitlines() if not line.startswith('version')))
lock = threading.Lock()
active = None
child = None
ready_at = 0.0

class Handler(http.server.BaseHTTPRequestHandler):
    def reply(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            preset_path=pathlib.Path(sys.argv[sys.argv.index('--models-preset')+1])
            if preset_path.name == 'empty.ini' and (preset_path.parents[2]/'slow-apply').exists():
                print('fixture apply readiness captured', flush=True)
                time.sleep(0.4)
            if preset_path.name == 'probe.ini' and (preset_path.parents[3]/'slow-probe').exists():
                print('fixture probe waiting', flush=True)
                time.sleep(10)
            return self.reply(200, {'status': 'ok', 'pid': os.getpid()})
        if active and config[active].get('ctx-size') == '888':
            print('fixture readiness captured', flush=True)
            time.sleep(0.4)
        self.reply(200, {'data': [{'id': name, 'status': {'value': ('loaded' if time.monotonic() >= ready_at else 'loading') if active == name else 'unloaded'}} for name in config.sections()]})

    def do_POST(self):
        global active, child, ready_at
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        if self.path == '/models/load':
            with lock:
                if child is not None or body['model'] not in config:
                    return self.reply(409, {'error': {'message': 'conflict'}})
                active = body['model']
                ready_at = time.monotonic() + (0.5 if config[active].get('ctx-size') == '777' else 0)
                child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(3600)'])
                if config[active].get('ctx-size') == '666':
                    if os.environ.get('FIXTURE_NVML_STATE'):
                        pathlib.Path(os.environ['FIXTURE_NVML_STATE']).write_text(f'{child.pid} {time.time()+(12 if pathlib.Path(os.environ['FIXTURE_NVML_STATE']).with_name('slow-release').exists() else 0.8)}')
                    return self.reply(500, {'error': {'message': 'fixture load failure after child launch'}})
            return self.reply(200, {'success': True})
        if self.path == '/models/unload':
            with lock:
                if child:
                    if os.environ.get('FIXTURE_NVML_STATE'):
                        pathlib.Path(os.environ['FIXTURE_NVML_STATE']).write_text(f'{child.pid} {time.time()+(12 if pathlib.Path(os.environ['FIXTURE_NVML_STATE']).with_name('slow-release').exists() else 0.8)}')
                    child.terminate()
                    child.wait()
                child = None
                active = None
            return self.reply(200, {'success': True})
        if self.path == '/v1/chat/completions':
            if body.get('fixture_options'):
                return self.reply(200, {'options': dict(config[active])})
            if body.get('fixture_model_crash'):
                if child:
                    child.kill()
                    child.wait()
                active = None
                child = None
                return self.reply(503, {'error': {'message': 'model process exited'}})
            if body.get('fixture_log'):
                print(body['fixture_log'], flush=True)
            if body.get('fixture_crash'):
                os._exit(1)
            if active != body.get('model'):
                return self.reply(400, {'error': {'message': 'model is not loaded'}})
            if body.get('stream'):
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                self.wfile.write(b'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n')
                self.wfile.flush()
                if body.get('fixture_early_eof'):
                    return
                time.sleep(0.5)
                if body.get('fixture_timings'):
                    self.wfile.write(b'data: {"choices":[{"delta":{"content":"done"}}],"timings":{"prompt_n":7,"predicted_n":3,"predicted_per_second":12.5}}\n\n')
                self.wfile.write(b'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n')
                self.wfile.flush()
                return
            return self.reply(200, {'id': 'fixture-completion' , 'object': 'chat.completion', 'model': active, 'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': 'ctx=' + config[active].get('ctx-size', '0')}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}})
        self.reply(404, {'error': {'message': 'unknown route'}})

    def log_message(self, *_):
        pass

http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
