// Published copy (GitHub Pages). Login, dashboard, devices, timeline and profiles work with no server;
// the AI assistant uses the first reachable address below.
window.TEMPO_CONFIG = {
    apiBases: [
        'https://tempo-care-ai-rupam.onrender.com',   // always-on cloud server (Render + Groq), branch ai-server
        'http://127.0.0.1:8000'                       // this laptop's server.py (start.cmd), when the cloud one is not set up
    ]
};
