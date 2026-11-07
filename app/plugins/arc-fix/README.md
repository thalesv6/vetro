# ARC receiver fix

Vetro plugin for HDMI 1.4 ARC receivers (such as the Yamaha RX-V375) that get stuck in "Decoder Off" when the TV
switches the ARC S/PDIF stream from PCM to Dolby Digital / DD+.

While the plugin is **switched on**, a small watcher on the TV listens for the audio-format change, then sends a CEC
RoutingChange away from ARC, waits a few seconds (default 3) and sets the TV as ActiveSource again. The receiver
re-locks onto the bitstream; the running app is not interrupted. Switched off, nothing runs.

- Page: **Plugins → ARC fix**: manual reset, wait time (1–10 s), HDMI port (auto or 1–4), live receiver and stream info, log.
- Needs the `exec` permission (it runs commands as root through Vetro's helper: `busctl`, `dbus-send`, `amixer`).
- Settings are kept in the plugin's `config.json` and survive updates. A delay and port saved by the built-in
  version of this feature (`vetro-arc-fix.json`) are read once.
- Coming from the built-in version: it is gone from *Audio* settings; install this plugin and switch it on. It reuses
  the same watcher unit (`vetro-arc-fix`), so a leftover watcher is replaced, not duplicated.

```
node scripts/vetro-plugin.cjs check plugins/arc-fix
node scripts/vetro-plugin.cjs pack plugins/arc-fix
```
