# TEMPO Care AI assistant server

This branch is only the assistant's server, for the free cloud host Render. The app itself is on the
`gh-pages` branch (https://rupam-dutta.github.io/TEMPO-Care/); the research code is on `main`.

It is the same `server.py` / `care_chat.py` as on the laptop. When `GROQ_API_KEY` is set it uses Groq's
hosted model (`openai/gpt-oss-20b`) instead of the laptop's Ollama, so the assistant works while the laptop is off.
The same answer checks, supporting records and per-person access rules apply.

## Deploy (once, about 5 minutes)

1. Create a free Groq API key: https://console.groq.com/keys
2. Open https://render.com/deploy?repo=https://github.com/RUPAM-DUTTA/TEMPO-Care/tree/ai-server
   (sign in to Render with GitHub), fill in `GROQ_API_KEY`, `TEMPO_ADMIN_USERNAME` and `TEMPO_ADMIN_PASSWORD`, click **Deploy Blueprint**.
3. When it shows **Live**, open https://tempo-care-ai-rupam.onrender.com/api/health - it should say `{"ok": true, "provider": "hosted"}`.

If Render gives the service a different address, put it in `config.js` on the `gh-pages` branch (`apiBases`).

Free plan: the server sleeps after 15 minutes without use and takes up to a minute to wake. The app logs you in
straight away from the database meanwhile, and the assistant tab connects as soon as the server is awake.
Questions and the activity records needed to answer them are sent to Groq for processing.
