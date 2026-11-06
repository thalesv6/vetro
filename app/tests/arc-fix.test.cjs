'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const {ArcFix} = require('../service/arc-fix.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetro-arc-fix-test-'));
const stateFile = path.join(tmpDir, 'vetro-arc-fix.json');

(async () => {
    let runningPid = '';
    const calls = [];
    const execute = (cmd) => {
        calls.push(cmd);
        const decoded = Buffer.from(cmd.split('echo ')[1].split(' |')[0], 'base64').toString('utf8');
        if (decoded.includes('echo started')) {
            runningPid = '4321';
            return Promise.resolve({exit_code: 0, timed_out: false, stdout: 'started\n', stderr: ''});
        }
        if (decoded.includes('reset_port=')) {
            return Promise.resolve({exit_code: 0, timed_out: false, stdout: 'reset_port=3\n', stderr: ''});
        }
        if (decoded.includes('avail=')) {
            return Promise.resolve({
                exit_code: 0,
                timed_out: false,
                stdout: [
                    'running=' + runningPid,
                    'avail=1',
                    'rname=RX-V375',
                    'rport=3',
                    'dec0=9',
                    'spdif=5',
                    'log:',
                    '[12:00:00] ARC reset complete on HDMI 3'
                ].join('\n') + '\n',
                stderr: ''
            });
        }
        if (decoded.includes('systemctl stop vetro-arc-fix.service')) {
            runningPid = '';
            return Promise.resolve({exit_code: 0, timed_out: false, stdout: '', stderr: ''});
        }
        return Promise.resolve({exit_code: 0, timed_out: false, stdout: '', stderr: ''});
    };

    const arc = new ArcFix({execute, stateFile, now: () => 1700000000000});

    // 1. Default state is strictly opt-in (disabled by default) and supervise does nothing.
    assert.deepEqual(arc.readState(), {enabled: false, delaySeconds: 3, port: null, since: null});
    assert.equal(await arc.supervise(true), null);
    assert.equal(calls.length, 0, 'no commands executed when disabled');

    // 2. Status probes receiver and active stream codec.
    const st0 = await arc.status();
    assert.equal(st0.enabled, false);
    assert.equal(st0.running, false);
    assert.deepEqual(st0.receiver, {available: true, name: 'RX-V375', port: 3});
    assert.deepEqual(st0.stream, {codecId: 9, codec: 'EAC3', spdifId: 5, spdif: 'ES DD+'});
    assert.equal(st0.effectivePort, 3);

    // 3. Manual trigger resets ARC without enabling the background watcher.
    const trig = await arc.trigger({delaySeconds: 3});
    assert.equal(trig.triggered, true);
    assert.equal(trig.usedPort, 3);
    assert.equal(trig.usedDelaySeconds, 3);
    assert.equal(arc.readState().enabled, false);

    // 4. Enable starts the background watcher and saves state.
    const stOn = await arc.enable({delaySeconds: 3, port: null});
    assert.equal(stOn.enabled, true);
    assert.equal(stOn.running, true);
    assert.equal(stOn.pid, 4321);
    assert.equal(arc.readState().enabled, true);

    // 5. Supervise restarts if watcher dies while enabled.
    runningPid = '';
    assert.equal(await arc.supervise(true), 'started');
    assert.equal(runningPid, '4321');

    // 6. Disable stops the watcher and persists enabled=false.
    const stOff = await arc.disable();
    assert.equal(stOff.enabled, false);
    assert.equal(stOff.running, false);
    assert.equal(arc.readState().enabled, false);

    fs.rmSync(tmpDir, {recursive: true, force: true});
    console.log('PASS arc-fix: opt-in by default, CEC receiver detection, manual trigger, watcher lifecycle and supervision');
})().catch(err => {
    console.error(err);
    process.exit(1);
});
