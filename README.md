# xplane-sixpack-panel

Six-pack and PFD instruments for X-Plane 12, served to any browser on your LAN
— including the iPad in your drawer.

```
iPad browser  <--HTTP/SSE-->  xpbridge.py  <--UDP 49000-->  X-Plane 12
```

Airspeed, attitude, altimeter, turn coordinator, heading indicator and vertical
speed, drawn as live SVG at 20 Hz. The panel reads the loaded aircraft's own
V-speeds and rebuilds itself around them, and switches to a glass PFD when the
aircraft has one.

No plugin. No `pip install`. X-Plane already publishes its datarefs over UDP,
and the bridge is one stdlib Python file.

---

## Why an old iPad

Every flight simmer has one: a tablet that stopped getting iOS updates years
ago, too slow for anything current, too intact to throw away. Meanwhile the
thing you actually want — a second screen showing instruments, so your main
monitor can be all window — costs a real display, an arm, and desk space you
don't have.

The obstacle is that old tablets are locked out of the modern software world.
An iPad 4 tops out at iOS 10.3.4; the App Store will not sell it anything
written this decade, so the usual answers (Air Manager, SimAvionics, an iPad
app) are unavailable no matter what you're willing to pay. The hardware is
fine. The distribution channel is closed.

But the browser is still open, and a 2012 iPad renders SVG at 60 fps without
breaking a sweat. That is the whole idea here: nothing is installed on the
tablet. It loads a URL. Everything modern happens on the Mac running the sim,
and the iPad does the one job it is still extremely good at — being a bright,
sharp, silent 9.7" panel that runs on its own battery and needs one cable, or
none.

The result is a genuinely modern setup — X-Plane 12, aircraft-aware gauges,
live glass-cockpit detection — with a retired device as the display. If your
tablet is newer, none of this costs you anything; it just works, and works on
phones, laptops and second monitors too.

**Known good on an iPad 4 (2012) running iOS 10.3.4.** See
[Older hardware](#older-hardware) for what that constrains.

---

## Run it

Requires Python 3.7 or newer — macOS and Linux already have it, and there is
nothing to install beyond it.

```sh
git clone https://github.com/JasonCarlyle/xplane-sixpack-panel
cd xplane-sixpack-panel
python3 xpbridge.py
```

It prints the URL to open:

```
X-Plane six-pack bridge
  talking to X-Plane at 127.0.0.1:49000 (UDP)
  streaming 20 updates/sec
  open on the iPad:
      http://192.168.86.73:8080/
```

Open that on the tablet, on the same Wi-Fi, and start X-Plane. Order doesn't
matter — the bridge re-subscribes until the sim answers, and recovers if
X-Plane restarts. On macOS you can also double-click `start.command` instead of
using a terminal.

Try it without the sim first:

```sh
python3 xpbridge.py --demo
```

| flag | meaning |
|---|---|
| `--demo` | synthetic flight data, for checking the page without the sim |
| `--xp-host 192.168.1.50` | X-Plane runs on a different machine than the bridge |
| `--port 8080` | web server port |
| `--rate 20` | updates per second pushed to the browser |
| `--bind 0.0.0.0` | web server bind address |

Add `?poll=10` to the URL (`http://…:8080/?poll=10`) to fall back from
Server-Sent Events to plain polling if anything on the network mangles streams.

### Setting up the tablet

* **Share ▸ Add to Home Screen** — launches full-screen, without Safari's chrome.
* **Settings ▸ Display & Brightness ▸ Auto-Lock ▸ Never**, or the screen sleeps
  mid-flight. (The Wake Lock API needs HTTPS, so the page can't do it for you.)
* **Settings ▸ Accessibility ▸ Guided Access** stops stray taps leaving the page.
* The `digits` button toggles the numeric readouts; the choice is remembered
  per device.

The layout is 3×2 in landscape and 2×3 in portrait, sized in JavaScript to
whatever screen it lands on.

---

## It follows the aircraft

The bridge reads the loaded aircraft's ICAO code, description and V-speeds
(`acf_Vso`, `acf_Vs`, `acf_Vfe`, `acf_Vno`, `acf_Vne`), and the page rebuilds
the airspeed dial around them — scale range, tick spacing, and the white,
green, yellow and red markings. Swap aircraft in X-Plane and the panel follows
within a second or so, without a reload:

```
aircraft: Cessna 172SP Skyhawk [C172] — Vso 41, Vfe 85, Vno 129, Vne 163
aircraft: Boeing 737-800 [B738] — Vso 108, Vfe 250, Vno 0, Vne 340
```

The 172 gets a 40–200 kt dial with a caution arc; the 737 gets 100–400 kt, no
yellow (jets leave Vno at zero, so green runs to the redline) and a ±6000 fpm
VSI instead of ±2000. Changing aircraft also makes the bridge re-probe which
gyros are alive, since the new one may drive different instruments.

### Glass cockpits

Fly something with a G1000 or an AHARS-driven panel and the page switches from
the six dials to a PFD: attitude across the middle, airspeed and altitude tapes
either side with the same V-speed colour bands, vertical speed on the right,
and a compass arc along the bottom with a heading bug and turn-rate bar. Same
data, drawn the way a glass panel draws it.

Detection uses two signals, in order:

1. **A G1000 publishes its current page as text** (`g1000_n1_page`, e.g.
   `MAP - NAVIGATION MAP`). Nothing else fills that in, so it is a positive
   test rather than a guess.
2. **AHARS with no vacuum or electric gyro alive** — an aircraft modern enough
   to want a PFD.

Detection latches per aircraft: a G1000 reports nothing until its avionics come
up, and a panel that flipped layouts mid-flight would be worse than either
choice. Loading a different aircraft re-probes from scratch.

The **panel** button in the status strip cycles `auto` → `six-pack` → `PFD` if
you disagree with the guess; the choice is remembered per device. `auto` shows
what it picked, e.g. `auto: PFD`.

### Overriding what the sim says

Add-on aircraft often ship with blank or wrong V-speeds. `static/profiles.json`
overrides them per ICAO type, and wins over the sim:

```json
{ "C172": { "vso": 40, "vs1": 48, "vfe": 85, "vno": 129, "vne": 163 } }
```

Recognised keys: `vso`, `vs1`, `vfe`, `vno`, `vne`, plus `asiMin`, `asiMax` and
`vsiMax` if you want to pin the dial ranges. The file is optional — delete it
and everything comes from the sim.

---

## Where the numbers come from

Airspeed, altitude, VSI, barometric setting and slip come from the pilot-side
`sim/cockpit2/gauges/indicators/…` datarefs, so they reflect the modelled
instrument — including a blocked pitot or a mis-set Kollsman window — rather
than the raw physics.

Attitude and heading are trickier: an aircraft models only the gyro sources it
actually has, and the others read a flat zero forever. The bridge watches the
vacuum, electric and AHARS groups, uses the first one that ever shows life, and
falls back to the flight model (`true_theta` / `true_phi` / `mag_psi`) when the
aircraft has none. The status strip names the source in use. A consequence
worth knowing: with vacuum gyros, the AI and HI stay dead until the engine is
running, exactly as they should.

Turn rate is differentiated from heading and smoothed, so the turn coordinator
reads a true 3°/sec at the standard-rate marks in any aircraft. X-Plane's own
`turn_rate_roll_deg_pilot` deflection is also in the feed if you prefer it —
see `CONFIG.tc.source` in `static/sixpack.js`.

Strings come back one byte per subscription, since X-Plane's UDP feed carries
only floats — that is why `acf_ICAO` costs eight subscriptions and the aircraft
name thirty-two.

The rest of the tuning is in the `CONFIG` block at the top of
`static/sixpack.js`; reload the page after editing. `tau` holds the display
smoothing constants in seconds — raise a value for a calmer needle, lower it
for a snappier one.

---

## If nothing shows up

The status strip at the bottom of the page says which half of the chain is
broken:

* **"no data from X-Plane"** — the browser is talking to the bridge, but the
  sim isn't answering. Start X-Plane and load an aircraft. If X-Plane is on
  another machine, enable **Settings ▸ Network ▸ Accept incoming connections**
  there and pass `--xp-host <that machine's IP>`.
* **"bridge offline"** — `xpbridge.py` stopped, or the tablet lost the network.
* **"page error"** — the page's own JavaScript failed; the message is on screen
  and in the bridge's terminal (`!! browser error from …`).
* **Nothing loads at all** — macOS firewall. System Settings ▸ Network ▸
  Firewall ▸ Options: allow incoming connections for Python, or turn the
  firewall off while you fly.

The terminal prints a line for every page load with the device's IP and
browser, so you can confirm the tablet is reaching the right machine.

If the live stream is blocked by something on the network, the page notices
after three seconds and switches itself to polling — the status strip then
reads `live · polling`. `?poll=10` forces that from the start.

Two endpoints are worth knowing. On the device, `http://<mac-ip>:8080/api/data`
should return a blob of JSON; if that works but the panel doesn't, it's the
page, not the network. On the Mac, `/api/raw` shows every dataref the bridge
reads, which is the quickest way to see whether the sim side is alive.

---

## Older hardware

The page targets Safari 10 (iOS 10.3, the last release for 32-bit iPads) and
newer. In practice that meant giving up `fetch`, `Object.fromEntries`,
`env()`-only layout and `dominant-baseline`, polling instead of the event
stream when `EventSource` is missing, and laying the panel out in JavaScript
rather than with CSS grid — old WebKit leaves a percentage-sized inline SVG
with no height. The bridge also has to chunk its SSE responses explicitly,
because iOS Safari buffers a close-delimited response instead of delivering it
incrementally.

An old iPad has no console, so the page reports its own faults two ways: on
screen, and back to the bridge's terminal. Add `?debug` to the URL and it also
narrates its startup:

```
 · page start [Mozilla/5.0 (iPad; CPU OS 10_3_4 …)]
 · sixpack.js parsed, building gauges
 · transport: opening event stream
 · layout: 1024x642 cells 3x2 of 341x321, dial 315px
 · asi svg 315x315 at 3,3, 5 children
 · boot complete
 · first data received over sse
```

Whichever line is missing is where it stopped. Real faults print with a `!!`
prefix.

Two traps if you edit `sixpack.js`. Every element with an `id` becomes a
property of `window`, and old JavaScriptCore rejects a top-level `const`/`let`
that shadows one — as a `SyntaxError`, which kills the entire file before a
line of it runs. Keep top-level names distinct from the ids in `index.html`
(that is why the overlay element is held in `overlayEl`). And old Safari
restores a tab from its page cache instead of re-running it, so open a **fresh
tab** after changing anything.

---

## Files

```
xpbridge.py            UDP subscriber + web server (stdlib only)
start.command          double-clickable macOS launcher
static/index.html      page shell
static/sixpack.css     layout: 3x2 landscape, 2x3 portrait
static/sixpack.js      the six gauges and the PFD, drawn as SVG
static/profiles.json   optional per-aircraft V-speed overrides
```

MIT licensed. Not affiliated with Laminar Research; X-Plane is their trademark.
