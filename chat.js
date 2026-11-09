// API transport. Login and the assistant run on the TEMPO Care server: the cloud server (always on),
// this laptop's server.py, or the server that served this page. config.js lists the addresses.
// On the published site (GitHub Pages) everything except the assistant also works with no server reachable:
// family login then falls back to a direct database check.
class ServerOffline extends Error {}

const tempoApi = {
    base: null,          // working API address ('' = the server that served this page)
    checkedAt: 0,
    token: null,         // bearer token for a server on another site
    creds: null,         // kept in memory only (this tab), to log in again after a cloud server restart
    waking: null,

    config() { return window.TEMPO_CONFIG || {}; },
    publishedSite() { return Array.isArray(this.config().apiBases) && this.config().apiBases.length > 0; },
    bases() { return this.publishedSite() ? this.config().apiBases.map(b => String(b).replace(/\/+$/, '')) : ['']; },

    async probe(base, ms) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ms);
        try {
            const r = await fetch(base + '/api/health', { cache: 'no-store', credentials: base ? 'omit' : 'same-origin', signal: controller.signal });
            return r.ok;
        } catch (_) { return false; }
        finally { clearTimeout(timer); }
    },

    // Finds a reachable server. quick: short timeouts (login must not wait); otherwise waits for a sleeping
    // free cloud server to start (about a minute).
    async resolve(quick) {
        if (location.protocol === 'file:') throw new ServerOffline('Open TEMPO Care from its web address, not as a file.');
        if (this.base !== null && Date.now() - this.checkedAt < 60000) return this.base;
        for (const base of this.bases()) {
            const cloud = /^https:/.test(base);
            if (await this.probe(base, quick ? 4000 : (cloud ? 75000 : 4000))) {
                this.base = base; this.checkedAt = Date.now();
                return base;
            }
        }
        this.base = null;
        throw new ServerOffline(this.publishedSite()
            ? 'The AI assistant server is not reachable right now (it may be starting up). Please try again in a minute.'
            : 'The TEMPO Care server is unavailable. Start it with start.cmd.');
    },

    // Starts a sleeping cloud server in the background (free hosting sleeps when unused).
    wake() {
        if (!this.publishedSite() || this.waking) return this.waking;
        this.waking = this.resolve(false).catch(() => null).finally(() => { this.waking = null; });
        return this.waking;
    },

    async send(base, path, body, signal) {
        const headers = { 'Content-Type': 'application/json', 'X-Tempo-Client': 'browser' };
        if (base && this.token) headers.Authorization = 'Bearer ' + this.token;
        let response;
        try {
            response = await fetch(base + path, {
                method: body === undefined ? 'GET' : 'POST', headers,
                credentials: base ? 'omit' : 'same-origin', cache: 'no-store',
                body: body === undefined ? undefined : JSON.stringify(body), signal
            });
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            this.base = null;
            throw new ServerOffline('The AI assistant server could not be reached. Please try again.');
        }
        let data;
        try { data = await response.json(); }
        catch (_) { this.base = null; throw new ServerOffline('The AI assistant server is unavailable right now. Please try again shortly.'); }
        if (!response.ok) { const e = new Error(data.error || 'The request could not be completed.'); e.status = response.status; throw e; }
        return data;
    },

    async request(path, body, signal) {
        if (this.waking) await this.waking;
        const base = await this.resolve(false);
        // logged in on the published site while the server was unreachable: log in to it now
        if (base && !this.token && this.creds && path !== '/api/session' && path !== '/api/logout') await this.serverLogin(base);
        try {
            return await this.send(base, path, body, signal);
        } catch (error) {
            // the free cloud server restarted (sessions are kept in memory): log in again once and retry
            if (error.status === 401 && this.creds && path !== '/api/session') {
                await this.serverLogin(base);
                return this.send(base, path, body, signal);
            }
            throw error;
        }
    },

    async serverLogin(base) {
        const data = await this.send(base, '/api/session', this.creds);
        this.token = data.token || null;
        return data;
    },

    async login(phone, password, role) {
        this.creds = { phone, password, role };
        let base;
        try { base = await this.resolve(true); }
        catch (error) {
            if (!(error instanceof ServerOffline) || !this.publishedSite()) { this.creds = null; throw error; }
            return this.directLogin(phone, password, role);
        }
        try {
            const data = await this.serverLogin(base);
            const { token, ...identity } = data;
            return identity;
        } catch (error) {
            if (error instanceof ServerOffline && this.publishedSite()) return this.directLogin(phone, password, role);
            this.creds = null;
            throw error;
        }
    },

    // Published site with no server reachable: check the family login against the database directly
    // (the same check the original app made). The assistant connects later, when its server is up.
    async directLogin(phone, password, role) {
        this.wake();
        if (role === 'Admin') {
            this.creds = null;
            throw new Error('Admin login is checked by the TEMPO Care server, which is starting up. Please try again in a minute.');
        }
        const { data, error } = await supabaseClient.from('tempo_users').select('name,phone,role')
            .eq('phone', phone).eq('role', 'Care Family').eq('password', password).limit(1);
        if (error) { this.creds = null; throw new Error('The login could not be checked: ' + error.message); }
        if (!data || !data.length) { this.creds = null; throw new Error('The login details do not match. Please try again.'); }
        return { phone: data[0].phone, role: 'Care Family', name: data[0].name || 'Care Family' };
    },

    logout() {
        const base = this.base;
        if (base !== null && (base === '' || this.token)) this.send(base, '/api/logout', {}).catch(() => {});
        this.token = null;
        this.creds = null;
    }
};

const aiChat = {
    controller: null,
    contextController: null,
    generation: 0,
    conversation: '',
    busy: false,
    initialized: false,

    init() {
        if (this.initialized) return;
        this.initialized = true;
        document.getElementById('chatProfile').addEventListener('change', () => this.clearChat());
        document.getElementById('chatPeriod').addEventListener('change', () => this.setPeriod());
        ['chatStart', 'chatEnd'].forEach(id => document.getElementById(id).addEventListener('change', () => {
            document.getElementById('chatPeriod').value = 'custom';
            this.clearChat();
        }));
        this.setPeriod();
    },

    dateValue(date) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    },

    setPeriod() {
        const period = document.getElementById('chatPeriod').value;
        if (period !== 'custom') {
            const start = new Date(), end = new Date();
            if (period === 'yesterday') { start.setDate(start.getDate() - 1); end.setDate(end.getDate() - 1); }
            if (period === 'week') start.setDate(start.getDate() - 6);
            document.getElementById('chatStart').value = this.dateValue(start);
            document.getElementById('chatEnd').value = this.dateValue(end);
        }
        this.clearChat();
    },

    offsetISO(date) {
        const offset = -date.getTimezoneOffset();
        const sign = offset >= 0 ? '+' : '-';
        return this.dateValue(date) + 'T00:00:00' + sign +
            String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0') + ':' +
            String(Math.abs(offset) % 60).padStart(2, '0');
    },

    scope() {
        const profile = document.getElementById('chatProfile').value;
        const first = document.getElementById('chatStart').value;
        const last = document.getElementById('chatEnd').value;
        if (!profile) throw new Error('Select a Care Focus person first.');
        if (!first || !last) throw new Error('Select a start and end date.');
        const start = new Date(first + 'T00:00:00'), end = new Date(last + 'T00:00:00');
        if (end < start) throw new Error('The end date must be on or after the start date.');
        end.setDate(end.getDate() + 1);
        if (Math.round((end - start) / 86400000) > 31) throw new Error('Choose a date range of up to 31 days.');
        return { profile_id: profile, start: this.offsetISO(start), end: this.offsetISO(end), conversation_id: this.conversation };
    },

    async open() {
        this.init();
        this.contextController?.abort();
        const controller = new AbortController();
        this.contextController = controller;
        const select = document.getElementById('chatProfile');
        const previous = select.value;
        this.setStatus(tempoApi.publishedSite() ? 'Connecting to the AI assistant… (up to a minute if it was asleep)' : 'Checking local assistant…', false);
        try {
            const data = await tempoApi.request('/api/chat/context', undefined, controller.signal);
            if (controller.signal.aborted) return;
            select.replaceChildren();
            data.profiles.forEach(profile => select.add(new Option(profile.name, profile.id)));
            if (!data.profiles.length) select.add(new Option('No linked Care Focus profiles', ''));
            if (data.profiles.some(profile => profile.id === previous)) select.value = previous;
            if (select.value !== previous) this.clearChat();
            this.setStatus(data.database?.ready === false ? data.database.message : data.model.message,
                data.model.ready && data.database?.ready !== false);
            document.getElementById('chatSend').disabled = !select.value || this.busy;
        } catch (error) {
            if (error.name === 'AbortError') return;
            select.replaceChildren(new Option('Profiles unavailable', ''));
            this.clearChat();
            this.setStatus(error.message, false);
            document.getElementById('chatSend').disabled = true;
        }
    },

    setStatus(message, ready) {
        const status = document.getElementById('chatStatus');
        status.textContent = message;
        status.classList.toggle('is-ready', ready);
    },

    setBusy(busy) {
        this.busy = busy;
        document.getElementById('chatSend').disabled = busy || !document.getElementById('chatProfile').value;
        document.getElementById('chatInput').disabled = busy;
        document.querySelectorAll('#viewInsights .chat-chip, #viewInsights .chat-examples button').forEach(button => button.disabled = busy);
        document.getElementById('chatContainer').setAttribute('aria-busy', String(busy));
    },

    clearChat() {
        const previousConversation = this.conversation;
        this.generation++;
        this.controller?.abort();
        this.controller = null;
        this.conversation = crypto.randomUUID();
        document.getElementById('chatContainer').replaceChildren();
        this.message('Choose a person and a period, then ask about their recorded activities. I can explain the latest record, summarize activity changes, or count recorded entries.', 'bot');
        document.getElementById('chatInput').value = '';
        this.setBusy(false);
        // Reset stored context too; a unique conversation ID prevents stale replies from reusing it.
        tempoApi.request('/api/chat/reset', { conversation_id: previousConversation }).catch(() => {});
    },

    resetSession() {
        this.contextController?.abort();
        this.clearChat();
        document.getElementById('chatProfile').replaceChildren(new Option('Log in to select a person', ''));
        this.setStatus('Log in to use the assistant', false);
        this.setBusy(false);
    },

    message(text, role) {
        const element = document.createElement('div');
        element.className = `chat-msg ${role === 'user' ? 'user-msg' : 'bot-msg'} pop-in`;
        element.textContent = text;
        document.getElementById('chatContainer').append(element);
        this.scroll();
        return element;
    },

    scroll() {
        const container = document.getElementById('chatContainer');
        container.scrollTop = container.scrollHeight;
    },

    showEvidence(element, data) {
        const coverage = data.coverage;
        const note = document.createElement('p');
        note.className = 'chat-coverage';
        const format = value => new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
        note.textContent = `${data.profile.name} · ${coverage.records_used} records checked · ${format(coverage.start)} to ${format(coverage.end_exclusive)}`;
        if (coverage.truncated) note.textContent += ' · Partial results';
        if (coverage.excluded_records) note.textContent += ` · ${coverage.excluded_records} unusable records excluded`;
        element.append(note);
        const details = document.createElement('details');
        details.className = 'chat-sources';
        const summary = document.createElement('summary');
        summary.textContent = 'View supporting records';
        details.append(summary);
        const list = document.createElement('ul');
        data.sources.forEach(source => {
            const item = document.createElement('li');
            item.textContent = source.type === 'event'
                ? `[${source.source_id}] ${source.activity} — ${format(source.time)} (record ${source.record_id})`
                : `[S1] Activity-change counts: ${Object.entries(source.activity_record_counts).map(([key, count]) => `${key}: ${count}`).join('; ') || 'No usable records'}. These counts do not establish duration or continuous sensor coverage.`;
            list.append(item);
        });
        details.append(list);
        element.append(details);
    },

    askSuggested(question) {
        if (this.busy) return;
        document.getElementById('chatInput').value = question;
        this.sendQuery();
    },

    async sendQuery() {
        if (this.busy) return;
        const input = document.getElementById('chatInput');
        const question = input.value.trim();
        if (!question) return;
        let scope;
        try { scope = this.scope(); }
        catch (error) { this.message(error.message, 'bot'); return; }
        const generation = this.generation;
        const controller = new AbortController();
        this.controller = controller;
        this.message(question, 'user');
        input.value = '';
        const reply = this.message('Reading the activity records and preparing an answer… On this computer an answer usually takes 30–90 seconds.', 'bot');
        this.setBusy(true);
        // Longer than the server's own model timeout, so its specific message is shown rather than this generic one.
        const timer = setTimeout(() => controller.abort(), 200000);
        try {
            const data = await tempoApi.request('/api/chat', { ...scope, question }, controller.signal);
            if (generation !== this.generation) return;
            reply.textContent = data.answer;
            this.showEvidence(reply, data);
        } catch (error) {
            if (generation !== this.generation) return;
            reply.textContent = error.name === 'AbortError'
                ? 'The local model took too long to respond. Please retry.' : error.message;
            reply.classList.add('chat-error');
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'chip-action';
            retry.textContent = 'Retry question';
            retry.addEventListener('click', () => this.askSuggested(question));
            reply.append(document.createElement('br'), retry);
        } finally {
            clearTimeout(timer);
            if (generation === this.generation) {
                this.setBusy(false);
                this.controller = null;
                input.focus();
                this.scroll();
            }
        }
    }
};
