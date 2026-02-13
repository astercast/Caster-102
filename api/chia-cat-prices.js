// chia-cat-prices.js — Vercel API route
// MODE 1: emoji market prices (default) - Spacescan → Dexie fallback
// MODE 2: treasury wallets (?mode=treasury&wallets=...)
//   - xchscan.com for XCH balance (Spacescan blocks Vercel IPs)
//   - Spacescan for NFTs/tokens (best effort, may get 403)

const CAT_IDS = [
    'a09af8b0d12b27772c64f89cf0d1db95186dca5b1871babc5108ff44f36305e6',
    'eb2155a177b6060535dd8e72e98ddb0c77aea21fab53737de1c1ced3cb38e4c4',
    'ae1536f56760e471ad85ead45f00d680ff9cca73b8cc3407be778f1c0c606eac',
    '70010d83542594dd44314efbae75d82b3d9ae7d946921ed981a6cd08f0549e50',
    'ab558b1b841365a24d1ff2264c55982e55664a8b6e45bc107446b7e667bb463b',
    'dd37f678dda586fad9b1daeae1f7c5c137ffa6d947e1ed5c7b4f3c430da80638',
];

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'application/json' };
const sleep = ms => new Promise(res => setTimeout(res, ms));

async function timedFetch(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        const r = await fetch(url, { headers: UA, signal: ctrl.signal });
        clearTimeout(timer);
        return r;
    } catch (e) { clearTimeout(timer); throw e; }
}

// ── TREASURY MODE ────────────────────────────────────────────────────────────

async function fetchTreasuryWallets(wallets) {
    const results = [];
    for (const wallet of wallets) {
        const walletData = { wallet, xchBal: 0, nfts: [], tokens: [] };
        try {
            // XCH Balance via xchscan (works from Vercel)
            try {
                const balResp = await timedFetch(`https://xchscan.com/api/account/balance?address=${wallet}`, 10000);
                if (balResp.ok) {
                    const balData = await balResp.json();
                    walletData.xchBal = parseFloat(balData?.xch || 0);
                }
            } catch (e) { console.warn(`[treasury] xchscan balance failed: ${e.message}`); }
            await sleep(300);

            // NFTs via Spacescan (best effort)
            try {
                const nftResp = await timedFetch(`https://api.spacescan.io/address/nft-balance/${wallet}`, 12000);
                if (nftResp.ok) {
                    const nftData = await nftResp.json();
                    walletData.nfts = (nftData?.balance || []).map(n => ({
                        nft_id: n.nft_id || '', name: n.name || '',
                        collection_id: n.collection_id || '', preview_url: n.preview_url || ''
                    }));
                }
            } catch (_) {}
            await sleep(800);

            // Tokens via Spacescan (best effort)
            try {
                const tokResp = await timedFetch(`https://api.spacescan.io/address/token-balance/${wallet}`, 25000);
                if (tokResp.ok) {
                    const tokData = await tokResp.json();
                    walletData.tokens = (tokData?.data || [])
                        .filter(t => parseFloat(t.balance || 0) > 0)
                        .map(t => ({
                            asset_id: t.asset_id || '', name: t.name || t.symbol || '',
                            symbol: t.symbol || t.name || '', balance: parseFloat(t.balance || 0),
                            price: parseFloat(t.price || 0), total_value: parseFloat(t.total_value || 0)
                        }));
                }
            } catch (_) {}
            await sleep(800);

            console.log(`[treasury] ${wallet.slice(-8)}: ${walletData.xchBal.toFixed(4)} XCH, ${walletData.nfts.length} NFTs, ${walletData.tokens.length} tokens`);
        } catch (err) {
            console.error(`[treasury] Error: ${err.message}`);
        }
        results.push(walletData);
    }
    return results;
}

// ── EMOJI MARKET MODE ────────────────────────────────────────────────────────

async function getSpacescanPrice(assetId) {
    try {
        const r = await timedFetch('https://api.spacescan.io/cat/info/' + assetId, 5000);
        if (!r.ok) return null;
        const d = await r.json();
        const price = parseFloat(d?.data?.amount_price || 0);
        if (price <= 0) return null;
        return { price, change: parseFloat(d?.data?.pricepercentage || 0), mcap: parseFloat(d?.data?.circulating_supply || 0) * price, source: 'spacescan' };
    } catch (_) { return null; }
}

async function getDexieBestAsk(assetId, xchUsd) {
    try {
        const r = await timedFetch('https://dexie.space/v1/offers?offered=' + assetId + '&requested=xch&page=1&page_size=5&sort=price&order=asc', 7000);
        if (!r.ok) return null;
        const d = await r.json();
        const offers = (d.offers || []).filter(o => o.price > 0);
        if (!offers.length) return null;
        return { price: Math.min(...offers.map(o => o.price)) * xchUsd, change: 0, mcap: 0, source: 'dexie' };
    } catch (_) { return null; }
}

// ── HANDLER ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // Cache for 60s, serve stale for 5min while revalidating
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const t0 = Date.now();
    const params = req.query || {};

    // TREASURY MODE
    if (params.mode === 'treasury' && params.wallets) {
        const wallets = params.wallets.split(',').map(w => w.trim()).filter(Boolean);
        try {
            const walletData = await fetchTreasuryWallets(wallets);
            return res.status(200).json({ ok: true, wallets: walletData, elapsed_ms: Date.now() - t0 });
        } catch (err) {
            return res.status(500).json({ ok: false, error: err.message });
        }
    }

    // EMOJI MARKET MODE
    try {
        const xchRespP = timedFetch('https://api.coingecko.com/api/v3/simple/price?ids=chia&vs_currencies=usd', 6000)
            .then(r => r.ok ? r.json() : {}).catch(() => ({}));

        // Also fetch Dexie tickers in parallel (for fallback)
        const dexieTickersP = timedFetch('https://dexie.space/v2/prices/tickers', 8000)
            .then(r => r.ok ? r.json() : {}).catch(() => ({}));

        // Try Spacescan sequentially
        const catResults = [];
        for (let i = 0; i < CAT_IDS.length; i++) {
            if (i > 0) await sleep(250);
            catResults.push(await getSpacescanPrice(CAT_IDS[i]));
        }

        const xchResp = await xchRespP;
        const xchUsd = xchResp?.chia?.usd || 3;
        const dexieTickers = await dexieTickersP;

        // Build Dexie ticker map
        const tickerMap = {};
        for (const tick of (dexieTickers.tickers || [])) {
            const bid = (tick.base_id || '').toLowerCase();
            const lp = parseFloat(tick.last_price || 0);
            if (bid && lp > 0) tickerMap[bid] = lp * xchUsd;
        }

        const prices = {}, changes = {}, mcaps = {}, sources = {};
        const dexieNeeded = [];

        for (let i = 0; i < CAT_IDS.length; i++) {
            const id = CAT_IDS[i], r = catResults[i];
            if (r) { prices[id] = r.price; changes[id] = r.change; mcaps[id] = r.mcap; sources[id] = r.source; }
            else {
                // Try Dexie ticker first
                const tp = tickerMap[id.toLowerCase()];
                if (tp > 0) { prices[id] = tp; changes[id] = 0; mcaps[id] = 0; sources[id] = 'dexie'; }
                else dexieNeeded.push(id);
            }
        }

        // Individual Dexie offers for anything still missing
        if (dexieNeeded.length > 0) {
            const dr = await Promise.all(dexieNeeded.map(id => getDexieBestAsk(id, xchUsd)));
            for (let i = 0; i < dexieNeeded.length; i++) {
                const id = dexieNeeded[i], r = dr[i];
                prices[id] = r?.price || 0; changes[id] = r?.change || 0;
                mcaps[id] = r?.mcap || 0; sources[id] = r?.source || 'none';
            }
        }

        return res.status(200).json({ prices, changes, mcaps, xch_usd: xchUsd, sources, success: true });
    } catch (e) {
        return res.status(200).json({ prices: {}, changes: {}, mcaps: {}, xch_usd: 3, success: false, error: e.message });
    }
}
