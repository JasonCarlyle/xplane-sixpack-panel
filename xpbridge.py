#!/usr/bin/env python3
"""
xpbridge.py -- X-Plane 12 -> browser bridge for the HTML six-pack.

Subscribes to X-Plane's built-in UDP "RREF" dataref feed, then re-publishes the
values to any browser on the LAN as Server-Sent Events, and serves the static
six-pack page alongside it.

Stdlib only -- no pip install, no X-Plane plugin required.

    python3 xpbridge.py                 # X-Plane on this machine
    python3 xpbridge.py --xp-host 192.168.86.50   # X-Plane on another box

Then open http://<this-machine-ip>:8080/ on the iPad.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import socket
import struct
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")

# (key, dataref, requested updates per second)
# The index into this list is the RREF index we hand to X-Plane.
BASE_DATAREFS = [
    # --- pitot/static instruments (present on essentially every aircraft) ---
    ("ias",         "sim/cockpit2/gauges/indicators/airspeed_kts_pilot",      20),
    ("alt",         "sim/cockpit2/gauges/indicators/altitude_ft_pilot",       20),
    ("vsi",         "sim/cockpit2/gauges/indicators/vvi_fpm_pilot",           20),
    ("baro",        "sim/cockpit2/gauges/actuators/barometer_setting_in_hg_pilot", 4),
    # --- turn coordinator ---
    ("slip",        "sim/cockpit2/gauges/indicators/slip_deg",                20),
    ("turn_defl",   "sim/cockpit2/gauges/indicators/turn_rate_roll_deg_pilot", 20),
    # --- gyro instruments, three possible power sources per aircraft ---
    ("pitch_vac",   "sim/cockpit2/gauges/indicators/pitch_vacuum_deg_pilot",  20),
    ("roll_vac",    "sim/cockpit2/gauges/indicators/roll_vacuum_deg_pilot",   20),
    ("hdg_vac",     "sim/cockpit2/gauges/indicators/heading_vacuum_deg_mag_pilot", 20),
    ("pitch_elec",  "sim/cockpit2/gauges/indicators/pitch_electric_deg_pilot", 20),
    ("roll_elec",   "sim/cockpit2/gauges/indicators/roll_electric_deg_pilot",  20),
    ("hdg_elec",    "sim/cockpit2/gauges/indicators/heading_electric_deg_mag_pilot", 20),
    ("pitch_ahars", "sim/cockpit2/gauges/indicators/pitch_AHARS_deg_pilot",   20),
    ("roll_ahars",  "sim/cockpit2/gauges/indicators/roll_AHARS_deg_pilot",    20),
    ("hdg_ahars",   "sim/cockpit2/gauges/indicators/heading_AHARS_deg_mag_pilot", 20),
    # --- raw flight model: always valid, used when no gyro source is alive ---
    ("pitch_true",  "sim/flightmodel/position/true_theta",                    20),
    ("roll_true",   "sim/flightmodel/position/true_phi",                      20),
    ("hdg_true",    "sim/flightmodel/position/mag_psi",                       20),
    # --- extras ---
    ("hdg_bug",     "sim/cockpit2/autopilot/heading_dial_deg_mag_pilot",       4),
    ("gs_ms",       "sim/flightmodel/position/groundspeed",                    4),
    ("paused",      "sim/time/paused",                                         2),
    # --- the aircraft's own limits, used to lay out the airspeed dial ---
    ("vso",   "sim/aircraft/view/acf_Vso",       1),   # stall, flaps down
    ("vs1",   "sim/aircraft/view/acf_Vs",        1),   # stall, clean
    ("vfe",   "sim/aircraft/view/acf_Vfe",       1),   # max flaps extended
    ("vno",   "sim/aircraft/view/acf_Vno",       1),   # max structural cruise
    ("vne",   "sim/aircraft/view/acf_Vne",       1),   # never exceed
    ("vle",   "sim/aircraft/overflow/acf_Vle",   1),   # max gear extended
    ("vyse",  "sim/aircraft/overflow/acf_Vyse",  1),   # blue line, twins
]

# X-Plane's UDP feed carries nothing but floats, so a string dataref has to be
# read one byte at a time -- each character is its own subscription.
STRING_REFS = [
    ("icao", "sim/aircraft/view/acf_ICAO", 8),
    ("name", "sim/aircraft/view/acf_descrip", 32),
    # Only a G1000 aircraft fills this in ("MAP - NAVIGATION MAP" and so on),
    # which makes it a positive test for glass rather than a guess.
    ("g1k",  "sim/cockpit/g1000/g1000_n1_page", 8),
]

DATAREFS = list(BASE_DATAREFS)
for _key, _dref, _n in STRING_REFS:
    for _i in range(_n):
        DATAREFS.append((f"{_key}#{_i}", f"{_dref}[{_i}]", 1))

KEY_INDEX = {key: i for i, (key, _, _) in enumerate(DATAREFS)}

# Gyro source groups, in the order we prefer them for a steam six-pack.
GYRO_SOURCES = [
    ("vacuum",   "pitch_vac",   "roll_vac",   "hdg_vac"),
    ("electric", "pitch_elec",  "roll_elec",  "hdg_elec"),
    ("ahars",    "pitch_ahars", "roll_ahars", "hdg_ahars"),
]

RESUBSCRIBE_AFTER = 3.0     # seconds of silence before we re-send subscriptions
STALE_AFTER = 1.5           # seconds of silence before we call the link dead


def wrap180(deg: float) -> float:
    """Wrap an angle difference into -180..180."""
    return (deg + 180.0) % 360.0 - 180.0


class XPlaneFeed:
    """Talks UDP to X-Plane and keeps the latest value of every dataref."""

    def __init__(self, host: str, port: int):
        self.addr = (host, port)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.settimeout(0.5)
        self.lock = threading.Lock()
        self.raw = {key: 0.0 for key, _, _ in DATAREFS}
        self.last_rx = 0.0
        self.packets = 0
        self.alive = set()          # gyro source groups that have ever shown life
        self.stop_flag = threading.Event()
        # derived turn rate state
        self._turn_rate = 0.0
        self._last_hdg = None
        self._last_hdg_t = None
        self.derived = ("model", 0.0, 0.0, 0.0, 0.0)
        self.acf = {"sig": "", "icao": "", "name": ""}
        self._acf_pending = ""
        self._acf_since = 0.0
        self.glass = False
        self.glass_why = ""

    # -- subscription ------------------------------------------------------
    def subscribe(self, freq_override=None):
        for i, (_key, dref, freq) in enumerate(DATAREFS):
            f = freq if freq_override is None else freq_override
            pkt = struct.pack("<4sxii400s", b"RREF", f, i, dref.encode("utf-8"))
            try:
                self.sock.sendto(pkt, self.addr)
            except OSError:
                return
            time.sleep(0.001)   # X-Plane drops bursts if we fire all at once

    def unsubscribe(self):
        self.subscribe(freq_override=0)

    # -- receive loop ------------------------------------------------------
    def run(self):
        self.subscribe()
        last_sub = time.time()
        while not self.stop_flag.is_set():
            now = time.time()
            if now - self.last_rx > RESUBSCRIBE_AFTER and now - last_sub > RESUBSCRIBE_AFTER:
                # X-Plane not running yet, or it restarted and forgot us.
                self.subscribe()
                last_sub = now
            try:
                data, _src = self.sock.recvfrom(8192)
            except socket.timeout:
                continue
            except OSError:
                time.sleep(0.25)
                continue
            if len(data) < 13 or data[0:4] != b"RREF":
                continue
            self.last_rx = time.time()
            self.packets += 1
            with self.lock:
                for off in range(5, len(data) - 7, 8):
                    idx, value = struct.unpack("<if", data[off:off + 8])
                    if 0 <= idx < len(DATAREFS):
                        self.raw[DATAREFS[idx][0]] = value
                self._update_aircraft(self.raw)
                src, pitch, roll, hdg = self._pick_gyro_source(self.raw)
                self._update_glass(self.raw, src)
                self.derived = (src, pitch, roll, hdg,
                                self._update_turn_rate(hdg, self.last_rx))

    def close(self):
        self.stop_flag.set()
        try:
            self.unsubscribe()
        except OSError:
            pass
        self.sock.close()

    # -- derived state -----------------------------------------------------
    @staticmethod
    def _text(raw, key, n):
        """Reassemble a string dataref from its per-byte subscriptions."""
        out = []
        for i in range(n):
            c = int(round(raw.get(f"{key}#{i}", 0.0)))
            if c <= 0 or c > 126:
                break                     # end of string, or not plain text
            if c >= 32:
                out.append(chr(c))
        return "".join(out).strip()

    def _update_aircraft(self, raw):
        """Notice which aircraft is loaded and publish its speed limits."""
        speeds = {k: round(float(raw[k]), 1)
                  for k in ("vso", "vs1", "vfe", "vno", "vne", "vle", "vyse")}
        icao = self._text(raw, "icao", 8)
        name = self._text(raw, "name", 32)
        sig = "|".join([icao, name] + [f"{speeds[k]}" for k in sorted(speeds)])
        if sig == self.acf["sig"]:
            return
        # A string arrives a byte at a time across several packets, so wait for
        # it to stop changing rather than reacting to every half-built name.
        now = time.time()
        if sig != self._acf_pending:
            self._acf_pending, self._acf_since = sig, now
            return
        if now - self._acf_since < 0.8:
            return
        acf = dict(speeds)
        acf.update({"sig": sig, "icao": icao, "name": name})
        self.acf = acf
        # A different aircraft has different instruments, so work out which
        # gyros it drives -- and whether it is glass -- from scratch.
        self.alive.clear()
        self.glass = False
        self.glass_why = ""
        if icao or name or speeds["vne"] > 0:
            print(f"aircraft: {name or icao or 'unknown'}"
                  f"{' [' + icao + ']' if icao and name else ''} — "
                  f"Vso {speeds['vso']:.0f}, Vfe {speeds['vfe']:.0f}, "
                  f"Vno {speeds['vno']:.0f}, Vne {speeds['vne']:.0f}", flush=True)

    def _update_glass(self, raw, src):
        """Decide whether this aircraft has a glass panel.

        A G1000 publishes its current page as text, which nothing else does.
        Failing that, an aircraft driving AHARS with no vacuum or electric gyro
        alive is modern enough to want a PFD. Latches on: the G1000 string is
        empty until its avionics come up, and we do not want the panel flipping
        back and forth mid-flight.
        """
        if self.glass:
            return
        if self._text(raw, "g1k", 8):
            self.glass, self.glass_why = True, "G1000"
        elif src == "ahars":
            self.glass, self.glass_why = True, "AHARS"

    def _pick_gyro_source(self, raw):
        """Choose which gyro set drives the AI and HI.

        A dataref that the current aircraft does not model reads a flat 0.0
        forever, so we remember any group that has ever shown a non-zero value
        and use the first live one; otherwise we fall back to the flight model,
        which is always valid.
        """
        for name, p, r, h in GYRO_SOURCES:
            if name not in self.alive:
                if raw[p] or raw[r] or raw[h]:
                    self.alive.add(name)
        for name, p, r, h in GYRO_SOURCES:
            if name in self.alive:
                return name, raw[p], raw[r], raw[h] % 360.0
        return "model", raw["pitch_true"], raw["roll_true"], raw["hdg_true"] % 360.0

    def _update_turn_rate(self, hdg, now):
        """Turn rate in deg/sec, differentiated from heading and smoothed.

        Works in every aircraft, unlike the turn-indicator deflection dataref,
        and is directly comparable to the 3 deg/sec standard rate.
        """
        if self._last_hdg is None:
            self._last_hdg, self._last_hdg_t = hdg, now
            return 0.0
        dt = now - self._last_hdg_t
        if dt < 0.02:
            return self._turn_rate
        rate = wrap180(hdg - self._last_hdg) / dt
        self._last_hdg, self._last_hdg_t = hdg, now
        if abs(rate) > 60.0:        # teleport / reposition, not a turn
            rate = self._turn_rate
        alpha = 1.0 - math.exp(-dt / 0.35)
        self._turn_rate += alpha * (rate - self._turn_rate)
        return self._turn_rate

    def snapshot(self):
        now = time.time()
        with self.lock:
            raw = dict(self.raw)
            src, pitch, roll, hdg, rate = self.derived
        age = now - self.last_rx if self.last_rx else 999.0
        return {
            "t": round(now, 3),
            "connected": age < STALE_AFTER,
            "age": round(age, 2),
            "src": src,
            "ias": raw["ias"],
            "alt_ft": raw["alt"],
            "vsi_fpm": raw["vsi"],
            "baro_inhg": raw["baro"],
            "slip_deg": raw["slip"],
            "turn_defl_deg": raw["turn_defl"],
            "turn_rate_dps": rate,
            "pitch_deg": pitch,
            "roll_deg": roll,
            "hdg_deg": hdg,
            "hdg_bug_deg": raw["hdg_bug"] % 360.0,
            "gs_kt": raw["gs_ms"] * 1.94384,
            "paused": bool(raw["paused"]),
            "acf": self.acf,
            "glass": self.glass,
            "glass_why": self.glass_why,
        }


class DemoFeed:
    """Synthetic flight, for checking the page without starting X-Plane."""

    def __init__(self):
        self.t0 = time.time()
        self.lock = threading.Lock()
        self.raw = {}

    def run(self):
        while True:
            time.sleep(1.0)

    def close(self):
        pass

    def snapshot(self):
        t = time.time() - self.t0
        turn = 3.0 * math.sin(t / 25.0)             # deg/sec, standard-rate-ish
        hdg = (95.0 + 3.0 * 25.0 * (1 - math.cos(t / 25.0))) % 360.0
        vsi = 700.0 * math.sin(t / 17.0)
        return {
            "t": round(time.time(), 3),
            "connected": True,
            "age": 0.0,
            "src": "demo",
            "ias": 108.0 + 14.0 * math.sin(t / 11.0),
            "alt_ft": 4250.0 + 400.0 * math.sin(t / 17.0),
            "vsi_fpm": vsi,
            "baro_inhg": 29.92,
            "slip_deg": 1.6 * math.sin(t / 6.0),
            "turn_defl_deg": turn / 3.0 * 20.0,
            "turn_rate_dps": turn,
            "pitch_deg": 4.0 * math.sin(t / 17.0),
            "roll_deg": 18.0 * math.sin(t / 25.0),
            "hdg_deg": hdg,
            "hdg_bug_deg": 120.0,
            "gs_kt": 112.0,
            "paused": False,
            "acf": {"sig": "demo", "icao": "C172", "name": "Cessna 172 (demo)",
                    "vso": 41.0, "vs1": 48.0, "vfe": 85.0, "vno": 129.0,
                    "vne": 163.0, "vle": 0.0, "vyse": 0.0},
            "glass": False,
            "glass_why": "",
        }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    feed: XPlaneFeed = None      # type: ignore[assignment]
    stream_hz = 20.0

    def log_message(self, fmt, *args):     # quieter than the default
        if "--verbose" in sys.argv:
            super().log_message(fmt, *args)

    # -- helpers -----------------------------------------------------------
    def _send(self, code, body: bytes, ctype="text/plain; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, relpath):
        path = os.path.normpath(os.path.join(STATIC_DIR, relpath.lstrip("/")))
        if not path.startswith(STATIC_DIR) or not os.path.isfile(path):
            self._send(404, b"not found")
            return
        types = {".html": "text/html; charset=utf-8",
                 ".js": "application/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8",
                 ".json": "application/json",
                 ".svg": "image/svg+xml",
                 ".png": "image/png"}
        ctype = types.get(os.path.splitext(path)[1], "application/octet-stream")
        with open(path, "rb") as fh:
            self._send(200, fh.read(), ctype)

    # -- routes ------------------------------------------------------------
    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path == "/":
            path = "/index.html"
            # One line per page load, so it is obvious which device connected.
            print(f"page loaded by {self.client_address[0]} "
                  f"[{self.headers.get('User-Agent', 'unknown')}]", flush=True)
        if path == "/api/log":
            # The page reports its own JavaScript errors here: an iPad has no
            # console, so this is the only way to see what went wrong there.
            # parse_qs already unquotes; decoding twice turns "+" into " ".
            msg = urllib.parse.parse_qs(query).get("msg", [""])[0]
            bad = msg.startswith("JS ERROR") or msg.startswith("report:")
            print(f"{'!!' if bad else ' ·'} {self.client_address[0]}: {msg}", flush=True)
            self._send(200, b"", "text/plain")
            return
        if path == "/api/data":
            self._send(200, json.dumps(self.feed.snapshot()).encode(),
                       "application/json")
        elif path == "/api/raw":
            with self.feed.lock:
                raw = dict(self.feed.raw)
            self._send(200, json.dumps(raw, indent=1).encode(), "application/json")
        elif path == "/api/stream":
            self._stream()
        else:
            self._serve_static(path)

    def _chunk(self, payload: bytes):
        """One HTTP chunk. Safari on iOS buffers a close-delimited response
        instead of delivering it incrementally, so the stream has to be
        explicitly chunked or EventSource never fires on the iPad."""
        self.wfile.write(b"%x\r\n" % len(payload) + payload + b"\r\n")
        self.wfile.flush()

    def _stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        period = 1.0 / self.stream_hz
        try:
            # Some clients hold a stream back until a couple of KB have
            # arrived; an SSE comment costs nothing and unblocks them.
            self._chunk(b":" + b" " * 2048 + b"\nretry: 1000\n\n")
            while True:
                payload = json.dumps(self.feed.snapshot(), separators=(",", ":"))
                self._chunk(b"data: " + payload.encode() + b"\n\n")
                time.sleep(period)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.close_connection = True


def lan_ips():
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    return ips


def main():
    ap = argparse.ArgumentParser(description="X-Plane 12 -> HTML six-pack bridge")
    ap.add_argument("--xp-host", default="127.0.0.1",
                    help="IP of the machine running X-Plane (default 127.0.0.1)")
    ap.add_argument("--xp-port", type=int, default=49000,
                    help="X-Plane UDP receive port (default 49000)")
    ap.add_argument("--port", type=int, default=8080, help="web server port")
    ap.add_argument("--bind", default="0.0.0.0", help="web server bind address")
    ap.add_argument("--rate", type=float, default=20.0,
                    help="updates per second pushed to the browser")
    ap.add_argument("--demo", action="store_true",
                    help="serve synthetic data instead of talking to X-Plane")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    feed = DemoFeed() if args.demo else XPlaneFeed(args.xp_host, args.xp_port)
    if not args.demo:
        threading.Thread(target=feed.run, daemon=True, name="xplane-udp").start()

    Handler.feed = feed
    Handler.stream_hz = args.rate
    httpd = ThreadingHTTPServer((args.bind, args.port), Handler)
    httpd.daemon_threads = True

    print("X-Plane six-pack bridge")
    if args.demo:
        print("  DEMO MODE -- synthetic data, X-Plane not contacted")
    else:
        print(f"  talking to X-Plane at {args.xp_host}:{args.xp_port} (UDP)")
    print(f"  streaming {args.rate:g} updates/sec")
    print("  open on the iPad:")
    for ip in lan_ips() or ["<this-machine-ip>"]:
        print(f"      http://{ip}:{args.port}/")
    print(f"  or locally:  http://localhost:{args.port}/")
    print("Ctrl-C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
    finally:
        feed.close()
        httpd.server_close()


if __name__ == "__main__":
    main()
