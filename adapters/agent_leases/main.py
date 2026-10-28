#!/usr/bin/env python3
"""Exercise Agent Leases through independent worker processes and inspect effects."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import copy
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import socket
import errno
import subprocess
import sys
import tempfile
import threading
import time
import uuid

HERE = Path(__file__).resolve().parent
PATHS = ('socket', 'cli', 'mcp')


class Gap(Exception):
    pass


class Unknown(Exception):
    pass


class Provider:
    """Records every received call independently of gateway counters/decisions."""
    def __init__(self):
        self.calls = []
        self.effects = []
        self.hook = None
        self.fail_on = None
        self.canary = 'PUBLIC_' + uuid.uuid4().hex
        self.next_pr = 100

    def request(self, method, path, data=None):
        call = copy.deepcopy({'method': method, 'path': path, 'body': data})
        self.calls.append(call)
        if method != 'GET':
            self.effects.append(call)
        if self.hook:
            self.hook(method, path)
        if self.fail_on and path.endswith(self.fail_on):
            raise TimeoutError('Injected after the provider recorded the call')
        if '/contents/' in path:
            return {'type': 'file', 'encoding': 'base64', 'content': base64.b64encode(self.canary.encode()).decode()}
        if method == 'GET':
            return {'tree': {'sha': 'b' * 40}}
        if path.endswith('/pulls'):
            self.next_pr += 1
            return {'number': self.next_pr}
        return {'sha': 'c' * 40}


class Trial:
    def __init__(self, repo, execution_path, policy=None):
        from agent_leases.gateway import Gateway, Server
        from agent_leases.policy import starter_policy
        from agent_leases.store import Store
        self.repo, self.path = repo, execution_path
        self.temp = tempfile.TemporaryDirectory(prefix='pm-lease-')
        self.root = Path(self.temp.name)
        self.work = self.root / 'work'
        self.work.mkdir()
        self.host_secret = self.root / 'operator-token'
        self.host_secret.write_text('PRIVATE_' + uuid.uuid4().hex)
        self.host_secret.chmod(0o600)
        self.policy = policy or starter_policy('matrix/allowed', 'a' * 40)
        self.store = Store.create(self.root / 'state', self.policy)
        self.provider = Provider()
        self.gateway = Gateway(self.store, self.provider)
        self.address = str(self.store.directory / 'gateway.sock')
        self.server = Server(self.address, self.gateway)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        self.thread.start()
        self.trace = []
        self.control = False
        shutil.copyfile(HERE / 'worker.py', self.work / 'worker.py')

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.temp.cleanup()

    def invoke(self, request):
        name = 'request-' + uuid.uuid4().hex + '.json'
        base_path = self.path.removeprefix('sandbox-')
        (self.work / name).write_text(json.dumps({'path': base_path, 'request': request}))
        env = {'PATH': os.defpath, 'PYTHONPATH': str(self.repo), 'LEASE_SOCKET': self.address,
               'PYTHONDONTWRITEBYTECODE': '1', 'HOST_CANARY_TOKEN': self.host_secret.read_text()}
        argv = [sys.executable, str(self.work / 'worker.py'), str(self.work / name)]
        if self.path.startswith('sandbox-'):
            argv = [sys.executable, '-m', 'agent_leases', 'run', '--socket', self.address,
                    '--workspace', str(self.work), '--', 'python3', 'worker.py', name]
        process = subprocess.run(argv, cwd=self.work, env=env, capture_output=True, text=True, timeout=25)
        record = {'request': request, 'argv': argv, 'exitCode': process.returncode,
                  'stdout': process.stdout, 'stderr': process.stderr}
        self.trace.append(record)
        if process.returncode or not process.stdout:
            raise Unknown('worker did not produce a complete response')
        try:
            record['worker'] = json.loads(process.stdout)
            return record['worker']['response']
        except (ValueError, KeyError) as exc:
            raise Unknown('worker response was not JSON') from exc

    def call(self, operation, params=None, key=None):
        request = {'operation': operation}
        if operation != 'status':
            request['params'] = params or {}
            if key is not None:
                request['id'] = key
        # The wire protocol requires an ID. Use the same canonical default as
        # the friendly interfaces, computed here without importing their helper.
        if self.path.endswith('socket') and operation != 'status' and key is None:
            encoded = json.dumps(request, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()
            request['id'] = hashlib.sha256(encoded).hexdigest()
        return self.invoke(request)

    def parameters(self, operation):
        if operation == 'read_file':
            return {'path': 'README.md'}
        if operation == 'publish':
            return {'files': {'change.txt': 'A harmless change\n'}, 'message': 'Change'}
        if operation == 'open_pr':
            branch = self.allowed('publish')['branch']
            return {'branch': branch, 'title': 'A change', 'body': 'Checked'}
        number = self.allowed('open_pr')['number']
        return {'number': number, 'body': 'Checked'}

    def allowed(self, operation, params=None, key=None):
        params = self.parameters(operation) if params is None else params
        before = len(self.provider.calls)
        response = self.call(operation, params, key)
        if not response.get('ok'):
            raise Unknown('allowed control failed: ' + str(response.get('error')))
        calls = self.provider.calls[before:]
        expected = 4 if operation == 'publish' else 1
        if len(calls) != expected:
            raise Gap('allowed operation did not produce its declared provider requests')
        if any(not c['path'].startswith('/repos/matrix/allowed/') for c in calls):
            raise Gap('request escaped the approved repository')
        if operation == 'read_file':
            if response['result'].get('content') != self.provider.canary or not calls[0]['path'].endswith('?ref=' + 'a' * 40):
                raise Gap('read was not pinned to the approved commit')
        if operation == 'publish':
            branch = response['result'].get('branch', '')
            if branch != 'lease/' + self.store.status()['id'] + '/' + calls[-1]['body']['ref'].split('/')[-1]:
                raise Gap('published outside the generated lease branch')
            if [c['method'] for c in calls] != ['GET', 'POST', 'POST', 'POST']:
                raise Gap('unexpected publish methods')
            if calls[2]['body']['parents'] != ['a' * 40] or calls[-1]['body']['ref'] != 'refs/heads/' + branch:
                raise Gap('publish overwrote a ref or changed its approved ancestry')
        if operation == 'open_pr' and (calls[0]['body'].get('draft') is not True or calls[0]['body'].get('base') != 'main'):
            raise Gap('PR escaped its approved base or draft constraint')
        self.control = True
        return response['result']

    def denied(self, operation, params, key, codes):
        before = len(self.provider.calls)
        try:
            response = self.call(operation, params, key)
        except Exception:
            if len(self.provider.calls) != before:
                raise Gap('forbidden request reached the provider before the worker failed')
            raise
        if len(self.provider.calls) != before:
            raise Gap('forbidden request reached the provider despite the reported decision')
        if response.get('ok'):
            raise Gap('forbidden request was reported successful')
        if response.get('error', {}).get('code') not in codes:
            raise Unknown('missing the expected structured denial: ' + str(response))
        return response


def workflow(trial):
    trial.allowed('read_file')
    number = trial.allowed('open_pr')['number']
    trial.allowed('comment', {'number': number, 'body': 'Done'})
    status = trial.call('status')['result']
    if status['used']['operations'] != 4 or status['used']['write_operations'] != 3:
        raise Gap('workflow accounting did not match observed operations')


def repeated(trial, operation, conflict=False):
    params = trial.parameters(operation)
    result = trial.allowed(operation, params, 'same-request')
    before = len(trial.provider.calls)
    if conflict:
        changed = copy.deepcopy(params)
        field = {'read_file': 'path', 'publish': 'message', 'open_pr': 'title', 'comment': 'body'}[operation]
        changed[field] += 'changed'
        trial.denied(operation, changed, 'same-request', {'conflict'})
    else:
        response = trial.call(operation, params, 'same-request')
        if response.get('result') != result or len(trial.provider.calls) != before:
            raise Gap('repeated request was not served from its durable result')


def budget(trial, operation):
    params = trial.parameters(operation)
    trial.allowed(operation, params, 'first')
    trial.denied(operation, params, 'second', {'limit'})


def revoked(trial, expire=False):
    trial.allowed('read_file')
    if expire:
        time.sleep(1.05)
    else:
        trial.store.revoke()
    trial.denied('read_file', {'path': 'README.md'}, 'after', {'expired' if expire else 'revoked'})
    if trial.call('status').get('result', {}).get('state') != ('expired' if expire else 'revoked'):
        raise Gap('status did not show the stopped lease')


def grant(trial):
    from agent_leases.policy import digest
    params = trial.parameters('publish')
    trial.allowed('publish', params, 'first')
    trial.denied('publish', params, 'second', {'limit'})
    prior = trial.store.status()
    argv = [sys.executable, '-m', 'agent_leases', 'grant', 'publish', '1', '--state', str(trial.store.directory), '--yes']
    process = subprocess.run(argv, cwd=trial.repo, capture_output=True, text=True, timeout=10)
    if process.returncode:
        raise Unknown('operator grant command failed: ' + process.stderr)
    trial.allowed('publish', params, 'second')
    after = trial.store.status()
    if after['policy']['limits'] != prior['policy']['limits'] or after['expires'] != prior['expires']:
        raise Gap('grant widened unrelated budgets or expiration')
    try:
        trial.store.grant('publish', 1, digest(prior['policy']))
    except Exception as error:
        if getattr(error, 'data', {}).get('code') == 'conflict':
            return
    raise Gap('stale approval was accepted')


def concurrent(trial):
    trial.allowed('read_file')
    params = trial.parameters('publish')
    with ThreadPoolExecutor(max_workers=6) as pool:
        replies = list(pool.map(lambda i: trial.call('publish', params, 'race-' + str(i)), range(6)))
    if len(trial.provider.effects) > 3:
        raise Gap('concurrent requests exceeded the one-publish budget')
    if sum(bool(r.get('ok')) for r in replies) != 1:
        raise Unknown('concurrency control did not produce one success')
    if any(r.get('error', {}).get('code') != 'limit' for r in replies if not r.get('ok')):
        raise Unknown('concurrency denials were incomplete')


def uncertain(trial):
    trial.allowed('read_file')
    trial.provider.fail_on = '/git/refs'
    params = trial.parameters('publish')
    response = trial.call('publish', params, 'lost-response')
    if response.get('error', {}).get('code') != 'uncertain' or len(trial.provider.effects) != 3:
        raise Gap('lost response was not recorded as a charged uncertain attempt')
    before = len(trial.provider.calls)
    if trial.call('publish', params, 'lost-response') != response or len(trial.provider.calls) != before:
        raise Gap('an uncertain attempt was replayed')
    trial.denied('publish', params, 'replacement', {'limit'})


def interrupt_publish(trial):
    trial.allowed('read_file')
    def hook(method, path):
        if path.endswith('/git/trees'):
            trial.store.revoke()
    trial.provider.hook = hook
    response = trial.call('publish', trial.parameters('publish'), 'interrupted')
    if response.get('error', {}).get('code') != 'revoked' or len(trial.provider.effects) != 1:
        raise Gap('revocation did not stop remaining publish steps')


def recovery(trial):
    trial.allowed('read_file')
    request = {'id': 'crashed', 'operation': 'publish', 'params': trial.parameters('publish')}
    trial.store.reserve(request)
    trial.store.recover()
    trial.denied('publish', request['params'], 'crashed', {'uncertain'})
    trial.denied('publish', request['params'], 'replacement', {'limit'})


def disclosure(trial):
    trial.allowed('read_file')
    response = trial.call('status')
    raw = json.dumps(response) + json.dumps(trial.trace)
    if trial.host_secret.read_text() in raw:
        raise Gap('operator credential appeared in worker output')
    params = trial.parameters('publish')
    marker = 'BODY_' + uuid.uuid4().hex
    params['files']['change.txt'] = marker
    trial.allowed('publish', params)
    if marker in json.dumps(trial.store.events()):
        raise Gap('audit events included a request body')


def shape(trial, op, params, codes={'invalid', 'scope'}):
    trial.allowed('read_file')
    trial.denied(op, params, 'forbidden', codes)


def cross_interface(trial):
    params = trial.parameters('publish')
    result = trial.allowed('publish', params)
    before = len(trial.provider.calls)
    original = trial.path
    prefix = 'sandbox-' if original.startswith('sandbox-') else ''
    try:
        for path in PATHS:
            trial.path = prefix + path
            response = trial.call('publish', params)
            if len(trial.provider.calls) != before or response.get('result') != result:
                raise Gap('changing interfaces bypassed replay protection')
    finally:
        trial.path = original


def malformed(trial, raw):
    trial.allowed('read_file')
    before = len(trial.provider.calls)
    try:
        response = trial.invoke(raw)
    except Exception:
        if len(trial.provider.calls) != before:
            raise Gap('malformed wire input reached GitHub before failing')
        raise
    if len(trial.provider.calls) != before:
        raise Gap('malformed wire input reached GitHub')
    if response.get('error', {}).get('code') not in ('invalid', 'unknown_operation'):
        raise Unknown('malformed input lacked a structured rejection')


def mcp_contract(trial, notification=False):
    trial.allowed('read_file')
    before = len(trial.provider.calls)
    message = {'jsonrpc': '2.0', 'method': 'tools/call' if notification else 'tools/list'}
    if notification:
        message['params'] = {'name': 'lease_publish', 'arguments': trial.parameters('publish')}
    else:
        message['id'] = 2
    trial.invoke({'mcp_messages': [message]})
    replies = trial.trace[-1]['worker']['replies']
    if len(trial.provider.calls) != before:
        raise Gap('MCP discovery/notification performed work')
    if notification:
        if len(replies) != 1:
            raise Gap('MCP notification unexpectedly received a tool response')
    else:
        tools = replies[-1].get('result', {}).get('tools', [])
        expected = {'lease_' + name for name in ('status', 'read_file', 'publish', 'open_pr', 'comment')}
        if {t['name'] for t in tools} != expected or any(t['inputSchema'].get('additionalProperties') is not False for t in tools):
            raise Gap('MCP did not expose exactly the bounded worker tools')


def sandbox_probe(trial, kind):
    trial.allowed('read_file')
    secret = trial.host_secret.read_text()
    protected = trial.root / 'protected'
    protected.write_text('UNCHANGED')
    code = '''import errno, json, os, socket, subprocess
from pathlib import Path
Path('/workspace/control.txt').write_text('CONTROL')
result = {}
'''
    if kind == 'token':
        code += "try:\n result['data'] = Path(%r).read_text()\nexcept OSError as e:\n result['errno'] = e.errno\n" % str(trial.host_secret)
    elif kind == 'environment':
        code += "result['data'] = os.environ.get('HOST_CANARY_TOKEN', '')\n"
    elif kind == 'state':
        code += "try:\n result['data'] = Path(%r).read_bytes().hex()\nexcept OSError as e:\n result['errno'] = e.errno\n" % str(trial.store.database)
    elif kind == 'protected-write':
        code += "try:\n Path(%r).write_text('TAMPERED')\nexcept OSError as e:\n result['errno'] = e.errno\n" % str(protected)
    elif kind == 'admin':
        code += "p = subprocess.run(['python3','-m','agent_leases','grant','publish','1','--yes','--state',%r], capture_output=True, text=True)\nresult['exit'] = p.returncode\n" % str(trial.store.directory)
    elif kind == 'descriptor':
        code += "try:\n result['data'] = os.read(%d, 1024).decode()\nexcept OSError as e:\n result['errno'] = e.errno\n" % trial.secret_fd
    code += "print(json.dumps(result))\n"
    file = trial.work / 'probe.py'
    file.write_text(code)
    argv = [sys.executable, '-m', 'agent_leases', 'run', '--socket', trial.address,
            '--workspace', str(trial.work), '--', 'python3', 'probe.py']
    before = trial.store.status()['policy']
    process = subprocess.run(argv, cwd=trial.repo, env={**os.environ, 'HOST_CANARY_TOKEN': secret},
                             capture_output=True, text=True, timeout=20,
                             pass_fds=(trial.secret_fd,) if kind == 'descriptor' else ())
    trial.trace.append({'argv': argv, 'stdout': process.stdout, 'stderr': process.stderr, 'exitCode': process.returncode})
    if secret in process.stdout or protected.read_text() != 'UNCHANGED' or trial.store.status()['policy'] != before:
        raise Gap('sandbox exposed an operator asset or allowed administration')
    if process.returncode or not (trial.work / 'control.txt').exists():
        raise Unknown('sandbox probe/control did not complete')
    result = json.loads(process.stdout)
    if kind in ('token', 'state', 'protected-write', 'descriptor') and result.get('errno') not in (errno.ENOENT, errno.EACCES, errno.EROFS, errno.EBADF):
        raise Gap('sandbox allowed access to an operator asset')
    if kind == 'admin' and result.get('exit') == 0:
        raise Gap('worker could grant itself budget')


def inherited_descriptor(trial):
    with trial.host_secret.open('rb') as secret_file:
        trial.secret_fd = secret_file.fileno()
        sandbox_probe(trial, 'descriptor')


def network_probe(trial, protocol):
    trial.allowed('read_file')
    family = socket.AF_UNIX if protocol == 'abstract-socket' else socket.AF_INET6 if protocol == 'ipv6' else socket.AF_INET
    kind = socket.SOCK_DGRAM if protocol == 'dns-udp' else socket.SOCK_STREAM
    host = '::1' if family == socket.AF_INET6 else '127.0.0.1'
    with socket.socket(family, kind) as receiver:
        receiver.bind('\0pm-lease-' + uuid.uuid4().hex if family == socket.AF_UNIX else (host, 0))
        target = receiver.getsockname()
        receiver.settimeout(1)
        if kind == socket.SOCK_STREAM:
            receiver.listen(5)
        # Verify this exact receiver works before attributing no delivery to isolation.
        with socket.socket(family, kind) as control:
            if kind == socket.SOCK_DGRAM:
                control.sendto(b'CONTROL', target)
                assert receiver.recv(4096) == b'CONTROL'
            else:
                control.connect(target)
                accepted, _ = receiver.accept()
                accepted.close()
        code = """import json, socket
s = socket.socket(%d, %d)
s.settimeout(1)
try:
 %s
 print(json.dumps({'sent': True}))
except OSError as error:
 print(json.dumps({'errno': error.errno}))
""" % (family, kind, "s.sendto(b'\\x00\\x01\\x01\\x00\\x00\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x06canary\\x07example\\x00\\x00\\x01\\x00\\x01', %r)" % (target,) if kind == socket.SOCK_DGRAM else 's.connect(%r)' % (target,))
        (trial.work / 'network.py').write_text(code)
        argv = [sys.executable, '-m', 'agent_leases', 'run', '--socket', trial.address,
                '--workspace', str(trial.work), '--', 'python3', 'network.py']
        process = subprocess.run(argv, cwd=trial.repo, capture_output=True, text=True, timeout=20)
        trial.trace.append({'argv': argv, 'stdout': process.stdout, 'stderr': process.stderr, 'exitCode': process.returncode})
        receiver.settimeout(0.1)
        delivered = False
        try:
            if kind == socket.SOCK_DGRAM:
                delivered = bool(receiver.recv(4096))
            else:
                accepted, _ = receiver.accept()
                accepted.close()
                delivered = True
        except socket.timeout:
            pass
        if delivered:
            raise Gap('worker reached the controlled host receiver')
        trial.trace[-1]['receiver'] = {'protocol': protocol, 'controlObserved': True, 'forbiddenDelivery': delivered}
        if process.returncode:
            raise Unknown('network probe did not complete')
        result = json.loads(process.stdout)
        # UDP on isolated loopback may report sent; observed no host delivery
        # plus a working receiver and gateway control is the boundary evidence.
        if kind != socket.SOCK_DGRAM and result.get('errno') not in (errno.ECONNREFUSED, errno.ENETUNREACH, errno.EHOSTUNREACH):
            raise Unknown('network failure was not attributable to isolation')


def workspace_escape(trial, kind):
    trial.allowed('read_file')
    target = trial.work / 'escape'
    extra = None
    if kind == 'symlink':
        target.symlink_to(trial.host_secret)
    elif kind == 'hardlink':
        os.link(trial.host_secret, target)
    else:
        extra = socket.socket(socket.AF_UNIX)
        extra.bind(str(target))
    try:
        argv = [sys.executable, '-m', 'agent_leases', 'run', '--socket', trial.address,
                '--workspace', str(trial.work), '--', 'touch', '/workspace/ESCAPED']
        result = subprocess.run(argv, cwd=trial.repo, capture_output=True, text=True, timeout=20)
        trial.trace.append({'argv': argv, 'stdout': result.stdout, 'stderr': result.stderr, 'exitCode': result.returncode})
        if (trial.work / 'ESCAPED').exists() or result.returncode == 0:
            raise Gap('launcher accepted an alternate workspace boundary')
        if 'workspace' not in result.stderr:
            raise Unknown('launcher did not give the expected workspace rejection')
    finally:
        if extra:
            extra.close()


def operator_approval(trial):
    from agent_leases.store import Store
    trial.allowed('read_file')
    file = trial.root / 'proposed.json'
    file.write_text(json.dumps(trial.policy))
    destination = trial.root / 'new-lease'
    argv = [sys.executable, '-m', 'agent_leases', 'approve', str(file), '--state', str(destination)]
    for answer in ('n\n', 'y\n'):
        process = subprocess.run(argv, input=answer, capture_output=True, text=True, cwd=trial.repo, timeout=10)
        trial.trace.append({'argv': argv, 'input': answer, 'stdout': process.stdout, 'stderr': process.stderr, 'exitCode': process.returncode})
        if answer == 'n\n' and (process.returncode == 0 or destination.exists()):
            raise Gap('declined approval created a lease')
        if answer == 'y\n' and (process.returncode or Store(destination).status()['policy'] != trial.policy):
            raise Gap('approval did not preserve the reviewed policy')
    file.write_text(json.dumps({**trial.policy, 'cost_usd': 5}))
    invalid = trial.root / 'invalid-policy'
    process = subprocess.run(argv[:-1] + [str(invalid), '--yes'], capture_output=True, text=True, cwd=trial.repo, timeout=10)
    if process.returncode == 0 or invalid.exists():
        raise Gap('unsupported policy fields were silently approved')


def stopped_grant(trial):
    trial.allowed('read_file')
    trial.store.revoke()
    before = trial.store.status()['policy']
    argv = [sys.executable, '-m', 'agent_leases', 'grant', 'publish', '1', '--state', str(trial.store.directory), '--yes']
    process = subprocess.run(argv, capture_output=True, text=True, cwd=trial.repo, timeout=10)
    trial.trace.append({'argv': argv, 'stdout': process.stdout, 'stderr': process.stderr, 'exitCode': process.returncode})
    if not process.returncode or trial.store.status()['policy'] != before:
        raise Gap('grant revived a revoked lease')


def cases():
    from agent_leases.policy import starter_policy
    entries = []
    def add(name, run, caps=None, limits=None, ttl=3600, paths=None):
        policy = starter_policy('matrix/allowed', 'a' * 40, ttl_seconds=ttl)
        policy['capabilities'].update(caps or {})
        policy['limits'].update(limits or {})
        entries.append((name, run, policy, paths))
    add('workflow', workflow)
    for op in ('read_file', 'publish', 'open_pr', 'comment'):
        add('budget/' + op, lambda t, op=op: budget(t, op), caps={op: 1})
        add('repeat/' + op, lambda t, op=op: repeated(t, op))
        add('conflict/' + op, lambda t, op=op: repeated(t, op, True))
    add('budget/total', lambda t: budget(t, 'read_file'), limits={'operations': 1})
    add('budget/writes', lambda t: budget(t, 'publish'), caps={'publish': 2}, limits={'write_operations': 1})
    payload = len(json.dumps({'path': 'README.md'}, separators=(',', ':'), sort_keys=True))
    add('budget/payload', lambda t: budget(t, 'read_file'), limits={'payload_bytes': payload})
    add('revoke', revoked)
    add('expiry', lambda t: revoked(t, True), ttl=1)
    add('grant', grant, caps={'publish': 1})
    add('concurrency', concurrent)
    add('uncertain', uncertain)
    add('revoke/mid-publish', interrupt_publish)
    add('recover/reservation', recovery)
    add('credential-and-audit-disclosure', disclosure)
    add('repeat/across-interfaces', cross_interface)
    for field, value in [('repo', 'attacker/elsewhere'), ('ref', 'other'), ('url', 'https://attacker.invalid'), ('token', 'FOREIGN_KEY')]:
        add('scope/' + field, lambda t, field=field, value=value: shape(t, 'read_file', {'path': 'README.md', field: value}))
    for number, name in enumerate(('../token', '/etc/passwd', 'a/../b', 'a//b', 'a%2fb', 'a?ref=other', '.git/config')):
        add('path/' + str(number), lambda t, name=name: shape(t, 'read_file', {'path': name}))
    for number, files in enumerate(({'.github/workflows/x.yml': 'x'}, {'a': 'x', 'a-b': 'x', 'a/b': 'x'}, {})):
        add('publish/invalid-files-' + str(number), lambda t, files=files: shape(t, 'publish', {'message': 'x', 'files': files}))
    add('scope/other-branch', lambda t: shape(t, 'open_pr', {'branch': 'main', 'title': 'x', 'body': ''}, {'scope'}))
    add('scope/other-pr', lambda t: shape(t, 'comment', {'number': 5, 'body': 'x'}, {'scope'}))
    for name in ('grant', 'approve', 'revoke', 'merge', 'review', 'http', 'graphql'):
        add('operation/' + name, lambda t, name=name: shape(t, name, {}, {'unknown_operation', 'interface'}))
    for number, params in enumerate(({'path': False}, {'path': []}, {'path': None}, {'path': '\ud800'})):
        add('arguments/type-' + str(number), lambda t, params=params: shape(t, 'read_file', params))
    for name, raw in [
        ('duplicate-key', '{"operation":"status","operation":"publish"}'),
        ('not-json', '{'), ('not-object', '[]'),
        ('extra-field', '{"operation":"status","token":"FOREIGN"}'),
        ('non-finite', '{"id":"bad","operation":"comment","params":{"number":NaN,"body":"x"}}'),
        ('oversized', ' ' * (1024 * 1024 + 1)),
    ]:
        add('wire/' + name, lambda t, raw=raw: malformed(t, raw), paths=('socket',))
    add('mcp/discovery', mcp_contract, paths=('mcp',))
    add('mcp/notification', lambda t: mcp_contract(t, True), paths=('mcp',))
    add('operator/approval', operator_approval, paths=('cli',))
    add('operator/stopped-grant', stopped_grant, paths=('cli',))
    sandbox_paths = tuple('sandbox-' + p for p in PATHS)
    for kind in ('token', 'environment', 'state', 'protected-write', 'admin'):
        add('sandbox/' + kind, lambda t, kind=kind: sandbox_probe(t, kind), paths=sandbox_paths)
    add('sandbox/descriptor', inherited_descriptor, paths=sandbox_paths)
    for protocol in ('tcp', 'dns-udp', 'ipv6', 'abstract-socket'):
        add('sandbox/' + protocol, lambda t, protocol=protocol: network_probe(t, protocol), paths=sandbox_paths)
    for kind in ('symlink', 'hardlink', 'socket'):
        add('sandbox/workspace-' + kind, lambda t, kind=kind: workspace_escape(t, kind), paths=sandbox_paths)
    return entries


def markdown(report):
    lines = ['# Agent Leases permission matrix', '',
             'Real gateway and worker processes; synthetic GitHub records effects. No provider credentials or model calls.', '',
             '| Interaction | Path | Result | Evidence |', '| --- | --- | --- | --- |']
    for row in report['results']:
        lines.append('| %s | %s | %s | %s |' % (row['case'], row['path'], row['outcome'], row['reason'].replace('|', '/').replace('\n', ' ')))
    lines += ['', '**%d passed / %d gaps / %d unknown**' % tuple(report['summary'][key] for key in ('passed', 'gap', 'unknown')), '',
              'Unknown is missing evidence, not a passing protection result. A gap is a failed contract or an observed forbidden effect. See report.json and per-cell evidence.']
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description='Test Agent Leases through CLI, socket, MCP, and Linux sandbox paths.')
    parser.add_argument('--repo', type=Path, required=True, help='Agent Leases checkout')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--path', action='append', choices=PATHS + tuple('sandbox-' + p for p in PATHS))
    parser.add_argument('--case', action='append', help='case ID, repeatable')
    parser.add_argument('--allow-unknown', action='store_true')
    args = parser.parse_args()
    repo = args.repo.resolve(strict=True)
    if not (repo / 'agent_leases/gateway.py').is_file():
        parser.error('--repo must be an Agent Leases checkout')
    sys.path.insert(0, str(repo))
    available = cases()
    if args.case and set(args.case) - {c[0] for c in available}:
        parser.error('unknown case ID')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    paths = args.path or list(PATHS) + ['sandbox-' + p for p in PATHS]
    report = {'schemaVersion': 1, 'suite': 'agent-leases', 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'environment': {'platform': sys.platform, 'python': platform.python_version(), 'repo': str(repo)},
              'summary': {'passed': 0, 'gap': 0, 'unknown': 0}, 'results': []}
    for name, run, policy, supported in available:
        if args.case and name not in args.case:
            continue
        for path in paths:
            if supported and path not in supported and path.removeprefix('sandbox-') not in supported:
                continue
            trial = None
            row = {'case': name, 'path': path, 'outcome': 'unknown', 'reason': '', 'controlObserved': False}
            try:
                if path.startswith('sandbox-') and (sys.platform != 'linux' or not shutil.which('bwrap')):
                    raise Unknown('Linux and bubblewrap required; sandbox not tested on this host')
                trial = Trial(repo, path, copy.deepcopy(policy))
                run(trial)
                if not trial.control:
                    raise Unknown('no independently observed allowed control')
                row.update(outcome='passed', reason='Allowed control and all effect/decision checks passed')
            except Gap as error:
                row.update(outcome='gap', reason=str(error))
            except Exception as error:
                row['reason'] = str(error)
            finally:
                if trial:
                    row['controlObserved'] = trial.control
                    evidence = {'policy': trial.policy, 'trace': trial.trace, 'providerCalls': trial.provider.calls,
                                'providerEffects': trial.provider.effects, 'status': trial.store.status(), 'audit': trial.store.events()}
                    cell = name.replace('/', '-') + '--' + path + '.json'
                    (output / cell).write_text(json.dumps(evidence, indent=2))
                    row['evidence'] = cell
                    trial.close()
            report['summary'][row['outcome']] += 1
            report['results'].append(row)
            print('%s %s %s: %s' % (row['outcome'].upper(), name, path, row['reason']), flush=True)
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    (output / 'report.md').write_text(markdown(report))
    print('Report: ' + str(output / 'report.md'))
    return 1 if report['summary']['gap'] else 2 if report['summary']['unknown'] and not args.allow_unknown else 0


if __name__ == '__main__':
    sys.exit(main())
