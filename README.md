# TEMPO Care app: connecting to the device

The dashboard gets live radar and audio results from the ESP32-P4 device in three ways
(tabs on the Home screen):

* **Remote:** works from **any network**. The phone can be on mobile data while the device is on
  home Wi-Fi. Both connect to the same MQTT broker over a persistent, encrypted connection, so
  updates arrive in a fraction of a second.
* **Bluetooth:** next to the device. Also used to **pair** (the app learns the device's pairing
  code automatically) and to **move the device to another Wi-Fi network**.
* **Local Wi-Fi:** same network, `ws://<device-ip>:81`.

The device card shows which links are up, the measured round-trip time (⚡) and how long ago the
last update arrived (🕒). Tap ⚙ for **Device Wi-Fi**: scan, choose a network, send. If the device
can't join it, it falls back to its previous network automatically.

## Hosting (important)

Web Bluetooth and the encryption API (WebCrypto) only work on **HTTPS** pages (or `http://localhost`).
Host this folder on any static HTTPS host, e.g. GitHub Pages, Netlify or Firebase Hosting, and open
it in **Chrome or Edge** (Android, Windows, macOS, ChromeOS). Safari/iOS can use Remote but not
Bluetooth: enter the pairing code by hand.

Browsers block plain `ws://` connections from HTTPS pages, so the **Local Wi-Fi** tab only works
when the app is opened over `http://` (e.g. `python -m http.server` on a laptop in the same network).
On the hosted HTTPS app, use **Remote**: it works on the same network too.

## Pairing

1. Switch the device on. Within 10 minutes, tap **Bluetooth → Find & connect device**.
   The app receives the pairing code and Remote connects automatically.
2. Or type the code from the device's serial log (`TCxxxxxxxxxxxx-XXXXXXXXXX`) into the Remote field.

The code is stored on the phone, so next time you only log in and Remote reconnects by itself.

## Settings → Device Link

Pairing code, broker WebSocket URL (default `wss://broker.emqx.io:8084/mqtt`) and optional broker
username/password. They must match the firmware's *Live link* menuconfig. See
`README_LIVE_LINK.md` in the firmware for the protocol and for setting up a private broker.

## Files

| File | |
|---|---|
| `device-link.js` | **New.** Remote (MQTT/WSS + AES-GCM), Bluetooth, local WebSocket, pairing, Wi-Fi setup, latency |
| `vendor/mqtt.min.js` | MQTT.js 5.10.1 (MIT), bundled so it doesn't depend on a CDN |
| `index.html`, `script.js`, `style.css` | Connection tabs, status chips, Device Wi-Fi card, settings. Audio tiles now match the firmware labels (`Flush`, `Walker_Crutch`, `Basin_Tap`, `Bathroom_Tap`, `Shower`, `Door`, `NO_Class`) |
