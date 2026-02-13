export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        let endpoint, address;
        if (req.method === 'POST') {
            const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
            endpoint = body.endpoint; address = body.address;
        } else {
            endpoint = req.query?.endpoint; address = req.query?.address;
        }

        if (!endpoint || !address) return res.status(400).json({ error: 'Missing endpoint or address' });
        const allowed = ['balance', 'nft-balance', 'token-balance'];
        if (!allowed.includes(endpoint)) return res.status(400).json({ error: 'Invalid endpoint' });

        const url = `https://api.spacescan.io/address/${endpoint}/${address}`;
        const timeout = endpoint === 'token-balance' ? 30000 : 12000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        const response = await fetch(url, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`Spacescan returned ${response.status}`);
        const data = await response.json();
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
