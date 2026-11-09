// Live radar readings as they arrive from the ESP32: distance and velocity, as tiles, charts and a table.
// Payload fields used: rd_d (mm) and rd_s (cm/s); rd_a, x, y, present and confidence are kept in the buffer only.
const sensorPlots = {
    samples: [],            // {t, d, v, a, x, y, present, activity, conf, gap}
    max: 400,               // about 200 s at the firmware's 2 Hz
    windowMs: 60000,
    paused: false,
    hadAngle: false,
    charts: null,
    packetTimes: [],
    lastRender: 0,
    timer: null,
    // Validated dark-surface categorical slots (blue, orange, aqua) and recessive chrome.
    colors: { distance: '#3987e5', velocity: '#d95926', angle: '#199e70', ink: '#94a3b8', grid: 'rgba(255,255,255,0.08)', axis: 'rgba(255,255,255,0.18)' },

    init() {
        document.getElementById('sensorPause').addEventListener('click', () => this.togglePause());
        document.getElementById('sensorClear').addEventListener('click', () => this.clear());
        if (typeof Chart === 'undefined') {
            document.getElementById('sensorNote').textContent = 'Charts could not be loaded (Chart.js is unavailable). The values and the table below still update.';
            document.getElementById('sensorNote').hidden = false;
        } else {
            this.charts = {
                distance: this.lineChart('sensorDistanceChart', this.colors.distance, 'm', 2),
                velocity: this.lineChart('sensorVelocityChart', this.colors.velocity, 'cm/s', 1)
            };
        }
        setInterval(() => this.tick(), 1000);
        this.render(true);
    },

    number(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
        return null;
    },

    receive(data, raw) {
        if (!data || typeof data !== 'object') return;
        const t = Date.now();
        this.lastPacket = typeof raw === 'string' ? raw.trim() : JSON.stringify(data);
        this.lastKeys = Object.keys(data);
        const d = this.number(data.rd_d), v = this.number(data.rd_s);
        let a = this.number(data.rd_a), x = this.number(data.x), y = this.number(data.y);
        const present = data.present === undefined ? d !== null && d > 0 : Boolean(this.number(data.present));
        if (a !== null) this.hadAngle = true;
        if (!present) { a = null; x = null; y = null; }  // without a target the angle and position are stale
        else if ((x === null || y === null) && a !== null && d !== null) {
            x = d * Math.sin(a * Math.PI / 180);
            y = d * Math.cos(a * Math.PI / 180);
        }
        if (d === null && v === null && a === null) return;
        this.packetTimes.push(t);
        this.packetTimes = this.packetTimes.filter(stamp => t - stamp <= 10000);
        this.samples.push({ t, d, v, a, x, y, present, activity: typeof data.activity === 'string' ? data.activity : null,
                            conf: this.number(data.confidence), gap: false });
        if (this.samples.length > this.max) this.samples.splice(0, this.samples.length - this.max);
        this.render();
    },

    disconnected() {
        const last = this.samples[this.samples.length - 1];
        if (last && !last.gap) this.samples.push({ t: Date.now(), d: null, v: null, a: null, x: null, y: null, present: false, activity: null, conf: null, gap: true });
        this.render(true);
    },

    clear() {
        this.samples = [];
        this.packetTimes = [];
        this.hadAngle = false;
        this.render(true);
    },

    togglePause() {
        this.paused = !this.paused;
        document.getElementById('sensorPause').innerHTML = this.paused
            ? '<i class="fa-solid fa-play"></i> Resume' : '<i class="fa-solid fa-pause"></i> Pause';
        this.render(true);
    },

    note(text) {
        const element = document.getElementById('sensorNote');
        element.textContent = text || '';
        element.hidden = !text;
    },

    visible() {
        const card = document.getElementById('uiSensorCard');
        return document.visibilityState === 'visible' && card && card.offsetParent !== null;
    },

    tick() {
        if (this.samples.length && !this.paused && this.visible()) this.render(true);
    },

    // Redraws are limited to four per second; the ESP32 sends two packets per second.
    render(force) {
        const now = Date.now();
        if (!force && now - this.lastRender < 250) {
            if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.render(true); }, 250 - (now - this.lastRender));
            return;
        }
        this.lastRender = now;
        const last = this.samples[this.samples.length - 1];
        const current = last && !last.gap ? last : null;
        const text = (id, value) => { document.getElementById(id).textContent = value; };
        text('sensorDistance', current && current.d !== null ? (current.d / 1000).toFixed(2) + ' m' : '—');
        text('sensorVelocity', current && current.v !== null ? current.v.toFixed(1) + ' cm/s' : '—');
        const rate = this.packetTimes.length / 10;
        text('sensorRate', !this.samples.length ? 'No data yet. Connect the sensor on this page.'
            : last.gap ? 'Sensor disconnected. Showing the last readings.'
            : `${rate.toFixed(1)} packets/s · last ${((now - last.t) / 1000).toFixed(1)} s ago`
              + (current && !current.present ? ' · no target' : '') + (this.paused ? ' · paused' : ''));
        text('sensorPacket', this.samples.length && this.lastPacket ? this.lastPacket.slice(0, 220) : 'none yet');
        if (this.charts) this.note('');  // the firmware notice is no longer shown; the raw packet line tells what arrives
        this.renderTable();
        if (!this.charts || this.paused || !this.visible()) return;
        const start = now - this.windowMs;
        const points = this.samples.filter(sample => sample.t >= start - 1000);
        for (const [key, field] of [['distance', 'd'], ['velocity', 'v']]) {
            const chart = this.charts[key];
            chart.data.datasets[0].data = points.map(sample => ({ x: sample.t, y: sample[field] === null ? null : key === 'distance' ? sample[field] / 1000 : sample[field] }));
            chart.options.scales.x.min = start;
            chart.options.scales.x.max = now;
            chart.update('none');
        }
    },

    renderTable() {
        const body = document.getElementById('sensorTableBody');
        const rows = this.samples.filter(sample => !sample.gap).slice(-12).reverse();
        body.replaceChildren(...rows.map(sample => {
            const row = document.createElement('tr');
            const cells = [new Date(sample.t).toLocaleTimeString(), sample.d === null ? '—' : sample.d.toFixed(0), sample.v === null ? '—' : sample.v.toFixed(1)];
            cells.forEach(value => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); });
            return row;
        }));
        if (!rows.length) {
            const row = document.createElement('tr'); const cell = document.createElement('td');
            cell.colSpan = 3; cell.textContent = 'No samples received yet.'; row.append(cell); body.append(row);
        }
    },

    alpha(hex, value) {
        return hex + Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0');
    },

    timeLabel(value) {
        return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    },

    lineChart(id, color, unit, decimals) {
        const c = this.colors;
        return new Chart(document.getElementById(id), {
            type: 'line',
            data: { datasets: [{
                data: [], borderColor: color, backgroundColor: this.alpha(color, 0.1), fill: 'origin', borderWidth: 2,
                borderJoinStyle: 'round', borderCapStyle: 'round', tension: 0, spanGaps: false,
                pointRadius: context => context.dataIndex === context.dataset.data.length - 1 ? 4 : 0,  // end-dot only
                pointBackgroundColor: color, pointHoverRadius: 5, pointHitRadius: 12
            }] },
            options: {
                animation: false, responsive: true, maintainAspectRatio: false, parsing: false, normalized: true,
                interaction: { mode: 'nearest', axis: 'x', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { title: items => this.timeLabel(items[0].parsed.x), label: item => item.parsed.y.toFixed(decimals) + ' ' + unit } }
                },
                scales: {
                    x: { type: 'linear', min: Date.now() - this.windowMs, max: Date.now(),
                         ticks: { color: c.ink, maxTicksLimit: 5, maxRotation: 0, callback: value => this.timeLabel(value) },
                         grid: { color: c.grid }, border: { color: c.axis } },
                    y: { ticks: { color: c.ink, maxTicksLimit: 5, callback: value => Number(value).toFixed(decimals) },
                         grid: { color: c.grid }, border: { display: false } }  // the caption carries the unit
                }
            }
        });
    }
};

sensorPlots.init();
