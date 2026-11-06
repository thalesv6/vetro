'use strict';
// Opt-in HDMI ARC receiver reset for legacy AV receivers (such as the Yamaha RX-V375) that get
// stuck in "Decoder Off" when the TV switches the ARC S/PDIF stream from PCM to Dolby Digital / DD+.
//
// Sending CEC <Routing Change> (0.0.0.0 -> <port>.0.0.0) via org.tizen.tv.HdmiCec.SendRoutingChange
// without starting Tizen's One-Touch-Play timer switches only the AV receiver's internal input away
// from ARC (e.g. AV1 -> HDMI 1) while leaving the TV's active app (Stremio, Netflix, etc.) untouched.
// Waiting ~3 seconds and calling org.tizen.tv.HdmiCec.SetActiveSource returns the receiver to ARC,
// forcing its S/PDIF DSP to re-lock onto the AC3/EAC3 bitstream.
//
// Disabled by default: nothing runs in the background unless the user switches it on.

var fs = require('fs');

var SHARE = '/opt/usr/home/owner/share';
var STATE_FILE = SHARE + '/vetro-arc-fix.json';
var RUN_DIR = '/home/owner';
var PID_FILE = RUN_DIR + '/vetro-arc-fix.pid';
var SCRIPT_FILE = RUN_DIR + '/vetro-arc-fix.sh';
var LOG_FILE = RUN_DIR + '/vetro-arc-fix.log';
var UNIT = 'vetro-arc-fix';
var RETRY_FIRST_MS = 15000;
var RETRY_MAX_MS = 180000;

var DEC_CODECS = {
    0: 'LPCM', 1: 'AC3', 2: 'MPEG', 3: 'DTS', 4: 'WMA', 5: 'AAC', 6: 'ADPCM',
    7: 'MULAW', 8: 'ALAW', 9: 'EAC3', 13: 'VORBIS', 14: 'HE-AAC', 15: 'DTS LBR',
    16: 'AC4', 17: 'MPEG-H', 18: 'TrueHD', 19: 'MAT', 20: 'OPUS', 21: 'MCH PCM', 23: 'Idle'
};
var SPDIF_FORMATS = {
    0: 'NEO ES DTS', 1: 'ES DTS', 2: 'ES Dolby Digital', 3: 'PCM',
    4: 'ES AAC', 5: 'ES DD+', 6: 'MAT', 7: 'MCH PCM'
};

function wrap(s) { return 'echo ' + Buffer.from(s, 'utf8').toString('base64') + ' | base64 -d | /bin/sh'; }

function clampDelay(v) {
    var n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 3;
}

function validPort(v) {
    if (v === null || v === undefined || v === '' || v === 'auto' || v === 0 || v === '0') return null;
    var n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 4 ? n : null;
}

function check(r, what) {
    if (!r || r.exit_code || r.timed_out) throw new Error((r && (r.stderr || r.stdout)) || what + ' failed');
    return r.stdout || '';
}

function ArcFix(options) {
    var o = typeof options === 'function' ? {execute: options} : (options || {});
    this.execute = o.execute;
    this.stateFile = o.stateFile || STATE_FILE;
    this.now = o.now || function () { return Date.now(); };
    this.busy = false;
    this.lastError = null;
    this.failures = 0;
    this.nextTry = 0;
}

ArcFix.prototype.readState = function () {
    try {
        var d = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        return {
            enabled: d && d.enabled === true,
            delaySeconds: clampDelay(d && d.delaySeconds),
            port: validPort(d && d.port),
            since: d && Number.isFinite(d.since) ? d.since : null
        };
    } catch (e) {
        return {enabled: false, delaySeconds: 3, port: null, since: null};
    }
};

ArcFix.prototype.writeState = function (state) {
    try { fs.writeFileSync(this.stateFile, JSON.stringify(state)); }
    catch (e) { throw new Error('The ARC fix setting could not be saved: ' + e.message); }
};

ArcFix.prototype.patchState = function (patch) {
    this.writeState(Object.assign(this.readState(), patch));
};

ArcFix.prototype.probeScript = function () {
    return [
        'p=$(cat ' + PID_FILE + ' 2>/dev/null)',
        'if [ -n "$p" ] && tr "\\0" " " < /proc/$p/cmdline 2>/dev/null | grep -q vetro-arc-fix; then echo "running=$p"; else echo "running="; fi',
        'avail=$(busctl --system call org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec IsReceiverAvailable 2>/dev/null | awk \'{print $2}\')',
        'echo "avail=${avail:-0}"',
        'rname=""; rport=""',
        'for idx in 0 1 2 3 4; do',
        '  dtype=$(busctl --system call org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec GetDeviceType i $idx 2>/dev/null)',
        '  case "$dtype" in *AUDIO_SYSTEM*)',
        '    rname=$(busctl --system call org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec GetDeviceName i $idx 2>/dev/null | sed -n \'s/^is [0-9-]* "\\(.*\\)"$/\\1/p\')',
        '    rport=$(busctl --system call org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec GetDevicePortNum i $idx 2>/dev/null | awk \'{print $3}\')',
        '    break ;;',
        '  esac',
        'done',
        'if [ -z "$rname" ] && [ "${avail:-0}" = "1" ]; then',
        '  rname=$(busctl --system call org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec GetDeviceName i 0 2>/dev/null | sed -n \'s/^is [0-9-]* "\\(.*\\)"$/\\1/p\')',
        '  rport=$(busctl --system call org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec GetDevicePortNum i 0 2>/dev/null | awk \'{print $3}\')',
        'fi',
        'echo "rname=$rname"',
        'echo "rport=$rport"',
        'dec0=$(amixer cget numid=89 2>/dev/null | sed -n \'s/.*: values=\\([0-9]*\\).*/\\1/p\')',
        'spdif=$(amixer cget numid=20 2>/dev/null | sed -n \'s/.*: values=\\([0-9]*\\).*/\\1/p\')',
        'echo "dec0=$dec0"',
        'echo "spdif=$spdif"',
        'echo "log:"',
        'tail -n 8 ' + LOG_FILE + ' 2>/dev/null || true'
    ].join('\n');
};

ArcFix.prototype.probe = function () {
    return this.execute(wrap(this.probeScript()), 8000).then(function (r) {
        var out = check(r, 'ARC probe');
        var runM = /^running=(\d*)$/m.exec(out);
        var availM = /^avail=(\d+)$/m.exec(out);
        var nameM = /^rname=(.*)$/m.exec(out);
        var portM = /^rport=(\d*)$/m.exec(out);
        var decM = /^dec0=(\d*)$/m.exec(out);
        var spdifM = /^spdif=(\d*)$/m.exec(out);
        var pid = runM && runM[1] ? +runM[1] : null;
        var port = portM && portM[1] ? +portM[1] : null;
        var dec0 = decM && decM[1] !== '' ? +decM[1] : null;
        var spdif = spdifM && spdifM[1] !== '' ? +spdifM[1] : null;
        var receiverName = nameM && nameM[1] ? nameM[1].trim() : null;
        return {
            running: !!pid,
            pid: pid,
            receiver: {
                available: availM ? availM[1] === '1' : false,
                name: receiverName || null,
                port: port && port >= 1 && port <= 4 ? port : null
            },
            stream: {
                codecId: dec0,
                codec: dec0 !== null ? (DEC_CODECS[dec0] || ('Codec ' + dec0)) : null,
                spdifId: spdif,
                spdif: spdif !== null ? (SPDIF_FORMATS[spdif] || ('Format ' + spdif)) : null
            },
            log: out.indexOf('log:\n') >= 0 ? out.split('log:\n')[1].trim() : ''
        };
    });
};

ArcFix.prototype.status = function () {
    var self = this, state = this.readState();
    var base = {
        enabled: state.enabled,
        delaySeconds: state.delaySeconds,
        port: state.port,
        since: state.since,
        busy: this.busy,
        error: this.lastError,
        failures: this.failures
    };
    return this.probe().then(function (p) {
        return Object.assign(base, p, {effectivePort: state.port || (p.receiver && p.receiver.port) || 3});
    }).catch(function (e) {
        return Object.assign(base, {
            running: null, pid: null,
            receiver: {available: false, name: null, port: null},
            stream: {codecId: null, codec: null, spdifId: null, spdif: null},
            effectivePort: state.port || 3,
            log: '',
            probeError: e.message
        });
    });
};

ArcFix.prototype.daemonFileContent = function (delaySeconds, configuredPort) {
    var delay = clampDelay(delaySeconds);
    var fixedPort = validPort(configuredPort);
    return [
        '#!/bin/sh',
        '# Vetro background watcher for HDMI ARC "Decoder Off" recovery.',
        'echo $$ > ' + PID_FILE,
        'DELAY=' + delay,
        'FIXED_PORT=' + (fixedPort || 0),
        'LAST_RUN=0',
        'log_msg() {',
        '  ts=$(date "+%H:%M:%S" 2>/dev/null || echo "--:--:--")',
        '  echo "[$ts] $1" >> ' + LOG_FILE,
        '  if [ "$(wc -l < ' + LOG_FILE + ' 2>/dev/null || echo 0)" -gt 60 ]; then',
        '    tail -n 40 ' + LOG_FILE + ' > ' + LOG_FILE + '.tmp && mv ' + LOG_FILE + '.tmp ' + LOG_FILE,
        '  fi',
        '}',
        'resolve_port() {',
        '  if [ "$FIXED_PORT" -ge 1 ] && [ "$FIXED_PORT" -le 4 ]; then echo "$FIXED_PORT"; return; fi',
        '  p=$(busctl --system call org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec GetDevicePortNum i 0 2>/dev/null | awk \'{print $3}\')',
        '  case "$p" in 1|2|3|4) echo "$p" ;; *) echo 3 ;; esac',
        '}',
        'log_msg "Watcher started (delay=${DELAY}s, port=${FIXED_PORT:-auto})"',
        'busctl --system --augment-creds=no -j monitor 2>/dev/null | grep --line-buffered -E \'"member":"SetAudioInformation"|"member":"DigitalAudioFormatChanged"\' | while read -r line; do',
        '  now=$(date +%s 2>/dev/null || echo 0)',
        '  if [ $((now - LAST_RUN)) -lt 8 ]; then continue; fi',
        '  enc=$(echo "$line" | sed -n \'s/.*"data":\\[\\[[0-9-]*,[0-9-]*,\\([0-9-]*\\),.*/\\1/p\')',
        '  sleep 1',
        '  dec0=$(amixer cget numid=89 2>/dev/null | sed -n \'s/.*: values=\\([0-9]*\\).*/\\1/p\')',
        '  spdif=$(amixer cget numid=20 2>/dev/null | sed -n \'s/.*: values=\\([0-9]*\\).*/\\1/p\')',
        '  case "${spdif:-3}" in 3|7) continue ;; esac',
        '  case "${dec0:-0}" in',
        '    1|3|9|15|16|18|19)',
        '      port=$(resolve_port)',
        '      log_msg "Dolby/DTS bitstream start (enc=${enc:-?}, dec0=${dec0}, spdif=${spdif}) -> RoutingChange(0->${port}), wait ${DELAY}s, SetActiveSource"',
        '      dbus-send --system --print-reply --dest=org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec.SendRoutingChange int32:0 int32:"$port" >/dev/null 2>&1',
        '      sleep "$DELAY"',
        '      dbus-send --system --print-reply --dest=org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec.SetActiveSource >/dev/null 2>&1',
        '      LAST_RUN=$(date +%s 2>/dev/null || echo 0)',
        '      log_msg "ARC reset complete on HDMI ${port}"',
        '      ;;',
        '  esac',
        'done'
    ].join('\n') + '\n';
};

ArcFix.prototype.stopLines = function () {
    return [
        'systemctl stop ' + UNIT + '.service >/dev/null 2>&1 || true',
        'p=$(cat ' + PID_FILE + ' 2>/dev/null)',
        'if [ -n "$p" ] && tr "\\0" " " < /proc/$p/cmdline 2>/dev/null | grep -q vetro-arc-fix; then',
        '  pkill -P "$p" >/dev/null 2>&1 || true',
        '  kill -9 "$p" >/dev/null 2>&1 || true',
        '  sleep 0.2',
        'fi',
        'rm -f ' + PID_FILE
    ].join('\n');
};

ArcFix.prototype.startScript = function (state) {
    var daemonB64 = Buffer.from(this.daemonFileContent(state.delaySeconds, state.port), 'utf8').toString('base64');
    var runner = '/bin/sh -c \'eval "$(cat ' + SCRIPT_FILE + ')"\'';
    return [
        this.stopLines(),
        'echo ' + daemonB64 + ' | base64 -d > ' + SCRIPT_FILE,
        'chmod 644 ' + SCRIPT_FILE,
        'systemd-run --unit=' + UNIT + ' --collect -p KillSignal=SIGKILL -p StandardOutput=null -p StandardError=null ' + runner + ' >/dev/null 2>&1 || ' +
            'setsid nohup ' + runner + ' </dev/null >/dev/null 2>&1 &',
        'sleep 0.4',
        'echo started'
    ].join('\n');
};

ArcFix.prototype.launch = function () {
    var self = this, state = this.readState();
    return this.execute(wrap(this.startScript(state)), 10000).then(function (r) {
        check(r, 'ARC watcher start');
        return self.probe();
    }).then(function (p) {
        if (!p.running) throw new Error('The ARC watcher process did not stay running');
        return p;
    });
};

ArcFix.prototype.enable = function (options) {
    var self = this;
    if (this.busy) return Promise.reject(new Error('Another ARC receiver action is in progress'));
    this.busy = true; this.lastError = null;
    var cur = this.readState();
    var nextDelay = options && options.delaySeconds !== undefined ? clampDelay(options.delaySeconds) : cur.delaySeconds;
    var nextPort = options && options.port !== undefined ? validPort(options.port) : cur.port;
    try { this.patchState({delaySeconds: nextDelay, port: nextPort}); }
    catch (e) { this.busy = false; return Promise.reject(e); }
    return this.launch().then(function () {
        self.patchState({enabled: true, since: self.now()});
        self.failures = 0; self.nextTry = 0;
        return self.status();
    }).catch(function (e) {
        self.lastError = e.message;
        return self.execute(wrap(self.stopLines()), 8000).catch(function () {}).then(function () { throw e; });
    }).finally(function () { self.busy = false; });
};

ArcFix.prototype.disable = function () {
    var self = this;
    if (this.busy) return Promise.reject(new Error('Another ARC receiver action is in progress'));
    this.busy = true; this.lastError = null;
    try { this.patchState({enabled: false}); }
    catch (e) { this.busy = false; return Promise.reject(e); }
    return this.execute(wrap(this.stopLines() + '\nrm -f ' + SCRIPT_FILE), 8000).then(function (r) {
        check(r, 'ARC watcher stop');
        return self.status();
    }).finally(function () { self.busy = false; });
};

ArcFix.prototype.configure = function (options) {
    var self = this;
    if (this.busy) return Promise.reject(new Error('Another ARC receiver action is in progress'));
    var cur = this.readState();
    var delaySeconds = options && options.delaySeconds !== undefined ? clampDelay(options.delaySeconds) : cur.delaySeconds;
    var port = options && options.port !== undefined ? validPort(options.port) : cur.port;
    try { this.patchState({delaySeconds: delaySeconds, port: port}); }
    catch (e) { return Promise.reject(e); }
    if (!cur.enabled) return this.status();
    this.busy = true; this.lastError = null;
    return this.launch().then(function () { return self.status(); }).catch(function (e) {
        self.lastError = e.message; throw e;
    }).finally(function () { self.busy = false; });
};

ArcFix.prototype.trigger = function (options) {
    var self = this;
    if (this.busy) return Promise.reject(new Error('Another ARC receiver action is in progress'));
    this.busy = true; this.lastError = null;
    var state = this.readState();
    var delay = options && options.delaySeconds !== undefined ? clampDelay(options.delaySeconds) : state.delaySeconds;
    var reqPort = options && options.port !== undefined ? validPort(options.port) : state.port;
    var script = [
        'port=' + (reqPort || 0),
        'if [ "$port" -lt 1 ] || [ "$port" -gt 4 ]; then',
        '  p=$(busctl --system call org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec GetDevicePortNum i 0 2>/dev/null | awk \'{print $3}\')',
        '  case "$p" in 1|2|3|4) port=$p ;; *) port=3 ;; esac',
        'fi',
        'ts=$(date "+%H:%M:%S" 2>/dev/null || echo "--:--:--")',
        'echo "[$ts] Manual reset -> RoutingChange(0->${port}), wait ' + delay + 's, SetActiveSource" >> ' + LOG_FILE,
        'dbus-send --system --print-reply --dest=org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec.SendRoutingChange int32:0 int32:"$port" >/dev/null',
        'sleep ' + delay,
        'dbus-send --system --print-reply --dest=org.tizen.tv.hdmicec /org/tizen/tv/hdmicec org.tizen.tv.HdmiCec.SetActiveSource >/dev/null',
        'ts2=$(date "+%H:%M:%S" 2>/dev/null || echo "--:--:--")',
        'echo "[$ts2] Manual ARC reset complete on HDMI ${port}" >> ' + LOG_FILE,
        'echo "reset_port=$port"'
    ].join('\n');
    return this.execute(wrap(script), (delay + 10) * 1000).then(function (r) {
        var out = check(r, 'ARC reset');
        var m = /^reset_port=(\d+)$/m.exec(out);
        var usedPort = m ? +m[1] : (reqPort || 3);
        return self.status().then(function (st) {
            return Object.assign(st, {triggered: true, usedPort: usedPort, usedDelaySeconds: delay});
        });
    }).catch(function (e) {
        self.lastError = e.message;
        throw e;
    }).finally(function () { self.busy = false; });
};

ArcFix.prototype.supervise = function (agentConnected) {
    var self = this, state = this.readState();
    if (!state.enabled || this.busy || !agentConnected || this.now() < this.nextTry) return Promise.resolve(null);
    this.busy = true;
    return this.probe().then(function (p) {
        if (p.running) { self.failures = 0; return 'running'; }
        return self.launch().then(function () { self.failures = 0; self.lastError = null; return 'started'; });
    }).catch(function (e) {
        self.failures++;
        self.nextTry = self.now() + Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * Math.pow(2, Math.min(self.failures, 6) - 1));
        self.lastError = e.message;
        return 'failed';
    }).finally(function () { self.busy = false; });
};

module.exports = {ArcFix: ArcFix, STATE_FILE: STATE_FILE, clampDelay: clampDelay, validPort: validPort};
