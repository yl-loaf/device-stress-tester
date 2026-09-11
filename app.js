(() => {
  "use strict";

  // ---------- Power estimation (rough) ----------
  // Approximate incremental draw in watts when each feature is active.
  // These are educated guesses for a typical modern phone.
  // Weighted subsystem coefficients (relative watts from typical mobile profiling)
  const POWER = {
    torch: 1.4,      // LED — medium-high
    camera: 1.8,     // ISP + sensor
    vibrate: 1.1,    // haptic continuous — medium
    location: 1.0,   // GNSS
    cpu: 4.5,        // all-core busy — high (scaled by workers)
    download: 1.5,   // radio
    gpu: 4.2,        // shader load — high
    mic: 0.45,       // audio in
    tone: 0.7,       // audio DSP / speaker — low-medium
    nfc: 0.25,
    ram: 0.9,
    sensors: 0.35,
    storage: 1.1,
    modem: 1.8,      // multi-stream radio
    isp: 2.4,        // camera + torch processing
    panel: 2.0,      // max brightness patterns — medium-high
    vrr: 1.2,        // continuous frame push
    bluetooth: 0.5,
    usb: 0.4,
    webgpuCompute: 5.0,
    webgpuDraw: 4.5,
    wasm: 4.0,
    ai: 4.8,
    zeroGc: 1.5,
    hdr: 2.5,
    audioDsp: 1.8,
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
    nfc: false,
    ram: false,
    sensors: false,
    storage: false,
    modem: false,
    isp: false,
    panel: false,
    vrr: false,
    bluetooth: false,
    usb: false,
    webgpuCompute: false,
    webgpuDraw: false,
    wasm: false,
    ai: false,
    zeroGc: false,
    hdr: false,
    audioDsp: false,
  };

  const metrics = {
    cpuOpsPerSec: 0,
    gpuFps: 0,
    storageOpsPerSec: 0,
    storageMBps: 0,
    networkMbps: 0,
    modemLatencyMs: 0,
  };

  let cpuWorkerCount = Math.min(8, Math.max(2, navigator.hardwareConcurrency || 4));
  let lastPowerIndexW = 0.3;
  let thermalEfficiency = null; // current throughput / baseline (1 = no throttle)

  function countActiveSubsystems() {
    let n = 0;
    for (const k of Object.keys(active)) if (active[k]) n++;
    return n;
  }

  /** Weighted Estimated Power Index (relative W) */
  function updatePower() {
    let total = 0.35; // browser chrome baseline
    const parts = [];
    for (const k of Object.keys(POWER)) {
      if (!active[k]) continue;
      let w = POWER[k];
      if (k === "cpu") w = POWER.cpu * (cpuWorkerCount / 4);
      if (k === "gpu" && metrics.gpuFps > 0 && metrics.gpuFps < 30) {
        // heavier effective draw when stuck in expensive frames
        w *= 1 + (30 - metrics.gpuFps) / 60;
      }
      total += w;
      parts.push(k);
    }
    lastPowerIndexW = total;
    const el = document.getElementById("powerWatts");
    if (el) el.textContent = total.toFixed(1);
    const hint = document.getElementById("powerModelHint");
    if (hint) {
      hint.textContent =
        parts.length
          ? "Index " + total.toFixed(1) + " W · " + parts.length + " subsystems: " + parts.slice(0, 6).join(", ") + (parts.length > 6 ? "…" : "")
          : "Weighted subsystem index (idle). Enable stressors to raise the curve.";
    }
  }

  // ---------- High-resolution battery delta tracking ----------
  // Precise timestamps on every levelchange; poll only as backup.
  let batteryManager = null;
  let batteryLevelEvents = []; // { tPerf, tWall, levelPct, charging, source }
  let batteryStartPct = null;
  let batteryStartTime = null;
  let batteryPollTimer = null;
  let batteryEventCount = 0;
  // Idle control: periods with no heavy stressors
  let idleRatePctPerMin = null;
  let stressRatePctPerMin = null;
  let batteryDerivedMw = null;

  const BATTERY_MAX_EVENTS = 400;
  const BATTERY_WINDOW_MS = 180000; // 3 min rolling window
  const NOMINAL_V_DEFAULT = 3.85;

  function formatDropRate(pointsPerUnit) {
    if (pointsPerUnit == null || !isFinite(pointsPerUnit) || pointsPerUnit < 0) return "—";
    if (pointsPerUnit < 0.001) return pointsPerUnit.toFixed(5) + "%";
    if (pointsPerUnit < 0.01) return pointsPerUnit.toFixed(4) + "%";
    if (pointsPerUnit < 0.1) return pointsPerUnit.toFixed(3) + "%";
    return pointsPerUnit.toFixed(2) + "%";
  }

  function getBatteryCapacityMah() {
    const el = document.getElementById("batteryCapacityMah");
    const v = el ? parseFloat(el.value) : 4500;
    return isFinite(v) && v > 0 ? v : 4500;
  }

  function getBatteryVoltage() {
    const el = document.getElementById("batteryVoltage");
    const v = el ? parseFloat(el.value) : NOMINAL_V_DEFAULT;
    return isFinite(v) && v > 0 ? v : NOMINAL_V_DEFAULT;
  }

  function isStressActive() {
    return !!(
      active.cpu || active.gpu || active.download || active.modem ||
      active.storage || active.ram || active.isp || active.panel ||
      active.camera || active.torch
    );
  }

  /**
   * Power (mW) ≈ (Δ%/Δt_hours) × Capacity_mAh × V_nominal
   * Δ% is percentage points of full charge (0–100).
   */
  function estimateMwFromDischarge(pctPerHour) {
    if (pctPerHour == null || pctPerHour <= 0) return null;
    return (pctPerHour / 100) * getBatteryCapacityMah() * getBatteryVoltage();
  }

  function rateFromEvents(events) {
    if (!events || events.length < 2) return null;
    const first = events[0];
    const last = events[events.length - 1];
    const dtSec = (last.tPerf - first.tPerf) / 1000;
    if (dtSec < 2) return null;
    const deltaPct = first.levelPct - last.levelPct; // positive = discharge
    if (deltaPct < 0) return 0; // charging
    return {
      pctPerSec: deltaPct / dtSec,
      pctPerMin: (deltaPct / dtSec) * 60,
      pctPerHour: (deltaPct / dtSec) * 3600,
      dtSec,
      deltaPct,
    };
  }

  function updateBatteryUI() {
    const levelEl = document.getElementById("batteryLevel");
    if (!levelEl) return;

    if (!batteryManager) {
      levelEl.textContent = "N/A";
      return;
    }

    const pct = batteryManager.level * 100;
    const charging = batteryManager.charging;
    levelEl.textContent =
      (Math.round(pct * 10) / 10).toFixed(1) + "%" + (charging ? " (charging)" : "");

    document.getElementById("batteryCap").textContent =
      getBatteryCapacityMah() + " mAh · " + getBatteryVoltage().toFixed(2) + " V";
    document.getElementById("batteryEvents").textContent = String(batteryEventCount);

    if (batteryLevelEvents.length < 2) {
      document.getElementById("batteryDropSec").textContent = "waiting for levelchange…";
      document.getElementById("batteryDropMin").textContent = "—";
      document.getElementById("batteryMw").textContent = "—";
      return;
    }

    const now = performance.now();
    const windowStart = now - BATTERY_WINDOW_MS;
    let windowEv = batteryLevelEvents.filter((e) => e.tPerf >= windowStart);
    if (windowEv.length < 2) windowEv = batteryLevelEvents;

    const stressEv = windowEv.filter((e) => e.stress);
    const idleEv = windowEv.filter((e) => !e.stress);

    const stressRate = rateFromEvents(stressEv.length >= 2 ? stressEv : windowEv);
    const idleRate = rateFromEvents(idleEv);

    if (stressRate) {
      stressRatePctPerMin = stressRate.pctPerMin;
      document.getElementById("batteryDropSec").textContent =
        formatDropRate(stressRate.pctPerSec) + " /s";
      document.getElementById("batteryDropMin").textContent =
        formatDropRate(stressRate.pctPerMin) + " /min";
      batteryDerivedMw = estimateMwFromDischarge(stressRate.pctPerHour);
      if (batteryDerivedMw != null) {
        const w = batteryDerivedMw / 1000;
        document.getElementById("batteryMw").textContent =
          batteryDerivedMw.toFixed(0) + " mW (" + w.toFixed(2) + " W)";
      }
    }

    if (idleRate && idleRate.pctPerMin > 0) {
      idleRatePctPerMin = idleRate.pctPerMin;
      document.getElementById("batteryIdleRate").textContent =
        formatDropRate(idleRate.pctPerMin) + " /min";
    } else if (idleRatePctPerMin != null) {
      document.getElementById("batteryIdleRate").textContent =
        formatDropRate(idleRatePctPerMin) + " /min (last)";
    } else {
      document.getElementById("batteryIdleRate").textContent =
        idleEv.length < 2 ? "need idle period" : "—";
    }

    // Excess stress drain vs idle control
    const hintEl = document.getElementById("batteryHint");
    if (charging && hintEl) {
      hintEl.textContent = "Charging — discharge math paused until unplugged.";
    } else if (hintEl && stressRate && idleRatePctPerMin != null) {
      const excess = Math.max(0, stressRate.pctPerMin - idleRatePctPerMin);
      hintEl.textContent =
        "Stress Δ " + formatDropRate(stressRate.pctPerMin) + "/min vs idle " +
        formatDropRate(idleRatePctPerMin) + "/min · excess " +
        formatDropRate(excess) + "/min attributed to load.";
    }

    if (batteryStartPct != null && batteryStartTime != null) {
      const last = batteryLevelEvents[batteryLevelEvents.length - 1];
      const sessionDrop = Math.max(0, batteryStartPct - last.levelPct);
      const sessionMin = (now - batteryStartTime) / 60000;
      document.getElementById("batterySession").textContent =
        sessionDrop.toFixed(1) + "% over " +
        (sessionMin < 1 ? Math.round(sessionMin * 60) + "s" : sessionMin.toFixed(1) + " min");
    }

    if (thermalEfficiency != null) {
      const el = document.getElementById("thermalEff");
      if (el) {
        el.textContent =
          (thermalEfficiency * 100).toFixed(0) +
          "% of baseline throughput" +
          (thermalEfficiency < 0.7 ? " · throttling likely" : "");
      }
    }
  }

  function recordBatteryEvent(source) {
    if (!batteryManager) return;
    const levelPct = batteryManager.level * 100;
    const tPerf = performance.now();
    const tWall = Date.now();
    if (batteryStartPct == null) {
      batteryStartPct = levelPct;
      batteryStartTime = tPerf;
    }
    // Only count discrete levelchange as events; polls fill the timeline
    if (source === "levelchange") batteryEventCount++;

    const last = batteryLevelEvents[batteryLevelEvents.length - 1];
    // Skip duplicate identical levels from polling within 200ms
    if (
      last &&
      source === "poll" &&
      Math.abs(last.levelPct - levelPct) < 1e-6 &&
      tPerf - last.tPerf < 5000
    ) {
      return;
    }

    batteryLevelEvents.push({
      tPerf,
      tWall,
      levelPct,
      charging: batteryManager.charging,
      stress: isStressActive(),
      source,
      powerIndexW: lastPowerIndexW,
    });
    if (batteryLevelEvents.length > BATTERY_MAX_EVENTS) {
      batteryLevelEvents.shift();
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
      recordBatteryEvent("init");
      batteryManager.addEventListener("levelchange", () => {
        recordBatteryEvent("levelchange");
      });
      batteryManager.addEventListener("chargingchange", () => {
        recordBatteryEvent("chargingchange");
        updateBatteryUI();
      });
      // Sparse poll — real precision comes from levelchange timestamps
      batteryPollTimer = setInterval(() => recordBatteryEvent("poll"), 5000);
      updateBatteryUI();

      const capEl = document.getElementById("batteryCapacityMah");
      const voltEl = document.getElementById("batteryVoltage");
      if (capEl) capEl.addEventListener("change", updateBatteryUI);
      if (voltEl) voltEl.addEventListener("change", updateBatteryUI);
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
          metrics.cpuOpsPerSec = total;
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
      for (int i = 0; i < 2048; i++) {
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
    // ray steps ×1.5, capped at 2000 (~720 at 100%, ~2000 at max over-load)
    webglSteps = Math.min(
      2000,
      Math.round((48 + t * 432 + over * 8.5) * 1.5)
    );
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
      metrics.gpuFps = fps;
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

  // ---------- NFC detector (Web NFC / NDEFReader) ----------
  let nfcReader = null;
  let nfcAbort = null;

  async function setNfc(on) {
    const status = document.getElementById("nfcStatus");
    if (on) {
      if (typeof NDEFReader === "undefined") {
        status.textContent = "Web NFC not supported (need Android Chrome + HTTPS)";
        status.className = "status warn";
        document.getElementById("nfcToggle").checked = false;
        return;
      }
      try {
        nfcAbort = new AbortController();
        nfcReader = new NDEFReader();
        await nfcReader.scan({ signal: nfcAbort.signal });
        active.nfc = true;
        updatePower();
        status.textContent = "Scanning — hold a tag near the phone…";
        status.className = "status on";

        nfcReader.addEventListener("reading", (event) => {
          if (!active.nfc) return;
          const records = event.message?.records || [];
          const parts = records.map((r) => {
            try {
              if (r.recordType === "text") {
                const dec = new TextDecoder(r.encoding || "utf-8");
                return "text: " + dec.decode(r.data);
              }
              if (r.recordType === "url") {
                return "url: " + new TextDecoder().decode(r.data);
              }
              return r.recordType + " (" + (r.data?.byteLength || 0) + " B)";
            } catch (_) {
              return r.recordType || "record";
            }
          });
          status.textContent =
            "Tag" + (event.serialNumber ? " " + event.serialNumber : "") +
            " — " + (parts.length ? parts.join(" · ") : "empty NDEF");
          status.className = "status on";
        });

        nfcReader.addEventListener("readingerror", () => {
          if (!active.nfc) return;
          status.textContent = "Read error — try again";
          status.className = "status warn";
        });
      } catch (err) {
        active.nfc = false;
        updatePower();
        status.textContent = "Error: " + (err.message || err.name);
        status.className = "status warn";
        document.getElementById("nfcToggle").checked = false;
      }
    } else {
      active.nfc = false;
      if (nfcAbort) {
        try { nfcAbort.abort(); } catch (_) {}
        nfcAbort = null;
      }
      nfcReader = null;
      status.textContent = "Off";
      status.className = "status";
      updatePower();
    }
  }

  document.getElementById("nfcToggle").addEventListener("change", (e) => {
    setNfc(e.target.checked);
  });

  // ---------- Web Bluetooth interrogation ----------
  let btDevice = null;
  let btServer = null;

  function setBtLog(text) {
    const log = document.getElementById("btLog");
    if (!log) return;
    log.hidden = !text;
    log.textContent = text || "";
  }

  async function setBluetooth(on) {
    const status = document.getElementById("btStatus");
    if (on) {
      if (!navigator.bluetooth) {
        status.textContent = "Web Bluetooth not supported";
        status.className = "status warn";
        document.getElementById("btToggle").checked = false;
        return;
      }
      try {
        status.textContent = "Pick a device…";
        status.className = "status on";
        // acceptAllDevices requires optionalServices to read most GATT data
        btDevice = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: [
            "battery_service",
            "device_information",
            "generic_access",
            "health_thermometer",
            "heart_rate",
            "environmental_sensing",
            "weight_scale",
            "glucose",
            "0000180a-0000-1000-8000-00805f9b34fb",
            "0000180f-0000-1000-8000-00805f9b34fb",
            "0000181a-0000-1000-8000-00805f9b34fb",
          ],
        });
        active.bluetooth = true;
        updatePower();
        status.textContent = "Connecting to " + (btDevice.name || "device") + "…";
        btDevice.addEventListener("gattserverdisconnected", () => {
          if (!active.bluetooth) return;
          status.textContent = "Disconnected — toggle off/on to reconnect";
          status.className = "status warn";
        });
        btServer = await btDevice.gatt.connect();
        const services = await btServer.getPrimaryServices();
        const lines = [
          "Device: " + (btDevice.name || "(no name)"),
          "ID: " + (btDevice.id || "—"),
          "Services: " + services.length,
          "",
        ];
        for (const svc of services) {
          lines.push("• " + (svc.uuid || "service"));
          try {
            const chars = await svc.getCharacteristics();
            for (const ch of chars) {
              const props = Object.keys(ch.properties || {})
                .filter((k) => ch.properties[k])
                .join(",");
              let val = "";
              if (ch.properties.read) {
                try {
                  const data = await ch.readValue();
                  const bytes = [];
                  for (let i = 0; i < Math.min(data.byteLength, 16); i++) {
                    bytes.push(data.getUint8(i).toString(16).padStart(2, "0"));
                  }
                  val = " = [" + bytes.join(" ") + (data.byteLength > 16 ? " …" : "") + "]";
                } catch (_) {
                  val = " (read denied)";
                }
              }
              lines.push("    " + ch.uuid + " {" + props + "}" + val);
            }
          } catch (_) {
            lines.push("    (characteristics locked)");
          }
        }
        setBtLog(lines.join("\n"));
        status.textContent =
          "Connected · " + (btDevice.name || "device") + " · " + services.length + " services";
        status.className = "status on";
      } catch (err) {
        active.bluetooth = false;
        updatePower();
        setBtLog("");
        status.textContent =
          err.name === "NotFoundError"
            ? "Cancelled / no device selected"
            : "Error: " + (err.message || err.name);
        status.className = "status warn";
        document.getElementById("btToggle").checked = false;
        try {
          if (btDevice && btDevice.gatt && btDevice.gatt.connected) {
            btDevice.gatt.disconnect();
          }
        } catch (_) {}
        btDevice = null;
        btServer = null;
      }
    } else {
      active.bluetooth = false;
      try {
        if (btDevice && btDevice.gatt && btDevice.gatt.connected) {
          btDevice.gatt.disconnect();
        }
      } catch (_) {}
      btDevice = null;
      btServer = null;
      setBtLog("");
      status.textContent = "Off";
      status.className = "status";
      updatePower();
    }
  }

  document.getElementById("btToggle").addEventListener("change", (e) => {
    setBluetooth(e.target.checked);
  });

  // ---------- WebUSB interrogation ----------
  let usbDevice = null;

  function setUsbLog(text) {
    const log = document.getElementById("usbLog");
    if (!log) return;
    log.hidden = !text;
    log.textContent = text || "";
  }

  async function setUsb(on) {
    const status = document.getElementById("usbStatus");
    if (on) {
      if (!navigator.usb) {
        status.textContent = "WebUSB not supported";
        status.className = "status warn";
        document.getElementById("usbToggle").checked = false;
        return;
      }
      try {
        status.textContent = "Pick a USB device…";
        status.className = "status on";
        usbDevice = await navigator.usb.requestDevice({ filters: [] });
        active.usb = true;
        updatePower();
        await usbDevice.open();
        if (usbDevice.configuration === null) {
          await usbDevice.selectConfiguration(1);
        }
        const lines = [
          "Product: " + (usbDevice.productName || "—"),
          "Manufacturer: " + (usbDevice.manufacturerName || "—"),
          "Serial: " + (usbDevice.serialNumber || "—"),
          "Vendor ID: 0x" + usbDevice.vendorId.toString(16),
          "Product ID: 0x" + usbDevice.productId.toString(16),
          "USB version: " + (usbDevice.usbVersionMajor + "." + usbDevice.usbVersionMinor),
          "Device class: " + usbDevice.deviceClass,
          "Configurations: " + (usbDevice.configurations || []).length,
          "",
        ];
        (usbDevice.configurations || []).forEach((cfg, ci) => {
          lines.push("Config " + (cfg.configurationValue || ci) + ":");
          (cfg.interfaces || []).forEach((iface) => {
            const alt = iface.alternates && iface.alternates[0];
            lines.push(
              "  iface " +
                iface.interfaceNumber +
                (alt
                  ? " class=" +
                    alt.interfaceClass +
                    " endpoints=" +
                    (alt.endpoints || []).length
                  : "")
            );
            (alt && alt.endpoints ? alt.endpoints : []).forEach((ep) => {
              lines.push(
                "    EP " +
                  ep.endpointNumber +
                  " " +
                  ep.direction +
                  " " +
                  ep.type +
                  " pkt=" +
                  ep.packetSize
              );
            });
          });
        });
        setUsbLog(lines.join("\n"));
        status.textContent =
          "Open · " +
          (usbDevice.productName ||
            "0x" + usbDevice.vendorId.toString(16) + ":" + usbDevice.productId.toString(16));
        status.className = "status on";
      } catch (err) {
        active.usb = false;
        updatePower();
        setUsbLog("");
        status.textContent =
          err.name === "NotFoundError"
            ? "Cancelled / no device selected"
            : "Error: " + (err.message || err.name);
        status.className = "status warn";
        document.getElementById("usbToggle").checked = false;
        try {
          if (usbDevice) await usbDevice.close();
        } catch (_) {}
        usbDevice = null;
      }
    } else {
      active.usb = false;
      try {
        if (usbDevice) await usbDevice.close();
      } catch (_) {}
      usbDevice = null;
      setUsbLog("");
      status.textContent = "Off";
      status.className = "status";
      updatePower();
    }
  }

  document.getElementById("usbToggle").addEventListener("change", (e) => {
    setUsb(e.target.checked);
  });

  // ---------- RAM stress (allocate up to slider % of safe ceiling) ----------
  let ramChunks = [];
  let ramBytes = 0;
  let ramTimer = null;
  let ramCeilingBytes = 0;

  function formatRam(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + " GB";
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
    return (bytes / 1e3).toFixed(0) + " KB";
  }

  /** Estimate how much JS can hold before the tab is likely to die */
  function estimateRamCeiling() {
    if (performance.memory && performance.memory.jsHeapSizeLimit > 0) {
      // Use most of the heap limit as the 100% reference
      return performance.memory.jsHeapSizeLimit;
    }
    if (navigator.deviceMemory && navigator.deviceMemory > 0) {
      // deviceMemory is approximate total RAM in GB; browsers rarely get all of it
      return navigator.deviceMemory * 0.35 * 1024 * 1024 * 1024;
    }
    // Conservative fallback ~1.5 GB
    return 1.5 * 1024 * 1024 * 1024;
  }

  function stopRam() {
    if (ramTimer) {
      clearTimeout(ramTimer);
      ramTimer = null;
    }
    ramChunks = [];
    ramBytes = 0;
    try { if (globalThis.gc) globalThis.gc(); } catch (_) {}
  }

  function setRam(on) {
    const status = document.getElementById("ramStatus");
    if (on) {
      stopRam();
      active.ram = true;
      updatePower();

      const pct = Math.min(
        95,
        Math.max(50, parseInt(document.getElementById("ramMaxSlider").value, 10) || 80)
      );
      ramCeilingBytes = estimateRamCeiling();
      const targetBytes = Math.floor(ramCeilingBytes * (pct / 100));

      status.textContent =
        "Allocating to " + pct + "% of ~" + formatRam(ramCeilingBytes) + "…";
      status.className = "status on";

      let chunkSize = 16 * 1024 * 1024; // 16 MB — finer control near the cap

      function tick() {
        if (!active.ram) return;

        // Already at or past target
        if (ramBytes >= targetBytes) {
          status.textContent =
            "Target reached — held " + formatRam(ramBytes) +
            " / " + formatRam(targetBytes) +
            " (" + pct + "% of ~" + formatRam(ramCeilingBytes) + ")";
          status.className = "status on";
          return;
        }

        // Shrink last chunks so we don't overshoot much
        const remaining = targetBytes - ramBytes;
        const thisChunk = Math.min(chunkSize, remaining);
        if (thisChunk < 1024 * 1024) {
          status.textContent =
            "Target reached — held " + formatRam(ramBytes) +
            " (" + pct + "%)";
          status.className = "status on";
          return;
        }

        try {
          const buf = new ArrayBuffer(thisChunk);
          const view = new Uint8Array(buf);
          for (let i = 0; i < view.length; i += 4096) view[i] = 1;
          ramChunks.push(buf);
          ramBytes += thisChunk;

          let extra = "";
          if (performance.memory) {
            extra =
              " · heap " +
              formatRam(performance.memory.usedJSHeapSize) +
              " / " +
              formatRam(performance.memory.jsHeapSizeLimit);
          }
          const usedPct = ((ramBytes / ramCeilingBytes) * 100).toFixed(0);
          status.textContent =
            "Held " + formatRam(ramBytes) +
            " (" + usedPct + "% of ceiling · target " + pct + "%)" +
            extra;
          status.className = "status on";
          ramTimer = setTimeout(tick, 40);
        } catch (err) {
          status.textContent =
            "Stopped early — held " + formatRam(ramBytes) +
            " (" + (err && err.name ? err.name : "OOM") + ")";
          status.className = "status warn";
        }
      }
      tick();
    } else {
      active.ram = false;
      stopRam();
      status.textContent = "Off — memory released";
      status.className = "status";
      updatePower();
    }
  }

  document.getElementById("ramToggle").addEventListener("change", (e) => {
    setRam(e.target.checked);
  });

  document.getElementById("ramMaxSlider").addEventListener("input", (e) => {
    document.getElementById("ramMaxValue").textContent = e.target.value;
    // If already running, restart toward the new target
    if (active.ram) {
      setRam(false);
      document.getElementById("ramToggle").checked = true;
      setRam(true);
    }
  });

  // ---------- Motion sensors + touch + ambient light ----------
  let sensorsRunning = false;
  let lightSensor = null;
  let touchCount = 0;
  let touchLastT = 0;
  let touchTimer = null;

  function fmtSensor(n, digits) {
    if (n == null || !isFinite(n)) return "—";
    return Number(n).toFixed(digits);
  }

  function onDeviceMotion(e) {
    if (!sensorsRunning) return;
    const a = e.accelerationIncludingGravity || e.acceleration;
    if (a) {
      document.getElementById("accX").textContent = fmtSensor(a.x, 3);
      document.getElementById("accY").textContent = fmtSensor(a.y, 3);
      document.getElementById("accZ").textContent = fmtSensor(a.z, 3);
    }
    const r = e.rotationRate;
    if (r) {
      document.getElementById("gyroA").textContent = fmtSensor(r.alpha, 2);
      document.getElementById("gyroB").textContent = fmtSensor(r.beta, 2);
      document.getElementById("gyroG").textContent = fmtSensor(r.gamma, 2);
    }
  }

  function onDeviceOrientation(e) {
    if (!sensorsRunning) return;
    document.getElementById("oriA").textContent = fmtSensor(e.alpha, 1);
    document.getElementById("oriB").textContent = fmtSensor(e.beta, 1);
    document.getElementById("oriG").textContent = fmtSensor(e.gamma, 1);
    const heading =
      e.webkitCompassHeading != null
        ? e.webkitCompassHeading
        : e.absolute && e.alpha != null
          ? (360 - e.alpha) % 360
          : null;
    document.getElementById("oriCompass").textContent =
      heading != null ? fmtSensor(heading, 1) + "°" : "—";
  }

  function onTouchSample(e) {
    if (!sensorsRunning) return;
    touchCount += e.touches ? e.touches.length : 1;
  }

  async function setSensors(on) {
    const status = document.getElementById("sensorsStatus");
    const pad = document.getElementById("touchPad");
    if (on) {
      try {
        if (
          typeof DeviceMotionEvent !== "undefined" &&
          typeof DeviceMotionEvent.requestPermission === "function"
        ) {
          const p1 = await DeviceMotionEvent.requestPermission();
          if (p1 !== "granted") throw new Error("Motion permission denied");
        }
        if (
          typeof DeviceOrientationEvent !== "undefined" &&
          typeof DeviceOrientationEvent.requestPermission === "function"
        ) {
          const p2 = await DeviceOrientationEvent.requestPermission();
          if (p2 !== "granted") throw new Error("Orientation permission denied");
        }

        sensorsRunning = true;
        active.sensors = true;
        updatePower();
        touchCount = 0;
        touchLastT = performance.now();

        window.addEventListener("devicemotion", onDeviceMotion, { passive: true });
        window.addEventListener("deviceorientation", onDeviceOrientation, { passive: true });
        window.addEventListener("deviceorientationabsolute", onDeviceOrientation, { passive: true });

        // Ambient light (Generic Sensor API — Chrome/Android)
        document.getElementById("lightLux").textContent = "—";
        if (typeof AmbientLightSensor !== "undefined") {
          try {
            lightSensor = new AmbientLightSensor({ frequency: 10 });
            lightSensor.addEventListener("reading", () => {
              document.getElementById("lightLux").textContent =
                fmtSensor(lightSensor.illuminance, 1) + " lx";
            });
            lightSensor.addEventListener("error", () => {
              document.getElementById("lightLux").textContent = "n/a";
            });
            lightSensor.start();
          } catch (_) {
            document.getElementById("lightLux").textContent = "n/a";
          }
        } else {
          document.getElementById("lightLux").textContent = "n/a";
        }

        if (pad) {
          pad.addEventListener("touchstart", onTouchSample, { passive: true });
          pad.addEventListener("touchmove", onTouchSample, { passive: true });
          pad.addEventListener("pointermove", onTouchSample, { passive: true });
        }
        touchTimer = setInterval(() => {
          const now = performance.now();
          const dt = (now - touchLastT) / 1000;
          const eps = dt > 0 ? touchCount / dt : 0;
          document.getElementById("touchEps").textContent = eps.toFixed(0);
          touchCount = 0;
          touchLastT = now;
        }, 1000);

        status.textContent = "Streaming sensors + touch…";
        status.className = "status on";
      } catch (err) {
        sensorsRunning = false;
        active.sensors = false;
        updatePower();
        status.textContent = "Error: " + (err.message || err);
        status.className = "status warn";
        document.getElementById("sensorsToggle").checked = false;
      }
    } else {
      sensorsRunning = false;
      active.sensors = false;
      window.removeEventListener("devicemotion", onDeviceMotion);
      window.removeEventListener("deviceorientation", onDeviceOrientation);
      window.removeEventListener("deviceorientationabsolute", onDeviceOrientation);
      if (lightSensor) {
        try { lightSensor.stop(); } catch (_) {}
        lightSensor = null;
      }
      if (pad) {
        pad.removeEventListener("touchstart", onTouchSample);
        pad.removeEventListener("touchmove", onTouchSample);
        pad.removeEventListener("pointermove", onTouchSample);
      }
      if (touchTimer) {
        clearInterval(touchTimer);
        touchTimer = null;
      }
      ["accX", "accY", "accZ", "gyroA", "gyroB", "gyroG", "oriA", "oriB", "oriG", "oriCompass"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = "—";
      });
      document.getElementById("lightLux").textContent = "—";
      document.getElementById("touchEps").textContent = "—";
      status.textContent = "Off";
      status.className = "status";
      updatePower();
    }
  }

  document.getElementById("sensorsToggle").addEventListener("change", (e) => {
    setSensors(e.target.checked);
  });

  // ---------- Camera + torch ISP loop (live filters) ----------
  let ispStream = null;
  let ispRaf = null;
  let ispTrack = null;

  function ispEdge(data, w, h) {
    // Simple 3x3 Laplacian-ish on grayscale
    const out = new Uint8ClampedArray(data.length);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        const g = (r, c) => {
          const j = (r * w + c) * 4;
          return data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114;
        };
        const v = Math.abs(
          -g(y - 1, x - 1) - g(y - 1, x) - g(y - 1, x + 1) -
          g(y, x - 1) + 8 * g(y, x) - g(y, x + 1) -
          g(y + 1, x - 1) - g(y + 1, x) - g(y + 1, x + 1)
        );
        const c = Math.min(255, v);
        out[i] = out[i + 1] = out[i + 2] = c;
        out[i + 3] = 255;
      }
    }
    return out;
  }

  function ispProcessFrame() {
    if (!active.isp) return;
    const video = document.getElementById("ispVideo");
    const canvas = document.getElementById("ispCanvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const w = 320;
    const h = Math.round((video.videoHeight / Math.max(1, video.videoWidth)) * w) || 240;
    if (canvas.width !== w) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(video, 0, 0, w, h);
    let frame = ctx.getImageData(0, 0, w, h);
    const filter = document.getElementById("ispFilter")?.value || "edge";
    const d = frame.data;

    if (filter === "invert") {
      for (let i = 0; i < d.length; i += 4) {
        d[i] = 255 - d[i];
        d[i + 1] = 255 - d[i + 1];
        d[i + 2] = 255 - d[i + 2];
      }
    } else if (filter === "gray") {
      for (let i = 0; i < d.length; i += 4) {
        const g = Math.min(255, (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) * 1.35);
        d[i] = d[i + 1] = d[i + 2] = g;
      }
    } else {
      // edge / sobel-ish
      const out = ispEdge(d, w, h);
      frame = new ImageData(out, w, h);
    }
    ctx.putImageData(frame, 0, 0);
    document.getElementById("ispStatus").textContent =
      "ISP loop · " + filter + " · " + w + "×" + h + (ispTrack ? " · torch" : "");
    document.getElementById("ispStatus").className = "status on";
    ispRaf = requestAnimationFrame(ispProcessFrame);
  }

  async function setIsp(on) {
    const status = document.getElementById("ispStatus");
    const wrap = document.getElementById("ispWrap");
    const video = document.getElementById("ispVideo");
    if (on) {
      try {
        ispStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 },
          },
          audio: false,
        });
        ispTrack = ispStream.getVideoTracks()[0];
        const caps = ispTrack.getCapabilities?.() || {};
        if (caps.torch) {
          try {
            await ispTrack.applyConstraints({ advanced: [{ torch: true }] });
          } catch (_) {}
        } else {
          ispTrack = null; // no torch capability marker
        }
        video.srcObject = ispStream;
        wrap.classList.add("active");
        active.isp = true;
        updatePower();
        status.textContent = "Starting ISP loop…";
        status.className = "status on";
        ispRaf = requestAnimationFrame(ispProcessFrame);
      } catch (err) {
        status.textContent = "Error: " + (err.message || err.name);
        status.className = "status warn";
        document.getElementById("ispToggle").checked = false;
        active.isp = false;
        updatePower();
      }
    } else {
      active.isp = false;
      if (ispRaf) cancelAnimationFrame(ispRaf);
      ispRaf = null;
      if (ispStream) {
        ispStream.getTracks().forEach((t) => t.stop());
        ispStream = null;
      }
      ispTrack = null;
      video.srcObject = null;
      wrap.classList.remove("active");
      status.textContent = "Off";
      status.className = "status";
      updatePower();
    }
  }

  document.getElementById("ispToggle").addEventListener("change", (e) => {
    setIsp(e.target.checked);
  });

  // ---------- Panel burn-in / flicker ----------
  let panelTimer = null;
  let panelFrame = 0;

  function setPanel(on) {
    const overlay = document.getElementById("panelOverlay");
    const status = document.getElementById("panelStatus");
    if (on) {
      overlay.hidden = false;
      active.panel = true;
      updatePower();
      panelFrame = 0;
      status.textContent = "Panel test running (full screen)";
      status.className = "status on";

      const paint = () => {
        if (!active.panel) return;
        const pattern = document.getElementById("panelPattern")?.value || "rgb";
        panelFrame++;
        let color = "#000";
        if (pattern === "rgb") {
          const colors = ["#ff0000", "#00ff00", "#0000ff", "#ffffff", "#000000"];
          color = colors[Math.floor(panelFrame / 20) % colors.length];
          overlay.style.background = color;
          overlay.style.backgroundImage = "";
        } else if (pattern === "flash") {
          color = panelFrame % 2 === 0 ? "#ffffff" : "#000000";
          overlay.style.background = color;
          overlay.style.backgroundImage = "";
        } else if (pattern === "spectrum") {
          const h = (panelFrame * 3) % 360;
          overlay.style.background = "hsl(" + h + ",100%,50%)";
          overlay.style.backgroundImage = "";
        } else {
          // grid
          overlay.style.background = "#000";
          overlay.style.backgroundImage =
            "repeating-linear-gradient(0deg,#fff 0 2px,transparent 2px 16px)," +
            "repeating-linear-gradient(90deg,#fff 0 2px,transparent 2px 16px)";
        }
        panelTimer = requestAnimationFrame(paint);
      };
      panelTimer = requestAnimationFrame(paint);
    } else {
      active.panel = false;
      if (panelTimer) cancelAnimationFrame(panelTimer);
      panelTimer = null;
      overlay.hidden = true;
      overlay.style.background = "";
      overlay.style.backgroundImage = "";
      status.textContent = "Off";
      status.className = "status";
      updatePower();
      document.getElementById("panelToggle").checked = false;
    }
  }

  document.getElementById("panelToggle").addEventListener("change", (e) => {
    setPanel(e.target.checked);
  });
  document.getElementById("panelCloseBtn").addEventListener("click", () => setPanel(false));

  // ---------- VRR / frame push ----------
  let vrrRaf = null;
  let vrrLast = 0;
  let vrrFrames = 0;
  let vrrHz = 0;
  let vrrJitter = 0;
  let vrrStutters = 0;
  let vrrDts = [];

  function vrrLoop(now) {
    if (!active.vrr) return;
    if (vrrLast) {
      const dt = now - vrrLast;
      vrrDts.push(dt);
      if (vrrDts.length > 120) vrrDts.shift();
      // Stutter: frame took >1.8× median
      if (vrrDts.length > 10) {
        const sorted = vrrDts.slice().sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        if (dt > med * 1.8 && dt > 12) vrrStutters++;
        const mean = vrrDts.reduce((a, b) => a + b, 0) / vrrDts.length;
        let v = 0;
        vrrDts.forEach((x) => { v += (x - mean) * (x - mean); });
        vrrJitter = Math.sqrt(v / vrrDts.length);
      }
    }
    vrrLast = now;
    vrrFrames++;

    const canvas = document.getElementById("vrrCanvas");
    const ctx = canvas.getContext("2d");
    const t = now * 0.001;
    // Moving bars to reveal tearing / stutter
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < 8; i++) {
      const x = ((t * (80 + i * 30)) + i * 40) % (canvas.width + 40) - 20;
      ctx.fillStyle = "hsl(" + ((i * 40 + t * 60) % 360) + ",90%,55%)";
      ctx.fillRect(x, 0, 18, canvas.height);
    }
    ctx.fillStyle = "#fff";
    ctx.font = "14px sans-serif";
    ctx.fillText(vrrHz.toFixed(1) + " Hz  jitter " + vrrJitter.toFixed(2) + "ms  stutters " + vrrStutters, 8, 20);

    if (vrrFrames % 30 === 0 && vrrDts.length > 5) {
      const mean = vrrDts.reduce((a, b) => a + b, 0) / vrrDts.length;
      vrrHz = mean > 0 ? 1000 / mean : 0;
      document.getElementById("vrrStatus").textContent =
        vrrHz.toFixed(1) + " Hz · jitter " + vrrJitter.toFixed(2) +
        " ms · stutters " + vrrStutters;
      document.getElementById("vrrStatus").className = "status on";
    }

    vrrRaf = requestAnimationFrame(vrrLoop);
  }

  function setVrr(on) {
    const status = document.getElementById("vrrStatus");
    if (on) {
      active.vrr = true;
      updatePower();
      vrrLast = 0;
      vrrFrames = 0;
      vrrHz = 0;
      vrrJitter = 0;
      vrrStutters = 0;
      vrrDts = [];
      status.textContent = "Pushing frames…";
      status.className = "status on";
      vrrRaf = requestAnimationFrame(vrrLoop);
    } else {
      active.vrr = false;
      if (vrrRaf) cancelAnimationFrame(vrrRaf);
      vrrRaf = null;
      status.textContent = "Off";
      status.className = "status";
      updatePower();
    }
  }

  document.getElementById("vrrToggle").addEventListener("change", (e) => {
    setVrr(e.target.checked);
  });

  // ---------- WebGPU compute (WGSL matrix stress) ----------
  let wgComputeRunning = false;
  let wgComputeDevice = null;
  let wgComputeTimer = null;

  async function setWebgpuCompute(on) {
    const status = document.getElementById("webgpuComputeStatus");
    if (on) {
      if (!navigator.gpu) {
        status.textContent = "WebGPU not supported";
        status.className = "status warn";
        document.getElementById("webgpuComputeToggle").checked = false;
        return;
      }
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error("No GPU adapter");
        wgComputeDevice = await adapter.requestDevice();
        const N = 512;
        const floats = N * N;
        const bufSize = floats * 4;
        const shader = wgComputeDevice.createShaderModule({
          code: `
            @group(0) @binding(0) var<storage, read_write> data: array<f32>;
            @compute @workgroup_size(16, 16)
            fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
              let N: u32 = 512u;
              if (gid.x >= N || gid.y >= N) { return; }
              let i = gid.y * N + gid.x;
              var acc = data[i];
              for (var k = 0u; k < 64u; k = k + 1u) {
                let j = (i + k * 17u) % (N * N);
                acc = acc * 1.000001 + data[j] * 0.0001;
                acc = sin(acc) + cos(acc * 0.5);
              }
              data[i] = acc;
            }
          `,
        });
        const pipeline = wgComputeDevice.createComputePipeline({
          layout: "auto",
          compute: { module: shader, entryPoint: "main" },
        });
        const storage = wgComputeDevice.createBuffer({
          size: bufSize,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        const init = new Float32Array(floats);
        for (let i = 0; i < floats; i++) init[i] = Math.random();
        wgComputeDevice.queue.writeBuffer(storage, 0, init);
        const bindGroup = wgComputeDevice.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: storage } }],
        });

        wgComputeRunning = true;
        active.webgpuCompute = true;
        updatePower();
        let passes = 0;
        const tick = () => {
          if (!wgComputeRunning) return;
          for (let p = 0; p < 4; p++) {
            const enc = wgComputeDevice.createCommandEncoder();
            const pass = enc.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(N / 16, N / 16);
            pass.end();
            wgComputeDevice.queue.submit([enc.finish()]);
            passes++;
          }
          status.textContent = "Compute · 512² · passes " + passes;
          status.className = "status on";
          wgComputeTimer = requestAnimationFrame(tick);
        };
        status.textContent = "WebGPU compute running…";
        status.className = "status on";
        wgComputeTimer = requestAnimationFrame(tick);
      } catch (err) {
        status.textContent = "Error: " + (err.message || err);
        status.className = "status warn";
        document.getElementById("webgpuComputeToggle").checked = false;
        active.webgpuCompute = false;
        updatePower();
      }
    } else {
      wgComputeRunning = false;
      if (wgComputeTimer) cancelAnimationFrame(wgComputeTimer);
      wgComputeTimer = null;
      try {
        if (wgComputeDevice) wgComputeDevice.destroy?.();
      } catch (_) {}
      wgComputeDevice = null;
      active.webgpuCompute = false;
      status.textContent = "Off";
      status.className = "status";
      updatePower();
    }
  }

  document.getElementById("webgpuComputeToggle").addEventListener("change", (e) => {
    setWebgpuCompute(e.target.checked);
  });

  // ---------- WebGPU dense instanced draw ----------
  let wgDrawRunning = false;
  let wgDrawRaf = null;
  let wgDrawDevice = null;

  async function setWebgpuDraw(on) {
    const status = document.getElementById("webgpuDrawStatus");
    const canvas = document.getElementById("webgpuDrawCanvas");
    if (on) {
      if (!navigator.gpu) {
        status.textContent = "WebGPU not supported";
        status.className = "status warn";
        document.getElementById("webgpuDrawToggle").checked = false;
        return;
      }
      try {
        const adapter = await navigator.gpu.requestAdapter();
        wgDrawDevice = await adapter.requestDevice();
        const ctx = canvas.getContext("webgpu");
        const format = navigator.gpu.getPreferredCanvasFormat();
        ctx.configure({ device: wgDrawDevice, format, alphaMode: "opaque" });
        const shader = wgDrawDevice.createShaderModule({
          code: `
            struct VSOut { @builtin(position) pos: vec4f, @location(0) col: vec4f };
            @vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
              var p = array<vec2f,3>(vec2f(0.0,0.06), vec2f(-0.05,-0.04), vec2f(0.05,-0.04));
              let ang = f32(ii) * 0.017;
              let c = cos(ang); let s = sin(ang);
              let lp = p[vi];
              let rp = vec2f(lp.x*c - lp.y*s, lp.x*s + lp.y*c);
              let scale = 0.15 + 0.85 * fract(f32(ii) * 0.002763);
              var o: VSOut;
              o.pos = vec4f(rp * scale + vec2f(sin(ang*3.0)*0.5, cos(ang*2.0)*0.5), 0.0, 1.0);
              o.col = vec4f(fract(f32(ii)*0.01), fract(f32(ii)*0.013), fract(f32(ii)*0.017), 1.0);
              return o;
            }
            @fragment fn fs(@location(0) col: vec4f) -> @location(0) vec4f { return col; }
          `,
        });
        const pipeline = wgDrawDevice.createRenderPipeline({
          layout: "auto",
          vertex: { module: shader, entryPoint: "vs" },
          fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
          primitive: { topology: "triangle-list" },
        });
        const INSTANCES = 8000;
        wgDrawRunning = true;
        active.webgpuDraw = true;
        updatePower();
        let frames = 0;
        const frame = () => {
          if (!wgDrawRunning) return;
          const enc = wgDrawDevice.createCommandEncoder();
          const pass = enc.beginRenderPass({
            colorAttachments: [{
              view: ctx.getCurrentTexture().createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              loadOp: "clear",
              storeOp: "store",
            }],
          });
          pass.setPipeline(pipeline);
          pass.draw(3, INSTANCES);
          pass.end();
          wgDrawDevice.queue.submit([enc.finish()]);
          frames++;
          if (frames % 30 === 0) {
            status.textContent = "Draw · " + INSTANCES + " instances · frames " + frames;
            status.className = "status on";
          }
          wgDrawRaf = requestAnimationFrame(frame);
        };
        status.textContent = "Dense draw running…";
        status.className = "status on";
        wgDrawRaf = requestAnimationFrame(frame);
      } catch (err) {
        status.textContent = "Error: " + (err.message || err);
        status.className = "status warn";
        document.getElementById("webgpuDrawToggle").checked = false;
        active.webgpuDraw = false;
        updatePower();
      }
    } else {
      wgDrawRunning = false;
      if (wgDrawRaf) cancelAnimationFrame(wgDrawRaf);
      wgDrawRaf = null;
      try { wgDrawDevice?.destroy?.(); } catch (_) {}
      wgDrawDevice = null;
      active.webgpuDraw = false;
      status.textContent = "Off";
      status.className = "status";
      updatePower();
    }
  }

  document.getElementById("webgpuDrawToggle").addEventListener("change", (e) => {
    setWebgpuDraw(e.target.checked);
  });

  // ---------- Multi-worker SIMD-style / WASM-like CPU stress ----------
  let wasmWorkers = [];
  let wasmTimer = null;

  const WASM_WORKER_SRC = `
    let run = false;
    function burn() {
      const n = 65536;
      const a = new Float64Array(n);
      const b = new Float64Array(n);
      for (let i = 0; i < n; i++) { a[i] = i * 0.001; b[i] = 1 - i * 0.0001; }
      let checksum = 0;
      const loop = () => {
        if (!run) return;
        // 4-wide software vector style
        for (let i = 0; i < n; i += 4) {
          a[i] = a[i] * b[i] + Math.sin(a[i]);
          a[i+1] = a[i+1] * b[i+1] + Math.sin(a[i+1]);
          a[i+2] = a[i+2] * b[i+2] + Math.sin(a[i+2]);
          a[i+3] = a[i+3] * b[i+3] + Math.sin(a[i+3]);
        }
        checksum += a[0];
        self.postMessage({ checksum });
        setTimeout(loop, 0);
      };
      loop();
    }
    self.onmessage = (e) => {
      if (e.data === "start") { run = true; burn(); }
      if (e.data === "stop") run = false;
    };
  `;

  function setWasm(on) {
    const status = document.getElementById("wasmStatus");
    if (on) {
      try {
        const cores = navigator.hardwareConcurrency || 4;
        const n = Math.min(8, Math.max(2, cores));
        const blob = new Blob([WASM_WORKER_SRC], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);
        let ops = 0;
        for (let i = 0; i < n; i++) {
          const w = new Worker(url);
          w.onmessage = () => { ops++; };
          w.postMessage("start");
          wasmWorkers.push(w);
        }
        URL.revokeObjectURL(url);
        active.wasm = true;
        updatePower();
        wasmTimer = setInterval(() => {
          status.textContent = n + " workers · ~" + ops + " ticks/s (SIMD-style loops)";
          status.className = "status on";
          ops = 0;
        }, 1000);
        status.textContent = "Running " + n + " workers…";
        status.className = "status on";
      } catch (err) {
        status.textContent = "Error: " + (err.message || err);
        status.className = "status warn";
        document.getElementById("wasmToggle").checked = false;
      }
    } else {
      active.wasm = false;
      wasmWorkers.forEach((w) => {
        try { w.postMessage("stop"); w.terminate(); } catch (_) {}
      });
      wasmWorkers = [];
      if (wasmTimer) clearInterval(wasmTimer);
      wasmTimer = null;
      status.textContent = "Off";
      status.className = "status";
      updatePower();
    }
  }

  document.getElementById("wasmToggle").addEventListener("change", (e) => {
    setWasm(e.target.checked);
  });

  // ---------- On-device AI-like WebGPU matmul / attention stress ----------
  let aiRunning = false;
  let aiRaf = null;
  let aiDevice = null;

  async function setAi(on) {
    const status = document.getElementById("aiStatus");
    if (on) {
      // Prefer WebGPU path; fallback to CPU matmul workers
      if (navigator.gpu) {
        try {
          const adapter = await navigator.gpu.requestAdapter();
          aiDevice = await adapter.requestDevice();
          const M = 256;
          const shader = aiDevice.createShaderModule({
            code: `
              @group(0) @binding(0) var<storage, read_write> x: array<f32>;
              @compute @workgroup_size(16, 16)
              fn main(@builtin(global_invocation_id) g: vec3<u32>) {
                let M: u32 = 256u;
                if (g.x >= M || g.y >= M) { return; }
                var sum = 0.0;
                for (var k = 0u; k < M; k = k + 1u) {
                  sum += x[g.y * M + k] * x[k * M + g.x];
                }
                // softmax-ish nonlinearity
                x[g.y * M + g.x] = sum / (1.0 + abs(sum));
              }
            `,
          });
          const pipeline = aiDevice.createComputePipeline({
            layout: "auto",
            compute: { module: shader, entryPoint: "main" },
          });
          const buf = aiDevice.createBuffer({
            size: M * M * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          });
          const init = new Float32Array(M * M);
          for (let i = 0; i < init.length; i++) init[i] = (Math.random() - 0.5) * 0.1;
          aiDevice.queue.writeBuffer(buf, 0, init);
          const bg = aiDevice.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: buf } }],
          });
          aiRunning = true;
          active.ai = true;
          updatePower();
          let steps = 0;
          const tick = () => {
            if (!aiRunning) return;
            const enc = aiDevice.createCommandEncoder();
            const pass = enc.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bg);
            for (let i = 0; i < 3; i++) {
              pass.dispatchWorkgroups(M / 16, M / 16);
            }
            pass.end();
            aiDevice.queue.submit([enc.finish()]);
            steps++;
            status.textContent = "AI-style matmul 256² · steps " + steps + " (WebGPU)";
            status.className = "status on";
            aiRaf = requestAnimationFrame(tick);
          };
          aiRaf = requestAnimationFrame(tick);
          return;
        } catch (err) {
          status.textContent = "WebGPU AI failed: " + (err.message || err);
        }
      }
      // CPU fallback
      active.ai = true;
      updatePower();
      aiRunning = true;
      const tickCpu = () => {
        if (!aiRunning) return;
        const n = 128;
        const a = new Float32Array(n * n);
        for (let i = 0; i < a.length; i++) a[i] = Math.random();
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            let s = 0;
            for (let k = 0; k < n; k++) s += a[i * n + k] * a[k * n + j];
            a[i * n + j] = s;
          }
        }
        status.textContent = "AI-style matmul 128² (CPU fallback)";
        status.className = "status on";
        aiRaf = requestAnimationFrame(tickCpu);
      };
      aiRaf = requestAnimationFrame(tickCpu);
    } else {
      aiRunning = false;
      if (aiRaf) cancelAnimationFrame(aiRaf);
      aiRaf = null;
      try { aiDevice?.destroy?.(); } catch (_) {}
      aiDevice = null;
      active.ai = false;
      status.textContent = "Off";
      status.className = "status";
      updatePower();
    }
  }

  document.getElementById("aiToggle").addEventListener("change", (e) => {
    setAi(e.target.checked);
  });

  // ---------- Zero-GC memory saturator ----------
  let zeroGcBuffers = [];
  let zeroGcTimer = null;

  function setZeroGc(on) {
    const status = document.getElementById("zeroGcStatus");
    if (on) {
      try {
        zeroGcBuffers = [];
        const chunk = 8 * 1024 * 1024; // 8MB
        const count = 24; // ~192MB retained
        for (let i = 0; i < count; i++) {
          const buf = new ArrayBuffer(chunk);
          const view = new Uint32Array(buf);
          for (let j = 0; j < view.length; j += 1024) view[j] = j;
          zeroGcBuffers.push(view);
        }
        active.zeroGc = true;
        updatePower();
        let passes = 0;
        zeroGcTimer = setInterval(() => {
          // In-place shuffle / write — no new allocations
          for (let b = 0; b < zeroGcBuffers.length; b++) {
            const v = zeroGcBuffers[b];
            const len = v.length;
            for (let i = 0; i < len; i += 64) {
              const j = (i * 1103515245 + passes) & (len - 1);
              const t = v[i];
              v[i] = v[j] + 1;
              v[j] = t;
            }
          }
          passes++;
          status.textContent =
            "Saturating · " + zeroGcBuffers.length + "×8MB retained · pass " + passes;
          status.className = "status on";
        }, 16);
        status.textContent = "Allocated · shuffling in place…";
        status.className = "status on";
      } catch (err) {
        status.textContent = "Error: " + (err.message || err);
        status.className = "status warn";
        document.getElementById("zeroGcToggle").checked = false;
        zeroGcBuffers = [];
      }
    } else {
      active.zeroGc = false;
      if (zeroGcTimer) clearInterval(zeroGcTimer);
      zeroGcTimer = null;
      zeroGcBuffers = [];
      status.textContent = "Off — buffers released";
      status.className = "status";
      updatePower();
    }
  }

  document.getElementById("zeroGcToggle").addEventListener("change", (e) => {
    setZeroGc(e.target.checked);
  });

  // ---------- HDR / peak brightness ----------
  let hdrRaf = null;

  function setHdr(on) {
    const overlay = document.getElementById("hdrOverlay");
    const status = document.getElementById("hdrStatus");
    const canvas = document.getElementById("hdrCanvas");
    if (on) {
      overlay.hidden = false;
      active.hdr = true;
      updatePower();
      const ctx = canvas.getContext("2d", { colorSpace: "display-p3" }) || canvas.getContext("2d");
      // Try HDR canvas configuration when available
      try {
        if (canvas.configureHighDynamicRange) {
          canvas.configureHighDynamicRange({ mode: "extended" });
        }
      } catch (_) {}
      const paint = (t) => {
        if (!active.hdr) return;
        canvas.width = window.innerWidth * (window.devicePixelRatio || 1);
        canvas.height = window.innerHeight * (window.devicePixelRatio || 1);
        // Peak white + moving bright geometry
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const g = ctx.createRadialGradient(
          canvas.width / 2, canvas.height / 2, 10,
          canvas.width / 2, canvas.height / 2, canvas.width * 0.4
        );
        g.addColorStop(0, "#ffffff");
        g.addColorStop(1, "#ffffee");
        ctx.fillStyle = g;
        const x = canvas.width / 2 + Math.sin(t * 0.002) * canvas.width * 0.2;
        const y = canvas.height / 2 + Math.cos(t * 0.0015) * canvas.height * 0.2;
        ctx.beginPath();
        ctx.arc(x, y, canvas.width * 0.15, 0, Math.PI * 2);
        ctx.fill();
        status.textContent = "HDR/peak white · full screen";
        status.className = "status on";
        hdrRaf = requestAnimationFrame(paint);
      };
      hdrRaf = requestAnimationFrame(paint);
    } else {
      active.hdr = false;
      if (hdrRaf) cancelAnimationFrame(hdrRaf);
      hdrRaf = null;
      overlay.hidden = true;
      status.textContent = "Off";
      status.className = "status";
      updatePower();
      document.getElementById("hdrToggle").checked = false;
    }
  }

  document.getElementById("hdrToggle").addEventListener("change", (e) => {
    setHdr(e.target.checked);
  });
  document.getElementById("hdrCloseBtn").addEventListener("click", () => setHdr(false));

  // ---------- Heavy Web Audio DSP ----------
  let audioDspCtx = null;
  let audioDspNodes = [];

  function setAudioDsp(on) {
    const status = document.getElementById("audioDspStatus");
    if (on) {
      try {
        audioDspCtx = new (window.AudioContext || window.webkitAudioContext)();
        const n = parseInt(document.getElementById("audioDspCount").value, 10) || 64;
        const master = audioDspCtx.createGain();
        master.gain.value = 0.0008 * Math.min(1, 32 / n); // keep quiet but DSP-heavy
        master.connect(audioDspCtx.destination);
        for (let i = 0; i < n; i++) {
          const osc = audioDspCtx.createOscillator();
          osc.type = ["sine", "square", "sawtooth", "triangle"][i % 4];
          osc.frequency.value = 80 + (i * 37) % 2000;
          const filt = audioDspCtx.createBiquadFilter();
          filt.type = "lowpass";
          filt.frequency.value = 400 + (i * 20) % 4000;
          const g = audioDspCtx.createGain();
          g.gain.value = 1;
          const delay = audioDspCtx.createDelay(0.3);
          delay.delayTime.value = 0.01 + (i % 20) * 0.005;
          osc.connect(filt);
          filt.connect(delay);
          delay.connect(g);
          g.connect(master);
          osc.start();
          audioDspNodes.push(osc, filt, delay, g);
        }
        active.audioDsp = true;
        updatePower();
        status.textContent = n + " oscillators + filters/delays active";
        status.className = "status on";
      } catch (err) {
        status.textContent = "Error: " + (err.message || err);
        status.className = "status warn";
        document.getElementById("audioDspToggle").checked = false;
      }
    } else {
      active.audioDsp = false;
      audioDspNodes.forEach((n) => {
        try { if (n.stop) n.stop(); n.disconnect(); } catch (_) {}
      });
      audioDspNodes = [];
      try { audioDspCtx?.close(); } catch (_) {}
      audioDspCtx = null;
      status.textContent = "Off";
      status.className = "status";
      updatePower();
    }
  }

  document.getElementById("audioDspToggle").addEventListener("change", (e) => {
    setAudioDsp(e.target.checked);
  });
  document.getElementById("audioDspCount").addEventListener("input", (e) => {
    document.getElementById("audioDspCountValue").textContent = e.target.value;
  });

  // ---------- Storage stress (OPFS or IndexedDB) ----------
  let storageAbort = false;
  let storageOps = 0;
  let storageBytes = 0;
  let storageLastT = 0;
  let storageLastOps = 0;
  let storageLastBytes = 0;

  function idbReq(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("IDB error"));
    });
  }

  async function openIdb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("pst-storage-stress", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("chunks")) {
          db.createObjectStore("chunks");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function storageLoop() {
    const status = document.getElementById("storageStatus");
    const pattern = document.getElementById("storagePattern")?.value || "mixed";
    const blockSize = 256 * 1024; // 256 KB
    const blocks = 32;
    storageOps = 0;
    storageBytes = 0;
    storageLastT = performance.now();
    storageLastOps = 0;
    storageLastBytes = 0;

    let mode = "idb";
    let root = null;
    let fileHandle = null;

    try {
      if (navigator.storage && navigator.storage.getDirectory) {
        root = await navigator.storage.getDirectory();
        fileHandle = await root.getFileHandle("pst-stress.bin", { create: true });
        mode = "opfs";
      }
    } catch (_) {
      mode = "idb";
    }

    let db = null;
    if (mode === "idb") {
      try {
        db = await openIdb();
      } catch (err) {
        status.textContent = "Storage unavailable: " + (err.message || err);
        status.className = "status warn";
        document.getElementById("storageToggle").checked = false;
        active.storage = false;
        updatePower();
        return;
      }
    }

    const payload = new Uint8Array(blockSize);
    for (let i = 0; i < blockSize; i += 4096) payload[i] = i & 0xff;

    status.textContent = "Running (" + mode.toUpperCase() + ")…";
    status.className = "status on";

    let seq = 0;
    while (!storageAbort) {
      const useRand = pattern === "rand" || (pattern === "mixed" && seq % 2 === 1);
      const idx = useRand ? (Math.random() * blocks) | 0 : seq % blocks;
      const t0 = performance.now();

      try {
        if (mode === "opfs") {
          const writable = await fileHandle.createWritable({ keepExistingData: true });
          await writable.seek(idx * blockSize);
          await writable.write(payload);
          await writable.close();
          const file = await fileHandle.getFile();
          const blob = file.slice(idx * blockSize, idx * blockSize + blockSize);
          await blob.arrayBuffer();
        } else {
          const key = "b" + idx;
          const wtx = db.transaction("chunks", "readwrite");
          await idbReq(wtx.objectStore("chunks").put(payload.buffer.slice(0), key));
          const rtx = db.transaction("chunks", "readonly");
          await idbReq(rtx.objectStore("chunks").get(key));
        }
        storageOps += 2; // write + read
        storageBytes += blockSize * 2;
      } catch (err) {
        status.textContent = "Error: " + (err.message || err.name);
        status.className = "status warn";
        break;
      }

      seq++;
      const now = performance.now();
      if (now - storageLastT >= 1000) {
        const dt = (now - storageLastT) / 1000;
        const ops = (storageOps - storageLastOps) / dt;
        const bps = (storageBytes - storageLastBytes) / dt;
        metrics.storageOpsPerSec = ops;
        metrics.storageMBps = bps / (1024 * 1024);
        status.textContent =
          mode.toUpperCase() + " · " + ops.toFixed(0) + " ops/s · " +
          metrics.storageMBps.toFixed(1) + " MB/s · lat ~" +
          (dt * 1000 / Math.max(1, storageOps - storageLastOps)).toFixed(1) + " ms";
        storageLastT = now;
        storageLastOps = storageOps;
        storageLastBytes = storageBytes;
      }
      // Yield so UI stays responsive
      await new Promise((r) => setTimeout(r, 0));
    }

    if (db) try { db.close(); } catch (_) {}
    if (!storageAbort) {
      // stopped due to error
    } else {
      status.textContent = "Off";
      status.className = "status";
    }
    metrics.storageOpsPerSec = 0;
    metrics.storageMBps = 0;
  }

  function setStorage(on) {
    if (on) {
      storageAbort = false;
      active.storage = true;
      updatePower();
      storageLoop();
    } else {
      storageAbort = true;
      active.storage = false;
      updatePower();
      document.getElementById("storageStatus").textContent = "Off";
      document.getElementById("storageStatus").className = "status";
      metrics.storageOpsPerSec = 0;
      metrics.storageMBps = 0;
    }
  }

  document.getElementById("storageToggle").addEventListener("change", (e) => {
    setStorage(e.target.checked);
  });

  // ---------- Modem multi-stream (fetch + WebSocket) ----------
  let modemAbort = null;
  let modemBytes = 0;
  let modemLastT = 0;
  let modemLastBytes = 0;
  let modemLatSum = 0;
  let modemLatN = 0;
  let modemSockets = [];

  const MODEM_URLS = [
    "https://speed.cloudflare.com/__down?bytes=2000000",
    "https://proof.ovh.net/files/1Mb.dat",
  ];

  async function modemFetchWorker(signal, id) {
    let i = 0;
    while (!signal.aborted) {
      const url = MODEM_URLS[i % MODEM_URLS.length] + "&t=" + Date.now() + "&s=" + id;
      i++;
      const t0 = performance.now();
      try {
        const res = await fetch(url, { signal, cache: "no-store", mode: "cors" });
        const buf = await res.arrayBuffer();
        modemBytes += buf.byteLength;
        modemLatSum += performance.now() - t0;
        modemLatN++;
      } catch (err) {
        if (err.name === "AbortError") break;
        // local churn fallback
        const size = 1 * 1024 * 1024;
        const b = new Uint8Array(size);
        for (let j = 0; j < size; j += 4096) b[j] = 1;
        modemBytes += size;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  }

  function modemWsWorker(signal) {
    return new Promise((resolve) => {
      let ws;
      try {
        ws = new WebSocket("wss://echo.websocket.events");
      } catch (_) {
        resolve();
        return;
      }
      modemSockets.push(ws);
      let timer = null;
      const cleanup = () => {
        if (timer) clearInterval(timer);
        try { ws.close(); } catch (_) {}
        resolve();
      };
      signal.addEventListener("abort", cleanup);
      ws.onopen = () => {
        timer = setInterval(() => {
          if (signal.aborted) return cleanup();
          try {
            const t0 = performance.now();
            ws.send("ping-" + t0);
            ws._pingAt = t0;
          } catch (_) {}
        }, 200);
      };
      ws.onmessage = () => {
        if (ws._pingAt) {
          modemLatSum += performance.now() - ws._pingAt;
          modemLatN++;
          ws._pingAt = 0;
        }
        modemBytes += 64;
      };
      ws.onerror = cleanup;
      ws.onclose = cleanup;
    });
  }

  function setModem(on) {
    const status = document.getElementById("modemStatus");
    if (on) {
      modemAbort = new AbortController();
      modemBytes = 0;
      modemLastT = performance.now();
      modemLastBytes = 0;
      modemLatSum = 0;
      modemLatN = 0;
      active.modem = true;
      updatePower();
      const n = parseInt(document.getElementById("modemStreamsSlider").value, 10) || 6;
      status.textContent = "Running " + n + " streams…";
      status.className = "status on";

      const workers = [];
      for (let i = 0; i < n; i++) {
        workers.push(modemFetchWorker(modemAbort.signal, i));
      }
      workers.push(modemWsWorker(modemAbort.signal));

      const ui = setInterval(() => {
        if (!active.modem) {
          clearInterval(ui);
          return;
        }
        const now = performance.now();
        const dt = (now - modemLastT) / 1000;
        if (dt > 0.2) {
          const bps = (modemBytes - modemLastBytes) / dt;
          metrics.networkMbps = (bps * 8) / 1e6;
          metrics.modemLatencyMs = modemLatN ? modemLatSum / modemLatN : 0;
          modemLastT = now;
          modemLastBytes = modemBytes;
          modemLatSum = 0;
          modemLatN = 0;
          status.textContent =
            n + " streams · " + metrics.networkMbps.toFixed(1) + " Mb/s · lag ~" +
            metrics.modemLatencyMs.toFixed(0) + " ms";
        }
      }, 1000);

      Promise.all(workers).finally(() => {
        clearInterval(ui);
        if (!active.modem) {
          status.textContent = "Off";
          status.className = "status";
        }
      });
    } else {
      active.modem = false;
      if (modemAbort) modemAbort.abort();
      modemSockets.forEach((ws) => { try { ws.close(); } catch (_) {} });
      modemSockets = [];
      metrics.networkMbps = 0;
      metrics.modemLatencyMs = 0;
      updatePower();
      status.textContent = "Off";
      status.className = "status";
    }
  }

  document.getElementById("modemToggle").addEventListener("change", (e) => {
    setModem(e.target.checked);
  });
  document.getElementById("modemStreamsSlider").addEventListener("input", (e) => {
    document.getElementById("modemStreamsValue").textContent = e.target.value;
  });

  // ---------- Telemetry / throttle timeline ----------
  let telemetrySamples = [];
  let telemetryTimer = null;
  let telemetryStart = 0;
  let telemetryBaseline = null;
  let marker5 = null, marker10 = null, marker15 = null;

  function compositeScore() {
    // Weighted blend of available metrics
    return (
      metrics.cpuOpsPerSec * 1e-6 * 40 +
      metrics.gpuFps * 0.5 +
      metrics.storageOpsPerSec * 0.05 +
      metrics.networkMbps * 0.3
    );
  }

  function startTelemetry() {
    if (telemetryTimer) return;
    telemetrySamples = [];
    telemetryStart = performance.now();
    telemetryBaseline = null;
    marker5 = marker10 = marker15 = null;
    document.getElementById("throttleStatus").textContent = "Sampling…";
    document.getElementById("throttleStatus").className = "status on";
    telemetryTimer = setInterval(() => {
      const tSec = (performance.now() - telemetryStart) / 1000;
      const score = compositeScore();
      if (telemetryBaseline == null && tSec >= 8) {
        const early = telemetrySamples.filter((s) => s.t >= 3 && s.t <= 12);
        if (early.length) {
          telemetryBaseline = early.reduce((a, s) => a + s.score, 0) / early.length;
          document.getElementById("telBaseline").textContent = telemetryBaseline.toFixed(1);
        }
      }

      // Thermal efficiency: throughput vs baseline (DVFS / heat proxy)
      if (telemetryBaseline && telemetryBaseline > 0) {
        thermalEfficiency = Math.max(0, Math.min(1.5, score / telemetryBaseline));
      } else {
        thermalEfficiency = null;
      }

      const sample = {
        t: tSec,
        cpuOpsPerSec: metrics.cpuOpsPerSec,
        gpuFps: metrics.gpuFps,
        storageOpsPerSec: metrics.storageOpsPerSec,
        storageMBps: metrics.storageMBps,
        networkMbps: metrics.networkMbps,
        modemLatencyMs: metrics.modemLatencyMs,
        score,
        powerIndexW: lastPowerIndexW,
        thermalEfficiency,
        stressRatePctPerMin,
        idleRatePctPerMin,
        batteryDerivedMw,
      };
      telemetrySamples.push(sample);
      document.getElementById("telCurrent").textContent = score.toFixed(1);
      document.getElementById("telSamples").textContent = String(telemetrySamples.length);

      const dropPct = (s) =>
        telemetryBaseline
          ? ((1 - s / telemetryBaseline) * 100).toFixed(0) + "% drop"
          : s.toFixed(1);

      if (!marker5 && tSec >= 300) {
        marker5 = score;
        document.getElementById("tel5").textContent = dropPct(score);
      }
      if (!marker10 && tSec >= 600) {
        marker10 = score;
        document.getElementById("tel10").textContent = dropPct(score);
      }
      if (!marker15 && tSec >= 900) {
        marker15 = score;
        document.getElementById("tel15").textContent = dropPct(score);
      }

      const te = thermalEfficiency;
      if (telemetryBaseline && score < telemetryBaseline * 0.7) {
        document.getElementById("throttleStatus").textContent =
          "Thermal throttle likely — " + score.toFixed(1) +
          " vs baseline " + telemetryBaseline.toFixed(1) +
          (te != null ? " · efficiency " + (te * 100).toFixed(0) + "%" : "");
        document.getElementById("throttleStatus").className = "status warn";
      } else {
        document.getElementById("throttleStatus").textContent =
          "Sampling · t=" + tSec.toFixed(0) + "s" +
          (te != null ? " · eff " + (te * 100).toFixed(0) + "%" : "");
        document.getElementById("throttleStatus").className = "status on";
      }
      updateBatteryUI();
      updatePower();
    }, 3000);
  }

  function stopTelemetry() {
    if (telemetryTimer) {
      clearInterval(telemetryTimer);
      telemetryTimer = null;
    }
    document.getElementById("throttleStatus").textContent =
      telemetrySamples.length ? "Stopped · " + telemetrySamples.length + " samples" : "Not sampling";
    document.getElementById("throttleStatus").className = "status";
  }

  function deviceSpecs() {
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency || null,
      deviceMemoryGB: navigator.deviceMemory || null,
      maxTouchPoints: navigator.maxTouchPoints || 0,
      language: navigator.language,
      jsHeapLimit: performance.memory ? performance.memory.jsHeapSizeLimit : null,
      screen: {
        width: screen.width,
        height: screen.height,
        pixelRatio: window.devicePixelRatio,
      },
    };
  }

  function buildReport() {
    const scores = telemetrySamples.map((s) => s.score);
    const minS = scores.length ? Math.min(...scores) : null;
    const maxS = scores.length ? Math.max(...scores) : null;
    const duration = telemetrySamples.length
      ? telemetrySamples[telemetrySamples.length - 1].t
      : 0;
    const throttleEvents = telemetrySamples.filter(
      (s) => telemetryBaseline && s.score < telemetryBaseline * 0.7
    );
    return {
      generatedAt: new Date().toISOString(),
      device: deviceSpecs(),
      durationSec: duration,
      baselineScore: telemetryBaseline,
      minScore: minS,
      maxScore: maxS,
      markers: { min5: marker5, min10: marker10, min15: marker15 },
      throttleEventCount: throttleEvents.length,
      throttleTimeline: throttleEvents.map((s) => ({
        t: +s.t.toFixed(1),
        score: +s.score.toFixed(2),
        thermalEfficiency: s.thermalEfficiency,
        powerIndexW: s.powerIndexW,
      })),
      power: {
        modelIndexW: lastPowerIndexW,
        coefficients: POWER,
        battery: {
          capacityMah: getBatteryCapacityMah(),
          voltageV: getBatteryVoltage(),
          stressRatePctPerMin,
          idleRatePctPerMin,
          derivedMw: batteryDerivedMw,
          eventCount: batteryEventCount,
          formula: "mW ≈ (Δ%/Δt_hours) × mAh × V",
        },
      },
      batteryLevelEvents: batteryLevelEvents.map((e) => ({
        tWall: e.tWall,
        tPerf: +e.tPerf.toFixed(1),
        levelPct: e.levelPct,
        charging: e.charging,
        stress: e.stress,
        source: e.source,
        powerIndexW: e.powerIndexW,
      })),
      samples: telemetrySamples,
    };
  }

  function downloadBlob(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  document.getElementById("exportJson").addEventListener("click", () => {
    const report = buildReport();
    downloadBlob(
      "pst-report-" + Date.now() + ".json",
      JSON.stringify(report, null, 2),
      "application/json"
    );
  });

  document.getElementById("exportCsv").addEventListener("click", () => {
    const rows = [
      ["t_sec", "cpu_ops_s", "gpu_fps", "storage_ops_s", "storage_MBps", "network_Mbps", "modem_lat_ms", "score"],
    ];
    telemetrySamples.forEach((s) => {
      rows.push([
        s.t.toFixed(1),
        s.cpuOpsPerSec,
        s.gpuFps,
        s.storageOpsPerSec,
        s.storageMBps.toFixed(3),
        s.networkMbps.toFixed(3),
        s.modemLatencyMs.toFixed(1),
        s.score.toFixed(2),
      ]);
    });
    downloadBlob(
      "pst-report-" + Date.now() + ".csv",
      rows.map((r) => r.join(",")).join("\n"),
      "text/csv"
    );
  });

  function renderScorecard() {
    const r = buildReport();
    const lines = [
      "═══ Device Stress Tester Scorecard ═══",
      "Time: " + r.generatedAt,
      "",
      "Device:",
      "  " + (r.device.userAgent || "").slice(0, 80),
      "  Cores: " + (r.device.hardwareConcurrency ?? "n/a") +
        " · RAM est: " + (r.device.deviceMemoryGB ?? "n/a") + " GB",
      "  Screen: " + r.device.screen.width + "×" + r.device.screen.height +
        " @" + r.device.screen.pixelRatio + "x",
      "",
      "Run: " + r.durationSec.toFixed(0) + "s",
      "Baseline score: " + (r.baselineScore != null ? r.baselineScore.toFixed(1) : "n/a"),
      "Min / Max score: " +
        (r.minScore != null ? r.minScore.toFixed(1) : "n/a") +
        " / " +
        (r.maxScore != null ? r.maxScore.toFixed(1) : "n/a"),
      "Throttle events: " + r.throttleEventCount,
      "  @5m: " + (r.markers.min5 != null ? r.markers.min5.toFixed(1) : "—") +
        "  @10m: " + (r.markers.min10 != null ? r.markers.min10.toFixed(1) : "—") +
        "  @15m: " + (r.markers.min15 != null ? r.markers.min15.toFixed(1) : "—"),
      "",
      "Compare this card across devices.",
      "═══════════════════════════════════",
    ];
    const text = lines.join("\n");
    document.getElementById("scorecardText").textContent = text;
    document.getElementById("scorecardCard").hidden = false;
    return text;
  }

  document.getElementById("exportScorecard").addEventListener("click", () => {
    renderScorecard();
  });
  document.getElementById("copyScorecard").addEventListener("click", async () => {
    const text = renderScorecard();
    try {
      await navigator.clipboard.writeText(text);
      document.getElementById("copyScorecard").textContent = "Copied!";
      setTimeout(() => {
        document.getElementById("copyScorecard").textContent = "Copy summary";
      }, 1500);
    } catch (_) {
      document.getElementById("copyScorecard").textContent = "Copy failed";
    }
  });

  // ---------- Preset profiles ----------
  let presetTimer = null;
  let presetName = null;

  function setToggle(id, on) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.checked === on) {
      // still fire handlers if needed by forcing change
      if (on) el.dispatchEvent(new Event("change"));
      return;
    }
    el.checked = on;
    el.dispatchEvent(new Event("change"));
  }

  function abortPreset(reason) {
    if (presetTimer) {
      clearTimeout(presetTimer);
      presetTimer = null;
    }
    presetName = null;
    document.getElementById("presetAbort").hidden = true;
    document.getElementById("presetStatus").textContent =
      reason || "Idle — pick a profile or use individual toggles";
    document.getElementById("presetStatus").className = "status";
  }

  let presetGpuDelayTimer = null;

  function stopHeavyLoads() {
    if (presetGpuDelayTimer) {
      clearTimeout(presetGpuDelayTimer);
      presetGpuDelayTimer = null;
    }
    setToggle("cpuToggle", false);
    setToggle("gpuToggle", false);
    setToggle("storageToggle", false);
    setToggle("modemToggle", false);
    setToggle("downloadToggle", false);
    setToggle("cameraToggle", false);
    setToggle("vibrateToggle", false);
    setToggle("locationToggle", false);
    setToggle("ramToggle", false);
    setToggle("sensorsToggle", false);
    setToggle("nfcToggle", false);
    setToggle("blurCloseToggle", false);
    setToggle("vrrToggle", false);
    setToggle("webgpuComputeToggle", false);
    setToggle("webgpuDrawToggle", false);
    setToggle("wasmToggle", false);
    setToggle("aiToggle", false);
    setToggle("zeroGcToggle", false);
    setToggle("hdrToggle", false);
    setToggle("audioDspToggle", false);
    // Leave torch / void / tone / mic / isp / panel alone unless part of a preset
  }

  function startPreset(name, durationMs, setup) {
    abortPreset();
    stopHeavyLoads();
    stopTelemetry();
    telemetrySamples = [];
    marker5 = marker10 = marker15 = null;
    ["telBaseline", "telCurrent", "tel5", "tel10", "tel15"].forEach((id) => {
      document.getElementById(id).textContent = "—";
    });
    document.getElementById("telSamples").textContent = "0";

    presetName = name;
    document.getElementById("presetAbort").hidden = false;
    document.getElementById("presetStatus").textContent =
      name + (durationMs ? " · running…" : " · running until abort");
    document.getElementById("presetStatus").className = "status on";

    setup();
    startTelemetry();

    if (durationMs) {
      presetTimer = setTimeout(() => {
        stopHeavyLoads();
        stopTelemetry();
        abortPreset(name + " complete — export report or scorecard");
        renderScorecard();
      }, durationMs);
    }
  }

  /** Active profile key for multi-tab / URL: quick | endurance | torture | max */
  let lastProfileKey = null;
  let lastProfileDurationSec = null; // null = profile default

  function applyGpuHeavy() {
    const mode = document.getElementById("gpuMode");
    if (mode) mode.value = "webgl";
    const goal = document.getElementById("goalFpsSlider");
    if (goal) {
      goal.value = "5";
      goal.dispatchEvent(new Event("input"));
    }
  }

  function runProfile(key, durationSecOverride) {
    const k = String(key || "").toLowerCase().trim();
    lastProfileKey = k;

    if (k === "quick" || k === "burst") {
      const dur =
        durationSecOverride != null
          ? durationSecOverride * 1000
          : 60 * 1000;
      lastProfileDurationSec =
        durationSecOverride != null ? durationSecOverride : 60;
      startPreset("Quick Burst", dur, () => {
        setToggle("cpuToggle", true);
        setToggle("modemToggle", true);
      });
      return true;
    }

    if (k === "endurance" || k === "thermal") {
      const dur =
        durationSecOverride != null
          ? durationSecOverride * 1000
          : 15 * 60 * 1000;
      lastProfileDurationSec =
        durationSecOverride != null ? durationSecOverride : 900;
      startPreset("Thermal Endurance", dur, () => {
        applyGpuHeavy();
        setToggle("cpuToggle", true);
        setToggle("gpuToggle", true);
        setToggle("storageToggle", true);
        setToggle("modemToggle", true);
      });
      return true;
    }

    if (k === "torture") {
      const dur =
        durationSecOverride != null && durationSecOverride > 0
          ? durationSecOverride * 1000
          : 0;
      lastProfileDurationSec =
        durationSecOverride != null ? durationSecOverride : 0;
      startPreset("Torture Test", dur, () => {
        applyGpuHeavy();
        setToggle("cpuToggle", true);
        setToggle("gpuToggle", true);
        setToggle("storageToggle", true);
        setToggle("modemToggle", true);
        setToggle("ramToggle", true);
      });
      return true;
    }

    if (k === "max") {
      const dur =
        durationSecOverride != null && durationSecOverride > 0
          ? durationSecOverride * 1000
          : 0;
      lastProfileDurationSec =
        durationSecOverride != null ? durationSecOverride : 0;
      startPreset("MAX", dur, () => {
        setToggle("cameraToggle", true);
        setToggle("vibrateToggle", true);
        setToggle("locationToggle", true);
        setToggle("cpuToggle", true);
        setToggle("downloadToggle", true);
        setToggle("modemToggle", true);
        setToggle("storageToggle", true);
        setToggle("ramToggle", true);
        setToggle("sensorsToggle", true);
        setToggle("nfcToggle", true);
        setToggle("blurCloseToggle", true);
        setToggle("vrrToggle", true);
        setToggle("wasmToggle", true);
        setToggle("zeroGcToggle", true);
        setToggle("audioDspToggle", true);

        // Still exclude simple torch / void / single-tone / mic / ISP torch-loop / RGB panel
        setToggle("torchToggle", false);
        setToggle("voidToggle", false);
        setToggle("toneToggle", false);
        setToggle("micToggle", false);
        setToggle("ispToggle", false);
        setToggle("panelToggle", false);

        applyGpuHeavy();

        document.getElementById("presetStatus").textContent =
          "MAX · permissions first — GPU/WebGPU in 2.5s…";

        presetGpuDelayTimer = setTimeout(() => {
          presetGpuDelayTimer = null;
          if (presetName !== "MAX") return;
          setToggle("gpuToggle", true);
          setToggle("webgpuComputeToggle", true);
          setToggle("webgpuDrawToggle", true);
          setToggle("aiToggle", true);
          setToggle("hdrToggle", true);
          document.getElementById("presetStatus").textContent =
            "MAX · full stack (WebGPU/AI/HDR/DSP) · until abort";
          document.getElementById("presetStatus").className = "status on";
        }, 2500);
      });
      return true;
    }

    return false;
  }

  // ---------- Stealth link encoding (AES-GCM, client-side key) ----------
  // Password in the URL is encrypted, not plain text. The key lives in this
  // script (anyone with the source can decrypt). Cleared from memory on refresh.
  const STEALTH_LINK_KEY_MATERIAL = "dst-stealth-v1-link-key-9f3a";

  async function stealthCryptoKey() {
    const enc = new TextEncoder();
    const base = await crypto.subtle.digest(
      "SHA-256",
      enc.encode(STEALTH_LINK_KEY_MATERIAL)
    );
    return crypto.subtle.importKey("raw", base, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  }

  function b64urlFromBuf(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function bufFromB64url(str) {
    const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
    const b64 = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  async function encryptStealthPassword(plain) {
    if (!plain) return "";
    const key = await stealthCryptoKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plain)
    );
    // iv (12) + ciphertext
    const packed = new Uint8Array(iv.length + ct.byteLength);
    packed.set(iv, 0);
    packed.set(new Uint8Array(ct), iv.length);
    return b64urlFromBuf(packed.buffer);
  }

  async function decryptStealthPassword(token) {
    if (!token) return "";
    try {
      const packed = new Uint8Array(bufFromB64url(token));
      if (packed.length < 13) return "";
      const iv = packed.slice(0, 12);
      const data = packed.slice(12);
      const key = await stealthCryptoKey();
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        data
      );
      return new TextDecoder().decode(pt);
    } catch (_) {
      return "";
    }
  }

  function parseHashParams() {
    const raw = (location.hash || "").replace(/^#/, "");
    const params = {};
    if (!raw) return params;
    raw.split("&").forEach((part) => {
      const [k, v] = part.split("=");
      if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || "");
    });
    return params;
  }

  function buildProfileHash(key, durationSec, spawnLeft, stealthExtra) {
    const parts = [];
    if (key) parts.push("profile=" + encodeURIComponent(key));
    if (durationSec != null && durationSec !== "") {
      parts.push("duration=" + encodeURIComponent(String(durationSec)));
    }
    if (spawnLeft != null && spawnLeft > 0) {
      parts.push("spawn=" + encodeURIComponent(String(spawnLeft)));
    }
    if (stealthExtra && stealthExtra.layout) {
      parts.push("stealth=" + encodeURIComponent(stealthExtra.layout));
    }
    if (stealthExtra && stealthExtra.sp) {
      parts.push("sp=" + encodeURIComponent(stealthExtra.sp));
    }
    if (stealthExtra && stealthExtra.tab) {
      parts.push("stab=" + encodeURIComponent(stealthExtra.tab));
    }
    return parts.join("&");
  }

  async function buildStealthShareHash() {
    const layout =
      document.getElementById("stealthLayout")?.value || "blank";
    const tabTitle =
      document.getElementById("stealthTitle")?.value || "Documentation";
    syncStealthPasswordFromInput();
    const sp = stealthSessionPassword
      ? await encryptStealthPassword(stealthSessionPassword)
      : "";
    const base = buildProfileHash(null, null, null, {
      layout,
      sp: sp || undefined,
      tab: tabTitle,
    });
    // Include active feature state so reload restores load behind the cover
    const feats = collectFeatureParams();
    const extra = Object.keys(feats)
      .map((k) => k + "=" + encodeURIComponent(feats[k]))
      .join("&");
    return extra ? base + (base ? "&" : "") + extra : base;
  }

  function profileUrl(key, durationSec, spawnLeft) {
    return (
      location.origin +
      location.pathname +
      location.search +
      "#" +
      buildProfileHash(key, durationSec, spawnLeft)
    );
  }

  /** Remaining tabs the user still needs to open (popup-blocker chain). */
  let spawnRemaining = 0;

  function getProfileKeyAndDuration() {
    const key = lastProfileKey || parseHashParams().profile || "torture";
    let dur = lastProfileDurationSec;
    if (dur == null) {
      const p = parseHashParams();
      if (p.duration !== undefined && p.duration !== "") {
        const n = parseFloat(p.duration);
        dur = isFinite(n) ? n : 0;
      } else {
        dur = 0;
      }
    }
    return { key, dur };
  }

  function updateSpawnBar() {
    const bar = document.getElementById("spawnBar");
    const text = document.getElementById("spawnBarText");
    const btn = document.getElementById("spawnNextBtn");
    if (!bar) return;
    if (spawnRemaining > 0) {
      bar.hidden = false;
      text.textContent =
        spawnRemaining +
        " more tab" +
        (spawnRemaining === 1 ? "" : "s") +
        " to open with the same preset. Browsers block bulk popups — click once per tab.";
      btn.textContent =
        "Open next tab (" + spawnRemaining + " left)";
    } else {
      bar.hidden = true;
    }
  }

  /** Open one child tab; child gets spawn=remaining-1 so the chain continues there. */
  function openOneSpawnTab() {
    if (spawnRemaining <= 0) {
      updateSpawnBar();
      return false;
    }
    const { key, dur } = getProfileKeyAndDuration();
    const leftAfter = spawnRemaining - 1;
    const url = profileUrl(key, dur, leftAfter);
    const w = window.open(url, "_blank");
    if (w) {
      spawnRemaining = leftAfter;
      updateSpawnBar();
      document.getElementById("presetStatus").textContent =
        leftAfter > 0
          ? "Opened a tab · " + leftAfter + " still left — click Open next tab"
          : "All requested tabs opened";
      document.getElementById("presetStatus").className = "status on";
      return true;
    }
    document.getElementById("presetStatus").textContent =
      "Popup blocked — allow popups for this site, then click Open next tab";
    document.getElementById("presetStatus").className = "status warn";
    updateSpawnBar();
    return false;
  }


  // ---------- Full feature URL state ----------
  // Compact params: f_torch=1, f_cpu=1, f_cpuw=4, f_goal=5, ...
  const FEATURE_PARAMS = [
    { p: "f_torch", id: "torchToggle", kind: "toggle" },
    { p: "f_cam", id: "cameraToggle", kind: "toggle" },
    { p: "f_isp", id: "ispToggle", kind: "toggle" },
    { p: "f_ispf", id: "ispFilter", kind: "select" },
    { p: "f_vib", id: "vibrateToggle", kind: "toggle" },
    { p: "f_loc", id: "locationToggle", kind: "toggle" },
    { p: "f_cpu", id: "cpuToggle", kind: "toggle" },
    { p: "f_cpuw", id: "cpuWorkersSlider", kind: "range", label: "cpuWorkersValue" },
    { p: "f_dl", id: "downloadToggle", kind: "toggle" },
    { p: "f_dld", id: "downloadDuration", kind: "number" },
    { p: "f_gpu", id: "gpuToggle", kind: "toggle" },
    { p: "f_gpum", id: "gpuMode", kind: "select" },
    { p: "f_goal", id: "goalFpsSlider", kind: "range", label: "goalFpsValue", label2: "goalFpsLabel" },
    { p: "f_mic", id: "micToggle", kind: "toggle" },
    { p: "f_tone", id: "toneToggle", kind: "toggle" },
    { p: "f_freq", id: "freqSlider", kind: "range" },
    { p: "f_vol", id: "volSlider", kind: "range" },
    { p: "f_nfc", id: "nfcToggle", kind: "toggle" },
    { p: "f_bt", id: "btToggle", kind: "toggle" },
    { p: "f_usb", id: "usbToggle", kind: "toggle" },
    { p: "f_ram", id: "ramToggle", kind: "toggle" },
    { p: "f_ramm", id: "ramMaxSlider", kind: "range", label: "ramMaxValue" },
    { p: "f_sens", id: "sensorsToggle", kind: "toggle" },
    { p: "f_panel", id: "panelToggle", kind: "toggle" },
    { p: "f_panp", id: "panelPattern", kind: "select" },
    { p: "f_vrr", id: "vrrToggle", kind: "toggle" },
    { p: "f_stor", id: "storageToggle", kind: "toggle" },
    { p: "f_storp", id: "storagePattern", kind: "select" },
    { p: "f_modem", id: "modemToggle", kind: "toggle" },
    { p: "f_mods", id: "modemStreamsSlider", kind: "range", label: "modemStreamsValue" },
    { p: "f_wgc", id: "webgpuComputeToggle", kind: "toggle" },
    { p: "f_wgd", id: "webgpuDrawToggle", kind: "toggle" },
    { p: "f_wasm", id: "wasmToggle", kind: "toggle" },
    { p: "f_ai", id: "aiToggle", kind: "toggle" },
    { p: "f_zgc", id: "zeroGcToggle", kind: "toggle" },
    { p: "f_hdr", id: "hdrToggle", kind: "toggle" },
    { p: "f_adsp", id: "audioDspToggle", kind: "toggle" },
    { p: "f_adspc", id: "audioDspCount", kind: "range", label: "audioDspCountValue" },
    { p: "f_blur", id: "blurCloseToggle", kind: "toggle" },
    { p: "f_void", id: "voidToggle", kind: "toggle" },
    { p: "f_ka", id: "keepAliveToggle", kind: "toggle" },
    { p: "f_stabon", id: "stealthTabToggle", kind: "toggle" },
  ];

  // Order: apply settings first, then enable toggles (GPU-ish last)
  const TOGGLE_APPLY_ORDER = [
    "cpuWorkersSlider", "goalFpsSlider", "ramMaxSlider", "modemStreamsSlider",
    "audioDspCount", "freqSlider", "volSlider", "downloadDuration",
    "ispFilter", "gpuMode", "panelPattern", "storagePattern",
    "cpuToggle", "downloadToggle", "modemToggle", "storageToggle", "ramToggle",
    "cameraToggle", "vibrateToggle", "locationToggle", "sensorsToggle",
    "nfcToggle", "vrrToggle", "wasmToggle", "zeroGcToggle", "audioDspToggle",
    "keepAliveToggle", "stealthTabToggle", "blurCloseToggle",
    "micToggle", "toneToggle", "btToggle", "usbToggle",
    "torchToggle", "ispToggle", "panelToggle", "voidToggle", "hdrToggle",
    "gpuToggle", "webgpuComputeToggle", "webgpuDrawToggle", "aiToggle",
  ];

  function collectFeatureParams() {
    const out = {};
    FEATURE_PARAMS.forEach((f) => {
      const el = document.getElementById(f.id);
      if (!el) return;
      if (f.kind === "toggle") {
        if (el.checked) out[f.p] = "1";
      } else if (f.kind === "range" || f.kind === "number") {
        out[f.p] = String(el.value);
      } else if (f.kind === "select") {
        out[f.p] = String(el.value);
      }
    });
    return out;
  }

  function setControlValue(f, raw) {
    const el = document.getElementById(f.id);
    if (!el || raw == null || raw === "") return;
    if (f.kind === "toggle") {
      const on = raw === "1" || raw === "true" || raw === "yes";
      if (el.checked !== on) {
        el.checked = on;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } else if (f.kind === "range" || f.kind === "number") {
      el.value = raw;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      if (f.label) {
        const lab = document.getElementById(f.label);
        if (lab) lab.textContent = raw;
      }
      if (f.label2) {
        const lab = document.getElementById(f.label2);
        if (lab) lab.textContent = raw;
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (f.kind === "select") {
      el.value = raw;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function applyFeatureParams(p) {
    if (!p) return;
    const byId = {};
    FEATURE_PARAMS.forEach((f) => {
      if (p[f.p] !== undefined) byId[f.id] = { f, raw: p[f.p] };
    });
    // Non-toggles first
    FEATURE_PARAMS.forEach((f) => {
      if (f.kind === "toggle") return;
      if (byId[f.id]) setControlValue(f, byId[f.id].raw);
    });
    // Toggles in safe order
    TOGGLE_APPLY_ORDER.forEach((id) => {
      if (byId[id] && byId[id].f.kind === "toggle") {
        setControlValue(byId[id].f, byId[id].raw);
      }
    });
    // Any remaining toggles
    FEATURE_PARAMS.forEach((f) => {
      if (f.kind !== "toggle") return;
      if (!TOGGLE_APPLY_ORDER.includes(f.id) && byId[f.id]) {
        setControlValue(f, byId[f.id].raw);
      }
    });
  }

  async function buildFullStateHash() {
    const parts = [];
    const { key, dur } = getProfileKeyAndDuration();
    if (lastProfileKey || parseHashParams().profile) {
      parts.push("profile=" + encodeURIComponent(key));
      if (dur != null && dur !== "") {
        parts.push("duration=" + encodeURIComponent(String(dur)));
      }
    }
    const feats = collectFeatureParams();
    Object.keys(feats).forEach((k) => {
      parts.push(k + "=" + encodeURIComponent(feats[k]));
    });
    // Stealth
    const layout = document.getElementById("stealthLayout")?.value;
    const tabTitle = document.getElementById("stealthTitle")?.value;
    if (stealthLayoutOn || layout) {
      // only include stealth key if layout is active OR user is copying stealth-aware full link while in stealth
    }
    if (stealthLayoutOn) {
      parts.push("stealth=" + encodeURIComponent(layout || "blank"));
      if (tabTitle) parts.push("stab=" + encodeURIComponent(tabTitle));
      syncStealthPasswordFromInput();
      if (stealthSessionPassword) {
        const sp = await encryptStealthPassword(stealthSessionPassword);
        if (sp) parts.push("sp=" + encodeURIComponent(sp));
      }
    }
    return parts.join("&");
  }

  async function applyStealthFromHash(p) {
    if (!p) p = parseHashParams();
    if (!p.stealth && !p.sp && !p.stab) {
      document.documentElement.classList.remove(
        "boot-stealth",
        "boot-stealth-docs",
        "boot-stealth-terminal"
      );
      return;
    }

    if (p.stealth) {
      const layoutEl = document.getElementById("stealthLayout");
      const allowed = ["blank", "docs", "terminal"];
      if (layoutEl && allowed.includes(p.stealth)) {
        layoutEl.value = p.stealth;
      }
    }
    if (p.stab) {
      const titleEl = document.getElementById("stealthTitle");
      if (titleEl) {
        const opts = [...titleEl.options].map((o) => o.value);
        if (opts.includes(p.stab)) titleEl.value = p.stab;
      }
      const tabToggle = document.getElementById("stealthTabToggle");
      if (tabToggle) {
        tabToggle.checked = true;
        applyStealthTab(true);
      }
    }
    if (p.sp) {
      const plain = await decryptStealthPassword(p.sp);
      const passEl = document.getElementById("stealthPassword");
      if (passEl && plain) {
        passEl.value = plain;
        stealthSessionPassword = plain;
        updateStealthPassStatus();
      }
    }
    if (p.stealth) {
      setStealthLayout(true);
      // Real cover is up — safe to drop the boot blank
      requestAnimationFrame(() => {
        document.documentElement.classList.remove(
          "boot-stealth",
          "boot-stealth-docs",
          "boot-stealth-terminal"
        );
      });
    } else {
      document.documentElement.classList.remove(
        "boot-stealth",
        "boot-stealth-docs",
        "boot-stealth-terminal"
      );
    }
  }

  async function applyHashProfile() {
    const p = parseHashParams();
    const hasStealth = !!p.stealth;

    if (p.spawn) {
      const s = parseInt(p.spawn, 10);
      if (isFinite(s) && s > 0) {
        spawnRemaining = s;
        updateSpawnBar();
      }
    }

    // Apply feature extents/toggles from URL (behind stealth cover if present)
    applyFeatureParams(p);

    if (p.profile) {
      let dur = null;
      if (p.duration !== undefined && p.duration !== "") {
        const n = parseFloat(p.duration);
        if (isFinite(n) && n >= 0) dur = n;
      }
      // Profile may toggle many features; feature params already applied.
      // Still run profile only if no explicit feature flags (or always for presets)
      const hasFeatureFlags = FEATURE_PARAMS.some((f) => p[f.p] !== undefined);
      if (!hasFeatureFlags) {
        const ok = runProfile(p.profile, dur);
        if (!ok) {
          document.getElementById("presetStatus").textContent =
            "Unknown profile in URL: " + p.profile;
          document.getElementById("presetStatus").className = "status warn";
        }
      } else {
        lastProfileKey = p.profile;
        if (dur != null) lastProfileDurationSec = dur;
        startTelemetry();
      }
    }

    await applyStealthFromHash(p);

    if (!hasStealth) {
      document.documentElement.classList.remove(
        "boot-stealth",
        "boot-stealth-docs",
        "boot-stealth-terminal"
      );
    }
  }

  document.getElementById("presetQuick").addEventListener("click", () => {
    runProfile("quick");
    try {
      history.replaceState(null, "", "#" + buildProfileHash("quick", 60));
    } catch (_) {}
  });

  document.getElementById("presetEndurance").addEventListener("click", () => {
    runProfile("endurance");
    try {
      history.replaceState(null, "", "#" + buildProfileHash("endurance", 900));
    } catch (_) {}
  });

  document.getElementById("presetTorture").addEventListener("click", () => {
    runProfile("torture");
    try {
      history.replaceState(null, "", "#" + buildProfileHash("torture", 0));
    } catch (_) {}
  });

  document.getElementById("presetMax").addEventListener("click", () => {
    runProfile("max");
    try {
      history.replaceState(null, "", "#" + buildProfileHash("max", 0));
    } catch (_) {}
  });

  document.getElementById("presetAbort").addEventListener("click", () => {
    stopHeavyLoads();
    stopTelemetry();
    abortPreset("Aborted — data kept for export");
    if (telemetrySamples.length) renderScorecard();
  });

  // Multi-tab launcher — browsers allow ~1 window.open per user gesture
  document.getElementById("multiTabSlider").addEventListener("input", (e) => {
    document.getElementById("multiTabValue").textContent = e.target.value;
  });

  document.getElementById("multiTabOpen").addEventListener("click", () => {
    const n = Math.min(
      10,
      Math.max(1, parseInt(document.getElementById("multiTabSlider").value, 10) || 1)
    );
    const { key, dur } = getProfileKeyAndDuration();
    lastProfileKey = key;
    lastProfileDurationSec = dur;

    // Try to open as many as the browser allows in this single click
    let opened = 0;
    for (let i = 0; i < n; i++) {
      const leftAfter = n - opened - 1;
      const url = profileUrl(key, dur, leftAfter > 0 ? leftAfter : 0);
      const w = window.open(url, "_blank");
      if (!w) break;
      opened++;
    }

    spawnRemaining = Math.max(0, n - opened);
    updateSpawnBar();

    document.getElementById("presetStatus").textContent =
      opened === 0
        ? "All popups blocked — allow popups, then use Open next tab"
        : opened < n
          ? "Opened " + opened + "/" + n + " · click Open next tab for the rest"
          : "Opened all " + opened + " tabs";
    document.getElementById("presetStatus").className =
      opened > 0 ? "status on" : "status warn";
  });

  document.getElementById("spawnNextBtn").addEventListener("click", () => {
    openOneSpawnTab();
  });

  // Auto-start from URL hash after UI is ready (short delay for permission UX)
  setTimeout(applyHashProfile, 50);
  // If no stealth in hash, clear any stray boot class
  if (!/(?:^|&)stealth=/.test((location.hash || "").replace(/^#/, ""))) {
    document.documentElement.classList.remove(
      "boot-stealth",
      "boot-stealth-docs",
      "boot-stealth-terminal"
    );
  }
  window.addEventListener("hashchange", () => {
    applyHashProfile();
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
    setStorage(false);
    setModem(false);
    stopTelemetry();
    abortPreset();
    setTone(false);
    setNfc(false);
    setRam(false);
    setSensors(false);
    setIsp(false);
    setPanel(false);
    setVrr(false);
    setBluetooth(false);
    setUsb(false);
    setWebgpuCompute(false);
    setWebgpuDraw(false);
    setWasm(false);
    setAi(false);
    setZeroGc(false);
    setHdr(false);
    setAudioDsp(false);
    setKeepAlive(false);
    setStealthLayout(false);
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

  // ---------- PC multi-column layout ----------
  function applyPcMode(on) {
    document.documentElement.classList.toggle("pc-mode", on);
    const btn = document.getElementById("pcModeToggle");
    if (btn) btn.textContent = on ? "Mobile" : "PC";
    try {
      localStorage.setItem("pst-pc-mode", on ? "1" : "0");
    } catch (_) {}
  }

  (function initPcMode() {
    let on = false;
    try {
      const stored = localStorage.getItem("pst-pc-mode");
      if (stored === "1") on = true;
      else if (stored === "0") on = false;
      else on = window.matchMedia && window.matchMedia("(min-width: 900px)").matches;
    } catch (_) {
      on = window.innerWidth >= 900;
    }
    applyPcMode(on);
  })();

  document.getElementById("pcModeToggle").addEventListener("click", () => {
    applyPcMode(!document.documentElement.classList.contains("pc-mode"));
  });

  // ---------- Stealth UI + neutral tab + audio keep-alive ----------
  const REAL_TITLE = document.title;
  const REAL_FAVICON =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%235b8cff'/%3E%3C/svg%3E";
  const STEALTH_FAVICON =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='4' fill='%239ca3af'/%3E%3C/svg%3E";

  let stealthLayoutOn = false;
  let stealthTabOn = false;
  let stealthSessionPassword = ""; // session-only; cleared on refresh

  let stealthExitTaps = 0;
  let stealthExitTimer = null;
  let keepAliveCtx = null;
  let keepAliveOsc = null;
  let keepAliveGain = null;
  let termTimer = null;

  function setFavicon(href) {
    let link = document.getElementById("appFavicon");
    if (!link) {
      link = document.createElement("link");
      link.id = "appFavicon";
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = href;
  }

  function applyStealthTab(on) {
    stealthTabOn = on;
    const titleSel = document.getElementById("stealthTitle");
    if (on) {
      document.title = (titleSel && titleSel.value) || "Documentation";
      setFavicon(STEALTH_FAVICON);
    } else {
      document.title = REAL_TITLE;
      setFavicon(REAL_FAVICON);
    }
    try {
      localStorage.setItem("pst-stealth-tab", on ? "1" : "0");
    } catch (_) {}
  }

  function showStealthPanel(kind) {
    ["stealthBlank", "stealthDocs", "stealthTerminal"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
    if (kind === "docs") document.getElementById("stealthDocs").hidden = false;
    else if (kind === "terminal") {
      document.getElementById("stealthTerminal").hidden = false;
      startTermScroll();
    } else {
      stopTermScroll();
      document.getElementById("stealthBlank").hidden = false;
    }
  }

  function startTermScroll() {
    stopTermScroll();
    const pre = document.getElementById("stealthTermBody");
    if (!pre) return;
    let lines = ["$ session ready"];
    const cmds = [
      "ls -la",
      "cat /etc/hostname",
      "uptime",
      "df -h",
      "ping -c 1 10.0.0.1",
      "echo ok",
    ];
    termTimer = setInterval(() => {
      if (!stealthLayoutOn) return;
      lines.push("$ " + cmds[Math.floor(Math.random() * cmds.length)]);
      lines.push("  done");
      if (lines.length > 40) lines = lines.slice(-30);
      pre.textContent = lines.join("\n") + "\n$ _";
    }, 2200);
  }

  function stopTermScroll() {
    if (termTimer) {
      clearInterval(termTimer);
      termTimer = null;
    }
  }

  function updateStealthPassStatus() {
    const el = document.getElementById("stealthPassStatus");
    if (!el) return;
    if (stealthSessionPassword) {
      el.textContent = "Password set for this session (clears on refresh)";
      el.className = "status on";
    } else {
      el.textContent = "No password set";
      el.className = "status";
    }
  }

  function syncStealthPasswordFromInput() {
    const input = document.getElementById("stealthPassword");
    stealthSessionPassword = (input && input.value) ? input.value : "";
    updateStealthPassStatus();
  }

  function hideStealthUnlock() {
    const box = document.getElementById("stealthUnlock");
    if (box) box.hidden = true;
    const err = document.getElementById("stealthUnlockErr");
    if (err) err.hidden = true;
    const inp = document.getElementById("stealthUnlockInput");
    if (inp) inp.value = "";
  }

  function requestStealthExit() {
    if (!stealthLayoutOn) return;
    syncStealthPasswordFromInput();
    if (!stealthSessionPassword) {
      setStealthLayout(false);
      return;
    }
    const box = document.getElementById("stealthUnlock");
    if (box) box.hidden = false;
    const inp = document.getElementById("stealthUnlockInput");
    if (inp) {
      inp.value = "";
      setTimeout(() => inp.focus(), 50);
    }
  }

  function tryStealthUnlock() {
    const inp = document.getElementById("stealthUnlockInput");
    const err = document.getElementById("stealthUnlockErr");
    const val = inp ? inp.value : "";
    if (val === stealthSessionPassword) {
      hideStealthUnlock();
      setStealthLayout(false);
    } else {
      if (err) err.hidden = false;
      if (inp) {
        inp.value = "";
        inp.focus();
      }
    }
  }

  function setStealthLayout(on) {
    const cover = document.getElementById("stealthCover");
    const btn = document.getElementById("stealthToggle");
    if (!cover) return;
    if (on) {
      syncStealthPasswordFromInput();
      stealthLayoutOn = true;
      const kind = document.getElementById("stealthLayout")?.value || "blank";
      showStealthPanel(kind);
      cover.hidden = false;
      hideStealthUnlock();
      document.documentElement.classList.add("stealth-on");
      if (btn) btn.textContent = "Exit stealth";
      const tabToggle = document.getElementById("stealthTabToggle");
      if (tabToggle && !tabToggle.checked) {
        tabToggle.checked = true;
        applyStealthTab(true);
      } else if (stealthTabOn) {
        applyStealthTab(true);
      }
    } else {
      stealthLayoutOn = false;
      cover.hidden = true;
      hideStealthUnlock();
      stopTermScroll();
      document.documentElement.classList.remove("stealth-on");
      if (btn) btn.textContent = "Stealth";
      stealthExitTaps = 0;
    }
    // Do not persist layout or password across sessions
  }

  function resumeKeepAlive() {
    if (keepAliveCtx && keepAliveCtx.state === "suspended") {
      keepAliveCtx.resume().catch(() => {});
    }
  }

  function setKeepAlive(on) {
    const status = document.getElementById("keepAliveStatus");
    if (on) {
      try {
        if (keepAliveCtx) {
          try { keepAliveOsc?.stop(); keepAliveCtx.close(); } catch (_) {}
        }
        keepAliveCtx = new (window.AudioContext || window.webkitAudioContext)();
        keepAliveOsc = keepAliveCtx.createOscillator();
        keepAliveGain = keepAliveCtx.createGain();
        keepAliveGain.gain.value = 0.00001;
        keepAliveOsc.frequency.value = 20;
        keepAliveOsc.connect(keepAliveGain);
        keepAliveGain.connect(keepAliveCtx.destination);
        keepAliveOsc.start();
        if (keepAliveCtx.state === "suspended") {
          keepAliveCtx.resume().catch(() => {});
        }
        if (status) {
          status.textContent = "Silent audio keep-alive running";
          status.className = "status on";
        }
        document.addEventListener("visibilitychange", resumeKeepAlive);
      } catch (err) {
        if (status) {
          status.textContent = "Keep-alive failed: " + (err.message || err);
          status.className = "status warn";
        }
        const t = document.getElementById("keepAliveToggle");
        if (t) t.checked = false;
        return;
      }
    } else {
      document.removeEventListener("visibilitychange", resumeKeepAlive);
      try {
        keepAliveOsc?.stop();
        keepAliveOsc?.disconnect();
        keepAliveGain?.disconnect();
        keepAliveCtx?.close();
      } catch (_) {}
      keepAliveOsc = null;
      keepAliveGain = null;
      keepAliveCtx = null;
      if (status) {
        status.textContent = "Off";
        status.className = "status";
      }
    }
    try {
      localStorage.setItem("pst-keep-alive", on ? "1" : "0");
    } catch (_) {}
  }

  const stealthBtn = document.getElementById("stealthToggle");
  if (stealthBtn) {
    stealthBtn.addEventListener("click", () => {
      if (stealthLayoutOn) requestStealthExit();
      else setStealthLayout(true);
    });
  }

  const stealthPassInput = document.getElementById("stealthPassword");
  if (stealthPassInput) {
    stealthPassInput.addEventListener("input", syncStealthPasswordFromInput);
    stealthPassInput.addEventListener("change", syncStealthPasswordFromInput);
  }

  const copyStealthLinkBtn = document.getElementById("copyStealthLink");
  if (copyStealthLinkBtn) {
    copyStealthLinkBtn.addEventListener("click", async () => {
      try {
        const hash = await buildStealthShareHash();
        const url =
          location.origin + location.pathname + location.search + "#" + hash;
        try {
          history.replaceState(null, "", "#" + hash);
        } catch (_) {}
        await navigator.clipboard.writeText(url);
        copyStealthLinkBtn.textContent = "Copied!";
        setTimeout(() => {
          copyStealthLinkBtn.textContent = "Copy stealth link";
        }, 1500);
      } catch (err) {
        copyStealthLinkBtn.textContent = "Copy failed";
        setTimeout(() => {
          copyStealthLinkBtn.textContent = "Copy stealth link";
        }, 1500);
      }
    });
  }

  const copyFullLinkBtn = document.getElementById("copyFullLink");
  if (copyFullLinkBtn) {
    copyFullLinkBtn.addEventListener("click", async () => {
      try {
        // Include stealth if currently active
        const hash = await buildFullStateHash();
        // If not in stealth but user wants features only, still fine
        const url =
          location.origin + location.pathname + location.search + (hash ? "#" + hash : "");
        try {
          if (hash) history.replaceState(null, "", "#" + hash);
        } catch (_) {}
        await navigator.clipboard.writeText(url);
        copyFullLinkBtn.textContent = "Copied full state!";
        setTimeout(() => {
          copyFullLinkBtn.textContent = "Copy full state link";
        }, 1500);
      } catch (err) {
        copyFullLinkBtn.textContent = "Copy failed";
        setTimeout(() => {
          copyFullLinkBtn.textContent = "Copy full state link";
        }, 1500);
      }
    });
  }

  const unlockSubmit = document.getElementById("stealthUnlockSubmit");
  if (unlockSubmit) unlockSubmit.addEventListener("click", tryStealthUnlock);
  const unlockCancel = document.getElementById("stealthUnlockCancel");
  if (unlockCancel) unlockCancel.addEventListener("click", hideStealthUnlock);
  const unlockInput = document.getElementById("stealthUnlockInput");
  if (unlockInput) {
    unlockInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") tryStealthUnlock();
      if (e.key === "Escape") hideStealthUnlock();
    });
  }

  const stealthTabEl = document.getElementById("stealthTabToggle");
  if (stealthTabEl) {
    stealthTabEl.addEventListener("change", (e) => {
      applyStealthTab(e.target.checked);
    });
  }

  const stealthTitleEl = document.getElementById("stealthTitle");
  if (stealthTitleEl) {
    stealthTitleEl.addEventListener("change", () => {
      if (stealthTabOn) applyStealthTab(true);
    });
  }

  const stealthLayoutEl = document.getElementById("stealthLayout");
  if (stealthLayoutEl) {
    stealthLayoutEl.addEventListener("change", () => {
      if (stealthLayoutOn) showStealthPanel(stealthLayoutEl.value);
    });
  }

  const keepAliveEl = document.getElementById("keepAliveToggle");
  if (keepAliveEl) {
    keepAliveEl.addEventListener("change", (e) => {
      setKeepAlive(e.target.checked);
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && stealthLayoutOn) {
      const unlock = document.getElementById("stealthUnlock");
      if (unlock && !unlock.hidden) hideStealthUnlock();
      else requestStealthExit();
    }
  });

  const exitHint = document.getElementById("stealthExitHint");
  if (exitHint) {
    exitHint.addEventListener("click", (e) => {
      e.stopPropagation();
      stealthExitTaps++;
      if (stealthExitTimer) clearTimeout(stealthExitTimer);
      stealthExitTimer = setTimeout(() => {
        stealthExitTaps = 0;
      }, 2000);
      if (stealthExitTaps >= 3) {
        stealthExitTaps = 0;
        requestStealthExit();
      }
    });
  }

  (function initStealthPrefs() {
    try {
      if (localStorage.getItem("pst-stealth-tab") === "1") {
        const t = document.getElementById("stealthTabToggle");
        if (t) t.checked = true;
        applyStealthTab(true);
      }
      if (localStorage.getItem("pst-keep-alive") === "1") {
        const t = document.getElementById("keepAliveToggle");
        if (t) t.checked = true;
        setTimeout(() => setKeepAlive(true), 500);
      }
    } catch (_) {}
  })();

  // ---------- Eclipse Void (blank screen + 5-tap close tab) ----------
  const VOID_TAPS_NEEDED = 5;
  let voidTapCount = 0;
  let voidTapResetTimer = null;
  let voidActive = false;

  function tryCloseTab() {
    try {
      window.close();
    } catch (_) {}
    setTimeout(() => {
      try {
        window.open("", "_self");
        window.close();
      } catch (_) {}
      window.location.replace("about:blank");
    }, 100);
  }

  function updateVoidTapUI() {
    const left = Math.max(0, VOID_TAPS_NEEDED - voidTapCount);
    const hint = document.getElementById("voidTapHint");
    const status = document.getElementById("voidStatus");
    if (hint) {
      hint.textContent =
        left === 0
          ? "Closing…"
          : left + " tap" + (left === 1 ? "" : "s") + " left to close tab";
    }
    if (status && voidActive) {
      status.textContent =
        "Active — " + left + " tap" + (left === 1 ? "" : "s") + " left · ✕ exits mode";
      status.className = "status on";
    }
  }

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
      updateVoidTapUI();
    } else {
      overlay.hidden = true;
      document.body.style.overflow = "";
      if (toggle) toggle.checked = false;
      if (status) {
        status.textContent = "Off";
        status.className = "status";
      }
      const hint = document.getElementById("voidTapHint");
      if (hint) hint.textContent = "";
    }
  }

  function onVoidTap(e) {
    if (e.target && e.target.id === "voidCloseBtn") return;
    if (!voidActive) return;

    voidTapCount++;
    updateVoidTapUI();

    if (voidTapResetTimer) clearTimeout(voidTapResetTimer);
    voidTapResetTimer = setTimeout(() => {
      voidTapCount = 0;
      voidTapResetTimer = null;
      updateVoidTapUI();
    }, 3000);

    if (voidTapCount >= VOID_TAPS_NEEDED) {
      voidTapCount = 0;
      if (voidTapResetTimer) {
        clearTimeout(voidTapResetTimer);
        voidTapResetTimer = null;
      }
      updateVoidTapUI();
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
  voidOverlayEl.addEventListener("pointerup", onVoidTap);

  // ---------- Close tab when page loses focus ----------
  document.getElementById("blurCloseToggle").addEventListener("change", (e) => {
    const status = document.getElementById("blurCloseStatus");
    if (e.target.checked) {
      status.textContent = "On — closes when unfocused (ignored during Stealth)";
      status.className = "status on";
    } else {
      status.textContent = "Off";
      status.className = "status";
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (
      document.hidden &&
      document.getElementById("blurCloseToggle")?.checked &&
      !stealthLayoutOn // stealth mode keeps the tab alive when backgrounded
    ) {
      tryCloseTab();
    }
  });

  window.addEventListener("pagehide", () => {
    // existing cleanup below also runs
  });

  // Initial power + battery tracking
  updatePower();
  initBatteryTracking();

  // ---------- Auto-update (detect new deploy without hard refresh) ----------
  // Bump BUILD_ID whenever you push a new version to GitHub Pages.
  const BUILD_ID = "31";
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
