(() => {
  "use strict";

  // ---------- Power estimation (rough) ----------
  // Approximate incremental draw in watts when each feature is active.
  // These are educated guesses for a typical modern phone.
  const POWER = {
    torch: 1.2,      // LED flashlight
    camera: 1.8,     // camera pipeline + ISP
    vibrate: 0.9,    // haptic motor continuous
    location: 1.1,   // GNSS + radio assists
    cpu: 4.0,        // multi-core busy workers (scaled by worker count)
    download: 1.5,   // radio + modem under load
    gpu: 3.5,        // heavy GPU (canvas or WebGL volume)
    mic: 0.5,        // mic + DSP
    tone: 0.4,       // speaker / audio amp
  };

  const active = {
    torch: false,
    camera: false,
    vibrate: false,
    location: false,
    cpu: false,
    download: false,
    gpu: false,
    mic: false,
    tone: false,
  };

  let cpuWorkerCount = Math.min(8, Math.max(2, navigator.hardwareConcurrency || 4));

  function updatePower() {
    let total = 0.3; // baseline idle-ish browser
    for (const k of Object.keys(POWER)) {
      if (!active[k]) continue;
      if (k === "cpu") {
        total += POWER.cpu * (cpuWorkerCount / 4);
      } else {
        total += POWER[k];
      }
    }
    document.getElementById("powerWatts").textContent = total.toFixed(1);
  }

  // ---------- Battery level tracking (Battery Status API) ----------
  // Samples battery.level over time; drop rates use percentage points (0–100).
  let batteryManager = null;
  let batterySamples = []; // { t, levelPct }
  let batteryStartPct = null;
  let batteryStartTime = null;
  let batteryPollTimer = null;
  const BATTERY_MAX_SAMPLES = 600; // ~10 min at 1 Hz
  const BATTERY_WINDOW_MS = 120000; // 2 min window for recent average

  function formatDropRate(pointsPerSec) {
    if (pointsPerSec == null || !isFinite(pointsPerSec) || pointsPerSec < 0) {
      return "—";
    }
    // Very small rates: show more precision
    if (pointsPerSec < 0.001) return pointsPerSec.toFixed(5) + "%";
    if (pointsPerSec < 0.01) return pointsPerSec.toFixed(4) + "%";
    if (pointsPerSec < 0.1) return pointsPerSec.toFixed(3) + "%";
    return pointsPerSec.toFixed(2) + "%";
  }

  function updateBatteryUI() {
    const levelEl = document.getElementById("batteryLevel");
    const dropSecEl = document.getElementById("batteryDropSec");
    const dropMinEl = document.getElementById("batteryDropMin");
    const sessionEl = document.getElementById("batterySession");
    const hintEl = document.getElementById("batteryHint");
    if (!levelEl) return;

    if (!batteryManager) {
      levelEl.textContent = "N/A";
      dropSecEl.textContent = "—";
      dropMinEl.textContent = "—";
      sessionEl.textContent = "—";
      return;
    }

    const pct = Math.round(batteryManager.level * 1000) / 10; // 0.1% precision
    const charging = batteryManager.charging;
    levelEl.textContent =
      pct.toFixed(1) + "%" + (charging ? " (charging)" : "");

    // Need at least 2 samples spanning some time
    if (batterySamples.length < 2) {
      dropSecEl.textContent = "warming up…";
      dropMinEl.textContent = "warming up…";
      sessionEl.textContent =
        batteryStartPct != null
          ? "start " + batteryStartPct.toFixed(1) + "%"
          : "—";
      return;
    }

    const now = performance.now();
    // Recent window average (last BATTERY_WINDOW_MS)
    const windowStart = now - BATTERY_WINDOW_MS;
    let windowSamples = batterySamples.filter((s) => s.t >= windowStart);
    if (windowSamples.length < 2) windowSamples = batterySamples;

    const first = windowSamples[0];
    const last = windowSamples[windowSamples.length - 1];
    const dtSec = (last.t - first.t) / 1000;
    let dropPerSec = 0;
    if (dtSec > 0.5) {
      // Only count drain (ignore charge-up as positive drop)
      const delta = first.levelPct - last.levelPct;
      dropPerSec = Math.max(0, delta / dtSec);
    }

    dropSecEl.textContent = formatDropRate(dropPerSec) + " /s";
    dropMinEl.textContent = formatDropRate(dropPerSec * 60) + " /min";

    // Session totals
    if (batteryStartPct != null && batteryStartTime != null) {
      const sessionDrop = Math.max(0, batteryStartPct - last.levelPct);
      const sessionMin = (now - batteryStartTime) / 60000;
      sessionEl.textContent =
        sessionDrop.toFixed(1) + "% over " +
        (sessionMin < 1
          ? Math.round(sessionMin * 60) + "s"
          : sessionMin.toFixed(1) + " min");
    }

    if (hintEl && charging) {
      hintEl.textContent =
        "Charging — drop rates stay at 0 until you unplug.";
    } else if (hintEl) {
      hintEl.textContent =
        "Averages use the last ~2 min of samples. OS often reports level in 1% steps, so short windows look jumpy.";
    }
  }

  function recordBatterySample() {
    if (!batteryManager) return;
    const levelPct = batteryManager.level * 100;
    const t = performance.now();
    if (batteryStartPct == null) {
      batteryStartPct = levelPct;
      batteryStartTime = t;
    }
    batterySamples.push({ t, levelPct });
    if (batterySamples.length > BATTERY_MAX_SAMPLES) {
      batterySamples.shift();
    }
    updateBatteryUI();
  }

  async function initBatteryTracking() {
    const hintEl = document.getElementById("batteryHint");
    if (!navigator.getBattery) {
      if (hintEl) {
        hintEl.textContent =
          "Battery Status API not supported (e.g. iOS Safari). Level tracking unavailable.";
      }
      document.getElementById("batteryLevel").textContent = "N/A";
      return;
    }
    try {
      batteryManager = await navigator.getBattery();
      recordBatterySample();
      batteryManager.addEventListener("levelchange", recordBatterySample);
      batteryManager.addEventListener("chargingchange", updateBatteryUI);
      // Poll in case levelchange is sparse (some devices only fire on 1% steps)
      batteryPollTimer = setInterval(recordBatterySample, 1000);
      updateBatteryUI();
    } catch (err) {
      if (hintEl) {
        hintEl.textContent = "Battery API error: " + (err.message || err);
      }
      document.getElementById("batteryLevel").textContent = "N/A";
    }
  }

  // ---------- Torch ----------
  let torchStream = null;
  let torchTrack = null;

  async function setTorch(on) {
    const status = document.getElementById("torchStatus");
    try {
      if (on) {
        // Prefer a dedicated stream for torch so it can stay on independently
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            // Some browsers accept torch in constraints
          },
          audio: false,
        });
        torchStream = stream;
        torchTrack = stream.getVideoTracks()[0];

        const capabilities = torchTrack.getCapabilities?.() || {};
        if (capabilities.torch) {
          await torchTrack.applyConstraints({
            advanced: [{ torch: true }],
          });
          // Try to push brightness if supported (rare)
          if (capabilities.brightness) {
            try {
              await torchTrack.applyConstraints({
                advanced: [{ brightness: capabilities.brightness.max }],
              });
            } catch (_) {}
          }
          status.textContent = "On (max brightness)";
          status.className = "status on";
          active.torch = true;
        } else {
          // Fallback: keep stream alive; torch may not be controllable
          status.textContent = "Camera open — torch not supported on this device/browser";
          status.className = "status warn";
          active.torch = true; // still costs camera power
        }
      } else {
        if (torchTrack) {
          try {
            await torchTrack.applyConstraints({ advanced: [{ torch: false }] });
          } catch (_) {}
          torchTrack.stop();
        }
        if (torchStream) {
          torchStream.getTracks().forEach((t) => t.stop());
        }
        torchStream = null;
        torchTrack = null;
        status.textContent = "Off";
        status.className = "status";
        active.torch = false;
      }
    } catch (err) {
      status.textContent = "Error: " + (err.message || err.name);
      status.className = "status warn";
      document.getElementById("torchToggle").checked = false;
      active.torch = false;
    }
    updatePower();
  }

  document.getElementById("torchToggle").addEventListener("change", (e) => {
    setTorch(e.target.checked);
  });

  // ---------- Camera (rear) ----------
  let cameraStream = null;

  async function setCamera(on) {
    const video = document.getElementById("cameraPreview");
    const wrap = document.querySelector(".camera-wrap");
    const status = document.getElementById("cameraStatus");

    try {
      if (on) {
        // Request maximum resolution + frame rate the device will give
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 4096 },
            height: { ideal: 2160 },
            frameRate: { ideal: 60 },
          },
          audio: false,
        });

        const track = cameraStream.getVideoTracks()[0];
        const caps = track.getCapabilities?.() || {};
        const advanced = {};
        if (caps.width?.max) advanced.width = caps.width.max;
        if (caps.height?.max) advanced.height = caps.height.max;
        if (caps.frameRate?.max) advanced.frameRate = caps.frameRate.max;
        if (Object.keys(advanced).length) {
          try {
            await track.applyConstraints({ advanced: [advanced] });
          } catch (_) {
            // Some browsers reject combined max constraints — try one at a time
            try {
              if (caps.width?.max && caps.height?.max) {
                await track.applyConstraints({
                  width: caps.width.max,
                  height: caps.height.max,
                });
              }
            } catch (_) {}
            try {
              if (caps.frameRate?.max) {
                await track.applyConstraints({ frameRate: caps.frameRate.max });
              }
            } catch (_) {}
          }
        }

        video.srcObject = cameraStream;
        wrap.classList.add("active");

        const settings = track.getSettings?.() || {};
        const res =
          (settings.width && settings.height)
            ? `${settings.width}×${settings.height}`
            : "max";
        const fpsStr = settings.frameRate
          ? ` · ${Math.round(settings.frameRate)} fps`
          : "";
        status.textContent = `Rear camera active — ${res}${fpsStr}`;
        status.className = "status on";
        active.camera = true;
      } else {
        if (cameraStream) {
          cameraStream.getTracks().forEach((t) => t.stop());
          cameraStream = null;
        }
        video.srcObject = null;
        wrap.classList.remove("active");
        status.textContent = "Off";
        status.className = "status";
        active.camera = false;
      }
    } catch (err) {
      status.textContent = "Error: " + (err.message || err.name);
      status.className = "status warn";
      document.getElementById("cameraToggle").checked = false;
      active.camera = false;
    }
    updatePower();
  }

  document.getElementById("cameraToggle").addEventListener("change", (e) => {
    setCamera(e.target.checked);
  });

  // ---------- Vibration ----------
  let vibrateTimer = null;

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function setVibrate(on) {
    const status = document.getElementById("vibrateStatus");
    if (on) {
      // iOS Safari / WebKit: Vibration API is not implemented at all
      if (isIOS() || typeof navigator.vibrate !== "function") {
        status.textContent = isIOS()
          ? "Not available on iOS Safari (Apple blocks Vibration API)"
          : "Vibration API not supported in this browser";
        status.className = "status warn";
        document.getElementById("vibrateToggle").checked = false;
        active.vibrate = false;
        updatePower();
        return;
      }
      // Continuous pattern loop (Android Chrome / Firefox)
      const pattern = [200, 50, 200, 50];
      const ok = navigator.vibrate(pattern);
      if (!ok) {
        status.textContent = "Vibrate call failed / blocked by OS";
        status.className = "status warn";
        document.getElementById("vibrateToggle").checked = false;
        active.vibrate = false;
        updatePower();
        return;
      }
      vibrateTimer = setInterval(() => {
        navigator.vibrate(pattern);
      }, 300);
      status.textContent = "Vibrating…";
      status.className = "status on";
      active.vibrate = true;
    } else {
      if (vibrateTimer) {
        clearInterval(vibrateTimer);
        vibrateTimer = null;
      }
      if (typeof navigator.vibrate === "function") navigator.vibrate(0);
      status.textContent = "Off";
      status.className = "status";
      active.vibrate = false;
    }
    updatePower();
  }

  document.getElementById("vibrateToggle").addEventListener("change", (e) => {
    setVibrate(e.target.checked);
  });

  // ---------- Location ping (continuous, resilient to timeouts) ----------
  let locationWatchId = null;
  let locationPingTimer = null;
  let locationCount = 0;
  let locationLast = null;
  let locationPending = false;
  let locationTimeouts = 0;
  let locationHighAccuracy = true;

  function formatLoc(pos) {
    const c = pos.coords;
    return (
      c.latitude.toFixed(5) + ", " + c.longitude.toFixed(5) +
      " ±" + Math.round(c.accuracy) + "m" +
      (c.altitude != null ? " · alt " + Math.round(c.altitude) + "m" : "")
    );
  }

  function showLocationOk(pos) {
    const status = document.getElementById("locationStatus");
    if (!active.location) return;
    locationCount++;
    locationLast = pos;
    locationTimeouts = 0;
    status.textContent = "Ping #" + locationCount + " — " + formatLoc(pos);
    status.className = "status on";
  }

  function showLocationWait(msg) {
    const status = document.getElementById("locationStatus");
    if (!active.location) return;
    // Keep last good fix visible when possible
    const tail = locationLast ? " · last: " + formatLoc(locationLast) : "";
    status.textContent = msg + tail;
    status.className = "status warn";
  }

  function geoOpts(high, timeoutMs) {
    return {
      enableHighAccuracy: high,
      maximumAge: high ? 2000 : 10000, // allow slight cache to reduce timeouts
      timeout: timeoutMs,
    };
  }

  function requestOneLocation() {
    if (!navigator.geolocation || !active.location) return;
    // Avoid stacking requests while one is still pending
    if (locationPending) return;
    locationPending = true;

    const tryHigh = locationHighAccuracy;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locationPending = false;
        locationHighAccuracy = true; // recover high accuracy after success
        showLocationOk(pos);
      },
      (err) => {
        locationPending = false;
        if (!active.location) return;

        // 1 = permission denied, 2 = position unavailable, 3 = timeout
        if (err.code === 1) {
          showLocationWait("Permission denied — enable location for this site");
          return;
        }

        if (err.code === 3 || (err.message || "").toLowerCase().includes("timeout")) {
          locationTimeouts++;
          // After a few high-accuracy timeouts, fall back to network/coarse
          if (tryHigh && locationTimeouts >= 2) {
            locationHighAccuracy = false;
            showLocationWait("GPS slow — trying network location…");
            // Immediate coarse retry
            locationPending = true;
            navigator.geolocation.getCurrentPosition(
              (pos) => {
                locationPending = false;
                showLocationOk(pos);
              },
              () => {
                locationPending = false;
                showLocationWait("Waiting for fix (timeout) — still pinging…");
              },
              geoOpts(false, 30000)
            );
            return;
          }
          showLocationWait("Waiting for GPS fix…");
          return;
        }

        showLocationWait("Unavailable — retrying…");
      },
      geoOpts(tryHigh, tryHigh ? 45000 : 30000)
    );
  }

  function setLocation(on) {
    const status = document.getElementById("locationStatus");
    if (on) {
      if (!navigator.geolocation) {
        status.textContent = "Geolocation not supported";
        status.className = "status warn";
        document.getElementById("locationToggle").checked = false;
        return;
      }
      locationCount = 0;
      locationTimeouts = 0;
      locationPending = false;
      locationHighAccuracy = true;
      active.location = true;
      updatePower();
      status.textContent = "Requesting location (high accuracy)…";
      status.className = "status on";

      try {
        locationWatchId = navigator.geolocation.watchPosition(
          (pos) => {
            showLocationOk(pos);
          },
          (err) => {
            if (!active.location) return;
            // Don't surface every watch timeout as a hard error
            if (err.code === 3) {
              showLocationWait("Watch waiting for GPS…");
            } else if (err.code === 1) {
              showLocationWait("Permission denied — enable location for this site");
            } else {
              showLocationWait("Watch: retrying…");
            }
          },
          {
            enableHighAccuracy: true,
            maximumAge: 5000,
            timeout: 60000,
          }
        );
      } catch (_) {}

      requestOneLocation();
      // 5s interval — less overlap with long GPS timeouts
      locationPingTimer = setInterval(requestOneLocation, 5000);
    } else {
      active.location = false;
      locationPending = false;
      if (locationWatchId != null && navigator.geolocation) {
        try {
          navigator.geolocation.clearWatch(locationWatchId);
        } catch (_) {}
        locationWatchId = null;
      }
      if (locationPingTimer) {
        clearInterval(locationPingTimer);
        locationPingTimer = null;
      }
      status.textContent =
        locationCount > 0
          ? "Off — " + locationCount + " pings total"
          : "Off";
      status.className = "status";
      updatePower();
    }
  }

  document.getElementById("locationToggle").addEventListener("change", (e) => {
    setLocation(e.target.checked);
  });

  // ---------- CPU stress (Web Workers busy loops) ----------
  let cpuWorkers = [];
  let cpuOps = [];
  let cpuStatusTimer = null;
  let cpuBlobUrl = null;

  const CPU_WORKER_SRC = `
    let running = false;
    let ops = 0;
    function burn() {
      // Mix of integer + float work so optimizers can't eliminate it
      let x = 1.0001;
      let n = 0x9e3779b9 | 0;
      for (let i = 0; i < 50000; i++) {
        n = (Math.imul(n, 1664525) + 1013904223) | 0;
        x = Math.sin(x + (n & 0xffff) * 1e-6) * 1.0000001 + 0.5;
        ops++;
      }
      if (running) {
        // Yield to the event loop so the worker can receive stop messages
        setTimeout(burn, 0);
      }
    }
    self.onmessage = function (e) {
      if (e.data === "start") {
        running = true;
        ops = 0;
        burn();
      } else if (e.data === "stop") {
        running = false;
      } else if (e.data === "stats") {
        self.postMessage({ ops: ops });
        ops = 0;
      }
    };
  `;

  function initCpuSlider() {
    const cores = navigator.hardwareConcurrency || 4;
    const slider = document.getElementById("cpuWorkersSlider");
    const max = Math.min(16, Math.max(cores * 2, cores));
    slider.max = String(max);
    cpuWorkerCount = Math.min(max, Math.max(1, cores));
    slider.value = String(cpuWorkerCount);
    document.getElementById("cpuWorkersValue").textContent =
      cpuWorkerCount + " (cores: " + cores + ")";
  }

  function stopCpuWorkers() {
    cpuWorkers.forEach((w) => {
      try {
        w.postMessage("stop");
        w.terminate();
      } catch (_) {}
    });
    cpuWorkers = [];
    cpuOps = [];
    if (cpuStatusTimer) {
      clearInterval(cpuStatusTimer);
      cpuStatusTimer = null;
    }
    if (cpuBlobUrl) {
      URL.revokeObjectURL(cpuBlobUrl);
      cpuBlobUrl = null;
    }
  }

  function setCpu(on) {
    const status = document.getElementById("cpuStatus");
    if (on) {
      if (typeof Worker === "undefined") {
        status.textContent = "Web Workers not supported";
        status.className = "status warn";
        document.getElementById("cpuToggle").checked = false;
        return;
      }
      stopCpuWorkers();
      const n = parseInt(document.getElementById("cpuWorkersSlider").value, 10) || cpuWorkerCount;
      cpuWorkerCount = n;
      try {
        const blob = new Blob([CPU_WORKER_SRC], { type: "application/javascript" });
        cpuBlobUrl = URL.createObjectURL(blob);
        for (let i = 0; i < n; i++) {
          const w = new Worker(cpuBlobUrl);
          cpuWorkers.push(w);
          cpuOps[i] = 0;
          w.onmessage = (ev) => {
            if (ev.data && typeof ev.data.ops === "number") {
              cpuOps[i] = ev.data.ops;
            }
          };
          w.postMessage("start");
        }
      } catch (err) {
        status.textContent = "Error: " + (err.message || err);
        status.className = "status warn";
        document.getElementById("cpuToggle").checked = false;
        stopCpuWorkers();
        return;
      }
      active.cpu = true;
      updatePower();
      status.textContent = "Running " + n + " workers…";
      status.className = "status on";

      cpuStatusTimer = setInterval(() => {
        if (!active.cpu) return;
        cpuWorkers.forEach((w) => {
          try { w.postMessage("stats"); } catch (_) {}
        });
        // Aggregate after a short delay so messages arrive
        setTimeout(() => {
          if (!active.cpu) return;
          const total = cpuOps.reduce((a, b) => a + b, 0);
          const mops = (total / 1e6).toFixed(1);
          status.textContent =
            n + " workers · ~" + mops + " M ops/s (tab must stay visible)";
          status.className = "status on";
        }, 80);
      }, 1000);
    } else {
      active.cpu = false;
      stopCpuWorkers();
      status.textContent = "Off";
      status.className = "status";
      updatePower();
    }
  }

  initCpuSlider();

  document.getElementById("cpuToggle").addEventListener("change", (e) => {
    setCpu(e.target.checked);
  });

  document.getElementById("cpuWorkersSlider").addEventListener("input", (e) => {
    const v = parseInt(e.target.value, 10);
    cpuWorkerCount = v;
    const cores = navigator.hardwareConcurrency || 4;
    document.getElementById("cpuWorkersValue").textContent =
      v + " (cores: " + cores + ")";
    if (active.cpu) {
      // Restart with new worker count
      setCpu(false);
      document.getElementById("cpuToggle").checked = true;
      setCpu(true);
    } else {
      updatePower();
    }
  });

  // ---------- Network download stress ----------
  // Public large-ish files that support range / repeated fetch.
  // We use multiple sources and also generate dummy downloads via blob URLs.
  const DOWNLOAD_URLS = [
    // Cloudflare / common CDNs often allow CORS or at least partial
    "https://speed.cloudflare.com/__down?bytes=25000000", // 25 MB
    "https://proof.ovh.net/files/10Mb.dat",
    "https://ash-speed.hetzner.com/100MB.bin",
  ];

  let downloadAbort = null;
  let downloadBytes = 0;
  let downloadStart = 0;
  let downloadTimeout = null;
  // Rolling window for instantaneous-ish speed
  let speedWindowBytes = 0;
  let speedWindowStart = 0;

  function formatMB(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1);
  }

  function formatMbPerSec(bytesPerSec) {
    // Mb/s = megabits per second
    return ((bytesPerSec * 8) / 1e6).toFixed(1);
  }

  async function runDownloadLoop(durationSec) {
    const status = document.getElementById("downloadStatus");
    downloadAbort = new AbortController();
    downloadBytes = 0;
    downloadStart = performance.now();
    speedWindowBytes = 0;
    speedWindowStart = downloadStart;
    active.download = true;
    updatePower();

    const endAt = durationSec > 0 ? downloadStart + durationSec * 1000 : Infinity;

    const updateStatus = () => {
      const now = performance.now();
      const elapsedSec = (now - downloadStart) / 1000;
      const windowSec = (now - speedWindowStart) / 1000;

      // Reset rolling window every ~1.5s for responsive speed
      if (windowSec >= 1.5) {
        speedWindowBytes = 0;
        speedWindowStart = now;
      }

      const avgBytesPerSec = elapsedSec > 0.05 ? downloadBytes / elapsedSec : 0;
      const instBytesPerSec = windowSec > 0.05 ? speedWindowBytes / windowSec : avgBytesPerSec;
      const speed = formatMbPerSec(instBytesPerSec || avgBytesPerSec);

      status.textContent =
        `Downloading… ${formatMB(downloadBytes)} MB · ${speed} Mb/s · ${elapsedSec.toFixed(0)}s`;
      status.className = "status on";
    };

    let urlIndex = 0;
    // Keep multiple downloads in flight so traffic never pauses between requests
    const CONCURRENCY = 4;

    async function oneDownload() {
      while (performance.now() < endAt && !downloadAbort.signal.aborted) {
        const url = DOWNLOAD_URLS[urlIndex % DOWNLOAD_URLS.length] + "&t=" + Date.now() + "&r=" + Math.random();
        urlIndex++;

        try {
          const res = await fetch(url, {
            signal: downloadAbort.signal,
            cache: "no-store",
            mode: "cors",
          });
          if (!res.ok && res.status !== 0) continue;

          const reader = res.body?.getReader();
          if (reader) {
            while (true) {
              if (performance.now() >= endAt || downloadAbort.signal.aborted) {
                try { reader.cancel(); } catch (_) {}
                break;
              }
              const { done, value } = await reader.read();
              if (done) break;
              downloadBytes += value.byteLength;
              speedWindowBytes += value.byteLength;
              updateStatus();
            }
          } else {
            const buf = await res.arrayBuffer();
            downloadBytes += buf.byteLength;
            speedWindowBytes += buf.byteLength;
            updateStatus();
          }
        } catch (err) {
          if (err.name === "AbortError") return;
          // Fallback: local memory churn — no delay, loop immediately
          const size = 16 * 1024 * 1024;
          const buffer = new ArrayBuffer(size);
          const view = new Uint8Array(buffer);
          for (let i = 0; i < size; i += 2048) view[i] = i & 0xff;
          downloadBytes += size;
          speedWindowBytes += size;
          updateStatus();
          const blob = new Blob([buffer]);
          const objUrl = URL.createObjectURL(blob);
          try {
            await fetch(objUrl, { signal: downloadAbort.signal, cache: "no-store" });
          } catch (_) {}
          URL.revokeObjectURL(objUrl);
          // no sleep — immediately start next chunk
        }
      }
    }

    try {
      // Launch concurrent workers so bandwidth stays saturated
      await Promise.all(
        Array.from({ length: CONCURRENCY }, () => oneDownload())
      );
    } finally {
      active.download = false;
      updatePower();
      const elapsedSec = (performance.now() - downloadStart) / 1000;
      const avgSpeed = elapsedSec > 0 ? formatMbPerSec(downloadBytes / elapsedSec) : "0.0";
      status.textContent =
        `Stopped — ${formatMB(downloadBytes)} MB · avg ${avgSpeed} Mb/s · ${elapsedSec.toFixed(0)}s`;
      status.className = "status";
      document.getElementById("downloadToggle").checked = false;
      downloadAbort = null;
    }
  }

  function stopDownload() {
    if (downloadAbort) {
      downloadAbort.abort();
    }
    if (downloadTimeout) {
      clearTimeout(downloadTimeout);
      downloadTimeout = null;
    }
  }

  document.getElementById("downloadToggle").addEventListener("change", (e) => {
    if (e.target.checked) {
      const dur = parseInt(document.getElementById("downloadDuration").value, 10) || 0;
      runDownloadLoop(dur);
    } else {
      stopDownload();
    }
  });

  // ---------- GPU stress: Canvas Julia OR WebGL volume raymarch (lag mode) ----------
  let canvas = document.getElementById("fractalCanvas");
  let ctx2d = null;
  let gl = null;
  let gpuAnimId = null;
  let lastFpsTime = 0;
  let frameCount = 0;
  let fps = 0;
  let time = 0;
  let gpuMode = "canvas"; // "canvas" | "webgl"

  // Canvas dynamic load
  let loadLevel = 40;
  let goalFps = 30;
  let currentW = 160;
  let currentH = 160;
  let maxIter = 32;
  let imageData = null;
  let data = null;

  // WebGL state — adaptive load toward goal FPS
  let glProgram = null;
  let glTimeLoc = null;
  let glResLoc = null;
  let glStepsLoc = null;
  let glBuf = null;
  let webglLoad = 70; // 0–100, drives resolution scale + ray steps + passes
  let webglSteps = 160;
  let webglScale = 1.2;
  let webglPasses = 2; // extra full-screen draws per frame to saturate GPU

  function resetCanvasElement() {
    // Replace canvas so we can switch between 2d and webgl contexts cleanly
    const parent = canvas.parentNode;
    const next = canvas.cloneNode(false);
    next.width = 400;
    next.height = 400;
    parent.replaceChild(next, canvas);
    canvas = next;
    ctx2d = null;
    gl = null;
    glProgram = null;
  }

  function applyLoadLevel(level) {
    loadLevel = Math.max(5, Math.min(100, level));
    const side = Math.round(160 + (loadLevel / 100) * 800);
    currentW = side;
    currentH = side;
    maxIter = Math.round(32 + (loadLevel / 100) * 288);

    if (!ctx2d) ctx2d = canvas.getContext("2d", { alpha: false });
    canvas.width = currentW;
    canvas.height = currentH;
    imageData = ctx2d.createImageData(currentW, currentH);
    data = imageData.data;

    document.getElementById("loadCounter").textContent =
      Math.round(loadLevel) + "% (" + currentW + "px · " + maxIter + " iter)";
  }

  function renderFractal(t) {
    const cx = Math.sin(t * 0.7) * 0.6;
    const cy = Math.cos(t * 0.5) * 0.5;
    const scale = 2.6 / currentW;
    const W = currentW;
    const H = currentH;
    const iters = maxIter;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let zx = (x - W / 2) * scale;
        let zy = (y - H / 2) * scale;
        let i = 0;
        while (zx * zx + zy * zy < 4 && i < iters) {
          const tmp = zx * zx - zy * zy + cx;
          zy = 2 * zx * zy + cy;
          zx = tmp;
          i++;
        }
        const idx = (y * W + x) * 4;
        if (i === iters) {
          data[idx] = 0;
          data[idx + 1] = 0;
          data[idx + 2] = 0;
        } else {
          const v = i / iters;
          data[idx] = Math.floor(20 + v * 180);
          data[idx + 1] = Math.floor(40 + Math.sin(v * 12 + t) * 80 + 80);
          data[idx + 2] = Math.floor(120 + v * 135);
        }
        data[idx + 3] = 255;
      }
    }
    ctx2d.putImageData(imageData, 0, 0);
  }

  function adjustLoadTowardGoal() {
    if (fps <= 0) return;
    const error = goalFps - fps;
    if (Math.abs(error) < 2) return;
    const step = Math.max(1, Math.min(8, Math.abs(error) * 0.6));
    if (error < 0) applyLoadLevel(loadLevel + step);
    else applyLoadLevel(loadLevel - step);
  }

  // ---- WebGL volume raymarch — heavy GPU load, adaptive to goal FPS ----
  const VERT_SRC = `
    attribute vec2 a_pos;
    void main() {
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  // Extreme fragment: forced-cost raymarch (no early-outs that skip work)
  const FRAG_SRC = `
    precision highp float;
    uniform float u_time;
    uniform vec2 u_res;
    uniform float u_steps;

    float mandelbulb(vec3 pos) {
      vec3 z = pos;
      float dr = 1.0;
      float r = 0.0;
      const float power = 8.0;
      for (int i = 0; i < 20; i++) {
        r = length(z);
        if (r > 4.0) break;
        float theta = acos(clamp(z.z / max(r, 1e-6), -1.0, 1.0));
        float phi = atan(z.y, z.x);
        dr = pow(max(r, 1e-6), power - 1.0) * power * dr + 1.0;
        float zr = pow(max(r, 1e-6), power);
        theta *= power;
        phi *= power;
        z = zr * vec3(sin(theta) * cos(phi), sin(phi) * sin(theta), cos(theta));
        z += pos;
      }
      return 0.5 * log(max(r, 1e-6)) * r / max(dr, 1e-6);
    }

    float map(vec3 p) {
      float a = u_time * 0.35;
      float c = cos(a), s = sin(a);
      p.xz = mat2(c, -s, s, c) * p.xz;
      float b = u_time * 0.21;
      float cb = cos(b), sb = sin(b);
      p.xy = mat2(cb, -sb, sb, cb) * p.xy;
      return mandelbulb(p * 0.95);
    }

    vec3 calcNormal(vec3 p) {
      const float e = 0.0006;
      return normalize(vec3(
        map(p + vec3(e, 0.0, 0.0)) - map(p - vec3(e, 0.0, 0.0)),
        map(p + vec3(0.0, e, 0.0)) - map(p - vec3(0.0, e, 0.0)),
        map(p + vec3(0.0, 0.0, e)) - map(p - vec3(0.0, 0.0, e))
      ));
    }

    float softShadow(vec3 ro, vec3 rd) {
      float res = 1.0;
      float t = 0.02;
      for (int i = 0; i < 12; i++) {
        float h = map(ro + rd * t);
        res = min(res, 8.0 * h / t);
        t += clamp(h, 0.02, 0.2);
        if (res < 0.05 || t > 4.0) break;
      }
      return clamp(res, 0.0, 1.0);
    }

    float ao(vec3 p, vec3 n) {
      float occ = 0.0;
      float sca = 1.0;
      for (int i = 0; i < 5; i++) {
        float hr = 0.01 + 0.12 * float(i);
        float dd = map(p + n * hr);
        occ += (hr - dd) * sca;
        sca *= 0.85;
      }
      return clamp(1.0 - 2.0 * occ, 0.0, 1.0);
    }

    void main() {
      vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
      vec3 ro = vec3(0.0, 0.0, 2.85);
      vec3 rd = normalize(vec3(uv, -1.3));

      float t = 0.0;
      float d = 1.0;
      int hit = 0;
      for (int i = 0; i < 1536; i++) {
        if (float(i) >= u_steps) break;
        vec3 p = ro + rd * t;
        d = map(p);
        if (d < 0.002) { hit = 1; break; }
        t += d * 0.8;
        if (t > 14.0) break;
      }

      vec3 col = vec3(0.012, 0.012, 0.035);
      if (hit == 1) {
        vec3 p = ro + rd * t;
        vec3 n = calcNormal(p);
        vec3 light = normalize(vec3(0.5, 0.9, 0.3));
        float diff = max(dot(n, light), 0.0);
        float sh = softShadow(p + n * 0.008, light);
        float occ = ao(p, n);
        float fre = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
        vec3 base = 0.5 + 0.5 * cos(vec3(0.0, 2.0, 4.0) + length(p) * 2.4 + u_time);
        col = base * (0.1 + 0.9 * diff * sh) * occ + fre * 0.5;
      } else {
        col += 0.06 * vec3(0.12, 0.22, 0.5) * (1.0 - length(uv));
      }
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  function compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn(gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  function applyWebglLoad(level) {
    // Allow >100 for sub-15 FPS targets (extra passes / scale / steps)
    webglLoad = Math.max(5, Math.min(200, level));
    const t = Math.min(webglLoad, 100) / 100;
    const over = Math.max(0, webglLoad - 100); // 0–100 beyond 100%

    // scale: 0.45 → 2.0 at 100%, up to ~3.2 past 100%
    webglScale = 0.45 + t * 1.55 + over * 0.012;
    // ray steps ×1.5: ~72 → 720 at 100%, up to ~1350 past 100%
    webglSteps = Math.round((48 + t * 432 + over * 4.2) * 1.5);
    // passes: 1 → 6 at 100%, up to 16 past 100%
    webglPasses = Math.max(1, Math.round(1 + t * 5 + over * 0.1));

    if (!gl) return;

    const cssW = Math.min(window.innerWidth - 28, 480);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.min(2048, Math.round(cssW * dpr * webglScale));
    const h = Math.min(2048, Math.round(cssW * dpr * webglScale));
    if (Math.abs(canvas.width - w) > 4 || Math.abs(canvas.height - h) > 4) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = cssW + "px";
      canvas.style.height = cssW + "px";
      gl.viewport(0, 0, w, h);
      if (glResLoc) gl.uniform2f(glResLoc, w, h);
    }
    if (glStepsLoc) gl.uniform1f(glStepsLoc, webglSteps);

    const pct = webglLoad > 100 ? Math.round(webglLoad) + "%+" : Math.round(webglLoad) + "%";
    document.getElementById("loadCounter").textContent =
      pct + " (" + canvas.width + "px · " + webglSteps + " steps · ×" + webglPasses + ")";
  }

  function startLoadForGoal(g) {
    // Always begin at 100%; adaptive control only increases from there
    void g;
    return 100;
  }

  function adjustWebglTowardGoal() {
    if (fps <= 0) return;
    const error = goalFps - fps;
    const dead = goalFps <= 10 ? 1 : goalFps < 15 ? 1.5 : 3;
    if (Math.abs(error) < dead) return;

    let step = Math.max(3, Math.min(12, Math.abs(error) * 0.8));
    // Near/below 10 FPS goal: push steps/passes hard if still too fast
    if (error < 0 && goalFps <= 10) {
      step = Math.max(10, Math.min(25, Math.abs(error) * 2));
    } else if (error < 0 && goalFps < 15) {
      step = Math.max(6, Math.min(20, Math.abs(error) * 1.5));
    }
    if (error < 0) {
      // FPS too high → increase load (never start path below 100%)
      applyWebglLoad(webglLoad + step);
    } else if (webglLoad > 100) {
      // Only ease off above the 100% floor
      applyWebglLoad(Math.max(100, webglLoad - step));
    }
  }

  function initWebGL() {
    resetCanvasElement();
    gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    }) || canvas.getContext("experimental-webgl");
    if (!gl) return false;

    const vs = compileShader(gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) return false;

    glProgram = gl.createProgram();
    gl.attachShader(glProgram, vs);
    gl.attachShader(glProgram, fs);
    gl.linkProgram(glProgram);
    if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
      console.warn(gl.getProgramInfoLog(glProgram));
      return false;
    }
    gl.useProgram(glProgram);

    glTimeLoc = gl.getUniformLocation(glProgram, "u_time");
    glResLoc = gl.getUniformLocation(glProgram, "u_res");
    glStepsLoc = gl.getUniformLocation(glProgram, "u_steps");

    const posLoc = gl.getAttribLocation(glProgram, "a_pos");
    glBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    applyWebglLoad(startLoadForGoal(goalFps));
    return true;
  }

  function renderWebGL(t) {
    if (!gl || !glProgram) return;
    gl.uniform1f(glTimeLoc, t);
    // Multiple passes = more GPU time per displayed frame
    for (let i = 0; i < webglPasses; i++) {
      gl.uniform1f(glTimeLoc, t + i * 0.01);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  function gpuLoop(now) {
    time += 0.016;
    if (gpuMode === "webgl") {
      renderWebGL(time);
    } else {
      renderFractal(time);
    }

    frameCount++;
    if (now - lastFpsTime >= 500) {
      fps = Math.round((frameCount * 1000) / (now - lastFpsTime));
      document.getElementById("fpsCounter").textContent = fps;
      frameCount = 0;
      lastFpsTime = now;
      if (gpuMode === "canvas") adjustLoadTowardGoal();
      else adjustWebglTowardGoal();
    }

    gpuAnimId = requestAnimationFrame(gpuLoop);
  }

  function updateModeUI() {
    const mode = document.getElementById("gpuMode").value;
    document.getElementById("goalFpsLabel").textContent = String(goalFps);
    document.getElementById("gpuHint").textContent = mode === "webgl"
      ? "WebGL volume raymarch. Load auto-scales to goal FPS — lower goal = harder lag. Close tab to stop."
      : "Canvas Julia set. Load auto-adjusts toward goal FPS.";
  }

  function setGpu(on) {
    if (on) {
      gpuMode = document.getElementById("gpuMode").value || "canvas";
      goalFps = parseInt(document.getElementById("goalFpsSlider").value, 10) || 15;
      updateModeUI();

      if (gpuMode === "webgl") {
        if (!initWebGL()) {
          document.getElementById("loadCounter").textContent = "WebGL not supported";
          document.getElementById("gpuToggle").checked = false;
          return;
        }
      } else {
        resetCanvasElement();
        applyLoadLevel(40);
      }

      lastFpsTime = performance.now();
      frameCount = 0;
      time = 0;
      active.gpu = true;
      updatePower();
      gpuAnimId = requestAnimationFrame(gpuLoop);
    } else {
      if (gpuAnimId) {
        cancelAnimationFrame(gpuAnimId);
        gpuAnimId = null;
      }
      if (gl) {
        const lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
        gl = null;
      }
      resetCanvasElement();
      document.getElementById("fpsCounter").textContent = "0";
      document.getElementById("loadCounter").textContent = "—";
      active.gpu = false;
      updatePower();
    }
  }

  document.getElementById("gpuToggle").addEventListener("change", (e) => {
    setGpu(e.target.checked);
  });

  document.getElementById("goalFpsSlider").addEventListener("input", (e) => {
    const v = parseInt(e.target.value, 10);
    goalFps = v;
    document.getElementById("goalFpsValue").textContent = v;
    document.getElementById("goalFpsLabel").textContent = v;
    // Immediately bias load toward a sensible level for the new goal
    if (active.gpu && gpuMode === "webgl") {
      const target = startLoadForGoal(v);
      // Blend current load toward target so slider feels responsive
      applyWebglLoad(webglLoad * 0.4 + target * 0.6);
    } else if (active.gpu && gpuMode === "canvas") {
      // Nudge canvas load similarly
      const target = v >= 50 ? 25 : v >= 30 ? 45 : v >= 15 ? 65 : 85;
      applyLoadLevel(loadLevel * 0.4 + target * 0.6);
    }
  });

  document.getElementById("gpuMode").addEventListener("change", () => {
    updateModeUI();
    if (document.getElementById("gpuToggle").checked) {
      setGpu(false);
      setGpu(true);
    }
  });

  window.addEventListener("resize", () => {
    if (active.gpu && gpuMode === "webgl") applyWebglLoad(webglLoad);
  });

  goalFps = 15;
  updateModeUI();

  // ---------- Microphone (amplitude + peak frequency) ----------
  let micStream = null;
  let micAudioCtx = null;
  let micAnalyser = null;
  let micSource = null;
  let micRaf = null;
  let micTimeData = null;
  let micFreqData = null;

  function stopMic() {
    if (micRaf) {
      cancelAnimationFrame(micRaf);
      micRaf = null;
    }
    if (micSource) {
      try { micSource.disconnect(); } catch (_) {}
      micSource = null;
    }
    if (micAnalyser) {
      try { micAnalyser.disconnect(); } catch (_) {}
      micAnalyser = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    if (micAudioCtx) {
      try { micAudioCtx.close(); } catch (_) {}
      micAudioCtx = null;
    }
    micTimeData = null;
    micFreqData = null;
    const ampBar = document.getElementById("micAmpBar");
    const freqBar = document.getElementById("micFreqBar");
    if (ampBar) ampBar.style.width = "0%";
    if (freqBar) freqBar.style.width = "0%";
    const ampVal = document.getElementById("micAmpValue");
    const freqVal = document.getElementById("micFreqValue");
    if (ampVal) ampVal.textContent = "0%";
    if (freqVal) freqVal.textContent = "— Hz";
  }

  function micLoop() {
    if (!micAnalyser || !active.mic) return;

    micAnalyser.getByteTimeDomainData(micTimeData);
    // RMS amplitude 0–1 from time domain (128 = silence)
    let sumSq = 0;
    for (let i = 0; i < micTimeData.length; i++) {
      const v = (micTimeData[i] - 128) / 128;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / micTimeData.length);
    // Scale for display (typical speech ~0.05–0.3)
    const ampPct = Math.min(100, Math.round(rms * 250));

    micAnalyser.getByteFrequencyData(micFreqData);
    // Dominant frequency bin (skip DC bin 0)
    let maxBin = 1;
    let maxVal = 0;
    for (let i = 1; i < micFreqData.length; i++) {
      if (micFreqData[i] > maxVal) {
        maxVal = micFreqData[i];
        maxBin = i;
      }
    }
    const sampleRate = micAudioCtx.sampleRate;
    const binHz = sampleRate / micAnalyser.fftSize;
    const peakHz = Math.round(maxBin * binHz);
    // Only show frequency if there's meaningful energy
    const hasSignal = ampPct >= 2 && maxVal > 20;

    document.getElementById("micAmpBar").style.width = ampPct + "%";
    document.getElementById("micAmpValue").textContent = ampPct + "%";
    if (hasSignal) {
      const freqPct = Math.min(100, (peakHz / 4000) * 100);
      document.getElementById("micFreqBar").style.width = freqPct + "%";
      document.getElementById("micFreqValue").textContent = peakHz + " Hz";
      document.getElementById("micStatus").textContent =
        "Live — amp " + ampPct + "% · peak ~" + peakHz + " Hz";
    } else {
      document.getElementById("micFreqBar").style.width = "0%";
      document.getElementById("micFreqValue").textContent = "— Hz";
      document.getElementById("micStatus").textContent = "Listening… (quiet)";
    }
    document.getElementById("micStatus").className = "status on";

    micRaf = requestAnimationFrame(micLoop);
  }

  async function setMic(on) {
    const status = document.getElementById("micStatus");
    if (on) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
          video: false,
        });
        micAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (micAudioCtx.state === "suspended") await micAudioCtx.resume();
        micSource = micAudioCtx.createMediaStreamSource(micStream);
        micAnalyser = micAudioCtx.createAnalyser();
        micAnalyser.fftSize = 2048;
        micAnalyser.smoothingTimeConstant = 0.7;
        micSource.connect(micAnalyser);
        // Do not connect to destination (would cause feedback)
        micTimeData = new Uint8Array(micAnalyser.fftSize);
        micFreqData = new Uint8Array(micAnalyser.frequencyBinCount);
        active.mic = true;
        updatePower();
        status.textContent = "Listening…";
        status.className = "status on";
        micRaf = requestAnimationFrame(micLoop);
      } catch (err) {
        stopMic();
        status.textContent = "Error: " + (err.message || err.name);
        status.className = "status warn";
        document.getElementById("micToggle").checked = false;
        active.mic = false;
        updatePower();
      }
    } else {
      active.mic = false;
      stopMic();
      status.textContent = "Off";
      status.className = "status";
      updatePower();
    }
  }

  document.getElementById("micToggle").addEventListener("change", (e) => {
    setMic(e.target.checked);
  });

  // ---------- Tone generator ----------
  let audioCtx = null;
  let oscillator = null;
  let gainNode = null;

  function ensureAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
  }

  function setTone(on) {
    const status = document.getElementById("toneStatus");
    const freq = parseFloat(document.getElementById("freqSlider").value);
    const vol = parseFloat(document.getElementById("volSlider").value) / 100;

    if (on) {
      ensureAudio();
      if (oscillator) {
        try { oscillator.stop(); } catch (_) {}
        oscillator.disconnect();
      }
      oscillator = audioCtx.createOscillator();
      gainNode = audioCtx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = freq;
      gainNode.gain.value = vol * 0.5; // keep headroom
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      oscillator.start();
      status.textContent = `Playing ${freq} Hz`;
      status.className = "status on";
      active.tone = true;
    } else {
      if (oscillator) {
        try { oscillator.stop(); } catch (_) {}
        oscillator.disconnect();
        oscillator = null;
      }
      if (gainNode) {
        gainNode.disconnect();
        gainNode = null;
      }
      status.textContent = "Off";
      status.className = "status";
      active.tone = false;
    }
    updatePower();
  }

  document.getElementById("toneToggle").addEventListener("change", (e) => {
    setTone(e.target.checked);
  });

  document.getElementById("freqSlider").addEventListener("input", (e) => {
    const v = e.target.value;
    document.getElementById("freqValue").textContent = v;
    if (oscillator && active.tone) {
      oscillator.frequency.setValueAtTime(parseFloat(v), audioCtx.currentTime);
      document.getElementById("toneStatus").textContent = `Playing ${v} Hz`;
    }
  });

  document.getElementById("volSlider").addEventListener("input", (e) => {
    const v = e.target.value;
    document.getElementById("volValue").textContent = v;
    if (gainNode && active.tone) {
      gainNode.gain.setValueAtTime((parseFloat(v) / 100) * 0.5, audioCtx.currentTime);
    }
  });

  // ---------- Cleanup on page hide ----------
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      // Optional: you can leave stressors running intentionally
    }
  });

  window.addEventListener("pagehide", () => {
    stopDownload();
    setVibrate(false);
    setTorch(false);
    setCamera(false);
    setLocation(false);
    setCpu(false);
    setGpu(false);
    setMic(false);
    setTone(false);
  });

  // ---------- Light / dark theme ----------
  function applyTheme(light) {
    document.documentElement.classList.toggle("light", light);
    const btn = document.getElementById("themeToggle");
    if (btn) btn.textContent = light ? "Dark" : "Light";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", light ? "#f2f3f7" : "#0a0a0f");
    try {
      localStorage.setItem("pst-theme", light ? "light" : "dark");
    } catch (_) {}
  }

  (function initTheme() {
    let light = false;
    try {
      light = localStorage.getItem("pst-theme") === "light";
    } catch (_) {}
    applyTheme(light);
  })();

  document.getElementById("themeToggle").addEventListener("click", () => {
    applyTheme(!document.documentElement.classList.contains("light"));
  });

  // ---------- Eclipse Void (blank screen + 5-tap close tab) ----------
  let voidTapCount = 0;
  let voidTapResetTimer = null;
  let voidActive = false;

  function setVoid(on) {
    const overlay = document.getElementById("voidOverlay");
    const status = document.getElementById("voidStatus");
    const toggle = document.getElementById("voidToggle");
    if (!overlay) return;

    voidActive = !!on;
    voidTapCount = 0;
    if (voidTapResetTimer) {
      clearTimeout(voidTapResetTimer);
      voidTapResetTimer = null;
    }

    if (on) {
      overlay.hidden = false;
      document.body.style.overflow = "hidden";
      if (status) {
        status.textContent = "Active — tap 5× to close tab · ✕ exits mode";
        status.className = "status on";
      }
    } else {
      overlay.hidden = true;
      document.body.style.overflow = "";
      if (toggle) toggle.checked = false;
      if (status) {
        status.textContent = "Off";
        status.className = "status";
      }
    }
  }

  function tryCloseTab() {
    // Browsers only allow close if script opened the window; fallback to blank
    try {
      window.close();
    } catch (_) {}
    setTimeout(() => {
      try {
        window.open("", "_self");
        window.close();
      } catch (_) {}
      // Last resort: leave the page
      window.location.replace("about:blank");
    }, 100);
  }

  function onVoidTap(e) {
    // Ignore the close button (handled separately)
    if (e.target && e.target.id === "voidCloseBtn") return;
    if (!voidActive) return;

    voidTapCount++;
    if (voidTapResetTimer) clearTimeout(voidTapResetTimer);
    voidTapResetTimer = setTimeout(() => {
      voidTapCount = 0;
      voidTapResetTimer = null;
    }, 3000);

    if (voidTapCount >= 5) {
      voidTapCount = 0;
      if (voidTapResetTimer) {
        clearTimeout(voidTapResetTimer);
        voidTapResetTimer = null;
      }
      tryCloseTab();
    }
  }

  document.getElementById("voidToggle").addEventListener("change", (e) => {
    setVoid(e.target.checked);
  });

  document.getElementById("voidCloseBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    setVoid(false);
  });

  const voidOverlayEl = document.getElementById("voidOverlay");
  // Single path for mouse + touch (avoids double-count on mobile)
  voidOverlayEl.addEventListener("pointerup", onVoidTap);

  // Initial power + battery tracking
  updatePower();
  initBatteryTracking();

  // ---------- Auto-update (detect new deploy without hard refresh) ----------
  // Bump BUILD_ID whenever you push a new version to GitHub Pages.
  const BUILD_ID = "14";
  const CHECK_EVERY_MS = 45_000;

  async function checkForUpdate() {
    try {
      const res = await fetch("index.html?_=" + Date.now(), { cache: "no-store" });
      if (!res.ok) return;
      const html = await res.text();
      const match = html.match(/[?&]v=(\d+)/) || html.match(/build-tag[^>]*>v?(\d+)/i);
      if (match && match[1] !== BUILD_ID) {
        window.location.reload();
      }
    } catch (_) {
      // offline / CORS — ignore
    }
  }

  setInterval(checkForUpdate, CHECK_EVERY_MS);
  // Also check when tab becomes visible again
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkForUpdate();
  });
})();
