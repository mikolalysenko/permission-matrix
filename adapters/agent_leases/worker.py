"""Untrusted-side driver: call the real CLI, wire socket, or MCP process."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys


def socket_call(address, request):
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(10)
        sock.connect(address)
        raw = request if isinstance(request, str) else json.dumps(request)
        sock.sendall(raw.encode() + b'\n')
        with sock.makefile('rb') as stream:
            return json.loads(stream.readline(2 * 1024 * 1024))


def command_call(address, request):
    op, params = request.get('operation'), request.get('params', {})
    argv = [sys.executable, '-m', 'agent_leases']
    # Valid calls exercise the friendly commands. Adversarial extra fields use
    # the public JSON command so the CLI cannot silently discard the probe.
    shapes = {'read_file': {'path'}, 'publish': {'files', 'message'},
              'open_pr': {'branch', 'title', 'body'}, 'comment': {'number', 'body'}}
    plain = isinstance(params, dict) and set(params) == shapes.get(op)
    if op == 'status' and set(request) == {'operation'}:
        argv += ['status', '--json']
    elif op == 'submit':
        body = request['request']
        if body['kind'] == 'ask':
            argv += ['ask', body['message']]
        else:
            argv += ['request', body['cap'], str(body['amount']), '--reason', body['message']]
        argv += ['--id', body['id'], '--json']
    elif op == 'poll':
        argv += ['wait', request['request_id'], '--poll', '--json']
    elif op == 'read_file' and plain and isinstance(params['path'], str) and not any(0xD800 <= ord(c) <= 0xDFFF for c in params['path']):
        argv += ['read', str(params['path']), '--json']
    elif op == 'publish' and plain and isinstance(params['message'], str) and isinstance(params['files'], dict) and params['files'] and all(
            isinstance(content, str) and isinstance(name, str) and '..' not in name.split('/')
            and not name.startswith('/') for name, content in params['files'].items()) and not any(
            a.startswith(b + '/') for a in params['files'] for b in params['files'] if a != b):
        for name, content in params['files'].items():
            file = Path(name)
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(content)
        argv += ['publish', *params['files'], '--message', params['message'], '--json']
    elif op == 'open_pr' and plain and all(isinstance(v, str) for v in params.values()):
        argv += ['pr', str(params['branch']), '--title', str(params['title']), '--body', str(params['body']), '--json']
    elif op == 'comment' and plain and type(params['number']) is int and isinstance(params['body'], str):
        argv += ['comment', str(params['number']), str(params['body']), '--json']
    else:
        argv += ['call', str(op), '--params', json.dumps(params)]
    if op != 'status' and 'id' in request:
        argv += ['--id', str(request['id'])]
    argv += ['--socket', address]
    process = subprocess.run(argv, capture_output=True, text=True, timeout=15)
    try:
        result = json.loads(process.stdout)
    except ValueError:
        result = {'ok': False, 'error': {'code': 'interface', 'rule': process.stderr.strip(), 'retryable': False}}
    return {'response': result, 'argv': argv, 'stdout': process.stdout,
            'stderr': process.stderr, 'exitCode': process.returncode}


def mcp_call(address, request):
    messages = [
        {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
            'protocolVersion': '2025-11-25', 'capabilities': {},
            'clientInfo': {'name': 'permission-matrix', 'version': '1'}}},
        {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
    ]
    if request.get('mcp_messages') is not None:
        messages += request['mcp_messages']
    else:
        op = request['operation']
        arguments = dict(request.get('params', {}))
        if op == 'submit':
            body = request['request']
            op = 'ask' if body['kind'] == 'ask' else 'request'
            arguments = {'message': body['message'], 'request_id': body['id']}
            if op == 'request':
                arguments.update(cap=body['cap'], amount=body['amount'])
        elif op == 'poll':
            arguments = {'id': request['request_id']}
        if 'id' in request:
            arguments['request_id'] = request['id']
        messages.append({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {
            'name': 'lease_' + op, 'arguments': arguments}})
    argv = [sys.executable, '-m', 'agent_leases', 'mcp', '--socket', address]
    process = subprocess.run(argv, input=''.join(json.dumps(m) + '\n' for m in messages),
                             capture_output=True, text=True, timeout=15)
    replies = [json.loads(line) for line in process.stdout.splitlines()]
    last = replies[-1] if replies else {}
    result = last.get('result', {}).get('structuredContent')
    if result is None:
        result = {'ok': False, 'error': {'code': 'interface', 'rule': last.get('error', {}), 'retryable': False}}
    return {'response': result, 'argv': argv, 'messages': messages, 'replies': replies,
            'stdout': process.stdout, 'stderr': process.stderr, 'exitCode': process.returncode}


def run(path, address, request):
    if path == 'cli':
        return command_call(address, request)
    if path == 'mcp':
        return mcp_call(address, request)
    return {'response': socket_call(address, request), 'request': request, 'exitCode': 0}


if __name__ == '__main__':
    spec = json.loads(Path(sys.argv[1]).read_text())
    print(json.dumps(run(spec['path'], os.environ['LEASE_SOCKET'], spec['request'])))
