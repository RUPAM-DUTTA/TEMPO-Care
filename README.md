# TEMPO Care activity assistant

The existing AI Assistant tab now uses a real local Ollama model. Family members and admins can select a Care Focus person and a period, ask questions in ordinary language, ask follow-up questions, and inspect the records behind an answer.

## Start on this computer

From PowerShell:

```powershell
cd 'D:\mmWave_Technology__1_\Tempo care'
.\start.cmd
```

Open **http://127.0.0.1:8000**, log in, and select **AI Assistant**. You can also double-click `start.cmd`. Use this local server rather than opening `index.html` directly or using VS Code Live Server. The launcher locates the installed Thonny/Python runtime and starts portable Ollama when needed. No Python packages are required by the application.

The `.cmd` launcher works without changing this computer's PowerShell execution policy. To launch directly with the Python already installed here:

```powershell
& "$env:LOCALAPPDATA\Programs\Thonny\python.exe" launch.py
```

The launcher starts Ollama if needed. Its portable executable is `.runtime\ollama\ollama.exe`, with model files in `.runtime\models`. The configured default model is **qwen2.5:7b**. The earlier `llama3.2:3b` trial model remains downloaded but is not used by the app. Ollama and the models were installed inside this project; no global Python installation was changed.

The previous admin login on this computer was migrated into `.tempo-admin.json` as a salted PBKDF2 password hash. The browser no longer contains the admin password. Change the existing password with:

```powershell
& "$env:LOCALAPPDATA\Programs\Thonny\python.exe" server.py --set-admin-password
```

Family accounts use the existing `tempo_users` table. Their credentials are checked on the server. A new copy without `.tempo-admin.json` prompts for an admin account on first launch.

## Required database setup (why the timeline was empty)

**Live inspection found that `tempo_activity_log` does not have a `profile_id` column.** Every sensor reading the app tried to save was rejected by the database with error `42703`, and the old timeline code only wrote that error to the browser console. Nothing was ever stored, so the timeline stayed empty. The activity query with the app's public database key returns no rows. The chat refuses to guess which person an unassigned record belongs to.

Open your existing Supabase project, go to **SQL Editor**, and run the contents of:

**[supabase/001_link_activity_profiles.sql](supabase/001_link_activity_profiles.sql)**

An administrator can also copy the same SQL from inside the app: open **Timeline**, and when the database is not ready a **Copy setup SQL** button appears. Paste it into the Supabase SQL Editor, run it once, then click **Retry saving** in the app.

The migration adds the ownership column using the same type as `tempo_profiles.id`, adds a foreign key and a query index, and requires future activity writes to identify a person. Existing unassigned rows are preserved and excluded from chat retrieval. Do not backfill ownership unless you know which person produced each record. The migration was prepared locally and has **not** been applied to the hosted database; the local server only hands the SQL text to a logged-in administrator and never executes it.

After applying it, connect the sensor, choose the person on the Home tab, and readings will be saved and shown on the Timeline. Choose a date range containing those records in the assistant. Until then, the timeline and the assistant both display an activity-setup message rather than an invented answer.

## Connecting the device (Home tab)

Three tabs, same as Tempo Care 2. All feed the same Radar Motion, Audio Environment and Live Sensor Data cards, and the timeline recording.

- **Remote**: works when the device and this computer/phone are on different networks. Both connect to the MQTT broker (default `wss://broker.emqx.io:8084/mqtt`, Settings → Device Link) and the payloads are AES-256-GCM encrypted with the device's pairing code. Requires the ESP32-P4 firmware with the live link (`ran_for`). After login the app reconnects by itself to the paired device.
- **Bluetooth**: the ESP32-P4 (`ESP32-TempoCare-XXXX`, also used for pairing and the **Device Wi-Fi** card) or the ESP32-S3 sketch (notify-only packets, which the app reads as before).
- **Local Wi-Fi**: `ws://<device-ip>:81` on the same network. Browsers block this from an `https://` page; use Remote there.

The device card shows which links are up, the round-trip time and the age of the last update. `device-link.js` holds the connection code; `vendor/mqtt.min.js` is MQTT.js 5.10.1 (MIT). The ESP32-P4 firmware does not send `rd_d` / `rd_s` yet, so the Live Sensor Data card fills only with the ESP32-S3 sketch.

## Live sensor data on the Home tab

To the right of the connection and activity cards (below them on narrow screens), the **Live Sensor Data** card shows what the ESP32 is sending, packet by packet (2 per second):

- Two tiles: **distance** (m from the sensor) and **velocity** (cm/s along the beam, signed), plus the packet rate, the age of the last packet and the last packet's raw JSON.
- Two charts of the last 60 seconds, one measure each (never a shared axis): distance and velocity. 2 px lines, an end-dot on the latest sample, a 10 % wash under the line, hairline grid, hover tooltips with the exact time and value. Gaps appear where the sensor was disconnected.
- **Pause** freezes the charts while packets keep buffering; **Clear** empties the buffer; **Recent samples (table)** lists the last 12 packets as numbers (time, distance, velocity).

The card keeps about 200 s of samples, redraws at most four times a second, and skips drawing while the Home tab is hidden. Colours are the first three slots of a colour-blind-validated dark palette (blue, orange, aqua). Nothing on this card is written to the database; it is a live view only.

**Firmware.** The card uses only `rd_d` and `rd_s`, which every version of the sketch sends. The original sketch sent only `activity`, `confidence`, `rd_d` (mm) and `rd_s` (cm/s). [Rd-03dsketch_jun29a2.0.ino](../mmWave%20Sensing/Rd-03dsketch_jun29a2.0.ino) now also sends `rd_a` (angle, °), `x`, `y` (mm) and `present` (0/1) in the same Bluetooth packet. A ready-to-open copy with its `rd03d_model.h` header is in `../mmWave Sensing/Rd03d_TempoCare/` (open `Rd03d_TempoCare.ino` in the Arduino IDE with the ESP32 board package installed, board "ESP32S3 Dev Module", plug the board in by USB, Upload) — these extra fields are received and kept in the sample buffer but are not displayed anywhere at present; flashing is optional. Older app versions ignore the extra fields, and the Wi-Fi/WebSocket path uses the same JSON.

## Activity timeline

The Home tab has a **This sensor is watching** selector. Readings are recorded only after a person is chosen; with a single linked person it is selected automatically, and with several people the app asks rather than guessing. Changing the selection does not move earlier records.

Each reading from the ESP32 (Bluetooth or Wi-Fi) is compared with the previous one for that person, so only activity *changes* are recorded, not every frame. A new change appears on the Timeline immediately, marked **Waiting to save** until the database confirms it, then **Saved**. If the database rejects or cannot reach a write, the reading stays queued in this browser tab (up to 1,000 events, retained across a reload of the same tab), the reason is shown in plain language, and saving retries every 10 seconds or when **Retry saving** is clicked. The queue is kept per account in this browser tab, so it survives a logout and is checked against that account's linked people on the next login; closing the tab discards it.

The Timeline shows the 35 most recent recorded changes for the selected person, newest first, in the computer's time zone. Saved history refreshes every 5 seconds while the tab is open and on **Refresh**. Family accounts can only read records of people they are linked to; each request is filtered by that person's ID.

## The language model

| | |
| --- | --- |
| Model | **Qwen2.5-7B-Instruct** (Alibaba Cloud Qwen team, September 2024), Ollama tag `qwen2.5:7b` |
| Parameters | **7,615,616,512** (7.6 B), decoder-only transformer, `qwen2` architecture |
| Layers / attention | 28 blocks; 28 query heads, 4 key-value heads (grouped-query attention); hidden size 3,584; feed-forward size 18,944; RMSNorm (ε = 1e-6); RoPE base 1,000,000 |
| Quantisation | Q4_K_M (4-bit, GGUF, llama.cpp `file_type` 15); 4.68 GB on disk, about 5.5 GB in memory with the 8,192-token context |
| Context | 32,768 tokens supported; the app uses 8,192 (`num_ctx`) and at most 400 output tokens |
| Decoding | temperature 0 (deterministic), JSON-schema constrained output (`format`), source IDs restricted to the evidence |
| Runtime | Ollama 0.34.0 (portable, `.runtime\ollama`), llama.cpp backend, **CPU only** on this computer (`OLLAMA_NUM_GPU=0`), model kept resident 30 minutes after a question |
| Licence | Apache 2.0 |
| Model card | <https://ollama.com/library/qwen2.5:7b> · <https://huggingface.co/Qwen/Qwen2.5-7B-Instruct> |

These values were read from the model file itself (`POST /api/show`). Qwen2.5 is a multilingual instruction-tuned model (29+ languages including Hindi and Bengali); on this hardware its English answers are markedly more reliable than its Hindi/Bengali ones. The earlier trial model, `llama3.2:3b` (3.2 B parameters), failed factual checks and is not used.

## Questions the assistant answers

The complete, categorised list is in **[chat_queries.txt](chat_queries.txt)** — 127 questions (including 10 in Hindi/Hinglish and 10 in Bengali/Benglish) covering every one of the eight activities (Standing, Sitting, Sit to stand, Stand to sit, Walking, Entry, Exit, No person), time-of-day windows, specific days, summaries, sequences, coverage, questions that must be declined, Hindi/Hinglish, Bengali/Benglish, and follow-ups, each with the behaviour to expect. The same file serves as an evaluation set and as the seed of a training set. The assistant page shows ten suggestion chips and a **More example questions** panel taken from it.

Examples:

- What was their latest recorded activity?
- How many times did they enter and exit the bathroom?
- When did they last leave the bathroom?
- Did they go to the bathroom at night? · What happened after 9 PM? · How many entries between 6 pm and 7 pm?
- How many sit-to-stand transitions were recorded? · When did they walk? · When was the bathroom last empty?
- How many entries were recorded yesterday? · Which day this week had the most activity? (choose **Last 7 days**)
- Aaj kitni baar bathroom gaye? · Raat ko kitni baar bathroom gaye? · Sokale ki hoyechhilo?
- And before that? (follow-up)

**Time windows and days.** When a question names a part of the day (night = 10 PM–6 AM, morning = 6 AM–12 PM, afternoon = 12–5 PM, evening = 5–10 PM, also *raat/subah/dopahar/shaam* and *raat/sokal/dupur/bikel*), a clock range ("between 6 pm and 7 pm", "after 9 PM", "before noon", "around 6:30 pm"), or a day ("yesterday", "on 13 September", "13/09"), Python filters **all** records for that window and gives the model exact counts and the events inside it; the answer states the window it used. Each request covers one person and at most 31 calendar days. "Today" and "yesterday" (also *aaj/kal/আজ/কাল*) must lie inside the selected period; otherwise the app asks you to change it. Changing person, date range, account, or starting a new chat clears conversational context.

## Suggestions (generative answers)

Besides questions about the records, the assistant now answers open questions like a general AI assistant: **"Suggest ways to make their night-time bathroom trips safer"**, "What exercises can help with their knee?", "Give me a simple daily routine and diet tips", "What does sit-to-stand difficulty mean?", or the same in Hinglish/Benglish (*sujhav do*, *ki korbo*, *poramorsho*). The page has three 💡 suggestion chips for these.

- A question that asks for advice, tips, ideas, explanations, or "what should I / how can I…" is routed to **suggestion mode**. Questions that ask for records ("how many…", "when did…", "list…") keep the strict, source-checked answers described below.
- In suggestion mode the model writes a free, practical answer (3–7 short points) using general care knowledge plus the person's **health profile** (conditions, medicines, mobility, night bathroom visits) and a summary of their recorded activity for the selected period. These answers are marked *"Suggestions … not a diagnosis; check with their doctor before medical changes"*.
- Safety rules stay on: no diagnosis, no medicine or dose changes, no invented events; anything that sounds urgent (a fall, chest pain, breathlessness, confusion) gets "check on them now / call 112" first.
- On the public site the answer is written by the cloud server (Groq); on this computer by Ollama. In suggestion mode the person's first name, age and health profile are sent to the model so the advice fits them; phone numbers and passwords are never sent.
- Note for the evaluation set: *"What should I do about their bathroom visits?"* in chat_queries.txt now receives suggestions instead of the earlier "no medical advice" refusal.

## How answers are produced

1. The backend verifies the login session and retrieves the permitted profiles. Family membership is checked against the database on every question. Admin access is established by server authentication, never by a role supplied with a question.
2. It retrieves activity rows filtered by `profile_id` and timestamps **before** applying limits. Pagination handles the database's page-size limit. At most the newest 5,000 rows are used; an extra row detects truncation, which is disclosed in the answer.
3. Python computes counts and identifies the latest record. Only eight recognized activity labels are accepted. Invalid timestamps and unknown labels are excluded and counted. Counts are counts of records, not completed visits or sampled frames. (PostgreSQL returns fractional seconds with trailing zeros trimmed, e.g. `10:36:23.29782`; the parser normalises any length, because Python 3.10 alone would reject about one record in ten.)
4. Ollama receives the question, bounded conversation history and a compact plain-text evidence block: the newest 24 events plus the first and latest record of every activity, every day of a multi-day period with its counts (or "no records"), and a **key facts** section (exact per-activity counts computed from all records, the latest record, and an explicit "durations unknown" line) placed last, next to the question, where a small model attends to it most. A time window or day named in the question adds a section computed from all records in that window. A sequence question ("what happened right after the last entry?", "what came before the first exit today?") adds the records immediately before and after that occurrence, with a pre-verified sentence the model may rephrase but not alter. A question about falls, safety, sleep or health adds a reminder that the records cannot determine it and that absence of a record is not evidence. Names, phone numbers, passwords, health profiles and raw radar streams are not included in the model context. The model can only generate an answer; it cannot execute SQL, edit data or send alerts.
5. The answer is checked before it is shown. Every clock time written in the answer must be the time of a record the answer cites (or a boundary of the asked window); any Entry/Exit/Walking count stated in a sentence must equal the computed count (English, Hinglish and Benglish count words are recognised); and an answer that cites only event records may name only those records' activities. On a mismatch the model is asked once more with the discrepancy spelled out (a cheap follow-up thanks to the cached prompt), and if it still disagrees the answer carries a note asking the reader to check the supporting records. Source ids are never shown inside the sentence. If the model states a duration ("about 5 minutes", "most of the time"), that sentence is removed and replaced by a statement that durations cannot be determined from change records. Fabricated source IDs and malformed/incomplete model responses are rejected. Model text and user questions are rendered as text, not executable HTML.
6. "Today"/"yesterday" in a question must match the selected period; the check also recognises Hindi/Hinglish and Bengali/Benglish words (aaj/आज/আজ, kal/कल/গতকাল/কাল). The model answers in the language of the question, but the 7B model's Hindi and Bengali are noticeably weaker than its English; for the paper, evaluate non-English answers separately.

### Answer time on this computer

Inference is CPU-only, and reading the prompt (about 32 tokens per second) dominates. The evidence text is byte-identical between questions about the same records, so Ollama reuses its cached prompt: the **first question about a person and period takes about 45–70 seconds**, and **follow-up questions take about 10–30 seconds**. The server pre-loads the model at startup and keeps it resident (`OLLAMA_KEEP_ALIVE`, default 30 minutes), so the ~25-second model load is paid once. When new readings arrive the evidence changes and the next question pays the full cost again. The earlier verbose JSON evidence (about 3,800 prompt tokens for one day of real readings) exceeded the 90-second limit and produced "The local model could not finish the answer"; the compact text is about half that size and the limit is now 180 seconds (`OLLAMA_TIMEOUT`).

The chat reads the same `tempo_activity_log` rows the Timeline writes, so a change shown as **Saved** on the Timeline can be asked about in the assistant once the selected period includes it.

The model is instructed not to invent durations, diagnoses, falls, sleep, or present safety from sparse change logs. Timestamp gaps do not establish inactivity. No-data responses are explicit and do not call the model. Prompts and source checks reduce errors but do not prove that every generated statement is correct; users can inspect the records.

Displayed event times use the computer's time zone. Model timestamps and daily aggregates use the fixed UTC offset at the beginning of the selected period. For daylight-saving transitions, use single-day selections if precise day boundaries matter. The current India time zone has no such transition.

## Checking activities in the Timeline

Each saved activity in the Timeline has **✓ Correct** and **✗ Wrong**. *Wrong* asks what it actually was (one of the activities, or "Nothing happened (false detection)"). The check is saved in `tempo_activity_log`: `verification` (`correct`, `corrected`, `rejected`), `original_activity` (the sensor's label when corrected), `verified_by`, `verified_at`. Corrected records hold the right activity in `activity`; rejected ones stay in the table but the AI assistant and the Report for Doctor leave them out. **Undo** restores the original. The columns come from `supabase/002_activity_validation.sql` (Timeline → Copy setup SQL as admin; safe to run again). The checked records are also labelled training data for improving the radar model.

## Public site (any device, always on)

**https://rupam-dutta.github.io/TEMPO-Care/** works on any phone or computer, with no server needed for login, Home (devices), Timeline, Profiles, Alerts, Settings and the doctor report. The repository has three branches: `main` (research code), `gh-pages` (this web app) and `ai-server` (the assistant's server).

- **Login** goes through the assistant server when it is reachable; otherwise the published site checks the family login directly against the database (as the original app did). Admin login always needs the server.
- **AI assistant** runs on an always-on free cloud server (Render) that uses Groq's hosted model `openai/gpt-oss-20b` instead of Ollama, with the same answer checks, supporting records and per-person access. `config.js` on `gh-pages` lists `https://tempo-care-ai-rupam.onrender.com` first and this laptop (`http://127.0.0.1:8000`) second. Deploy it once: create a key at https://console.groq.com/keys, open https://render.com/deploy?repo=https://github.com/RUPAM-DUTTA/TEMPO-Care/tree/ai-server, fill in `GROQ_API_KEY`, `TEMPO_ADMIN_USERNAME`, `TEMPO_ADMIN_PASSWORD`, and deploy. The free server sleeps after 15 minutes unused and wakes in about a minute. Questions and the records needed to answer them are sent to Groq, unlike the laptop setup.
- `server.py` accepts the published site (`TEMPO_ORIGINS`, default `https://rupam-dutta.github.io`) with bearer tokens, answers `/api/health`, and uses the hosted model whenever `GROQ_API_KEY` is set; without it (this laptop) it keeps using local Ollama.
- **Local Wi-Fi** is hidden on the https site because browsers block `ws://` from secure pages; **Remote** works on the same network too. **Bluetooth** needs Chrome or Edge (Windows, macOS, Android, ChromeOS); iPhone browsers have no Web Bluetooth.

## Making it available to other people

By default the server listens only on this computer (`127.0.0.1:8000`) and refuses any other `Host` header. To let others use it, put an HTTPS address in front of it and tell the server that address. Every option keeps the server bound to loopback; the tunnel or proxy in front terminates HTTPS and forwards `X-Forwarded-Host` / `X-Forwarded-Proto` / `X-Forwarded-For`, which the server uses for its host check, `Secure` cookies and per-client login throttling.

```powershell
.\start.cmd --public-host care.example.com            # or set TEMPO_HOSTS=care.example.com
.\start.cmd --public-host "*.trycloudflare.com"       # a suffix entry for tunnels that assign a random hostname
```

**Option A — Tailscale Funnel (this computer, free, no server).** Tailscale is already installed here. A one-time switch by the tailnet owner is needed: run `tailscale funnel 8000` once and open the link it prints (or enable Funnel under *Access controls* in the Tailscale admin console). Then:

```powershell
.\start.cmd --public-host desktop-mdfk3rt.tailef791e.ts.net
& "C:\Program Files\Tailscale\tailscale.exe" funnel --bg 8000
& "C:\Program Files\Tailscale\tailscale.exe" cert desktop-mdfk3rt.tailef791e.ts.net   # first time only: issues the certificate; until it exists the browser shows ERR_TUNNEL_CONNECTION_FAILED
```

The app is then at **https://desktop-mdfk3rt.tailef791e.ts.net** for anyone on the internet, with a valid certificate, for as long as this computer is on and logged in to Tailscale (`tailscale funnel status` shows it; `tailscale funnel --https=443 off` stops it). The Funnel setting survives reboots, and `--public-host` is remembered in `.tempo-hosts`, so after a restart a plain `.\start.cmd` is enough. Because the language model runs here, every visitor's questions are answered by this laptop, one at a time. This was set up and verified on 15 Sep 2026.

**Option B — Cloudflare quick tunnel.** Download `cloudflared`, run `cloudflared tunnel --url http://127.0.0.1:8000`, and start the app with `--public-host "*.trycloudflare.com"`. The address changes on every run, so it suits demonstrations rather than families.

**Option C — your own server.** On a Linux VM with 8 GB RAM or more: install Python 3.10+ and Ollama, `ollama pull qwen2.5:7b`, copy this folder, run `python launch.py --public-host care.example.com`, and put Caddy in front (`care.example.com { reverse_proxy 127.0.0.1:8000 }` gives automatic HTTPS). CPU-only answers take about as long as here; a GPU instance makes them a few seconds. Web Bluetooth needs HTTPS, which all three options provide, so the sensor can be connected from any computer that opens the site.

**Before real families use it, do these** (none of them is done by this repository):

1. Turn on row-level security in Supabase for every `tempo_*` table and add policies; today the publishable key in `script.js` allows browser-side reads and writes of every table, so anyone with the page source can read all records.
2. Move family accounts to Supabase Auth: `tempo_users` stores passwords in plain text, and the login form sends them to this server, which compares them against that table.
3. Keep `.tempo-admin.json` private, use a long admin password, and back up the database.
4. Expect one answer at a time: a second visitor asking while an answer is being produced sees "The local assistant is answering another question. Please retry in a moment."
5. Remember that a public address makes this laptop a server: keep it plugged in, awake, and updated, or use Option C.

## Privacy and deployment boundary

Ollama processing is local. The launcher sets `OLLAMA_NO_CLOUD=1`. Python bypasses system proxies for loopback model requests and refuses redirects. No cloud LLM API key is needed. Questions and answers are held only in session memory (up to three exchanges) and are not written to a chat database. Sessions expire after eight hours or server restart; logout revokes the session. The static file server only exposes the frontend files (`index.html`, `style.css`, `script.js`, `chat.js`, `timeline.js`, `sensor.js`, `device-link.js`, `vendor/mqtt.min.js`), never configuration, Python files or model files.

**The existing database is still hosted on Supabase**, and the existing UI loads libraries, icons and fonts from CDNs. The complete app therefore still needs internet access; local inference does not turn the app into a fully offline system.

This server intentionally binds to `127.0.0.1` for local development. The original app uses shared family passwords stored in `tempo_users` and browser-side CRUD access through a publishable key. The new chat authorization checks do not fix the entire legacy database access model. Before making the app available to families over the internet, migrate accounts to Supabase Auth, enforce appropriate database grants and row-level security for every table, and host behind HTTPS with a production application server. No hosted database policies or existing care data were changed by this implementation.

## Configuration

Optional environment variables, set before starting the server:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Loopback HTTP only |
| `OLLAMA_MODEL` | `qwen2.5:7b` | Downloaded local model; cloud-tagged models rejected |
| `OLLAMA_NUM_GPU` | `0` | CPU inference; the Intel Vulkan path on this computer produced corrupt responses during testing |
| `TEMPO_HOSTS` | *(none)* | Comma-separated public hostnames the app may be reached through (`*.example.com` allows a suffix); `--public-host` sets it too |
| `TEMPO_HTTPS` | *(unset)* | Set to `1` to mark session cookies `Secure` when the proxy does not send `X-Forwarded-Proto: https` |
| `OLLAMA_KEEP_ALIVE` | `30m` | How long the model stays loaded after a question (Ollama duration syntax; `-1` keeps it loaded) |
| `OLLAMA_TIMEOUT` | `180` | Seconds allowed for one answer before the app reports a model failure |
| `SUPABASE_URL` | Existing URL in `script.js` | Database endpoint |
| `SUPABASE_KEY` | Existing publishable key in `script.js` | Server database access; never add a service key to frontend files |

Use `start.cmd --port 8001` to change the local web port. Ollama stays on port 11434. CPU inference is slower than working GPU acceleration; requests time out rather than waiting indefinitely. GPU offload is configurable but should be retested before enabling it on this machine.

## Validation

```powershell
& "$env:LOCALAPPDATA\Programs\Thonny\python.exe" -m unittest -v test_chat
& "$env:LOCALAPPDATA\Programs\Thonny\python.exe" test_browser.py
```

The optional browser tests use Playwright installed in `.tools\python` and the existing Chrome browser. They use synthetic accounts and an in-memory stand-in for the database, covering login, conversation context, person switching, missing records, model outages/retry, HTML injection, mobile layout, cancellation and logout, plus the timeline: automatic and explicit person selection, one record per activity change, the queued/retry path when the `profile_id` column is missing, the administrator's setup SQL, and per-person history; and the live sensor card: tiles, both charts (against a Chart.js stand-in), table, old-firmware packets, disconnect, pause and clear. They never query or modify real care records. Backend tests cover access control, pagination, date boundaries, proxy bypass, model-response validation, and the administrator-only setup endpoint. Screenshots are written to `.tools\*.png`.

The real-model smoke check in `.tools\check_local_model.py` uses synthetic records. It is a development check, not a clinical evaluation or an accuracy benchmark for the paper. The initial smaller model failed factual examples and was replaced. With the first real day of readings (30 records), the verbose JSON evidence made the 7B model miscount entries (3 instead of 5), misname the latest record and compute a duration; the compact evidence with key facts placed last corrected all of these in the same six questions. Remaining slips seen during testing were copying a neighbouring record's time (06:01:17 instead of 06:01:15) and under-counting in a summary ("walked twice" for three records); both are now caught by the time and count checks and corrected on the retry. Question-typed checks were added afterwards: a count stated for the activity the question names, the time stated for "first/last <activity>", superlatives ("most often", "busiest day") and labelled posture counts ("9 records of sitting") are all compared with the computed facts. A pilot of 23 questions from `chat_queries.txt` over 49 real records (`.tools/pilot-eval.json`; script in the paper's scratch tooling) went from 17/23 correct before those checks to 22/23 with them, the remaining error being disclosed in the answer; because the checks were written in response to the first run, the second figure is not an independent test. Ambiguous statements (whether "sat down" means a Sitting or a Stand-to-sit record) are still not checked, so answers show their supporting records and remain subject to human verification. The paper (`../main.tex`, Section "Caregiver Web Platform and Activity Assistant") describes the platform and this pilot; its figures `fig_webapp_dashboard.png` (a recorded session replayed through the app) and `fig_webapp_chat.png` (a real answer) are generated by `.tools`-style Playwright scripts and can be replaced by real screenshots under the same names.

## Protocol references

The integration follows the official [Ollama chat API](https://docs.ollama.com/api/chat). Portable setup follows [Ollama's Windows documentation](https://docs.ollama.com/windows), and local-only settings follow the [Ollama FAQ](https://docs.ollama.com/faq). Model metadata is available on the [Qwen2.5 7B page](https://ollama.com/library/qwen2.5:7b). Database deployment guidance follows [Supabase's API security documentation](https://supabase.com/docs/guides/api/securing-your-api).
