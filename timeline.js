// Incoming events are visible immediately; only acknowledged writes are marked saved.
const activityTimeline = {
    pending: [],
    saved: new Map(),
    observed: new Map(),
    profiles: [],
    profileId: '',
    session: 0,
    readVersion: 0,
    reading: null,
    saving: false,
    retryTimer: null,
    saveError: null,
    loadError: null,
    lastReceived: null,
    lastId: Date.now(),
    storageKey: null,
    storageError: false,
    dropped: 0,
    editing: null,          // id of the record whose "what was it actually?" picker is open
    editChoice: '',
    checking: new Set(),    // ids being saved
    checkError: null,
    CHOICES: ['Entry', 'Exit', 'Walking', 'Standing', 'Sitting', 'Stand_To_Sit', 'Sit_To_Stand', 'No_Person'],

    normalize(activity) {
        const names = {
            standing: 'Standing', sitting: 'Sitting', walking: 'Walking', entry: 'Entry', exit: 'Exit',
            noperson: 'No_Person', standtosit: 'Stand_To_Sit', sittostand: 'Sit_To_Stand'
        };
        return names[String(activity).toLowerCase().replace(/[^a-z]/g, '')] || null;
    },

    setProfiles(profiles) {
        const key = `tempo.pending.v1:${appAuth.currentSelectedRole}:${appAuth.currentUserPhone}`;
        const changedAccount = key !== this.storageKey;
        if (changedAccount) this.reset();
        this.storageKey = key;
        this.profiles = profiles.map(profile => ({ id: String(profile.id), name: profile.name }));
        const allowed = new Set(this.profiles.map(profile => profile.id));
        if (changedAccount) {
            try {
                const stored = JSON.parse(sessionStorage.getItem(key) || '[]');
                if (Array.isArray(stored)) this.pending = stored.slice(0, 1000).filter(entry =>
                    entry && Number.isSafeInteger(entry.id) && allowed.has(String(entry.profile_id)) &&
                    this.normalize(entry.activity) && Number.isFinite(Date.parse(entry.created_at))
                ).map(entry => ({ id: entry.id, profile_id: String(entry.profile_id),
                                 activity: this.normalize(entry.activity), created_at: entry.created_at }));
            } catch (_) { this.storageError = true; }
        }
        this.pending = this.pending.filter(entry => allowed.has(String(entry.profile_id)));
        if (!allowed.has(String(appState.activeProfileId))) {
            appState.activeProfileId = this.profiles.length === 1 ? this.profiles[0].id : null;
        }
        if (!allowed.has(this.profileId)) this.profileId = String(appState.activeProfileId || '');
        for (const [id, value] of [['recordingProfile', appState.activeProfileId], ['timelineProfile', this.profileId]]) {
            const select = document.getElementById(id);
            select.replaceChildren(new Option(this.profiles.length ? 'Select a person' : 'No linked profiles', ''));
            this.profiles.forEach(profile => select.add(new Option(profile.name, profile.id)));
            select.value = value || '';
        }
        this.persist();
        this.render();
        this.flush();
        this.refresh();
    },

    reset() {
        this.session++;
        this.readVersion++;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.pending = [];
        this.saved.clear();
        this.observed.clear();
        this.profiles = [];
        this.profileId = '';
        this.reading = null;
        this.saving = false;
        this.saveError = this.loadError = this.lastReceived = null;
        this.storageKey = null;
        this.storageError = false;
        this.dropped = 0;
        this.editing = null; this.editChoice = ''; this.checking.clear(); this.checkError = null;
        for (const id of ['recordingProfile', 'timelineProfile']) {
            document.getElementById(id)?.replaceChildren(new Option('Log in to select a person', ''));
        }
        this.render();
    },

    persist() {
        if (!this.storageKey) return;
        try {
            if (this.pending.length) sessionStorage.setItem(this.storageKey, JSON.stringify(this.pending));
            else sessionStorage.removeItem(this.storageKey);
            this.storageError = false;
        } catch (_) { this.storageError = true; }
    },

    chooseRecording(value) {
        if (value && !this.profiles.some(profile => profile.id === value)) return;
        appState.activeProfileId = value || null;
        this.observed.delete(value);
        if (!this.profileId) {
            document.getElementById('timelineProfile').value = value;
            this.chooseTimeline(value);
        }
        this.render();
    },

    chooseTimeline(value) {
        this.editing = null; this.editChoice = ''; this.checkError = null;
        this.profileId = this.profiles.some(profile => profile.id === value) ? value : '';
        this.readVersion++;
        this.reading = null;
        this.loadError = null;
        this.render();
        this.refresh();
    },

    receive(value) {
        const activity = this.normalize(value);
        if (!activity || !appAuth.currentUserPhone) return;
        const profileId = String(appState.activeProfileId || '');
        this.lastReceived = new Date();
        if (!this.profiles.some(profile => profile.id === profileId)) { this.render(); return; }
        // A repeated frame is deduplicated against an event retained in the queue or already saved.
        // Failed writes stay queued and retry independently of the sensor's next label.
        if (this.observed.get(profileId) === activity) { this.render(); return; }
        if (this.pending.length >= 1000) { this.dropped++; this.render(); return; }
        this.lastId = Math.max(Date.now(), this.lastId + 1, ...this.pending.map(entry => entry.id + 1));
        this.pending.push({ id: this.lastId, profile_id: profileId, activity, created_at: this.lastReceived.toISOString() });
        this.observed.set(profileId, activity);
        this.persist();
        this.render();
        if (!this.retryTimer) this.flush();
    },

    async flush() {
        if (this.saving || !this.pending.length || !appAuth.currentUserPhone) return;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        const session = this.session;
        this.saving = true;
        this.render();
        try {
            while (this.pending.length && session === this.session) {
                const entry = this.pending[0];
                const saved = await appDatabase.logActivity(entry);
                if (session !== this.session) return;
                this.pending.shift();
                const key = String(entry.profile_id);
                const rows = this.saved.get(key) || [];
                this.saved.set(key, [saved, ...rows.filter(row => String(row.id) !== String(saved.id))].slice(0, 35));
                this.saveError = null;
                this.persist();
                this.render();
            }
        } catch (error) {
            if (session !== this.session) return;
            this.saveError = error;
            this.retryTimer = setTimeout(() => { this.retryTimer = null; this.flush(); }, 10000);
        } finally {
            if (session === this.session) {
                this.saving = false;
                this.render();
            }
        }
    },

    async refresh(force) {
        if (this.editing && !force) return;        // do not rebuild the list while a correction is being chosen
        const profileId = this.profileId;
        if (!profileId || !appAuth.currentUserPhone) { this.render(); return; }
        if (this.reading?.profileId === profileId) return;
        const version = ++this.readVersion, session = this.session;
        this.reading = { profileId, version };
        try {
            const rows = await appDatabase.getActivityLogs(35, profileId);
            if (session !== this.session || version !== this.readVersion) return;
            // Retain locally acknowledged events if this read started before their write completed.
            const merged = new Map(rows.map(row => [String(row.id), row]));
            (this.saved.get(profileId) || []).forEach(row => { if (!merged.has(String(row.id))) merged.set(String(row.id), row); });
            this.saved.set(profileId, [...merged.values()].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 35));
            this.loadError = null;
        } catch (error) {
            if (session !== this.session || version !== this.readVersion) return;
            this.loadError = error;
        } finally {
            if (session === this.session && version === this.readVersion) {
                this.reading = null;
                this.render();
            }
        }
    },

    errorMessage(error) {
        if (!error) return '';
        const message = String(error.message || error);
        if (/profile_id/i.test(message) && ['PGRST204', '42703'].includes(error.code)) {
            return 'Database setup is incomplete: the activity table needs its person column. An administrator must run the prepared SQL migration.';
        }
        if (/verification|original_activity|verified_/i.test(message) && ['PGRST204', '42703'].includes(error.code)) {
            return 'Activity checks need a one-time database update: the activity table has no check columns yet. An administrator must run the prepared SQL migration.';
        }
        if (error.code === '42501') return 'The database denied access to activity records. Ask your administrator to check activity permissions.';
        return 'Activity database error: ' + message;
    },

    render() {
        const container = document.getElementById('timelineContainer');
        if (!container) return;
        const pending = this.pending.filter(entry => String(entry.profile_id) === this.profileId);
        const rows = new Map((this.saved.get(this.profileId) || []).map(row => [String(row.id), { ...row, pending: false }]));
        pending.forEach(row => rows.set(String(row.id), { ...row, pending: true }));
        const sorted = [...rows.values()].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || Number(b.id) - Number(a.id)).slice(0, 35);
        container.replaceChildren();
        for (const row of sorted) {
            const item = document.createElement('li');
            if (row.pending) item.className = 'is-pending';
            const label = document.createElement('strong');
            label.className = 'text-cyan';
            label.textContent = String(row.activity).replace(/_/g, ' ');
            const time = document.createElement('small');
            time.className = 'text-muted';
            time.textContent = new Date(row.created_at).toLocaleString();
            const state = document.createElement('span');
            state.className = row.pending ? 'timeline-state pending' : 'timeline-state saved';
            state.textContent = row.pending ? 'Waiting to save' : 'Saved';
            item.append(label, document.createElement('br'), time, document.createElement('br'), state);
            if (!row.pending) this.renderCheck(item, label, row);
            container.append(item);
        }
        if (!sorted.length) {
            const empty = document.createElement('li');
            empty.textContent = !this.profileId ? 'Select a person to view their activity timeline.'
                : this.loadError ? 'Saved activity history is unavailable. New readings will appear here as they arrive.'
                : 'No activity changes recorded for this person yet.';
            container.append(empty);
        }
        let status = this.errorMessage(this.saveError || this.loadError || this.checkError);
        if (this.pending.length) status += ` ${this.pending.length} event(s) waiting to save. Retrying automatically. Keep this browser tab open.`;
        if (this.storageError && this.pending.length) status += ' This browser cannot retain the pending queue across a reload.';
        if (this.dropped) status += ` Buffer full: ${this.dropped} additional change(s) could not be retained.`;
        document.getElementById('timelineStatus').textContent = status.trim() || 'Showing recorded activity changes. Saved history refreshes every 5 seconds.';
        document.getElementById('timelineRetry').hidden = !this.pending.length;
        const recording = this.profiles.find(profile => profile.id === String(appState.activeProfileId));
        document.getElementById('recordingStatus').textContent = !recording
            ? 'Select the person using this sensor before recording activities.'
            : status.trim() || (this.lastReceived ? `Receiving data for ${recording.name}. Last received at ${this.lastReceived.toLocaleTimeString()}.`
                : `Ready to record for ${recording.name}. Connect the sensor to start.`);
        const setup = /person column|check columns/.test(status) && appAuth.currentSelectedRole === 'Admin';
        document.getElementById('timelineSetup').hidden = !setup;
    },

    label(activity) { return String(activity || '').replace(/_/g, ' '); },

    // Correct / Wrong controls under a saved record
    renderCheck(item, label, row) {
        const id = String(row.id), busy = this.checking.has(id);
        const box = document.createElement('div');
        box.className = 'timeline-check';
        const button = (text, act, cls, extra = {}) => {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'tl-btn ' + (cls || ''); b.textContent = text;
            b.dataset.act = act; b.dataset.id = id; b.disabled = busy;
            Object.assign(b, extra);
            return b;
        };
        if (row.verification === 'correct') {
            item.classList.add('is-correct');
            const tag = document.createElement('span'); tag.className = 'tl-tag ok'; tag.textContent = '✓ Checked: correct';
            box.append(tag, button('Undo', 'undo', 'tl-link'));
        } else if (row.verification === 'corrected') {
            item.classList.add('is-corrected');
            const tag = document.createElement('span'); tag.className = 'tl-tag fix';
            tag.textContent = `✎ Corrected (sensor said ${this.label(row.original_activity)})`;
            box.append(tag, button('Undo', 'undo', 'tl-link'));
        } else if (row.verification === 'rejected') {
            item.classList.add('is-rejected');
            label.classList.add('tl-struck');
            const tag = document.createElement('span'); tag.className = 'tl-tag bad'; tag.textContent = '✗ Wrong: nothing happened (left out of reports)';
            box.append(tag, button('Undo', 'undo', 'tl-link'));
        } else if (this.editing === id) {
            const select = document.createElement('select');
            select.className = 'tl-select'; select.dataset.id = id; select.disabled = busy;
            select.setAttribute('aria-label', 'What was the activity actually?');
            select.add(new Option('What was it actually?', ''));
            this.CHOICES.filter(a => a !== row.activity).forEach(a => select.add(new Option(this.label(a), a)));
            select.add(new Option('Nothing happened (false detection)', '__none'));
            select.value = this.editChoice;
            box.append(select, button('Save', 'save', 'tl-save', { disabled: busy || !this.editChoice }), button('Cancel', 'cancel', 'tl-link'));
        } else {
            const q = document.createElement('span'); q.className = 'tl-q'; q.textContent = 'Is this right?';
            box.append(q, button('✓ Correct', 'correct', 'tl-ok'), button('✗ Wrong', 'wrong', 'tl-bad'));
        }
        if (busy) { const s = document.createElement('span'); s.className = 'tl-q'; s.textContent = 'Saving…'; box.append(s); }
        item.append(box);
    },

    findRow(id) {
        return (this.saved.get(this.profileId) || []).find(row => String(row.id) === String(id));
    },

    async check(id, kind, actual) {
        const row = this.findRow(id);
        if (!row || this.checking.has(String(id))) return;
        this.checking.add(String(id));
        this.checkError = null;
        this.render();
        try {
            const updated = await appDatabase.verifyActivity(row, kind, actual);
            const rows = this.saved.get(this.profileId) || [];
            this.saved.set(this.profileId, rows.map(r => (String(r.id) === String(id) ? { ...r, ...updated } : r)));
            if (this.editing === String(id)) { this.editing = null; this.editChoice = ''; }
        } catch (error) {
            this.checkError = error;
        } finally {
            this.checking.delete(String(id));
            this.render();
        }
    },

    onClick(event) {
        const b = event.target.closest('button[data-act]');
        if (!b) return;
        const id = b.dataset.id, act = b.dataset.act;
        if (act === 'correct') this.check(id, 'correct');
        else if (act === 'wrong') { this.editing = id; this.editChoice = ''; this.render(); document.querySelector(`.tl-select[data-id="${id}"]`)?.focus(); }
        else if (act === 'cancel') { this.editing = null; this.editChoice = ''; this.render(); }
        else if (act === 'save' && this.editChoice) {
            if (this.editChoice === '__none') this.check(id, 'rejected');
            else this.check(id, 'corrected', this.editChoice);
        } else if (act === 'undo') this.check(id, null);
    },

    onChange(event) {
        if (!event.target.classList.contains('tl-select')) return;
        this.editChoice = event.target.value;
        this.render();
        document.querySelector(`.tl-select[data-id="${event.target.dataset.id}"]`)?.focus();
    },

    async copySetup() {
        try {
            const data = await tempoApi.request('/api/activity/setup');
            await navigator.clipboard.writeText(data.sql);
            document.getElementById('timelineSetupMessage').textContent = 'SQL copied. Paste it into your Supabase SQL Editor and run it, then click Retry saving.';
        } catch (error) { document.getElementById('timelineSetupMessage').textContent = error.message; }
    }
};

document.getElementById('recordingProfile').addEventListener('change', event => activityTimeline.chooseRecording(event.target.value));
document.getElementById('timelineProfile').addEventListener('change', event => activityTimeline.chooseTimeline(event.target.value));
document.getElementById('timelineRefresh').addEventListener('click', () => activityTimeline.refresh(true));
document.getElementById('timelineContainer').addEventListener('click', event => activityTimeline.onClick(event));
document.getElementById('timelineContainer').addEventListener('change', event => activityTimeline.onChange(event));
document.getElementById('timelineRetry').addEventListener('click', () => { activityTimeline.flush(); activityTimeline.refresh(); });
window.addEventListener('online', () => { activityTimeline.flush(); activityTimeline.refresh(); });
setInterval(() => {
    if (document.visibilityState === 'visible' && document.getElementById('viewTimeline').style.display === 'block') activityTimeline.refresh();
}, 5000);
