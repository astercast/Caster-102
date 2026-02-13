// spacescan-proxy.js — Vercel API route
// Proxies Spacescan API calls to avoid CORS issues from browser
// Handles: /cat/info/{assetId}, /address/balance/{addr}, etc.

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { path } = req.query;
    if (!path) return res.status(400).json({ error: 'Missing path parameter' });

    // Reconstruct the Spacescan URL
    const url = `https://api.spacescan.io/${path}`;
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        
        const response = await fetch(url, {
            headers: { 
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            },
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            return res.status(response.status).json({ error: `Spacescan returned ${response.status}` });
        }
        
        const data = await response.json();
        // Cache for 2 minutes
        res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
