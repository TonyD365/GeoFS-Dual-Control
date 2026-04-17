## Please note: If the mobile device is the host device, the host device will not be able to control the throttle! Could someone please help me fix this? Thank you!

---

# ✈️ GeoFS Dual Control

A real-time dual control system for GeoFS using a Tampermonkey userscript and a WebSocket server.

This project allows **two or more players** to control the same aircraft:

- 👨‍✈️ **Host (Pilot)** — main control authority  
- 🧑‍✈️ **Copilot** — assists with real control inputs  

---

## 🚀 Features

- Real-time dual control (pitch, roll, yaw, throttle, etc.)
- Host / Copilot role separation
- Conflict-safe control system (no fighting inputs)
- Smooth synchronization of aircraft position
- Visual stick movement sync (without overriding control values)
- Works entirely in browser (Tampermonkey)

---

## 🧩 Architecture

```text
Copilot ---> Server ---> Host
   ^                      |
   |                      v
   <------ Server <-------
```

- Server only relays messages
- All control logic is handled on the client side

---

## 📦 Project Structure

```text
/project-root
│
├── server.js           # WebSocket relay server
├── userscript.js       # Tampermonkey script
├── package.json
```

---

## 🔧 Setup

### 1. Run the server or you can use our server (https://tonyd365-geofs-link-flight.hf.space)

```bash
npm install
npm start
```

Server runs on:

```text
http://localhost:7860
```

WebSocket endpoint:

```text
ws://localhost:7860/ws
```

### If you want to use our server on Hugging Face, you can skip this step.

---

### 2. Install the Userscript

1. Install Tampermonkey
2. Create a new script
3. Paste `userscript.js`
4. Save

#### Step on mobile user:
1. Create a bookmark on **Chrome** broser
2. Paste `mobile_userscript.js`
3. save
---

### 3. Configure in GeoFS

Open GeoFS and use the in-game panel.

Fill in:

- **Server URL**
  - Local:
    ```text
    http://localhost:7860
    ```
  - Or hosted (HF Space, etc.)
 
### If you want to use my server on Hugging Face, type "https://tonyd365-geofs-link-flight.hf.space" in Server URL.

- **Room ID**
  - Any string (must match between users)

- **Password**
  - Optional

- **Mode**
  - `Host` or `Copilot`

---

### 4. Connect

- Host clicks **Connect**
- Copilot uses the same Room ID and connects

---

## 🎮 How It Works

### Host → Copilot

- Sends:
  - Aircraft position (authoritative)
  - Telemetry data
  - Visual control inputs (stick movement only)

### Copilot → Host

- Sends:
  - Real control values (pitch, roll, yaw, throttle)

---

## 🧠 Control Logic

### Host side

- Uses per-channel ownership system
- If host is actively controlling:
  - Copilot input is ignored
- If host is idle:
  - Copilot can take over that channel

### Copilot side

- Can actively control the aircraft
- Still receives position updates from host
- Visual stick movement is synced, but:
  - control values are NOT overwritten

---

## ⚠️ Known Behavior

- Copilot can control pitch, roll, and yaw
- Aircraft position is still synced from host
- This means:
  - Controls are real
  - Flight path is partially constrained

---

## 📡 WebSocket Messages

### Join

```json
{
  "type": "join",
  "roomId": "room001",
  "password": "",
  "role": "host"
}
```

### Host State

```json
{
  "type": "host_state",
  "data": { ... }
}
```

### Copilot Controls

```json
{
  "type": "copilot_controls",
  "data": { ... }
}
```

---

## ⚠️ Limitations

- Depends on GeoFS internal APIs
- May break if GeoFS updates
- Not an official GeoFS feature

---

## 📜 License

MIT

---

## 👨‍✈️ Author

TonyD365
