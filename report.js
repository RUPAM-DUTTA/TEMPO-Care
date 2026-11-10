// Report for Doctor: a summary of one person's recorded activity over a period, with their health
// profile, a comparison with the period before, observations, a day-by-day table, a PDF and sharing.
//
// Same reading rules as the AI assistant (care_chat.py):
//  * an Entry record is a recorded entry event, not a verified complete bathroom visit;
//  * night = 22:00-06:00 (a night belongs to the evening's date);
//  * days without records mean "no data" (sensor off or no coverage), never "no activity".
// Time in the room is ESTIMATED only from an Entry followed by an Exit within 2 hours with no other Entry between.
const doctorReport = {
    NIGHT_START: 22, NIGHT_END: 6,
    MAX_STAY_MIN: 120, LONG_STAY_MIN: 30, BUSY_NIGHT: 3,
    PAGE: 1000, MAX_ROWS: 20000,
    report: null,
    building: false,

    // ------------------------------------------------------------------ helpers
    pad(n) { return String(n).padStart(2, '0'); },
    dayKey(d) { return `${d.getFullYear()}-${this.pad(d.getMonth() + 1)}-${this.pad(d.getDate())}`; },
    nightKey(d) {                                   // 01:30 on the 5th belongs to the night of the 4th
        const n = new Date(d);
        if (d.getHours() < this.NIGHT_END) n.setDate(n.getDate() - 1);
        return this.dayKey(n);
    },
    isNight(d) { return d.getHours() >= this.NIGHT_START || d.getHours() < this.NIGHT_END; },
    fmtDate(d) { return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); },
    fmtShort(key) { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); },
    fmtTime(d) { return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); },
    num(x, digits = 1) { return x == null || !Number.isFinite(x) ? '–' : (Math.round(x * 10 ** digits) / 10 ** digits).toString(); },
    esc(t) { return String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
    median(list) {
        if (!list.length) return null;
        const s = [...list].sort((a, b) => a - b), m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    },
    canonical(activity) {
        const names = { standing: 'Standing', sitting: 'Sitting', walking: 'Walking', entry: 'Entry', exit: 'Exit',
                        noperson: 'No_Person', standtosit: 'Stand_To_Sit', sittostand: 'Sit_To_Stand' };
        return names[String(activity || '').toLowerCase().replace(/[^a-z]/g, '')] || null;
    },

    // Period from the form: [start, end) in local time, end exclusive.
    period() {
        const choice = document.getElementById('reportPeriod').value;
        const today = new Date(); today.setHours(0, 0, 0, 0);
        let start, end;
        if (choice === 'custom') {
            const from = document.getElementById('reportFrom').value, to = document.getElementById('reportTo').value;
            if (!from || !to) throw new Error('Choose both dates for the custom period.');
            start = new Date(from + 'T00:00:00'); end = new Date(to + 'T00:00:00'); end.setDate(end.getDate() + 1);
            if (!(end > start)) throw new Error('The end date must be on or after the start date.');
            if ((end - start) / 86400000 > 366) throw new Error('Choose a period of at most one year.');
        } else {
            const days = Number(choice) || 30;
            end = new Date(today); end.setDate(end.getDate() + 1);           // up to the end of today
            start = new Date(end); start.setDate(start.getDate() - days);
        }
        return { start, end, days: Math.round((end - start) / 86400000) };
    },

    // ------------------------------------------------------------------ data
    async fetchRows(ownerId, start, end) {
        const rows = [];
        for (let from = 0; from < this.MAX_ROWS; from += this.PAGE) {
            const { data, error } = await supabaseClient.from('tempo_activity_log').select('id,activity,created_at')
                .eq('profile_id', ownerId).gte('created_at', start.toISOString()).lt('created_at', end.toISOString())
                .order('created_at', { ascending: true }).range(from, from + this.PAGE - 1);
            if (error) {
                if (/profile_id/.test(error.message || '')) throw new Error('Activity history is not set up yet. An admin must run the Timeline setup SQL once (Timeline → Copy setup SQL → Supabase SQL Editor).');
                throw new Error('The activity records could not be loaded: ' + error.message);
            }
            rows.push(...(data || []));
            if (!data || data.length < this.PAGE) break;
        }
        return rows;
    },

    // Pure: rows (any order) -> figures for [start, end)
    analyse(rows, start, end) {
        const events = rows.map(r => ({ at: new Date(r.created_at), activity: this.canonical(r.activity) }))
            .filter(e => e.activity && !isNaN(e.at) && e.at >= start && e.at < end)
            .sort((a, b) => a.at - b.at);
        const days = [];
        for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) days.push(this.dayKey(d));
        const perDay = Object.fromEntries(days.map(k => [k, { records: 0, entries: 0, nightEntries: 0, exits: 0, transitions: 0, longestStay: null }]));
        const byType = {};
        const stays = [];
        let open = null, unpairedEntries = 0, unpairedExits = 0;
        for (const e of events) {
            const day = perDay[this.dayKey(e.at)];
            byType[e.activity] = (byType[e.activity] || 0) + 1;
            if (day) day.records++;
            if (e.activity === 'Entry') {
                if (day) day.entries++;
                if (this.isNight(e.at)) { const n = perDay[this.nightKey(e.at)]; if (n) n.nightEntries++; }
                if (open) unpairedEntries++;
                open = e.at;
            } else if (e.activity === 'Exit') {
                if (day) day.exits++;
                if (open) {
                    const minutes = (e.at - open) / 60000;
                    if (minutes <= this.MAX_STAY_MIN) {
                        stays.push({ start: open, minutes });
                        const sd = perDay[this.dayKey(open)];
                        if (sd) sd.longestStay = Math.max(sd.longestStay || 0, minutes);
                    } else unpairedEntries++;
                    open = null;
                } else unpairedExits++;
            } else if (e.activity === 'Stand_To_Sit' || e.activity === 'Sit_To_Stand') {
                if (day) day.transitions++;
            }
        }
        if (open) unpairedEntries++;
        const covered = days.filter(k => perDay[k].records > 0);
        const n = covered.length || 1;
        const sum = key => covered.reduce((a, k) => a + perDay[k][key], 0);
        const nightsCovered = covered.length;   // a night counts when its evening's day has data
        const minutes = stays.map(s => s.minutes);
        return {
            start, end, days, perDay, events: events.length, byType, stays,
            covered, missing: days.filter(k => !perDay[k].records),
            entries: sum('entries'), exits: sum('exits'), transitions: sum('transitions'),
            entriesPerDay: covered.length ? sum('entries') / n : null,
            nightPerNight: covered.length ? sum('nightEntries') / nightsCovered : null,
            transitionsPerDay: covered.length ? sum('transitions') / n : null,
            medianStay: this.median(minutes),
            longestStay: stays.length ? stays.reduce((a, b) => (b.minutes > a.minutes ? b : a)) : null,
            longStays: stays.filter(s => s.minutes >= this.LONG_STAY_MIN),
            busyNights: days.filter(k => perDay[k].nightEntries >= this.BUSY_NIGHT),
            maxEntriesDay: covered.reduce((best, k) => (!best || perDay[k].entries > perDay[best].entries ? k : best), null),
            unpairedEntries, unpairedExits
        };
    },

    compare(now, before, key, label, unit) {
        const a = now[key], b = before[key];
        if (a == null || b == null) return null;
        const diff = a - b;
        if (Math.abs(diff) < 1 || Math.abs(diff) < 0.5 * Math.max(b, 0.0001)) return null;
        return `${label} ${diff > 0 ? 'increased' : 'decreased'} from ${this.num(b)} to ${this.num(a)}${unit} compared with the previous ${now.days.length} days.`;
    },

    observations(cur, prev, health) {
        const out = [];
        if (!cur.events) return ['No activity was recorded in this period. The sensor may have been off or not assigned to this person.'];
        for (const [key, label, unit] of [['entriesPerDay', 'Recorded entries per day', ''], ['nightPerNight', 'Night-time entries per night', ''],
                                         ['transitionsPerDay', 'Sit/stand transitions per day', ''], ['medianStay', 'Typical (median) estimated time in the room', ' min']]) {
            const line = this.compare(cur, prev, key, label, unit);
            if (line) out.push(line);
        }
        if (cur.longStays.length) {
            const list = cur.longStays.slice().sort((a, b) => b.minutes - a.minutes).slice(0, 5)
                .map(s => `${this.fmtDate(s.start)} ${this.fmtTime(s.start)} (${Math.round(s.minutes)} min)`).join('; ');
            out.push(`${cur.longStays.length} estimated stay${cur.longStays.length > 1 ? 's' : ''} of ${this.LONG_STAY_MIN} min or longer: ${list}.`);
        }
        if (cur.busyNights.length) {
            out.push(`${cur.busyNights.length} night${cur.busyNights.length > 1 ? 's' : ''} with ${this.BUSY_NIGHT} or more recorded night-time entries: ${cur.busyNights.slice(0, 8).map(k => this.fmtShort(k)).join(', ')}${cur.busyNights.length > 8 ? ', …' : ''}.`);
        }
        if (health && health.night_bathroom_frequency != null && cur.nightPerNight != null) {
            const told = Number(health.night_bathroom_frequency);
            if (Number.isFinite(told) && Math.abs(told - cur.nightPerNight) >= 1)
                out.push(`The family reported about ${told} night-time bathroom visit${told === 1 ? '' : 's'} per night; the sensor recorded ${this.num(cur.nightPerNight)} entries per night on average.`);
        }
        if (cur.missing.length) {
            out.push(`No records on ${cur.missing.length} of ${cur.days.length} days${cur.missing.length <= 6 ? ' (' + cur.missing.map(k => this.fmtShort(k)).join(', ') + ')' : ''}. These days are left out of the averages; they show missing data, not inactivity.`);
        }
        if (!out.length) out.push('No notable changes compared with the previous period.');
        return out;
    },

    healthLines(profile, h) {
        const lines = [];
        if (profile) lines.push(['Person', [profile.name, profile.age ? `${profile.age} years` : '', profile.gender || ''].filter(Boolean).join(', ')]);
        if (!h) { lines.push(['Health profile', 'Not filled in']); return lines; }
        const med = (on, name, freq) => on ? ` · medicine: ${name || 'yes'}${freq ? ` (${freq})` : ''}` : '';
        if (h.has_diabetes) lines.push(['Diabetes', ['Yes', h.hba1c ? `HbA1c ${h.hba1c}%` : '', h.sugar_fasting ? `fasting ${h.sugar_fasting} mg/dL` : '',
            h.sugar_postprandial ? `post-meal ${h.sugar_postprandial} mg/dL` : ''].filter(Boolean).join(', ') + med(h.takes_diab_med, h.diab_med_name, h.diab_med_freq)]);
        if (h.has_bp) lines.push(['Blood pressure', ['Yes', h.bp_systolic && h.bp_diastolic ? `${h.bp_systolic}/${h.bp_diastolic} mmHg` : '',
            h.bp_last_check ? `checked ${h.bp_last_check}` : ''].filter(Boolean).join(', ') + med(h.takes_bp_med, h.bp_med_name, h.bp_med_freq)]);
        if (h.has_fracture) lines.push(['Past fracture', (h.fracture_parts || []).join(', ') || 'Yes']);
        if (h.has_metal_implant) lines.push(['Metal implant', h.metal_implant_details || 'Yes']);
        const mob = [];
        if (h.has_mobility_issue) mob.push('mobility difficulty' + ((h.mobility_knees || []).length ? ` (${h.mobility_knees.join(', ')})` : ''));
        if (h.sitting_standing_difficulty) mob.push('difficulty sitting down / standing up');
        if (h.bathroom_assistance) mob.push('needs help in the bathroom');
        if (h.caregiver_present) mob.push('caregiver present');
        if (mob.length) lines.push(['Mobility', mob.join('; ')]);
        const sleep = [];
        if (h.has_sleep_issue) sleep.push('sleep problems');
        if (h.sleep_duration) sleep.push(`about ${h.sleep_duration} h sleep`);
        if (h.night_bathroom_frequency != null) sleep.push(`family reports ~${h.night_bathroom_frequency} night bathroom visit(s)`);
        if (sleep.length) lines.push(['Sleep', sleep.join('; ')]);
        if (h.has_memory_issue) lines.push(['Memory', 'Memory difficulties reported']);
        if ((h.other_issues || []).length) lines.push(['Other', h.other_issues.join('; ')]);
        if (h.relevant_notes) lines.push(['Notes', h.relevant_notes]);
        return lines;
    },

    // ------------------------------------------------------------------ UI
    async open() {
        const select = document.getElementById('reportProfile');
        const profiles = await appDatabase.getProfiles();
        this.profiles = profiles;
        const keep = select.value || String(appState.activeProfileId || '');
        select.replaceChildren(new Option(profiles.length ? 'Select a person' : 'No linked profiles', ''));
        profiles.forEach(p => select.add(new Option(p.name, p.id)));
        select.value = profiles.some(p => String(p.id) === keep) ? keep : (profiles.length === 1 ? String(profiles[0].id) : '');
        try {
            const saved = JSON.parse(localStorage.getItem('tempo.doctorContact') || '{}');
            if (!document.getElementById('reportDoctorPhone').value) document.getElementById('reportDoctorPhone').value = saved.phone || '';
            if (!document.getElementById('reportDoctorEmail').value) document.getElementById('reportDoctorEmail').value = saved.email || '';
        } catch (_) { /* private mode */ }
        this.toggleCustom();
        document.getElementById('btnReportShare').hidden = !(navigator.canShare && window.File);
        if (select.value && !this.report) this.build();
    },

    toggleCustom() {
        const custom = document.getElementById('reportPeriod').value === 'custom';
        document.getElementById('reportCustom').hidden = !custom;
    },

    message(text, kind) {
        const el = document.getElementById('reportMsg');
        el.textContent = text || '';
        el.className = 'report-msg' + (kind ? ' is-' + kind : '');
    },

    async build() {
        if (this.building) return;
        const profileId = document.getElementById('reportProfile').value;
        if (!profileId) return this.message('Choose the person the report is for.', 'error');
        const ownerId = appState.allowedProfileIds.find(id => String(id) === String(profileId));
        if (ownerId === undefined) return this.message('You can only create reports for people linked to your account.', 'error');
        let range;
        try { range = this.period(); } catch (e) { return this.message(e.message, 'error'); }
        this.building = true;
        this.setActions(false);
        this.message('Reading the records…');
        try {
            const prevStart = new Date(range.start); prevStart.setDate(prevStart.getDate() - range.days);
            const [rows, prevRows, healthAll] = await Promise.all([
                this.fetchRows(ownerId, range.start, range.end),
                this.fetchRows(ownerId, prevStart, range.start),
                appDatabase.getHealthProfiles()
            ]);
            const profile = (this.profiles || []).find(p => String(p.id) === String(profileId)) || null;
            const health = healthAll.filter(h => String(h.profile_id) === String(profileId))
                .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))[0] || null;
            const cur = this.analyse(rows, range.start, range.end);
            const prev = this.analyse(prevRows, prevStart, range.start);
            this.report = { profile, health, cur, prev, generated: new Date(), healthLines: this.healthLines(profile, health),
                            notes: this.observations(cur, prev, health) };
            this.render();
            this.message(cur.events ? `Report ready: ${cur.events} records from ${cur.covered.length} of ${cur.days.length} days.` : 'No records in this period. The report says so.', cur.events ? 'ok' : 'error');
            this.setActions(true);
        } catch (e) {
            console.error('Report error:', e);
            this.message(e.message || 'The report could not be created.', 'error');
        } finally {
            this.building = false;
        }
    },

    setActions(enabled) {
        for (const id of ['btnReportPdf', 'btnReportShare', 'btnReportWhatsApp', 'btnReportEmail'])
            document.getElementById(id).disabled = !enabled;
    },

    keyRows() {
        const { cur, prev } = this.report;
        const stay = s => (s ? `${Math.round(s.minutes)} min (${this.fmtShort(this.dayKey(s.start))} ${this.fmtTime(s.start)})` : '–');
        return [
            ['Days with records', `${cur.covered.length} of ${cur.days.length}`, `${prev.covered.length} of ${prev.days.length}`],
            ['Recorded entries (total)', String(cur.entries), String(prev.entries)],
            ['Entries per day', this.num(cur.entriesPerDay), this.num(prev.entriesPerDay)],
            ['Most entries in one day', cur.maxEntriesDay ? `${cur.perDay[cur.maxEntriesDay].entries} (${this.fmtShort(cur.maxEntriesDay)})` : '–', prev.maxEntriesDay ? String(prev.perDay[prev.maxEntriesDay].entries) : '–'],
            ['Night-time entries per night (22:00–06:00)', this.num(cur.nightPerNight), this.num(prev.nightPerNight)],
            ['Estimated time in room, median', cur.medianStay == null ? '–' : `${this.num(cur.medianStay)} min`, prev.medianStay == null ? '–' : `${this.num(prev.medianStay)} min`],
            ['Longest estimated stay', stay(cur.longestStay), prev.longestStay ? `${Math.round(prev.longestStay.minutes)} min` : '–'],
            [`Stays of ${this.LONG_STAY_MIN} min or more`, String(cur.longStays.length), String(prev.longStays.length)],
            ['Sit/stand transitions per day', this.num(cur.transitionsPerDay), this.num(prev.transitionsPerDay)]
        ];
    },

    dailyRows() {
        const { cur } = this.report;
        return cur.days.map(k => {
            const d = cur.perDay[k];
            return d.records ? [this.fmtShort(k), String(d.entries), String(d.nightEntries), String(d.transitions),
                                d.longestStay == null ? '–' : `${Math.round(d.longestStay)} min`]
                             : [this.fmtShort(k), 'no data', '', '', ''];
        });
    },

    periodText() {
        const { cur } = this.report;
        const last = new Date(cur.end); last.setDate(last.getDate() - 1);
        return `${this.fmtDate(cur.start)} – ${this.fmtDate(last)} (${cur.days.length} days)`;
    },

    render() {
        const r = this.report, box = document.getElementById('reportPreview');
        const table = (head, rows, cls) => `<div class="report-table-wrap"><table class="report-table ${cls || ''}"><thead><tr>${head.map(h => `<th>${this.esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(c => `<td>${this.esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
        const maxDay = Math.max(1, ...r.cur.days.map(k => r.cur.perDay[k].entries));
        const bars = r.cur.days.map(k => {
            const d = r.cur.perDay[k];
            const h = d.records ? Math.max(2, Math.round(d.entries / maxDay * 100)) : 0;
            const nh = d.records && d.entries ? Math.round(Math.min(d.nightEntries, d.entries) / d.entries * h) : 0;
            return `<div class="rbar${d.records ? '' : ' rbar-none'}" title="${this.esc(this.fmtShort(k))}: ${d.records ? `${d.entries} entries, ${d.nightEntries} at night` : 'no data'}"><span style="height:${h}%"><i style="height:${h ? Math.round(nh / h * 100) : 0}%"></i></span></div>`;
        }).join('');
        box.innerHTML = `
            <div class="report-head">
                <div><strong>${this.esc(r.profile ? r.profile.name : 'Person')}</strong><br><span>${this.esc(this.periodText())}</span></div>
                <span class="report-stamp">Generated ${this.esc(this.fmtDate(r.generated))} ${this.esc(this.fmtTime(r.generated))}</span>
            </div>
            <h3>Health profile (reported by the family)</h3>
            <dl class="report-health">${r.healthLines.map(([k, v]) => `<dt>${this.esc(k)}</dt><dd>${this.esc(v)}</dd>`).join('')}</dl>
            <h3>Key figures</h3>
            ${table(['Measure', 'This period', `Previous ${r.cur.days.length} days`], this.keyRows(), 'report-key')}
            <h3>Observations</h3>
            <ul class="report-notes">${r.notes.map(n => `<li>${this.esc(n)}</li>`).join('')}</ul>
            <h3>Recorded entries per day <small><span class="lg lg-day"></span>day <span class="lg lg-night"></span>night</small></h3>
            <div class="report-bars" role="img" aria-label="Recorded entries per day">${bars}</div>
            <div class="report-bars-axis"><span>${this.esc(this.fmtShort(r.cur.days[0]))}</span><span>${this.esc(this.fmtShort(r.cur.days[r.cur.days.length - 1]))}</span></div>
            <h3>Day by day</h3>
            ${table(['Date', 'Entries', 'Night entries', 'Sit/stand', 'Longest stay'], this.dailyRows(), 'report-daily')}
            <p class="report-method">${this.esc(this.methodText())}</p>`;
    },

    methodText() {
        const { cur } = this.report;
        return `How to read this report: figures come from a radar sensor in the bathroom that records activity changes (Entry, Exit, Sitting, Standing, Walking, sit/stand transitions). ` +
            `An Entry record is a recorded entry event, not a verified complete visit. Night = 22:00–06:00. Averages use only days with records. ` +
            `Time in the room is estimated from an Entry followed by an Exit within ${this.MAX_STAY_MIN} minutes (${cur.stays.length} pairs; ` +
            `${cur.unpairedEntries} entries without a matching exit were not used). Sensor recognition can be wrong. ` +
            `This report supports a conversation with a doctor and is not a diagnosis.`;
    },

    // ------------------------------------------------------------------ PDF
    latin(text) {            // the PDF's built-in fonts cover Western characters only
        return String(text ?? '').replace(/[–—]/g, '-').replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...')
            .replace(/≥/g, '>=').replace(/·/g, '-').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '?');
    },

    fileName() {
        const r = this.report;
        const name = (r.profile ? r.profile.name : 'person').normalize('NFKD').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '') || 'person';
        const last = new Date(r.cur.end); last.setDate(last.getDate() - 1);
        return `TEMPO_Care_Report_${name}_${this.dayKey(r.cur.start)}_to_${this.dayKey(last)}.pdf`;
    },

    pdfBlob() {
        if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('The PDF tool did not load. Check the internet connection and reload the page.');
        const r = this.report, L = t => this.latin(t);
        const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
        const W = 210, M = 14, ink = [30, 41, 59], muted = [100, 116, 139], blue = [37, 99, 235], night = [124, 58, 237];
        let y = 0;
        const ensure = h => { if (y + h > 282) { doc.addPage(); y = 18; } };
        const heading = (t, keep = 14) => { ensure(keep); y += 4; doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...blue); doc.text(L(t), M, y); y += 2; doc.setDrawColor(226, 232, 240); doc.line(M, y, W - M, y); y += 5; };

        // header band
        doc.setFillColor(15, 23, 42); doc.rect(0, 0, W, 26, 'F');
        doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
        doc.text('TEMPO Care - Activity report for the doctor', M, 12);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
        doc.text(L(`${r.profile ? r.profile.name : 'Person'}  |  ${this.periodText()}  |  generated ${this.fmtDate(r.generated)} ${this.fmtTime(r.generated)}`), M, 20);
        y = 34;

        heading('Health profile (reported by the family)', 40);
        doc.autoTable({ startY: y, margin: { left: M, right: M }, theme: 'plain', styles: { fontSize: 9, cellPadding: 1.2, textColor: ink },
                        columnStyles: { 0: { fontStyle: 'bold', cellWidth: 38 } }, body: r.healthLines.map(([k, v]) => [L(k), L(v)]) });
        y = doc.lastAutoTable.finalY + 2;

        heading('Key figures', 60);
        doc.autoTable({ startY: y, margin: { left: M, right: M }, theme: 'striped', styles: { fontSize: 9, cellPadding: 1.8, textColor: ink },
                        headStyles: { fillColor: blue, textColor: 255 }, columnStyles: { 0: { cellWidth: 82 } },
                        head: [['Measure', 'This period', `Previous ${r.cur.days.length} days`]], body: this.keyRows().map(row => row.map(L)) });
        y = doc.lastAutoTable.finalY + 2;

        heading('Observations');
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...ink);
        for (const note of r.notes) {
            const lines = doc.splitTextToSize(L(note), W - 2 * M - 5);
            ensure(lines.length * 4.6 + 1);
            doc.text('-', M, y); doc.text(lines, M + 4, y); y += lines.length * 4.6 + 1;
        }

        // bar chart: entries per day, night part darker
        heading('Recorded entries per day (dark = night 22:00-06:00, grey = no data)', 58);
        const cx = M + 8, cw = W - 2 * M - 10, ch = 34, base = y + ch;
        const maxDay = Math.max(1, ...r.cur.days.map(k => r.cur.perDay[k].entries));
        const step = cw / r.cur.days.length, bw = Math.max(0.6, step * 0.7);
        doc.setDrawColor(203, 213, 225); doc.setFontSize(7); doc.setTextColor(...muted);
        for (const v of [0, Math.ceil(maxDay / 2), maxDay]) {
            const gy = base - v / maxDay * ch; doc.line(cx, gy, cx + cw, gy); doc.text(String(v), cx - 2, gy + 1, { align: 'right' });
        }
        r.cur.days.forEach((k, i) => {
            const d = r.cur.perDay[k], x = cx + i * step + (step - bw) / 2;
            if (!d.records) { doc.setFillColor(226, 232, 240); doc.rect(x, base - 1.2, bw, 1.2, 'F'); return; }
            const h = d.entries / maxDay * ch, nh = Math.min(d.nightEntries, d.entries) / maxDay * ch;
            if (h > 0) { doc.setFillColor(...blue); doc.rect(x, base - h, bw, h, 'F'); }
            if (nh > 0) { doc.setFillColor(...night); doc.rect(x, base - nh, bw, nh, 'F'); }
        });
        const labelEvery = Math.ceil(r.cur.days.length / 10);
        r.cur.days.forEach((k, i) => { if (i % labelEvery === 0) doc.text(L(this.fmtShort(k)), cx + i * step + step / 2, base + 4, { align: 'center' }); });
        y = base + 8;

        heading('Day by day', 40);
        doc.autoTable({ startY: y, margin: { left: M, right: M }, theme: 'grid', styles: { fontSize: 8.5, cellPadding: 1.3, textColor: ink, halign: 'center' },
                        headStyles: { fillColor: [51, 65, 85], textColor: 255 }, columnStyles: { 0: { halign: 'left' } },
                        head: [['Date', 'Entries', 'Night entries', 'Sit/stand transitions', 'Longest estimated stay']],
                        body: this.dailyRows().map(row => row.map(L)),
                        didParseCell: d => { if (d.section === 'body' && d.row.raw[1] === 'no data') d.cell.styles.textColor = muted; } });
        y = doc.lastAutoTable.finalY + 4;

        heading('How to read this report', 30);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...muted);
        const method = doc.splitTextToSize(L(this.methodText()), W - 2 * M);
        ensure(method.length * 4); doc.text(method, M, y);

        const pages = doc.getNumberOfPages();
        for (let i = 1; i <= pages; i++) {
            doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(...muted);
            doc.text(L(`TEMPO Care - ${r.profile ? r.profile.name : ''} - not a diagnosis`), M, 290);
            doc.text(`Page ${i} of ${pages}`, W - M, 290, { align: 'right' });
        }
        return doc.output('blob');
    },

    summaryText() {
        const r = this.report, c = r.cur;
        const lines = [
            `TEMPO Care activity report: ${r.profile ? r.profile.name : 'person'}`,
            `Period: ${this.periodText()}`,
            `Days with records: ${c.covered.length} of ${c.days.length}`,
            `Recorded entries per day: ${this.num(c.entriesPerDay)} (previous period ${this.num(r.prev.entriesPerDay)})`,
            `Night-time entries per night: ${this.num(c.nightPerNight)} (previous ${this.num(r.prev.nightPerNight)})`,
            `Estimated time in room, median: ${c.medianStay == null ? '-' : this.num(c.medianStay) + ' min'}; longest: ${c.longestStay ? Math.round(c.longestStay.minutes) + ' min' : '-'}`,
            `Sit/stand transitions per day: ${this.num(c.transitionsPerDay)}`,
            '',
            'Observations:',
            ...r.notes.slice(0, 5).map(n => '- ' + n),
            '',
            'The full PDF report is attached. Generated by TEMPO Care from a bathroom motion sensor; not a diagnosis.'
        ];
        return lines.join('\n');
    },

    // ------------------------------------------------------------------ actions
    saveContact() {
        try {
            localStorage.setItem('tempo.doctorContact', JSON.stringify({
                phone: document.getElementById('reportDoctorPhone').value.trim(),
                email: document.getElementById('reportDoctorEmail').value.trim() }));
        } catch (_) { /* private mode */ }
    },

    download() {
        const blob = this.pdfBlob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = this.fileName(); a.rel = 'noopener';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return blob;
    },

    async share() {
        const file = new File([this.pdfBlob()], this.fileName(), { type: 'application/pdf' });
        if (!(navigator.canShare && navigator.canShare({ files: [file] }))) {
            this.download();
            return this.message('This browser cannot share files directly, so the PDF was downloaded. Attach it in WhatsApp or your email.', 'ok');
        }
        try {
            await navigator.share({ files: [file], title: 'TEMPO Care report', text: this.summaryText() });
            this.message('Shared.', 'ok');
        } catch (e) {
            if (e.name !== 'AbortError') this.message('Sharing failed: ' + e.message, 'error');
        }
    },

    whatsapp() {
        this.saveContact();
        const digits = document.getElementById('reportDoctorPhone').value.replace(/[^\d]/g, '');
        if (digits && digits.length < 10) return this.message('Enter the doctor\'s WhatsApp number with the country code, e.g. 91 98765 43210.', 'error');
        this.download();
        window.open(`https://wa.me/${digits}?text=${encodeURIComponent(this.summaryText())}`, '_blank', 'noopener');
        this.message('WhatsApp opened with the summary, and the PDF was downloaded: attach it in the chat (📎 → Document).', 'ok');
    },

    email() {
        this.saveContact();
        const to = document.getElementById('reportDoctorEmail').value.trim();
        if (to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return this.message('That email address does not look right.', 'error');
        this.download();
        const r = this.report;
        const subject = `TEMPO Care activity report: ${r.profile ? r.profile.name : ''} (${this.periodText()})`;
        window.location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(this.summaryText())}`;
        this.message('Your email app opened with the summary, and the PDF was downloaded: attach it to the email.', 'ok');
    }
};
