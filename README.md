# Car Thingy

Final-approach flight radar and Claude usage limits on a Spotify Car Thing.

Clone on any Mac, run install once, plug in the Car Thing, and it runs.

## New Mac (work laptop, etc.)

```bash
git clone https://github.com/YOUR_USER/carthingy.git
cd carthingy
./scripts/install.sh
claude    # sign in once on this Mac
```

Plug in the Car Thing with a **data** USB-C cable. The host starts automatically. No need to run `adb reverse` or `start.sh` by hand.

Preview in a browser: http://127.0.0.1:8787/

Logs: `carthingy.log` in the repo root.

## What lives where

| Location | Purpose |
|----------|---------|
| This repo | Host server, install scripts, dashboard files |
| macOS Keychain `Claude Code-credentials` | Claude login on macOS (Claude Code often never writes the json file) |
| `~/.claude/.credentials.json` | Claude login on Linux / older installs |
| Car Thing storage | ThingLabs firmware + dashboard UI (survives unplug) |
| `carthingy.conf` | adb path, office coordinates, port (auto-created, gitignored) |

The Car Thing only needs flashing **once** (see below). After that, any Mac only runs `./scripts/install.sh`.

## Manual controls

```bash
./scripts/start.sh                 # foreground mode (debugging)
./scripts/carthingy-host.sh status # is the background host up?
./scripts/apply-kiosk.sh           # if Welcome screen comes back
./scripts/uninstall-autostart.sh   # disable plug-and-play autostart
./scripts/doctor.sh                # check prerequisites
```

## First-time firmware (once per Car Thing)

Stock firmware has no adb. Flash Thing Labs 8.9.2 once:

```bash
./scripts/flash.sh
```

Hold **presets 1 and 4**, plug in USB (black screen = burn mode), wait for the flash to finish.

Then run `./scripts/install.sh` with the device plugged in.

## How it works

```
Mac (this repo)                    Car Thing
┌─────────────────────┐   USB    ┌─────────────────────┐
│ host/server.mjs     │◄────────►│ file:// dashboard   │
│ adsb.lol + Claude   │ adb      │ polls               │
│ /api/flights        │ reverse  │ 127.0.0.1:8787      │
│ /api/usage          │          │                     │
└─────────────────────┘          └─────────────────────┘
```

1. Dashboard UI is stored on the Car Thing at `/usr/share/carthingy/`.
2. Your Mac fetches nearby aircraft from [adsb.lol](https://api.adsb.lol/docs) (free, no API key).
3. Claude usage comes from Anthropic using Claude Code credentials.
4. `adb reverse` tunnels port 8787 so the device can reach the Mac API.
5. A background watcher starts/stops the host when you plug/unplug USB.

## Flight radar

The dashboard shows aircraft near the origin you set in `carthingy.conf`. Range is nautical miles. Optional exclude vars drop traffic that belongs to a nearby competing airport.

```bash
OFFICE_LAT=
OFFICE_LON=
OFFICE_RADIUS_NM=7
OFFICE_LABEL="Office"
```

**Navigation** (knob and Back only):

| Control | Action |
|--------|--------|
| Turn knob | Move focus, or cycle extra details on a flight |
| Click knob | Open the focused row |
| Back | Return to the list |

**Preset hotkeys** (open apps on the Mac):

| Preset | Default |
|--------|---------|
| 1 | Calendar |
| 2 | Mail |
| 3 | Slack |
| 4 | Safari |

Change them in `carthingy.conf`:

```bash
HOTKEY_1="Calendar|open -a Calendar"
HOTKEY_4="Maps|open -a Maps"
```

The display is a 480×800 LVDS panel driven at **60 Hz**, rotated to 800×480.

## Configuration

`carthingy.conf` (created by setup, gitignored):

```bash
CAR_THING_ADB=/opt/homebrew/bin/adb
CAR_THING_SERIAL=YOUR_SERIAL
CARTHINGY_PORT=8787
OFFICE_LAT=
OFFICE_LON=
OFFICE_RADIUS_NM=7
OFFICE_LABEL="Office"
HOTKEY_1="Calendar|open -a Calendar"
HOTKEY_2="Mail|open -a Mail"
HOTKEY_3="Slack|open -a Slack"
HOTKEY_4="Safari|open -a Safari"
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `CARTHINGY_PORT` | `8787` | Host server port |
| `OFFICE_LAT` / `OFFICE_LON` | (required) | Radar origin |
| `OFFICE_RADIUS_NM` | `7` | Scan radius in nautical miles |
| `OFFICE_LABEL` | `Office` | Label on the dashboard |
| `EXCLUDE_NEAR_LAT` / `EXCLUDE_NEAR_LON` | unset | Drop aircraft closer to this point than to the office |
| `EXCLUDE_DEST` | unset | Comma-separated destination codes to drop |
| `RADAR_AIRPORTS` | unset | Detail-radar airport markers as `CODE:lat:lon` pairs, comma-separated. Markers farther than `OFFICE_RADIUS_NM` are dropped. |
| `HOTKEY_1` … `HOTKEY_4` | Calendar/Mail/Slack/Safari | Preset shortcuts (`Label\|open args`) |
| `CARTHINGY_FLIGHTS_REFRESH_MS` | `15000` | Host ADS-B cache interval |
| `CARTHINGY_REFRESH_MS` | `120000` | Claude cache refresh interval |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude credentials directory |

## Troubleshooting

**No Claude credentials**

Run `claude` on this Mac. On macOS the token lives in Keychain, not `~/.claude/.credentials.json`. The first time the host reads it, click **Always Allow** for the node binary. Do that from `./scripts/start.sh` in Terminal once so launchd is not the process waiting on a dialog.

**No adb device**

Use a data-capable cable. Run `./scripts/usb-status.sh`.

**Welcome screen instead of dashboard**

The stock Spotify app (`qt-superbird-app`) can take over the display after a reboot or memory pressure. Reapply the kiosk:

```bash
./scripts/apply-kiosk.sh
```

Autostart now runs `./scripts/ensure-kiosk.sh` every time you plug in and every ~5 minutes while connected. That stops the Spotify UI and keeps Chromium on the dashboard.

If it keeps coming back after a firmware update, run `apply-kiosk.sh` once more.

**Autostart not working**

```bash
tail -f carthingy.log
./scripts/install-autostart.sh   # re-register
```

**Revert to Spotify UI**

```bash
adb shell "mount -o remount,rw / && cp /etc/supervisord.conf.stock /etc/supervisord.conf && supervisorctl restart chromium"
```

## License

MIT
