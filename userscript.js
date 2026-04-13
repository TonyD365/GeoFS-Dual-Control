// ==UserScript==
// @name         GeoFS Dual Control Final
// @namespace    geofs.dual.control.final
// @version      5.2.0
// @description  Host/Copilot dual control for GeoFS on HF Space
// @match        https://www.geofs.com/*
// @match        http://www.geofs.com/*
// @match        https://www.geo-fs.com/geofs.php?v=3.9
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/TonyD365/GeoFS-Dual-Control/refs/heads/main/userscript.js
// @updateURL    https://raw.githubusercontent.com/TonyD365/GeoFS-Dual-Control/refs/heads/main/userscript.js
// ==/UserScript==

(function () {
    "use strict";

    /*************************************************
     * Config
     *************************************************/
    const DEFAULTS = {
        serverOrigin: "https://tonyd365-geofs-link-flight.hf.space",
        roomId: "room001",
        password: "",
        mode: "host",

        sendIntervalMs: 40,
        pingIntervalMs: 3000,

        // Ownership hold time after a side is considered active on a channel
        localPriorityMs: 260,

        // Relative difference thresholds
        axisDiffThreshold: 0.03,
        throttleDiffThreshold: 0.03,
        trimDiffThreshold: 0.01,

        // Host -> Copilot
        syncPositionToCopilot: true,
        syncVisualInputsToCopilot: true,

        // Remote model hiding
        hideRemoteModels: true,
        remoteHideIntervalMs: 1500
    };

    const STORAGE_KEY = "geofs_dual_control_final_v5_2";

    function loadConfig() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { ...DEFAULTS };
            return { ...DEFAULTS, ...JSON.parse(raw) };
        } catch {
            return { ...DEFAULTS };
        }
    }

    function saveConfig() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(CONFIG));
    }

    const CONFIG = loadConfig();

    const CHANNEL_KEYS = [
        "rawPitch",
        "roll",
        "yaw",
        "throttle",
        "gear",
        "flaps",
        "airbrakes",
        "brakes",
        "parkingBrake",
        "pitchTrim",
        "rudderTrim"
    ];

    const STATE = {
        socket: null,
        connected: false,
        joined: false,

        roomHostOnline: false,
        roomCopilotCount: 0,
        ping: null,

        latestHostState: null,
        latestHostStateTs: 0,

        latestCopilotControls: null,
        latestCopilotControlsTs: 0,

        collapsed: false
    };

    const HOST_LOCAL_ACTIVITY = Object.fromEntries(CHANNEL_KEYS.map(k => [k, 0]));
    const COPILOT_LOCAL_ACTIVITY = Object.fromEntries(CHANNEL_KEYS.map(k => [k, 0]));
    const COPILOT_REMOTE_ACTIVITY_ON_HOST = Object.fromEntries(CHANNEL_KEYS.map(k => [k, 0]));

    const COPILOT_LAST_VALUES_ON_HOST = Object.fromEntries(CHANNEL_KEYS.map(k => [k, null]));

    /*************************************************
     * Basic helpers
     *************************************************/
    function log(...args) {
        console.log("[GeoFS Dual Final]", ...args);
    }

    function warn(...args) {
        console.warn("[GeoFS Dual Final]", ...args);
    }

    function safeGet(fn, fallback = null) {
        try {
            const v = fn();
            return v === undefined ? fallback : v;
        } catch {
            return fallback;
        }
    }

    function now() {
        return Date.now();
    }

    function isGeoFSReady() {
        return typeof window.geofs !== "undefined" &&
               typeof window.controls !== "undefined" &&
               safeGet(() => geofs.aircraft.instance) != null;
    }

    function getWsUrl() {
        return CONFIG.serverOrigin.replace(/^http/, "ws") + "/ws";
    }

    function fmtNum(v) {
        return typeof v === "number" ? v.toFixed(1) : "-";
    }

    function escapeHtml(s) {
        return String(s)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;");
    }

    function isNumber(v) {
        return typeof v === "number" && Number.isFinite(v);
    }

    function getChannelThreshold(key) {
        if (key === "throttle") return CONFIG.throttleDiffThreshold;
        if (key === "pitchTrim" || key === "rudderTrim") return CONFIG.trimDiffThreshold;
        if (key === "rawPitch" || key === "roll" || key === "yaw") return CONFIG.axisDiffThreshold;
        return null;
    }

    function valuesDifferByChannel(key, a, b) {
        if (a == null || b == null) return false;

        const threshold = getChannelThreshold(key);
        if (threshold == null) {
            return a !== b;
        }

        if (!isNumber(a) || !isNumber(b)) return a !== b;
        return Math.abs(a - b) > threshold;
    }

    /*************************************************
     * UI
     *************************************************/
    let root = null;

    function createUI() {
        root = document.createElement("div");
        root.className = "gdc-root";
        root.innerHTML = `
            <div class="gdc-header">
                <div class="gdc-title">GeoFS Dual Control</div>
                <button id="gdc-toggle" class="gdc-btn ghost">Collapse</button>
            </div>

            <div id="gdc-body">
                <div class="gdc-grid">
                    <label class="gdc-field gdc-full">
                        <span>HF Space URL</span>
                        <input id="gdc-server" type="text" value="${escapeHtml(CONFIG.serverOrigin)}" placeholder="https://your-space-name.hf.space" />
                    </label>

                    <label class="gdc-field">
                        <span>Room ID</span>
                        <input id="gdc-room" type="text" value="${escapeHtml(CONFIG.roomId)}" />
                    </label>

                    <label class="gdc-field">
                        <span>Password</span>
                        <input id="gdc-password" type="password" value="${escapeHtml(CONFIG.password)}" />
                    </label>

                    <label class="gdc-field">
                        <span>Mode</span>
                        <select id="gdc-mode">
                            <option value="host" ${CONFIG.mode === "host" ? "selected" : ""}>Host</option>
                            <option value="copilot" ${CONFIG.mode === "copilot" ? "selected" : ""}>Copilot</option>
                        </select>
                    </label>

                    <label class="gdc-field">
                        <span>Send Interval (ms)</span>
                        <input id="gdc-send-interval" type="number" min="20" max="200" value="${CONFIG.sendIntervalMs}" />
                    </label>

                    <label class="gdc-field gdc-full">
                        <span>Channel Ownership Hold (ms)</span>
                        <input id="gdc-local-priority" type="number" min="50" max="1000" value="${CONFIG.localPriorityMs}" />
                    </label>
                </div>

                <div class="gdc-actions">
                    <button id="gdc-save" class="gdc-btn">Save</button>
                    <button id="gdc-connect" class="gdc-btn primary">Connect / Join</button>
                    <button id="gdc-disconnect" class="gdc-btn danger">Disconnect</button>
                </div>

                <div class="gdc-status-grid">
                    <div class="gdc-card"><div class="k">Connection</div><div class="v" id="gdc-st-conn">-</div></div>
                    <div class="gdc-card"><div class="k">Mode</div><div class="v" id="gdc-st-mode">-</div></div>
                    <div class="gdc-card"><div class="k">Room</div><div class="v" id="gdc-st-room">-</div></div>
                    <div class="gdc-card"><div class="k">Latency</div><div class="v" id="gdc-st-ping">-</div></div>
                    <div class="gdc-card"><div class="k">Host Online</div><div class="v" id="gdc-st-host">-</div></div>
                    <div class="gdc-card"><div class="k">Copilot Count</div><div class="v" id="gdc-st-cp">-</div></div>
                    <div class="gdc-card"><div class="k">Host State Age</div><div class="v" id="gdc-st-age">-</div></div>
                    <div class="gdc-card"><div class="k">GeoFS</div><div class="v" id="gdc-st-geofs">-</div></div>
                </div>

                <div class="gdc-telemetry">
                    <div class="gdc-sub">Host Telemetry</div>
                    <div id="gdc-host-telemetry">-</div>
                </div>
            </div>
        `;

        const style = document.createElement("style");
        style.textContent = `
            .gdc-root{
                position:fixed;
                top:16px;
                right:16px;
                width:390px;
                z-index:999999;
                color:#eef4ff;
                font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
                background:linear-gradient(180deg,rgba(15,20,34,.95),rgba(8,12,22,.97));
                border:1px solid rgba(110,150,255,.22);
                border-radius:18px;
                box-shadow:0 18px 42px rgba(0,0,0,.42), inset 0 1px 0 rgba(255,255,255,.05);
                backdrop-filter:blur(12px);
                overflow:hidden;
            }
            .gdc-header{
                display:flex;
                align-items:center;
                justify-content:space-between;
                padding:14px;
                border-bottom:1px solid rgba(255,255,255,.05);
                cursor:move;
            }
            .gdc-title{font-size:16px;font-weight:800}
            #gdc-body{padding:14px}
            .gdc-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
            .gdc-field{display:flex;flex-direction:column;gap:6px}
            .gdc-full{grid-column:1 / -1}
            .gdc-field span{font-size:11px;opacity:.78}
            .gdc-field input,.gdc-field select{
                width:100%;
                height:38px;
                border-radius:12px;
                border:1px solid rgba(255,255,255,.08);
                background:rgba(255,255,255,.05);
                color:#eef4ff;
                padding:0 12px;
                outline:none;
            }
            .gdc-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
            .gdc-btn{
                height:38px;
                border:none;
                border-radius:12px;
                padding:0 14px;
                font-weight:700;
                cursor:pointer;
                color:#eef4ff;
                background:rgba(255,255,255,.08)
            }
            .gdc-btn.ghost{background:rgba(255,255,255,.06)}
            .gdc-btn.primary{background:linear-gradient(180deg,#4b7dff,#355ee8)}
            .gdc-btn.danger{background:linear-gradient(180deg,#e45b6e,#c84558)}
            .gdc-status-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
            .gdc-card{
                background:rgba(255,255,255,.04);
                border:1px solid rgba(255,255,255,.06);
                border-radius:14px;
                padding:10px;
            }
            .gdc-card .k{font-size:11px;opacity:.72;margin-bottom:5px}
            .gdc-card .v{font-size:14px;font-weight:800;word-break:break-all}
            .gdc-telemetry{
                margin-top:12px;
                padding:10px 12px;
                border-radius:12px;
                background:rgba(255,255,255,.04);
                border:1px solid rgba(255,255,255,.06);
                font-size:12px;
                line-height:1.5
            }
            .gdc-sub{font-size:12px;opacity:.75;margin-bottom:6px}
            .gdc-green{color:#8df0a8}
            .gdc-red{color:#ff9a9a}
            .gdc-yellow{color:#ffd77a}
        `;
        document.documentElement.appendChild(style);
        document.body.appendChild(root);

        bindUI();
        enableDrag(root);
        updateStatus();
    }

    function bindUI() {
        const toggleBtn = root.querySelector("#gdc-toggle");
        const body = root.querySelector("#gdc-body");

        toggleBtn.addEventListener("click", () => {
            const hidden = body.style.display === "none";
            body.style.display = hidden ? "block" : "none";
            toggleBtn.textContent = hidden ? "Collapse" : "Expand";
            STATE.collapsed = !hidden;
        });

        root.querySelector("#gdc-save").addEventListener("click", () => {
            readConfigFromUI();
            saveConfig();
            updateStatus();
        });

        root.querySelector("#gdc-connect").addEventListener("click", () => {
            readConfigFromUI();
            saveConfig();
            disconnect();
            connectAndJoin();
        });

        root.querySelector("#gdc-disconnect").addEventListener("click", () => {
            disconnect();
        });
    }

    function enableDrag(el) {
        let isDragging = false;
        let offsetX = 0;
        let offsetY = 0;

        el.addEventListener("mousedown", (e) => {
            if (!e.target.closest(".gdc-header")) return;

            isDragging = true;
            const rect = el.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            document.body.style.userSelect = "none";
        });

        document.addEventListener("mousemove", (e) => {
            if (!isDragging) return;

            el.style.left = `${e.clientX - offsetX}px`;
            el.style.top = `${e.clientY - offsetY}px`;
            el.style.right = "auto";
        });

        document.addEventListener("mouseup", () => {
            isDragging = false;
            document.body.style.userSelect = "";
        });
    }

    function readConfigFromUI() {
        CONFIG.serverOrigin = root.querySelector("#gdc-server").value.trim();
        CONFIG.roomId = root.querySelector("#gdc-room").value.trim();
        CONFIG.password = root.querySelector("#gdc-password").value;
        CONFIG.mode = root.querySelector("#gdc-mode").value;
        CONFIG.sendIntervalMs = Math.max(20, Number(root.querySelector("#gdc-send-interval").value) || 40);
        CONFIG.localPriorityMs = Math.max(50, Number(root.querySelector("#gdc-local-priority").value) || 260);
    }

    function setStatus(id, text, cls = "") {
        const el = root.querySelector(id);
        if (!el) return;
        el.className = "v " + cls;
        el.textContent = text;
    }

    function updateStatus() {
        if (!root) return;

        setStatus(
            "#gdc-st-conn",
            !STATE.connected ? "Disconnected" : (STATE.joined ? "Connected" : "Connected, not joined"),
            !STATE.connected ? "gdc-red" : "gdc-green"
        );
        setStatus("#gdc-st-mode", CONFIG.mode.toUpperCase());
        setStatus("#gdc-st-room", CONFIG.roomId || "-");
        setStatus("#gdc-st-ping", STATE.ping == null ? "-" : `${STATE.ping} ms`, STATE.ping != null && STATE.ping < 160 ? "gdc-green" : "gdc-yellow");
        setStatus("#gdc-st-host", STATE.roomHostOnline ? "Online" : "Offline", STATE.roomHostOnline ? "gdc-green" : "gdc-red");
        setStatus("#gdc-st-cp", String(STATE.roomCopilotCount));
        setStatus("#gdc-st-geofs", isGeoFSReady() ? "Ready" : "Waiting", isGeoFSReady() ? "gdc-green" : "gdc-yellow");

        const age = STATE.latestHostStateTs ? (now() - STATE.latestHostStateTs) : null;
        setStatus("#gdc-st-age", age == null ? "-" : `${age} ms`, age != null && age < 160 ? "gdc-green" : "gdc-yellow");

        updateTelemetryText();
    }

    function updateTelemetryText() {
        const box = root?.querySelector("#gdc-host-telemetry");
        if (!box) return;

        const hs = STATE.latestHostState;
        if (!hs) {
            box.textContent = "-";
            return;
        }

        const p = hs.telemetry || {};
        const lat = Array.isArray(hs.llaLocation) ? hs.llaLocation[0]?.toFixed?.(5) : "-";
        const lon = Array.isArray(hs.llaLocation) ? hs.llaLocation[1]?.toFixed?.(5) : "-";
        const alt = Array.isArray(hs.llaLocation) ? hs.llaLocation[2] : "-";

        box.innerHTML = `
            Position: ${lat}, ${lon}, ${typeof alt === "number" ? alt.toFixed(1) : "-"}<br>
            Heading: ${fmtNum(p.heading)}　Altitude: ${fmtNum(p.altitude)}　Speed: ${fmtNum(p.speed)}<br>
            Engine: ${hs.engineOn == null ? "-" : (hs.engineOn ? "ON" : "OFF")}
        `;
    }

    /*************************************************
     * WebSocket
     *************************************************/
    function connectAndJoin() {
        const ws = new WebSocket(getWsUrl());
        STATE.socket = ws;

        ws.onopen = () => {
            STATE.connected = true;
            updateStatus();

            ws.send(JSON.stringify({
                type: "join",
                roomId: CONFIG.roomId,
                password: CONFIG.password,
                role: CONFIG.mode
            }));
        };

        ws.onmessage = (ev) => {
            let msg;
            try {
                msg = JSON.parse(ev.data);
            } catch {
                return;
            }

            if (msg.type === "joined") {
                STATE.joined = true;
                updateStatus();
                return;
            }

            if (msg.type === "room_state") {
                STATE.roomHostOnline = !!msg.hostOnline;
                STATE.roomCopilotCount = msg.copilotCount || 0;
                updateStatus();
                return;
            }

            if (msg.type === "pong") {
                if (msg.clientTs) {
                    STATE.ping = now() - msg.clientTs;
                    updateStatus();
                }
                return;
            }

            if (msg.type === "host_state" && CONFIG.mode === "copilot") {
                STATE.latestHostState = msg.data || null;
                STATE.latestHostStateTs = now();
                return;
            }

            if (msg.type === "copilot_controls" && CONFIG.mode === "host") {
                STATE.latestCopilotControls = msg.data || null;
                STATE.latestCopilotControlsTs = now();
                updateCopilotRemoteActivityOnHost(msg.data || null);
                return;
            }

            if (msg.type === "error") {
                alert("Server error: " + msg.message);
            }
        };

        ws.onclose = () => {
            STATE.connected = false;
            STATE.joined = false;
            updateStatus();
        };

        ws.onerror = () => {
            STATE.connected = false;
            updateStatus();
        };
    }

    function disconnect() {
        if (STATE.socket) {
            try { STATE.socket.close(); } catch (_) {}
        }
        STATE.socket = null;
        STATE.connected = false;
        STATE.joined = false;
        STATE.roomHostOnline = false;
        STATE.roomCopilotCount = 0;
        STATE.latestHostState = null;
        STATE.latestHostStateTs = 0;
        STATE.latestCopilotControls = null;
        STATE.latestCopilotControlsTs = 0;
        updateStatus();
    }

    function wsSend(obj) {
        const ws = STATE.socket;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    }

    /*************************************************
     * Read local real control values
     *************************************************/
    function getLocalDirectControls() {
        return {
            rawPitch: safeGet(() => controls.rawPitch, null),
            roll: safeGet(() => controls.roll, null),
            yaw: safeGet(() => controls.yaw, null),
            throttle: safeGet(() => controls.throttle, null),

            gear: safeGet(() => controls.gear.position, null),
            flaps: safeGet(() => controls.flaps.position, null),
            airbrakes: safeGet(() => controls.airbrakes.position, null),

            brakes: safeGet(() => controls.brakes, null),
            parkingBrake: safeGet(() => controls.parkingBrake, null),

            pitchTrim: safeGet(() => controls.pitchTrim, null),
            rudderTrim: safeGet(() => controls.rudderTrim, null)
        };
    }

    /*************************************************
     * Host packet
     *************************************************/
    function getHostStatePacket() {
        const ac = safeGet(() => geofs.aircraft.instance, null);
        if (!ac) return null;

        const lla = safeGet(() => ac.llaLocation, null);
        const htr = safeGet(() => ac.htr, null);
        const lv = safeGet(() => ac.rigidBody.getLinearVelocity(), null);
        const av = safeGet(() => ac.rigidBody.getAngularVelocity(), null);

        return {
            llaLocation: Array.isArray(lla) ? [...lla] : null,

            // telemetry/reference only
            htr: Array.isArray(htr) ? [...htr] : null,
            linearVelocity: Array.isArray(lv) ? [...lv] : null,
            angularVelocity: Array.isArray(av) ? [...av] : null,

            engineOn: safeGet(() => ac.engine.on, null),

            telemetry: {
                altitude: Array.isArray(lla) ? lla[2] : null,
                heading: Array.isArray(htr) ? htr[0] : null,
                pitch: Array.isArray(htr) ? htr[1] : null,
                roll: Array.isArray(htr) ? htr[2] : null,
                speed: safeGet(() => geofs.animation.values.kias, null)
            },

            visualInputs: CONFIG.syncVisualInputsToCopilot ? {
                rawPitch: safeGet(() => controls.rawPitch, 0),
                roll: safeGet(() => controls.roll, 0),
                yaw: safeGet(() => controls.yaw, 0),
                throttle: safeGet(() => controls.throttle, 0)
            } : null
        };
    }

    /*************************************************
     * Relative-position ownership detection
     *************************************************/
    function updateHostOwnershipAgainstCopilot() {
        const local = getLocalDirectControls();
        const remote = STATE.latestCopilotControls || null;
        if (!remote) return;

        const t = now();
        for (const key of CHANNEL_KEYS) {
            if (valuesDifferByChannel(key, local[key], remote[key])) {
                HOST_LOCAL_ACTIVITY[key] = t;
            }
        }
    }

    function updateCopilotOwnershipAgainstHostVisuals() {
        const local = getLocalDirectControls();
        const remote = STATE.latestHostState?.visualInputs || null;
        if (!remote) return;

        const t = now();
        for (const key of ["rawPitch", "roll", "yaw", "throttle"]) {
            if (valuesDifferByChannel(key, local[key], remote[key])) {
                COPILOT_LOCAL_ACTIVITY[key] = t;
            }
        }
    }

    function updateCopilotRemoteActivityOnHost(packet) {
        if (!packet) return;
        const t = now();

        for (const key of CHANNEL_KEYS) {
            const newVal = packet[key];
            const oldVal = COPILOT_LAST_VALUES_ON_HOST[key];

            if (oldVal !== null && valuesDifferByChannel(key, oldVal, newVal)) {
                COPILOT_REMOTE_ACTIVITY_ON_HOST[key] = t;
            }

            COPILOT_LAST_VALUES_ON_HOST[key] = newVal;
        }
    }

    function hostLocalOwnsChannel(key) {
        return (now() - (HOST_LOCAL_ACTIVITY[key] || 0)) <= CONFIG.localPriorityMs;
    }

    function copilotRecentlyTouchedChannelOnHost(key) {
        return (now() - (COPILOT_REMOTE_ACTIVITY_ON_HOST[key] || 0)) <= CONFIG.localPriorityMs;
    }

    function copilotLocalOwnsChannel(key) {
        return (now() - (COPILOT_LOCAL_ACTIVITY[key] || 0)) <= CONFIG.localPriorityMs;
    }

    /*************************************************
     * Host applies copilot controls
     *************************************************/
    function applyCopilotControlsToHost(packet) {
        if (!packet || !isGeoFSReady()) return;

        tryApplyControlToHost("rawPitch", packet.rawPitch, (v) => { controls.rawPitch = v; });
        tryApplyControlToHost("roll", packet.roll, (v) => { controls.roll = v; });
        tryApplyControlToHost("yaw", packet.yaw, (v) => { controls.yaw = v; });
        tryApplyControlToHost("throttle", packet.throttle, (v) => { controls.throttle = v; });

        tryApplyControlToHost("gear", packet.gear, (v) => {
            if (controls.gear) controls.gear.position = v;
        });

        tryApplyControlToHost("flaps", packet.flaps, (v) => {
            if (controls.flaps) controls.flaps.position = v;
        });

        tryApplyControlToHost("airbrakes", packet.airbrakes, (v) => {
            if (controls.airbrakes) controls.airbrakes.position = v;
        });

        tryApplyControlToHost("brakes", packet.brakes, (v) => {
            if (typeof controls.brakes !== "undefined") controls.brakes = v;
        });

        tryApplyControlToHost("parkingBrake", packet.parkingBrake, (v) => {
            if (typeof controls.parkingBrake !== "undefined") controls.parkingBrake = v;
        });

        tryApplyControlToHost("pitchTrim", packet.pitchTrim, (v) => {
            if (typeof controls.pitchTrim !== "undefined") controls.pitchTrim = v;
        });

        tryApplyControlToHost("rudderTrim", packet.rudderTrim, (v) => {
            if (typeof controls.rudderTrim !== "undefined") controls.rudderTrim = v;
        });
    }

    function tryApplyControlToHost(key, value, applyFn) {
        if (value == null) return;

        if (hostLocalOwnsChannel(key)) return;
        if (!copilotRecentlyTouchedChannelOnHost(key)) return;

        try {
            applyFn(value);
        } catch (e) {
            warn("apply control failed:", key, e);
        }
    }

    /*************************************************
     * Copilot applies host state
     *************************************************/
    function applyHostStateToCopilot(packet) {
        if (!packet || !isGeoFSReady()) return;

        const ac = safeGet(() => geofs.aircraft.instance, null);
        if (!ac) return;

        try {
            if (CONFIG.syncPositionToCopilot && Array.isArray(packet.llaLocation)) {
                ac.llaLocation = [...packet.llaLocation];

                // Preserve local attitude by re-placing with current local HTR if possible
                if (typeof ac.place === "function") {
                    const currentHtr = safeGet(() => ac.htr, [0, 0, 0]);
                    try {
                        ac.place([...packet.llaLocation], Array.isArray(currentHtr) ? [...currentHtr] : [0, 0, 0]);
                    } catch (_) {}
                }
            }

            if (packet.engineOn != null) {
                const engine = safeGet(() => ac.engine, null);
                if (engine && typeof engine.on !== "undefined") {
                    engine.on = packet.engineOn;
                }
            }

            if (CONFIG.syncVisualInputsToCopilot && packet.visualInputs) {
                applyVisualInputsOnly(packet.visualInputs);
            }
        } catch (e) {
            warn("applyHostStateToCopilot failed:", e);
        }
    }

    function applyVisualInputsOnly(visualInputs) {
        if (!visualInputs) return;

        const av = safeGet(() => geofs.animation.values, null);
        if (!av) return;

        try {
            if (!copilotLocalOwnsChannel("rawPitch") && isNumber(visualInputs.rawPitch)) {
                if (typeof av.pitch !== "undefined") av.pitch = visualInputs.rawPitch;
                if (typeof av.atilt !== "undefined") av.atilt = visualInputs.rawPitch;
            }

            if (!copilotLocalOwnsChannel("roll") && isNumber(visualInputs.roll)) {
                if (typeof av.roll !== "undefined") av.roll = visualInputs.roll;
            }

            if (!copilotLocalOwnsChannel("yaw") && isNumber(visualInputs.yaw)) {
                if (typeof av.yaw !== "undefined") av.yaw = visualInputs.yaw;
            }

            if (!copilotLocalOwnsChannel("throttle") && isNumber(visualInputs.throttle)) {
                if (typeof av.throttle !== "undefined") av.throttle = visualInputs.throttle;
            }
        } catch (e) {
            warn("applyVisualInputsOnly failed:", e);
        }
    }

    /*************************************************
     * Best-effort remote model hiding
     *************************************************/
    function hideRemoteAircraftModels() {
        if (!CONFIG.hideRemoteModels || !isGeoFSReady()) return;

        const localAircraft = safeGet(() => geofs.aircraft.instance, null);
        if (!localAircraft) return;

        const candidates = collectAircraftCandidates();
        for (const aircraft of candidates) {
            if (!aircraft || aircraft === localAircraft) continue;
            hideAircraftModel(aircraft);
        }
    }

    function collectAircraftCandidates() {
        const out = new Set();

        const maybeArrays = [
            safeGet(() => geofs.aircraftList, null),
            safeGet(() => geofs.aircrafts, null),
            safeGet(() => geofs.api?.aircraftList, null),
            safeGet(() => geofs.api?.aircrafts, null),
            safeGet(() => geofs.multiplayer?.aircrafts, null),
            safeGet(() => geofs.multiplayer?.trafficAircraftList, null),
            safeGet(() => geofs.traffic?.aircraftList, null)
        ];

        for (const entry of maybeArrays) {
            if (Array.isArray(entry)) {
                entry.forEach(x => out.add(x));
            } else if (entry && typeof entry === "object") {
                Object.values(entry).forEach(x => out.add(x));
            }
        }

        return Array.from(out);
    }

    function hideAircraftModel(aircraft) {
        const objects = [
            safeGet(() => aircraft.object3d, null),
            safeGet(() => aircraft.model, null),
            safeGet(() => aircraft._model, null),
            safeGet(() => aircraft.aircraftObject, null),
            safeGet(() => aircraft.parts?.root, null),
            safeGet(() => aircraft.root, null)
        ].filter(Boolean);

        for (const obj of objects) {
            tryHideObjectRecursive(obj);
        }
    }

    function tryHideObjectRecursive(obj) {
        try {
            if (typeof obj.visible !== "undefined") {
                obj.visible = false;
            }
        } catch (_) {}

        try {
            if (obj.material) {
                setMaterialTransparent(obj.material);
            }
        } catch (_) {}

        try {
            if (typeof obj.traverse === "function") {
                obj.traverse((child) => {
                    try {
                        if (typeof child.visible !== "undefined") {
                            child.visible = false;
                        }
                    } catch (_) {}

                    try {
                        if (child.material) {
                            setMaterialTransparent(child.material);
                        }
                    } catch (_) {}
                });
            }
        } catch (_) {}
    }

    function setMaterialTransparent(material) {
        if (Array.isArray(material)) {
            material.forEach(setMaterialTransparent);
            return;
        }
        if (!material) return;
        material.transparent = true;
        material.opacity = 0;
        material.depthWrite = false;
    }

    /*************************************************
     * Loops
     *************************************************/
    function startPingLoop() {
        setInterval(() => {
            if (!STATE.connected) return;
            wsSend({
                type: "ping",
                clientTs: now()
            });
        }, CONFIG.pingIntervalMs);
    }

    function startHostSendLoop() {
        setInterval(() => {
            if (CONFIG.mode !== "host") return;
            if (!STATE.joined || !isGeoFSReady()) return;

            updateHostOwnershipAgainstCopilot();

            const packet = getHostStatePacket();
            if (!packet) return;

            wsSend({
                type: "host_state",
                data: packet
            });
        }, CONFIG.sendIntervalMs);
    }

    function startCopilotSendLoop() {
        setInterval(() => {
            if (CONFIG.mode !== "copilot") return;
            if (!STATE.joined || !isGeoFSReady()) return;

            updateCopilotOwnershipAgainstHostVisuals();

            const packet = getLocalDirectControls();
            wsSend({
                type: "copilot_controls",
                data: packet
            });
        }, CONFIG.sendIntervalMs);
    }

    function startHostApplyLoop() {
        function tick() {
            if (CONFIG.mode === "host" && STATE.joined && isGeoFSReady() && STATE.latestCopilotControls) {
                updateHostOwnershipAgainstCopilot();
                applyCopilotControlsToHost(STATE.latestCopilotControls);
            }
            requestAnimationFrame(tick);
        }
        tick();
    }

    function startCopilotApplyLoop() {
        function tick() {
            if (CONFIG.mode === "copilot" && STATE.joined && isGeoFSReady() && STATE.latestHostState) {
                updateCopilotOwnershipAgainstHostVisuals();
                applyHostStateToCopilot(STATE.latestHostState);
            }
            requestAnimationFrame(tick);
        }
        tick();
    }

    function startRemoteModelHideLoop() {
        setInterval(() => {
            if (!STATE.joined || !isGeoFSReady()) return;
            hideRemoteAircraftModels();
        }, CONFIG.remoteHideIntervalMs);
    }

    function startUiLoop() {
        setInterval(updateStatus, 300);
    }

    /*************************************************
     * Boot
     *************************************************/
    function boot() {
        const timer = setInterval(() => {
            if (!document.body) return;
            clearInterval(timer);

            createUI();
            startPingLoop();
            startHostSendLoop();
            startCopilotSendLoop();
            startHostApplyLoop();
            startCopilotApplyLoop();
            startRemoteModelHideLoop();
            startUiLoop();

            log("UI ready");
        }, 200);
    }

    boot();
})();
