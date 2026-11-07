'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {ArcFix} = require('../plugins/arc-fix/arc-fix.js');
const {PluginHost} = require('../service/plugin-host.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetro-arc-fix-test-'));

// A fake root agent: the plugin only talks to the TV through execute().
function fakeAgent() {
    const agent = {runningPid: '', calls: [], connected: true};
    agent.execute = (cmd) => {
        agent.calls.push(cmd);
        if (!agent.connected) return Promise.reject(new Error('Root agent is not connected'));
        const decoded = Buffer.from(cmd.split('echo ')[1].split(' |')[0], 'base64').toString('utf8');
        const ok = (stdout) => Promise.resolve({exit_code: 0, timed_out: false, stdout: stdout || '', stderr: ''});
        if (decoded.includes('echo started')) { agent.runningPid = '4321'; return ok('started\n'); }
        if (decoded.includes('reset_port=')) return ok('reset_port=3\n');
        if (decoded.includes('avail=')) {
            return ok(['running=' + agent.runningPid, 'avail=1', 'rname=RX-V375', 'rport=3', 'dec0=9', 'spdif=5', 'log:',
                '[12:00:00] ARC reset complete on HDMI 3'].join('\n') + '\n');
        }
        if (decoded.includes('systemctl stop vetro-arc-fix.service')) agent.runningPid = '';
        return ok('');
    };
    return agent;
}

function memoryStore(initial) {
    let v = initial || {};
    return {get: () => v, set: (x) => { v = x; }};
}

(async () => {
    // 1. Logic: opt-in, nothing runs until the plugin is on.
    const agent = fakeAgent();
    const store = memoryStore();
    let clock = 1700000000000;
    const arc = new ArcFix({execute: agent.execute, store, legacyFile: null, now: () => clock});
    assert.deepEqual(arc.readState(), {delaySeconds: 3, port: null, since: null});
    assert.equal(await arc.supervise(), null);
    assert.equal(agent.calls.length, 0, 'no commands executed while the plugin is off');

    // 2. Status probes receiver and stream codec.
    const st0 = await arc.status();
    assert.equal(st0.enabled, false);
    assert.equal(st0.running, false);
    assert.deepEqual(st0.receiver, {available: true, name: 'RX-V375', port: 3});
    assert.deepEqual(st0.stream, {codecId: 9, codec: 'EAC3', spdifId: 5, spdif: 'ES DD+'});
    assert.equal(st0.effectivePort, 3);

    // 3. Manual trigger works without the watcher.
    const trig = await arc.trigger({delaySeconds: 3});
    assert.equal(trig.triggered, true);
    assert.equal(trig.usedPort, 3);
    assert.equal(arc.active, false);

    // 4. begin() (plugin switched on) starts the watcher and records the time.
    await arc.begin();
    assert.equal(arc.active, true);
    assert.equal(agent.runningPid, '4321');
    assert.equal(arc.readState().since, 1700000000000);

    // 5. configure() while on relaunches the watcher with the new values; invalid values fall back.
    const cfg = await arc.configure({delaySeconds: 5, port: 2});
    assert.equal(cfg.delaySeconds, 5);
    assert.equal(cfg.port, 2);
    assert.equal(cfg.enabled, true);
    assert.equal((await arc.configure({delaySeconds: 99, port: 9})).delaySeconds, 3);

    // 6. supervise() restarts a watcher that died, and backs off while the agent is away.
    agent.runningPid = '';
    assert.equal(await arc.supervise(), 'started');
    agent.runningPid = ''; agent.connected = false;
    assert.equal(await arc.supervise(), 'failed');
    assert.equal(arc.failures, 1);
    agent.connected = true;
    assert.equal(await arc.supervise(), null, 'waits for the retry delay');
    clock += 20000;
    assert.equal(await arc.supervise(), 'started');
    assert.equal(arc.failures, 0);

    // 7. end() (plugin switched off) stops the watcher.
    await arc.end();
    assert.equal(arc.active, false);
    assert.equal(agent.runningPid, '');
    assert.equal(await arc.supervise(), null);

    // 8. A delay and port saved by the built-in version are carried over once.
    const legacy = path.join(tmpDir, 'vetro-arc-fix.json');
    fs.writeFileSync(legacy, JSON.stringify({enabled: true, delaySeconds: 4, port: 1}));
    const migrated = new ArcFix({execute: agent.execute, store: memoryStore(), legacyFile: legacy});
    assert.deepEqual(migrated.readState(), {delaySeconds: 4, port: 1, since: null});
    const own = new ArcFix({execute: agent.execute, store: memoryStore({delaySeconds: 2}), legacyFile: legacy});
    assert.equal(own.readState().delaySeconds, 2, 'the plugin\'s own settings win');

    // 9. Through the real plugin host: installed from a bundle, off until switched on, routes and lifecycle.
    const {pack} = require('../scripts/vetro-plugin.cjs');
    const agent2 = fakeAgent();
    const host = new PluginHost({dir: path.join(tmpDir, 'plugins'), execute: agent2.execute, stableMs: 0});
    host.start();
    const packed = pack(path.join(__dirname, '..', 'plugins', 'arc-fix'));
    host.install(packed.text, packed.sha256);
    assert.equal(agent2.calls.length, 0, 'installing runs nothing');
    host.setEnabled('arc-fix', true);
    assert.equal(host.status('arc-fix').state, 'running');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(agent2.runningPid, '4321', 'switching the plugin on starts the watcher');

    const call = (method, sub, body) => new Promise((resolve, reject) => {
        const req = {method, url: '/plugins/arc-fix/api/' + sub, on: () => {}};
        const listeners = {};
        req.on = (ev, fn) => { listeners[ev] = fn; return req; };
        const res = {writeHead(code) { res.code = code; }, end(text) { resolve({code: res.code, text}); }};
        const inst = host.entries['arc-fix'].instance;
        const ok = inst.route(req, res, sub);
        if (!ok) return resolve({code: 404, text: ''});
        if (body !== undefined) { listeners.data(Buffer.from(JSON.stringify(body))); listeners.end(); }
    });
    const page = await call('GET', 'ui');
    assert.equal(page.code, 200);
    assert.ok(page.text.includes('Reset ARC receiver now'));
    const status = JSON.parse((await call('GET', 'status')).text);
    assert.equal(status.running, true);
    assert.equal(status.enabled, true);
    const reset = await call('POST', 'action', {action: 'trigger', delaySeconds: 2});
    assert.equal(reset.code, 200);
    assert.equal(JSON.parse(reset.text).triggered, true);
    const bad = await call('POST', 'action', {action: 'nope'});
    assert.equal(bad.code, 409);
    assert.equal((await call('GET', 'other')).code, 404);

    host.setEnabled('arc-fix', false);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(agent2.runningPid, '', 'switching the plugin off stops the watcher');
    host.stop();

    fs.rmSync(tmpDir, {recursive: true, force: true});
    console.log('PASS plugin arc-fix: opt-in, receiver detection, manual trigger, watcher lifecycle, supervision with backoff, settings migration and plugin host integration');
})().catch(err => {
    console.error(err);
    process.exit(1);
});
