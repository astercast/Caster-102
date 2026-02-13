// Cloud save for Caster Valley (Vercel KV REST API)
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const json = (res, status, body) => {
    res.status(status).json(body);
};

async function kvFetch(path, options = {}) {
    if (!KV_URL || !KV_TOKEN) {
        throw new Error('KV not configured');
    }
    const url = KV_URL.replace(/\/$/, '') + path;
    const headers = {
        Authorization: `Bearer ${KV_TOKEN}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
    };
    const resp = await fetch(url, { ...options, headers });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`KV error ${resp.status}: ${text}`);
    }
    return resp.json();
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const deviceId = req.query?.deviceId || req.body?.deviceId;
        if (!deviceId) return json(res, 400, { ok: false, error: 'Missing deviceId' });
        const key = `cv:save:${deviceId}`;

        if (req.method === 'GET') {
            const data = await kvFetch(`/get/${encodeURIComponent(key)}`);
            const saved = data?.result ? JSON.parse(data.result) : null;
            return json(res, 200, { ok: true, save: saved });
        }

        if (req.method === 'POST') {
            const body = req.body || {};
            if (!body.save || typeof body.save !== 'object') {
                return json(res, 400, { ok: false, error: 'Missing save payload' });
            }
            if (!body.save.savedAt) body.save.savedAt = Date.now();
            const payload = JSON.stringify(body.save);
            await kvFetch(`/set/${encodeURIComponent(key)}`, {
                method: 'POST',
                body: JSON.stringify({ value: payload })
            });
            return json(res, 200, { ok: true });
        }

        return json(res, 405, { ok: false, error: 'Method not allowed' });
    } catch (err) {
        return json(res, 500, { ok: false, error: err.message || 'Server error' });
    }
};
