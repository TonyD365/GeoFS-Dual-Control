// ==UserScript==
// @name         GeoFS Dual Control Final
// @namespace    geofs.dual.control.final
// @version      5.1.0
// @description  Host/Copilot dual control for GeoFS on HF Space
// @match        https://www.geofs.com/*
// @match        http://www.geofs.com/*
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    /*************************************************
     * Config
     *************************************************/
    const DEFAULTS = {
        serverOrigin: "https://your-space-name.hf.space",
        roomId: "room001",
        password: "",
        mode: "host",

        sendIntervalMs: 40,
        pingIntervalMs: 3000,

        // Channel ownership hold time
        localPriorityMs: 260,

        // Minimum change threshold for activity detection
        inputEpsilon: 0.0005,

        // Host -> Copilot: still sync real-time position
        syncPositionToCopilot: true,

        // Host -> Copilot: do NOT hard-write these result values anymore
        syncHTRToCopilot: false,
        syncLinearVelocityToCopilot: false,
        syncAngularVelocityToCopilot: false,

        // Host -> Copilot: sync stick / input visuals only
        syncVisualInputsToCopilot: true
    };

    const STORAGE_KEY = "geofs_dual_control_final_v5_1";

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

    const HOST_LAST_VALUES = Object.fromEntries(CHANNEL_KEYS.map(k => [k, null]));
    const HOST_LOCAL_ACTIVITY = Object.fromEntries(CHANNEL_KEYS.map(k => [k, 0]));
    const COPILOT_LAST_VALUES = Object.fromEntries(CHANNEL_KEYS.map(k => [k, null]));
    const COPILOT_LOCAL_ACTIVITY = Object.fromEntries(CHANNEL_KEYS.map(k => [k, 0]));

    // On host side, remember recent copilot input changes too
    const COPILOT_REMOTE_ACTIVITY_ON_HOST = Object.fromEntries(CHANNEL_KEYS.map(k => [k, 0]));

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

    function nearlyChanged(a, b, eps = CONFIG.inputEpsilon) {
        if (a == null || b == null) return false;
        if (typeof a !== "number" || typeof b !== "number") return a !== b;
        return Math.abs(a - b) > eps;
    }

    function getWsUrl() {
        return CONFIG.serverOrigin.replace(/^http/, "ws") + "/ws";
    }

    function fmtNum(v) {
        return typeof v === "number" ? v.toFixed(1) : "-";
    }

    /*************************************************
     * UI
     *************************************************/
    let root = null;

    function escapeHtml(s) {
        return String(s)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;");
    }

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
                position:fixed;top:16px;right:16px;width:390px;z-index:999999;
                color:#eef4ff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
                background:linear-gradient(180deg,rgba(15,20,34,.95),rgba(8,12,22,.97));
                border:1px solid rgba(110,150,255,.22);border-radius:18px;
                box-shadow:0 18px 42px rgba(0,0,0,.42), inset 0 1px 0 rgba(255,255,255,.05);
                backdrop-filter:blur(12px);overflow:hidden;
            }
            .gdc-header{display:flex;align-items:center;justify-content:space-between;padding:14px;border-bottom:1px solid rgba(255,255,255,.05);}
            .gdc-title{font-size:16px;font-weight:800}
            #gdc-body{padding:14px}
            .gdc-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
            .gdc-field{display:flex;flex-direction:column;gap:6px}
            .gdc-full{grid-column:1 / -1}
            .gdc-field span{font-size:11px;opacity:.78}
            .gdc-field input,.gdc-field select{
                width:100%;height:38px;border-radius:12px;border:1px solid rgba(255,255,255,.08);
                background:rgba(255,255,255,.05);color:#eef4ff;padding:0 12px;outline:none;
            }
            .gdc-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
            .gdc-btn{
                height:38px;border:none;border-radius:12px;padding:0 14px;font-weight:700;cursor:pointer;
                color:#eef4ff;background:rgba(255,255,255,.08)
            }
            .gdc-btn.ghost{background:rgba(255,255,255,.06)}
            .gdc-btn.primary{background:linear-gradient(180deg,#4b7dff,#355ee8)}
            .gdc-btn.danger{background:linear-gradient(180deg,#e45b6e,#c84558)}
            .gdc-status-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
            .gdc-card{
                background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);
                border-radius:14px;padding:10px;
            }
            .gdc-card .k{font-size:11px;opacity:.72;margin-bottom:5px}
            .gdc-card .v{font-size:14px;font-weight:800;word-break:break-all}
            .gdc-telemetry{
                margin-top:12px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.04);
                border:1px solid rgba(255,255,255,.06);font-size:12px;line-height:1.5
            }
            .gdc-sub{font-size:12px;opacity:.75;margin-bottom:6px}
            .gdc-green{color:#8df0a8}.gdc-red{color:#ff9a9a}.gdc-yellow{color:#ffd77a}
        `;
        document.documentElement.appendChild(style);
        document.body.appendChild(root);

        bindUI();
        updateStatus();
    }

    function bindUI() {
        const toggleBtn = root.querySelector("#gdc-toggle");
        const body = root.querySelector("#gdc-body");

        toggleBtn.addEventListener("click", () => {
            const hidden = body.style.display === "none";
            body.style.display = hidden ? "block" : "none";
            toggleBtn.textContent = hidden ? "Collapse" : "Expand";
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

        setStatus("#gdc-st-conn",
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
     * Host packet:
     * send position + telemetry + visual input motions
     * but do not force direct control values onto copilot
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

            // keep sending these as telemetry/reference only
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

            // Visual-only sync of stick / lever motions
            visualInputs: CONFIG.syncVisualInputsToCopilot ? {
                rawPitch: safeGet(() => controls.rawPitch, 0),
                roll: safeGet(() => controls.roll, 0),
                yaw: safeGet(() => controls.yaw, 0),
                throttle: safeGet(() => controls.throttle, 0)
            } : null
        };
    }

    /*************************************************
     * Activity detection
     *************************************************/
    function updateHostLocalActivity() {
        const cur = getLocalDirectControls();
        const t = now();

        for (const key of CHANNEL_KEYS) {
            const oldVal = HOST_LAST_VALUES[key];
            const newVal = cur[key];

            if (oldVal !== null && nearlyChanged(oldVal, newVal)) {
                HOST_LOCAL_ACTIVITY[key] = t;
            }
            HOST_LAST_VALUES[key] = newVal;
        }
    }

    function updateCopilotLocalActivity() {
        const cur = getLocalDirectControls();
        const t = now();

        for (const key of CHANNEL_KEYS) {
            const oldVal = COPILOT_LAST_VALUES[key];
            const newVal = cur[key];

            if (oldVal !== null && nearlyChanged(oldVal, newVal)) {
                COPILOT_LOCAL_ACTIVITY[key] = t;
            }
            COPILOT_LAST_VALUES[key] = newVal;
        }
    }

    function updateCopilotRemoteActivityOnHost(packet) {
        if (!packet) return;
        const t = now();

        for (const key of CHANNEL_KEYS) {
            const v = packet[key];
            if (v != null) {
                COPILOT_REMOTE_ACTIVITY_ON_HOST[key] = t;
            }
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
     * Host applies copilot controls with channel ownership
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

        // If host recently touched this channel, host wins
        if (hostLocalOwnsChannel(key)) return;

        // Otherwise copilot may own it
        if (!copilotRecentlyTouchedChannelOnHost(key)) return;

        try {
            applyFn(value);
        } catch (e) {
            warn("apply control failed:", key, e);
        }
    }

    /*************************************************
     * Copilot:
     * apply host non-direct-control values only
     * + visual stick motion sync
     *************************************************/
    function applyHostStateToCopilot(packet) {
        if (!packet || !isGeoFSReady()) return;

        const ac = safeGet(() => geofs.aircraft.instance, null);
        if (!ac) return;

        try {
            // 1) Position sync stays
            if (CONFIG.syncPositionToCopilot && Array.isArray(packet.llaLocation)) {
                ac.llaLocation = [...packet.llaLocation];
                if (typeof ac.place === "function" && Array.isArray(packet.htr)) {
                    try {
                        ac.place([...packet.llaLocation], [...packet.htr]);
                    } catch (_) {}
                }
            }

            // 2) Do NOT hard-write HTR / velocities by default anymore
            if (CONFIG.syncHTRToCopilot && Array.isArray(packet.htr)) {
                ac.htr = [...packet.htr];
            }

            const rb = safeGet(() => ac.rigidBody, null);
            if (rb) {
                if (CONFIG.syncLinearVelocityToCopilot && Array.isArray(packet.linearVelocity)) {
                    if (typeof rb.setLinearVelocity === "function") {
                        rb.setLinearVelocity([...packet.linearVelocity]);
                    } else if (rb.v_linear) {
                        rb.v_linear = [...packet.linearVelocity];
                    }
                }

                if (CONFIG.syncAngularVelocityToCopilot && Array.isArray(packet.angularVelocity)) {
                    if (typeof rb.setAngularVelocity === "function") {
                        rb.setAngularVelocity([...packet.angularVelocity]);
                    } else if (rb.v_angular) {
                        rb.v_angular = [...packet.angularVelocity];
                    }
                }
            }

            if (packet.engineOn != null) {
                const engine = safeGet(() => ac.engine, null);
                if (engine && typeof engine.on !== "undefined") {
                    engine.on = packet.engineOn;
                }
            }

            // 3) Sync joystick motions visually only
            // Do NOT write controls.* here
            if (CONFIG.syncVisualInputsToCopilot && packet.visualInputs) {
                applyVisualInputsOnly(packet.visualInputs);
            }
        } catch (e) {
            warn("applyHostStateToCopilot failed:", e);
        }
    }

    function applyVisualInputsOnly(visualInputs) {
        if (!visualInputs) return;

        // If copilot is actively touching a channel, do not overwrite its local visual feel
        const av = safeGet(() => geofs.animation.values, null);
        if (!av) return;

        try {
            if (!copilotLocalOwnsChannel("rawPitch") && typeof visualInputs.rawPitch === "number") {
                if (typeof av.pitch !== "undefined") av.pitch = visualInputs.rawPitch;
                if (typeof av.atilt !== "undefined") av.atilt = visualInputs.rawPitch;
            }

            if (!copilotLocalOwnsChannel("roll") && typeof visualInputs.roll === "number") {
                if (typeof av.roll !== "undefined") av.roll = visualInputs.roll;
            }

            if (!copilotLocalOwnsChannel("yaw") && typeof visualInputs.yaw === "number") {
                if (typeof av.yaw !== "undefined") av.yaw = visualInputs.yaw;
            }

            if (!copilotLocalOwnsChannel("throttle") && typeof visualInputs.throttle === "number") {
                if (typeof av.throttle !== "undefined") av.throttle = visualInputs.throttle;
            }
        } catch (e) {
            warn("applyVisualInputsOnly failed:", e);
        }
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

            updateHostLocalActivity();

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

            updateCopilotLocalActivity();

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
                updateHostLocalActivity();
                applyCopilotControlsToHost(STATE.latestCopilotControls);
            }
            requestAnimationFrame(tick);
        }
        tick();
    }

    function startCopilotApplyLoop() {
        function tick() {
            if (CONFIG.mode === "copilot" && STATE.joined && isGeoFSReady() && STATE.latestHostState) {
                updateCopilotLocalActivity();
                applyHostStateToCopilot(STATE.latestHostState);
            }
            requestAnimationFrame(tick);
        }
        tick();
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
            startUiLoop();

            log("UI ready");
        }, 200);
    }

    boot();
})();
