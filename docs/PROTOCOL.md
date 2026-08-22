# Sony BRAVIA Professional Display — control protocol reference

Research notes gathered from the [BRAVIA Professional Displays Knowledge Center](https://pro-bravia.sony.net/remote-display-control/)
(docs moved from `/develop/integrate/...` to `/remote-display-control/...`; the old paths 302 to the new index).

## Four control planes

| Plane | Endpoint | Strength | Weakness |
|---|---|---|---|
| **REST API** | `POST http://{ip}/sony/{service}` JSON-RPC | Full surface: 8 services, ~40 methods. Everything is here. | **No push.** Poll-only. |
| **Simple IP Control (SSIP)** | TCP `{ip}:20060`, 24-byte fixed ASCII | **Unsolicited push notifications** for power/input/volume/mute/picture-mute | Small command set (11 commands) |
| **IRCC-IP** | `POST http://{ip}/sony/ircc` SOAP | IR remote key emulation (menu nav, OSD, app keys) | Fire-and-forget, no feedback |
| **Wake-on-LAN** | UDP magic packet | Recovers a suspended display (HTTP server stops in suspend) | Needs MAC (from `getSystemInformation`) |

All three IP planes authenticate with the same **`X-Auth-PSK: <key>`** header / shared PSK setting.

Display prerequisites:
- `[Settings] → [Network & Internet] → [Remote device settings] → [Control remotely]` = on
- `[Settings] → [Network & Internet] → [Home network] → [IP control] → [Authentication]` = Pre-Shared Key
- `[Settings] → [Network & Internet] → [Home network] → [IP control] → [Simple IP control]` = on (for SSIP)
- Wake-on-LAN on, to recover from suspend

> **EU models** have 3 RED-DA compliance variants with *different available command sets*. Capability
> discovery (below) is therefore not optional.

---

## REST API

`POST http://{ip}/sony/{service}` — no trailing slash. Body:

```json
{ "method": "getPowerStatus", "params": [], "id": 50, "version": "1.0" }
```

Response success `{"result": [...], "id": 50}` / failure `{"error": [code, "message"], "id": 50}`.
`id` must be 1..2147483647 (0 reserved). Auth levels: `none` < `generic` (control) < `private` (PII).

### Full method surface

| Service | Methods |
|---|---|
| `guide` | getSupportedApiInfo |
| `system` | getPowerStatus, setPowerStatus, getSystemInformation (1.0/1.7), getSystemSupportedFunction, getNetworkSettings, getInterfaceInformation, getRemoteDeviceSettings, getCurrentTime (1.0/1.1), getLEDIndicatorStatus, setLEDIndicatorStatus (1.1), getPowerSavingMode, setPowerSavingMode, getWolMode, setWolMode, getRemoteControllerInfo, getScreenshot, requestReboot |
| `audio` | getVolumeInformation, setAudioVolume (1.0/1.2), setAudioMute, getSpeakerSettings, setSpeakerSettings, setSoundSettings (1.1) |
| `avContent` | getSchemeList, getSourceList, getContentCount (1.0/1.1), getContentList (1.5), getCurrentExternalInputsStatus (1.0/1.1), getPlayingContentInfo, setPlayContent |
| `video` | getPictureQualitySettings (1.0/1.1), setPictureQualitySettings (1.0/1.1), getScreenRotation, setScreenRotation |
| `videoScreen` | getSceneSetting, setSceneSetting — *not supported on BZ40P / BZ35P / BZ30P* |
| `appControl` | getApplicationList, getApplicationStatusList, getWebAppStatus, setActiveApp, terminateApps, installApp, uninstallApp, prepareAppUpload, getTextForm (1.0/1.1), setTextForm (1.0/1.1) |
| `encryption` | getPublicKey (RSA 2048/1024 + AES-128-CBC for sensitive params) |

### Capability discovery — the load-bearing design fact

The display describes **itself**. Do not hardcode per-model tables:

- `getSupportedApiInfo` → exactly which services/methods/versions this unit implements
- `getPictureQualitySettings` with `target: ""` → **all** picture targets, each with `currentValue`,
  `isAvailable`, and `candidate[]`
- `getSpeakerSettings` / `getSoundSettings` → same shape for audio
- `getCurrentExternalInputsStatus` → real input list with labels + connection state
- `getRemoteControllerInfo` → this unit's IRCC key/code table
- `getApplicationList` → installed apps

`candidate[]` maps directly onto ioBroker `common`:

| Candidate shape | ioBroker state |
|---|---|
| `[{ "min": 0, "max": 100, "step": 1 }]` | `type: number`, `role: level`, `common.min/max/step` |
| `[{"value":"standard"},{"value":"vivid"}]` | `type: string`, `role: level`, `common.states` |
| `candidate: null` | read-only / free value |
| `isAvailable: false` | present but not applicable to the current input |

Known `video` targets (indicative only — always enumerate): color, brightness, contrast, sharpness,
pictureMode, lightSensor, colorSpace, colorTemperature, autoPictureMode, hdrMode, autoLocalDimming,
xtendedDynamicRange, contentType, hdmiSignalFormat, hdmiSignalFormatVrr.

> `hdmiSignalFormat` / `hdmiSignalFormatVrr` **must be sent one target per HTTP request** — batching
> them can fail depending on signal state. Everything else may be batched in one `settings` array.

Input URIs follow `extInput:hdmi?port=2` form; `setPlayContent` takes `{uri}`.

### Error codes worth handling

| Code | Meaning | Adapter action |
|---|---|---|
| 401 / 403 | Unauthorized / Forbidden | Bad PSK → surface in `info.lastError`, stop retrying blindly |
| 404 | No such API version | Fall back to lower version |
| 503 | Service Unavailable (too many connections) | Back off + retry |
| 3 / 5 / 15 | Illegal argument / request / unsupported operation | Log, don't retry |
| 7 | Illegal State | Retry later |
| 12 | No Such Method | Mark capability absent |
| 14 | Unsupported Version | Retry with older version |
| 40003 | Request Duplicated | Serialize requests per display |
| 40004 | Multiple Settings Failed | Re-read with paired `getXXXSettings` to find which failed |
| 40005 | Display is turned off | Expected while in standby — suppress noise |
| 40200 / 40201 | Password expired / AC power required | Surface to user |
| 40600 | Screen Change in Progress | Retry |
| 40800 / 40801 | Target not supported / Volume out of range | Clamp or mark unsupported |

---

## Simple IP Control (SSIP)

TCP port **20060**. Fixed **24-byte** ASCII messages:

```
byte  0-1   header    "*S"
byte  2     type      C=Control  E=Enquiry  A=Answer  N=Notify
byte  3-6   command   FourCC
byte  7-22  parameter 16 chars
byte  23    footer    0x0A (LF)
```

Parameter conventions: `#` × 16 = no parameter; numbers are **left**-padded with `0`; strings are
**right**-padded with `#`. Answers: `0`×16 = success, `F`×16 = error, `N`×16 = not found/not available.

| FourCC | Type | Function |
|---|---|---|
| `POWR` | C/E/N | set/get/notify power — `…0000`=standby, `…0001`=active |
| `TPOW` | C | toggle power |
| `VOLU` | C/E/N | set/get/notify volume (decimal, zero-padded) |
| `AMUT` | C/E/N | set/get/notify audio mute |
| `PMUT` | C/E/N | set/get/notify picture mute |
| `TPMU` | C | toggle picture mute |
| `INPT` | C/E/N | set/get/notify input — `0000000{type}0000{port}`, type 1=HDMI 3=Composite 4=Component 5=Screen Mirroring |
| `IRCC` | C | send IR code (numeric, see table below) |
| `SCEN` | C/E | scene setting (`auto` / `auto24pSync` / `general`) — *not on BZ40P/BZ35P/BZ30P* |
| `MADR` | E | MAC address of interface (param `eth0`) |
| `BADR` | E | broadcast IPv4 address of interface (param `eth0`) |

**Notify (`N`) messages arrive unsolicited** for POWR, INPT, VOLU, AMUT, PMUT — this is the only
push feedback path in the whole protocol family, and the reason to hold the SSIP socket open.

SSIP numeric IR codes (`IRCC` param, zero-padded): Display 5, Home 6, Options 7, Return 8, Up 9,
Down 10, Right 11, Left 12, Confirm 13, Red 14, Green 15, Yellow 16, Blue 17, Num1-9 18-26, Num0 27,
VolumeUp 30, VolumeDown 31, Mute 32, ChannelUp 33, ChannelDown 34, Subtitle 35, DOT 38, PictureOff 50,
Wide 61, Jump 62, SyncMenu 76, Forward 77, Play 78, Rewind 79, Prev 80, Stop 81, Next 82, Pause 84,
FlashPlus 86, FlashMinus 87, TVPower 98, Audio 99, Input 101, Sleep 104, SleepTimer 105, Video2 108,
PictureMode 110, DemoSurround 121, HDMI1-4 124-127, ActionMenu 129, Help 130.

---

## IRCC-IP

```
POST /sony/ircc HTTP/1.1
Content-Type: text/xml; charset=UTF-8
SOAPACTION: "urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"
X-Auth-PSK: <psk>
```

SOAP envelope wrapping `<u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>…</IRCCCode></u:X_SendIRCC>`.

Codes are **base64** here (distinct from SSIP's numeric codes), e.g. Power `AAAAAQAAAAEAAAAVAw==`,
Input `AAAAAQAAAAEAAAAlAw==`, Hdmi1 `AAAAAgAAABoAAABaAw==`. Retrieve the unit's own table with REST
`getRemoteControllerInfo` rather than shipping a static list.

---

## Comparison of the reference domestic adapter

[`ioBroker.sony-bravia`](https://github.com/iobroker-community-adapters/ioBroker.sony-bravia) uses REST
+ PSK only, with a hardcoded 10 s `setInterval` poll and no push, no capability discovery, no SSIP,
and no retry/backoff. It is a useful shape reference for the avContent/appControl state layout but
does not cover the professional command surface.

---

## Implementation caveats found while building against the specification

These are the details that change adapter behaviour and are easy to miss on a first read:

| Method | Caveat |
|---|---|
| `system.setPowerStatus` | `{status: boolean}`. **Power-on works only from "Sleep"** — from full suspend the HTTP server is down. Also fails if *Remote start* is off. The adapter falls back to Wake-on-LAN. |
| `audio.setAudioVolume` | `volume` is a **string** and accepts relative forms: `"25"`, `"+14"`, `"-10"`. Volume up/down therefore needs no read-modify-write. v1.2 adds an optional `ui` flag. |
| `audio.getSoundSettings` | **Not documented for professional displays** — only the setter is. Discovery must degrade gracefully; the adapter falls back to the documented `outputTerminal` target. |
| `video.setScreenRotation` | `{rotation: 0\|90\|180\|270}`. Documented as callable **from localhost (127.0.0.1) only**, and only on FW-BZxxx with PKG 6.2512 / generation 5.7.0 or later. Expect network writes to be refused. |
| `video.setPictureQualitySettings` | `hdmiSignalFormat` and `hdmiSignalFormatVrr` **must be sent one target per request**; batching them with others can fail depending on the current signal. |
| `system.setLEDIndicatorStatus` | Takes `{mode, status}` **together**. `status` is the *string* `"true"`/`"false"`, and `null` means "server decides". Writing one half requires re-sending the other. |
| `system.getLEDIndicatorStatus` | `status` may be `null` = unknown; do not coerce that to `false`. |
| Picture mute | Has **no REST equivalent** at all. `PMUT` / `TPMU` over SSIP is the only route. |
| Power toggle | No REST equivalent either — SSIP `TPOW` only. |
| SSIP answers | Carry **no request identifier**; they can only be matched by FourCC, so commands must be issued strictly one at a time. |
| SSIP `A` answers | `0`×16 is ambiguous: it means both "success" for a Control and the value 0 for an Enquiry. The caller must know which it sent. |
| REST concurrency | `40003 Request Duplicated` means a second request arrived while the first was outstanding — serialise per display. |

### ioBroker mapping notes

- `switch` is defined as **writable**; a boolean the display exposes read-only must use `indicator`,
  otherwise the repository object checker rejects it.
- `level` is the writable-number role; `value` is read-only. A discovered numeric target that has
  no setter must be `value`.
- A settings target reported as `isAvailable: false` is *not applicable to the current input*, not
  absent — its state must still be created, or states would appear and disappear as inputs change.
