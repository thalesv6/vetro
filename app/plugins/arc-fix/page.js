'use strict';
// The plugin's page. It runs in a sandboxed frame: relative URLs only, no cookies, no storage.
module.exports = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
'<meta name="color-scheme" content="light dark">' +
'<style>body{font:15px/1.45 system-ui,sans-serif;margin:20px;max-width:720px}h2{margin:0 0 4px;font-size:20px}p{margin:6px 0}' +
'.muted{opacity:.7}.chips{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.chip{border:1px solid;border-color:color-mix(in srgb,currentColor 30%,transparent);border-radius:999px;padding:2px 10px;font-size:13px}' +
'.on{border-color:#2a9d5c;color:#2a9d5c}.warn{border-color:#c77d00;color:#c77d00}' +
'.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:12px 0}button,select{font:inherit;padding:6px 12px}' +
'.err{border:1px solid #c0392b;color:#c0392b;border-radius:6px;padding:8px 10px;margin:10px 0}pre{white-space:pre-wrap;font:12px ui-monospace,monospace}</style>' +
'<body><h2>HDMI ARC receiver fix</h2>' +
'<p class="muted">For HDMI 1.4 ARC receivers (such as the Yamaha RX-V375) that get stuck in “Decoder Off” when a movie switches the ARC output from PCM to Dolby Digital or DD+. ' +
'While this plugin is switched on, Vetro sends a CEC RoutingChange away from ARC, waits, and restores ActiveSource, without interrupting playback.</p>' +
'<div class="chips" id="chips"></div><div id="err"></div>' +
'<div class="row"><button id="reset">Reset ARC receiver now</button>' +
'<label>Wait <select id="delay"></select></label><label>Port <select id="port"></select></label>' +
'<button id="refresh">Refresh</button></div>' +
'<details><summary>ARC reset log</summary><pre id="log"></pre></details>' +
'<script>' +
'var $=function(i){return document.getElementById(i)},busy=false;' +
'function chip(t,c){var s=document.createElement("span");s.className="chip "+(c||"");s.textContent=t;$("chips").appendChild(s)}' +
'function opt(sel,v,t,on){var o=document.createElement("option");o.value=v;o.textContent=t;if(on)o.selected=true;sel.appendChild(o)}' +
'function show(d){var r=d.receiver||{},st=d.stream||{},auto=r.port||3;$("chips").textContent="";' +
'chip(d.running===true?"Watching":d.running===false?"Not running":"State unknown",d.running===true?"on":"warn");' +
'chip(r.available?(r.name||"AVR")+" \\u00b7 HDMI "+(r.port||auto):"No CEC receiver detected \\u00b7 fallback HDMI "+auto,r.available?"on":"");' +
'if(st.codec)chip("Stream: "+st.codec+(st.spdif?" \\u00b7 "+st.spdif:""));' +
'$("err").textContent="";var e=d.error||d.probeError;if(e){var x=document.createElement("div");x.className="err";x.textContent=e;$("err").appendChild(x)}' +
'{$("delay").textContent="";[1,2,3,4,5,6,8,10].forEach(function(n){opt($("delay"),n,n+" s"+(n===3?" (default)":""),n===d.delaySeconds)});' +
'$("port").textContent="";opt($("port"),"auto","Auto (HDMI "+auto+")",!d.port);[1,2,3,4].forEach(function(n){opt($("port"),n,"HDMI "+n,d.port===n)})}' +
'$("log").textContent=d.log||"(empty)"}' +
'function call(path,opts){busy=true;[].forEach.call(document.querySelectorAll("button,select"),function(b){b.disabled=true});' +
'return fetch(path,opts).then(function(r){return r.json().then(function(j){if(!r.ok||j.error)throw Error(j.error||("HTTP "+r.status));return j})}).then(show)' +
'.catch(function(e){$("err").textContent="";var x=document.createElement("div");x.className="err";x.textContent=e.message;$("err").appendChild(x)})' +
'.then(function(){busy=false;[].forEach.call(document.querySelectorAll("button,select"),function(b){b.disabled=false})})}' +
'function post(a){var p=$("port").value;return call("action",{method:"POST",headers:{"Content-Type":"text/plain"},body:JSON.stringify({action:a,delaySeconds:+$("delay").value,port:p==="auto"?null:+p})})}' +
'$("reset").onclick=function(){post("trigger")};$("delay").onchange=$("port").onchange=function(){post("configure")};$("refresh").onclick=function(){call("status")};' +
'call("status");' +
'</script></body>';
