async function fetchCollection(cid) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
        const r = await fetch(`https://api.mintgarden.io/collections/${cid}`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!r.ok) return null;
        const col = await r.json();
        if (!col?.id || !col.name) return null;
        return { id: col.id, name: col.name, thumbnail: col.thumbnail_uri || '',
            floor_xch: parseFloat(col.floor_price || 0), nft_count: col.nft_count || 0 };
    } catch (e) { clearTimeout(timer); return null; }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    let colIds = [];
    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        colIds = (body.colIds || []).slice(0, 60);
    } catch { return res.status(400).json({ ok: false, error: 'bad body' }); }

    if (colIds.length === 0) return res.status(200).json({ ok: true, collections: {} });

    const results = await Promise.all(colIds.map(fetchCollection));
    const mgMap = {};
    for (const col of results) { if (col) mgMap[col.id] = col; }

    return res.status(200).json({ ok: true, collections: mgMap });
}
