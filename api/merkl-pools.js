export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const resp = await fetch('https://api.merkl.xyz/v4/opportunities?search=9mm&test=true', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    if (!resp.ok) throw new Error(`Merkl API ${resp.status}`);
    const data = await resp.json();
    const items = Array.isArray(data) ? data : (data.items || data.opportunities || []);
    const pools = items.filter(p => p.apr > 0 && p.tvl > 0).map(p => {
      let name = p.name || p.identifier || 'Pool';
      name = name.replace(/^Provide liquidity to\s+/i, '').replace(/\s*\d+(\.\d+)?%\s*$/, '').replace(/NINEMM\s*/i, '').trim();
      const parts = name.split(/[-\/]/).map(s => s.trim()).filter(Boolean);
      const displayName = parts.length >= 2 ? `${parts[0]} / ${parts[1]}` : name;
      return { name: displayName, symbol: displayName, apr: parseFloat(p.apr || 0), tvl: parseFloat(p.tvl || 0),
        url: 'https://app.merkl.xyz/?search=ninemm&sort=apr-desc&test=true' };
    }).sort((a, b) => b.apr - a.apr).slice(0, 3);
    return res.status(200).json(pools);
  } catch (err) {
    return res.status(200).json([
      { name: 'WETH / SPROUT', symbol: 'WETH / SPROUT', apr: 125.1, tvl: 2076, url: 'https://app.merkl.xyz/?search=ninemm&sort=apr-desc&test=true' },
      { name: 'CASTER / SPROUT', symbol: 'CASTER / SPROUT', apr: 73.3, tvl: 3284, url: 'https://app.merkl.xyz/?search=ninemm&sort=apr-desc&test=true' },
      { name: 'WETH / CBBTC', symbol: 'WETH / CBBTC', apr: 64.2, tvl: 17167, url: 'https://app.merkl.xyz/?search=ninemm&sort=apr-desc&test=true' }
    ]);
  }
}
