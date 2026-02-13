export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    if (req.method === 'OPTIONS') return res.status(200).end();
    try {
        const resp = await fetch('https://api.merkl.xyz/v4/opportunities?search=9mm&test=true', {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
        });
        if (!resp.ok) throw new Error(`Merkl ${resp.status}`);
        const data = await resp.json();
        const items = Array.isArray(data) ? data : (data.items || []);
        const pools = items.filter(p => p.apr > 0 && p.tvl > 0).map(p => {
            let name = (p.name || '').replace(/^Provide liquidity to\s+/i, '').replace(/\s*\d+(\.\d+)?%\s*$/, '').replace(/NINEMM\s*/i, '').trim();
            const parts = name.split(/[-\/]/).map(s => s.trim()).filter(Boolean);
            const displayName = parts.length >= 2 ? `${parts[0]} / ${parts[1]}` : name;
            return { name: displayName, symbol: displayName, pair: displayName,
                apr: parseFloat(p.apr || 0), tvl: parseFloat(p.tvl || 0),
                chainName: 'Base', url: 'https://app.merkl.xyz/?search=ninemm&sort=apr-desc&test=true' };
        }).sort((a, b) => b.apr - a.apr).slice(0, 3);
        return res.status(200).json({ pools });
    } catch (e) { return res.status(200).json({ pools: [] }); }
}
