# Device Stress Tester

Browser-based hardware stress lab for phones and PCs. Static site (GitHub Pages ready). Current build **v25**.

Stresses CPU, GPU, memory, storage, radios, sensors, camera/ISP, display, audio, and optional peripherals — with telemetry, power modeling, and shareable reports.

---

## Test profiles

| Profile | Behavior |
|---------|----------|
| **Quick Burst** | ~1 min — CPU + modem |
| **Thermal Endurance** | ~15 min — CPU + GPU + storage + modem + throttle log |
| **Torture Test** | Until abort — CPU + GPU + storage + modem + RAM |
| **MAX** | Full stack until abort (permissions first, then WebGL/WebGPU/AI/HDR). Excludes torch, Eclipse Void, simple tone, mic, ISP torch-loop, RGB panel |

URL automation (examples):

- `#profile=quick`
- `#profile=endurance`
- `#profile=torture&duration=300`
- `#profile=max&duration=0` (0 = until abort)

**Multi-tab:** slider 1–10 opens additional windows with the same profile hash.

---

## Power, battery & thermal

- **Weighted power index** — relative watts from active subsystems (CPU/GPU high, panel medium-high, vibration medium, audio lower, etc.)
- **High-resolution battery delta** — timestamped `levelchange` events (Chrome/Android)
- **Δ%/min stress vs idle control** — excess drain attributed to load
- **Battery-derived power** — configurable capacity (mAh) and nominal voltage;  
  \(P_{\mathrm{mW}} \approx (\Delta\% / \Delta t_{\mathrm{hours}}) \times \mathrm{mAh} \times V\)
- **Thermal efficiency** — throughput score vs baseline; flags likely DVFS/thermal throttling
- **Throttle log** — samples every few seconds; markers at 5 / 10 / 15 minutes
- **Export** — JSON, CSV, and copyable scorecard (device specs, min/max scores, throttle timeline, battery events)

---

## Compute & graphics

| Feature | Description |
|---------|-------------|
| **GPU Fractal (Canvas Julia)** | Adaptive load toward a goal FPS |
| **GPU WebGL volume** | Heavy raymarch; load starts at 100% and can ramp past for low FPS goals |
| **WebGPU compute** | WGSL compute shaders (large matrix-style GPGPU loops) |
| **WebGPU dense draw** | Thousands of instanced triangles, GPU-side |
| **On-device AI stress** | Repeated attention-like matmuls on WebGPU (CPU fallback) |
| **VRR / frame push** | Continuous `requestAnimationFrame`; reports Hz, jitter, stutter count |

---

## CPU, memory & storage

| Feature | Description |
|---------|-------------|
| **CPU stress** | Multi Web Worker busy loops; worker count slider |
| **WASM / SIMD-style workers** | Multi-core vectorized float loops |
| **RAM stress** | Allocates up to a **50–95%** ceiling of estimated heap/device memory |
| **Zero-GC RAM saturator** | Pre-allocated buffers shuffled in place (bandwidth + cache pressure, minimal GC) |
| **Storage (flash)** | Sequential / random / mixed R/W via **OPFS** or **IndexedDB** |

---

## Network & radios

| Feature | Description |
|---------|-------------|
| **Network download stress** | Continuous parallel downloads; speed in Mb/s |
| **Modem multi-stream** | Concurrent fetches + WebSocket ping-pong; stream count slider |
| **NFC** | NDEF scan (mainly Android Chrome + HTTPS) |
| **Web Bluetooth** | Device picker; GATT services/characteristics interrogation |
| **WebUSB** | Device descriptors, interfaces, endpoints |

---

## Camera, sensors & input

| Feature | Description |
|---------|-------------|
| **Torch** | Rear-camera flashlight at max when supported |
| **Rear camera** | Max resolution / frame rate request |
| **Camera + torch ISP loop** | Live canvas filters (edge, Sobel-style, invert, grayscale) |
| **Motion sensors** | Accelerometer, gyroscope, orientation/compass at max event rate |
| **Ambient light** | Lux via Ambient Light Sensor when available |
| **Multi-touch pad** | Touch events per second under load |
| **Location ping** | High-accuracy GPS with long timeouts + network fallback |

---

## Display & audio

| Feature | Description |
|---------|-------------|
| **Panel burn-in / flicker** | Full-screen RGB cycle, white/black flash, grid, spectrum |
| **HDR / peak brightness** | Full-screen peak white (+ HDR canvas when supported) |
| **Eclipse Void** | Blank black/white screen; 5 taps to close tab; ✕ exits mode |
| **Tone generator** | Single oscillator with frequency & volume |
| **Audio DSP load** | Dozens–hundreds of oscillators through filters/delays |

---

## Other controls

- **Close tab when unfocused** — attempts tab close on visibility loss
- **Vibration** — continuous haptic (not on iOS Safari)
- **Light / dark theme** — persisted preference
- **PC mode** — multi-column layout (2–4 columns by width); auto on wide viewports
- **Auto-update** — detects new deploys via build id and soft-reloads

---

## Platform notes

| Capability | Typical support |
|------------|-----------------|
| Most media / WebGL / workers | Chrome, Firefox, Safari |
| Battery API, WebNFC, WebBluetooth, torch | Strongest on **Android Chrome** |
| WebGPU | Recent Chromium |
| Vibration | Android browsers; **not** iOS Safari |
| Battery / BLE / NFC on iOS | Generally unavailable (WebKit limits) |
| SharedArrayBuffer / true WASM SIMD | Needs COOP/COEP isolation headers |

Power figures are **models and estimates**. Browsers cannot read true instantaneous battery current.

---

## Files

- `index.html` — UI structure
- `styles.css` — layout, themes, PC grid
- `app.js` — all feature logic

MIT — free to use and modify.
