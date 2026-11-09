// =====================================================================================
//  TEMPO Care — device link
//
//  Talks to the ESP32-P4 device over three transports. All three carry the same JSON
//  messages, so the dashboard does not care which one delivered a result.
//
//   Remote (Internet)  MQTT over secure WebSockets to the broker the device also uses.
//                      Phone and device can be on completely different networks
//                      (mobile data vs. home Wi-Fi). Persistent connection, no polling:
//                      results arrive ~100–400 ms after the device produces them.
//                      Payloads are AES-256-GCM encrypted end-to-end (key from the
//                      pairing code), so the broker only sees ciphertext.
//   Bluetooth          Web Bluetooth GATT (Chrome / Edge / Android; HTTPS or localhost).
//                      Also used to PAIR (read the pairing code) and to set the device's Wi-Fi.
//   Local Wi-Fi        WebSocket ws://<device-ip>:81 on the same network.
//
//  Remote + Bluetooth can run at the same time; duplicates are dropped by sequence number.
// =====================================================================================
(function () {
    'use strict';

    const BLE_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
    const BLE_CHAR_UUID    = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
    const DEFAULTS = {
        broker: 'wss://broker.emqx.io:8084/mqtt',   // must be the same broker as CONFIG_LIVE_MQTT_URI
        prefix: 'tempocare/v1',
        user: '', pass: '',
        code: '',                                    // "TCxxxxxxxxxxxx-SECRET"
        autoRemote: true,
        lastIp: ''
    };
    const STORE_KEY = 'tempocare.deviceLink';
    const PING_EVERY_MS = 5000;
    const STALE_AFTER_MS = 15000;                   // device sends at least every 5 s

    // ------------------------------------------------------------------ settings
    function loadSettings() {
        try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); }
        catch (e) { return Object.assign({}, DEFAULTS); }
    }
    function saveSettings() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ }
    }
    let settings = loadSettings();

    function parseCode(code) {
        const m = /^\s*(TC[0-9A-F]{12})-([2-9A-HJ-NP-Z]{6,32})\s*$/i.exec(code || '');
        return m ? { id: m[1].toUpperCase(), secret: m[2].toUpperCase() } : null;
    }

    // ------------------------------------------------------------------ crypto (matches live_crypto.c)
    const enc = new TextEncoder(), dec = new TextDecoder();
    let aesKey = null, aesFor = '';
    async function getKey(secret) {
        if (aesKey && aesFor === secret) return aesKey;
        if (!window.crypto || !crypto.subtle) throw new Error('WebCrypto unavailable — open the app over HTTPS or localhost');
        const raw = await crypto.subtle.digest('SHA-256', enc.encode('tempocare-v1:' + secret));
        aesKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
        aesFor = secret;
        return aesKey;
    }
    async function seal(secret, text) {
        const key = await getKey(secret);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)));
        const out = new Uint8Array(12 + ct.length);
        out.set(iv, 0); out.set(ct, 12);
        return out;
    }
    async function open(secret, bytes) {
        const key = await getKey(secret);
        const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (b.length < 28) throw new Error('short');
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, key, b.subarray(12));
        return dec.decode(pt);
    }

    // ------------------------------------------------------------------ shared state / events
    const state = {
        remote: 'off', ble: 'off', local: 'off',    // off | connecting | on | error
        deviceOnline: null,                          // from retained status (remote)
        status: null,                                // last status message
        lastMsgAt: 0,                                // performance.now() of the last live/status message
        rtt: { remote: null, ble: null, local: null },
        lastSeqs: [],
        scan: null
    };
    const listeners = {};
    function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }
    function emit(ev, data) { (listeners[ev] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }

    function setState(transport, value) {
        if (state[transport] === value) return;
        state[transport] = value;
        emit('state', Object.assign({}, state));
    }

    function handleMessage(msg, via) {
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
        case 'live':
            if (typeof msg.seq === 'number') {         // drop the copy that arrives over the 2nd transport
                const key = msg.seq + ':' + (msg.ts || 0);
                if (state.lastSeqs.includes(key)) return;
                state.lastSeqs.push(key);
                if (state.lastSeqs.length > 40) state.lastSeqs.shift();
            }
            state.lastMsgAt = performance.now();
            emit('live', Object.assign({ via }, msg));
            break;
        case 'status':
            if (msg.online === false) { state.deviceOnline = false; emit('state', Object.assign({}, state)); break; }
            state.deviceOnline = true;
            state.status = msg;
            state.lastMsgAt = performance.now();
            if (msg.ip) { settings.lastIp = msg.ip; saveSettings(); }
            emit('status', Object.assign({ via }, msg));
            emit('state', Object.assign({}, state));
            break;
        case 'pong':
            if (typeof msg.t === 'number') {
                state.rtt[via] = Math.max(0, Math.round(Date.now() - msg.t));
                emit('rtt', { via, ms: state.rtt[via] });
            }
            break;
        case 'pair':
            if (msg.code && parseCode(msg.code)) {
                const changed = settings.code !== msg.code;
                settings.code = msg.code;
                saveSettings();
                emit('paired', msg);
                if (changed || state.remote === 'off') remote.connect();
            }
            break;
        case 'scan':
            state.scan = msg.aps || [];
            emit('scan', state.scan);
            break;
        case 'ack': case 'err':
            emit('ack', Object.assign({ via }, msg));
            break;
        default:
            break;
        }
    }

    function parseLine(line, via) {
        line = (line || '').trim();
        if (!line) return;
        try { handleMessage(JSON.parse(line), via); }
        catch (e) { console.warn('[device-link] bad message via', via, line.slice(0, 80)); }
    }

    // ================================================================== Remote (MQTT over WSS)
    const remote = {
        client: null, ids: null,
        topics(id) {
            const p = settings.prefix.replace(/\/+$/, '');
            return { d: `${p}/${id}/d`, s: `${p}/${id}/s`, c: `${p}/${id}/c` };
        },
        connect() {
            const ids = parseCode(settings.code);
            if (!ids) { this.disconnect(); emit('need-pairing'); return false; }
            if (typeof mqtt === 'undefined') { console.error('mqtt.js not loaded'); setState('remote', 'error'); return false; }
            this.disconnect();
            this.ids = ids;
            const t = this.topics(ids.id);
            setState('remote', 'connecting');
            const opts = {
                clientId: 'tcapp-' + Math.random().toString(16).slice(2, 10),
                clean: true, keepalive: 30, reconnectPeriod: 2000, connectTimeout: 10000,
                protocolVersion: 4
            };
            if (settings.user) { opts.username = settings.user; opts.password = settings.pass; }
            const c = mqtt.connect(settings.broker, opts);
            this.client = c;
            c.on('connect', () => {
                if (this.client !== c) return;
                c.subscribe([t.d, t.s], { qos: 0 }, (err) => {
                    if (err) { console.error('[remote] subscribe', err); setState('remote', 'error'); return; }
                    setState('remote', 'on');
                    this.send({ cmd: 'status' });     // ask for the current state at once
                    this.ping();
                });
            });
            c.on('reconnect', () => { if (this.client === c) setState('remote', 'connecting'); });
            c.on('offline', () => { if (this.client === c) setState('remote', 'connecting'); });
            c.on('error', (e) => { console.warn('[remote]', e && e.message); if (this.client === c) setState('remote', 'error'); });
            c.on('message', async (topic, payload) => {
                if (this.client !== c) return;
                try {
                    const text = await open(ids.secret, payload);
                    parseLine(text, 'remote');
                } catch (e) {
                    console.warn('[remote] message could not be decrypted — wrong pairing code?');
                    emit('decrypt-error', topic);
                }
            });
            return true;
        },
        disconnect() {
            if (this.client) { const c = this.client; this.client = null; try { c.end(true); } catch (e) {} }
            setState('remote', 'off');
        },
        async send(obj) {
            if (!this.client || !this.client.connected || !this.ids) return false;
            obj = Object.assign({ ts: Date.now() }, obj);
            const payload = await seal(this.ids.secret, JSON.stringify(obj));
            this.client.publish(this.topics(this.ids.id).c, payload, { qos: 0 });
            return true;
        },
        ping() { return this.send({ cmd: 'ping', t: Date.now() }); }
    };

    // ================================================================== Bluetooth (Web Bluetooth)
    const ble = {
        device: null, chr: null, rx: '', queue: Promise.resolve(),
        supported() { return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); },
        async connect() {
            if (!this.supported()) throw new Error('Web Bluetooth is not available in this browser. Use Chrome or Edge (Android / Windows / macOS) over HTTPS.');
            setState('ble', 'connecting');
            try {
                const dev = await navigator.bluetooth.requestDevice({
                    filters: [{ services: [BLE_SERVICE_UUID] }, { namePrefix: 'ESP32-TempoCare' }, { namePrefix: 'ESP32' }],
                    optionalServices: [BLE_SERVICE_UUID]
                });
                this.device = dev;
                dev.addEventListener('gattserverdisconnected', () => {
                    this.chr = null;
                    setState('ble', 'off');
                    emit('ble-disconnected');
                });
                const server = await dev.gatt.connect();
                const svc = await server.getPrimaryService(BLE_SERVICE_UUID);
                this.chr = await svc.getCharacteristic(BLE_CHAR_UUID);
                this.rx = '';
                this.chr.addEventListener('characteristicvaluechanged', (e) => {
                    this.rx += dec.decode(e.target.value);
                    let i;
                    while ((i = this.rx.indexOf('\n')) >= 0) {
                        const line = this.rx.slice(0, i);
                        this.rx = this.rx.slice(i + 1);
                        parseLine(line, 'ble');
                    }
                    if (this.rx.length > 8192) this.rx = '';
                });
                await this.chr.startNotifications();
                setState('ble', 'on');
                await this.send({ cmd: 'pair' });     // returns the pairing code (inside the pairing window)
                await this.send({ cmd: 'status' });
                this.ping();
                return dev.name || 'device';
            } catch (e) {
                setState('ble', this.chr ? 'on' : 'off');
                throw e;
            }
        },
        disconnect() {
            try { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) {}
            this.chr = null;
            setState('ble', 'off');
        },
        // Writes are serialised and split into 20-byte pieces (works with the minimum ATT MTU).
        send(obj) {
            if (!this.chr) return Promise.resolve(false);
            const ids = parseCode(settings.code);
            if (ids && ['wifi', 'wifi_forget', 'reboot', 'scan', 'pair'].includes(obj.cmd)) obj = Object.assign({ key: ids.secret }, obj);
            const bytes = enc.encode(JSON.stringify(obj) + '\n');
            this.queue = this.queue.then(async () => {
                for (let off = 0; off < bytes.length; off += 20) {
                    const part = bytes.slice(off, off + 20);
                    if (this.chr.writeValueWithResponse) await this.chr.writeValueWithResponse(part);
                    else await this.chr.writeValue(part);
                }
                return true;
            }).catch(e => { console.warn('[ble] write failed', e); return false; });
            return this.queue;
        },
        ping() { return this.send({ cmd: 'ping', t: Date.now() }); }
    };

    // ================================================================== Local Wi-Fi (WebSocket)
    const local = {
        ws: null, ip: '', retry: null, wanted: false,
        connect(ip) {
            ip = (ip || '').trim().replace(/^wss?:\/\//, '').replace(/\/.*$/, '');
            if (!ip) throw new Error('Enter the device IP address');
            if (location.protocol === 'https:' && !/^(localhost|127\.)/.test(ip)) {
                emit('warn', 'This page is served over HTTPS, so the browser blocks the plain local connection (ws://). ' +
                             'Use "Remote" instead — it works on the same network too — or open the app from http:// or a file.');
            }
            this.disconnect();
            this.wanted = true;
            this.ip = ip;
            settings.lastIp = ip; saveSettings();
            const host = ip.includes(':') ? ip : `${ip}:${(state.status && state.status.ws_port) || 81}`;
            setState('local', 'connecting');
            let ws;
            try { ws = new WebSocket(`ws://${host}/`); }
            catch (e) { setState('local', 'error'); throw e; }
            this.ws = ws;
            ws.onopen = () => { setState('local', 'on'); this.send({ cmd: 'status' }); this.ping(); };
            ws.onmessage = (e) => String(e.data).split('\n').forEach(l => parseLine(l, 'local'));
            ws.onerror = () => setState('local', 'error');
            ws.onclose = () => {
                if (this.ws !== ws) return;
                this.ws = null;
                setState('local', this.wanted ? 'connecting' : 'off');
                if (this.wanted) this.retry = setTimeout(() => { try { this.connect(this.ip); } catch (e) {} }, 3000);
            };
        },
        disconnect() {
            this.wanted = false;
            clearTimeout(this.retry);
            if (this.ws) { const w = this.ws; this.ws = null; try { w.close(); } catch (e) {} }
            setState('local', 'off');
        },
        send(obj) {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
            const ids = parseCode(settings.code);
            if (ids && ['wifi', 'wifi_forget', 'reboot', 'scan', 'pair'].includes(obj.cmd)) obj = Object.assign({ key: ids.secret }, obj);
            this.ws.send(JSON.stringify(obj));
            return true;
        },
        ping() { return this.send({ cmd: 'ping', t: Date.now() }); }
    };

    // ================================================================== commands (best transport first)
    async function command(obj) {
        if (state.ble === 'on' && await ble.send(obj)) return 'ble';
        if (state.local === 'on' && local.send(obj)) return 'local';
        if (state.remote === 'on' && await remote.send(obj)) return 'remote';
        throw new Error('Not connected to the device');
    }

    setInterval(() => {
        if (state.remote === 'on') remote.ping();
        if (state.ble === 'on') ble.ping();
        if (state.local === 'on') local.ping();
        emit('tick', { ageMs: state.lastMsgAt ? performance.now() - state.lastMsgAt : null });
    }, PING_EVERY_MS);

    document.addEventListener('visibilitychange', () => {   // phones suspend sockets in the background
        if (document.visibilityState === 'visible' && settings.code && state.remote !== 'on' && settings.autoRemote) remote.connect();
    });

    window.deviceLink = {
        on, state, STALE_AFTER_MS,
        get settings() { return Object.assign({}, settings); },
        updateSettings(patch) {
            const reconnect = ['broker', 'prefix', 'user', 'pass', 'code'].some(k => k in patch && patch[k] !== settings[k]);
            settings = Object.assign(settings, patch);
            saveSettings();
            if (reconnect && settings.code) remote.connect();
        },
        parseCode,
        connectRemote: () => remote.connect(),
        disconnectRemote: () => remote.disconnect(),
        connectBLE: () => ble.connect(),
        disconnectBLE: () => ble.disconnect(),
        bleSupported: () => ble.supported(),
        connectLocal: (ip) => local.connect(ip),
        disconnectLocal: () => local.disconnect(),
        disconnectAll() { remote.disconnect(); ble.disconnect(); local.disconnect(); },
        anyConnected: () => state.remote === 'on' || state.ble === 'on' || state.local === 'on',
        command,
        scanWifi: () => command({ cmd: 'scan' }),
        setWifi: (ssid, pass) => command({ cmd: 'wifi', ssid, pass }),
        forgetWifi: () => command({ cmd: 'wifi_forget' }),
        reboot: () => command({ cmd: 'reboot' }),
        _crypto: { seal, open }          // used by the self-test page
    };
})();
