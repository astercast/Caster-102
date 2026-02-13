// treasury-comprehensive.js v6.1
// Chia tokens: ?address=ADDR&chain=chia&type=tokens
//   - XCH balance fast endpoint first
//   - token-balance with up to 3 retries (0s / 7s / 14s backoff), 23s timeout each
//   - Returns after first success — total budget ≤25s
// Chia NFTs: ?address=ADDR&chain=chia&type=nfts
//   - Spacescan nft-balance (fast, never rate-limited)
//   - MintGarden enrichment: parallel batch for collection metadata
// Base: LP valuation using actual pool reserves via RPC

const HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
};

// Multiple RPC endpoints — round-robin on failure to avoid rate limits
const BASE_RPCS = [
    'https://base-rpc.publicnode.com',
    'https://base.llamarpc.com',
    'https://base.meowrpc.com',
];
let _rpcIdx = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeFetch(url, opts = {}, ms = 10000) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try {
        const r = await fetch(url, {
            ...opts,
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...(opts.headers || {}) },
            signal: c.signal
        });
        clearTimeout(t);
        return r;
    } catch (e) { clearTimeout(t); throw e; }
}

async function getEthPrice() {
    try {
        const r = await safeFetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', {}, 5000);
        if (r.ok) { const d = await r.json(); return d.ethereum?.usd || 2500; }
    } catch {}
    return 2500;
}

async function getXchPrice() {
    try {
        const r = await safeFetch('https://api.coingecko.com/api/v3/simple/price?ids=chia&vs_currencies=usd', {}, 5000);
        if (r.ok) { const d = await r.json(); return d.chia?.usd || 4; }
    } catch {}
    return 4;
}

// ─── BASE RPC helpers ─────────────────────────────────────────────────────────

async function ethCall(to, data) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const rpc = BASE_RPCS[(_rpcIdx + attempt) % BASE_RPCS.length];
        try {
            const r = await safeFetch(rpc, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] })
            }, 6000);
            if (!r.ok) { _rpcIdx++; continue; }
            const d = await r.json();
            if (d.error) { _rpcIdx++; continue; }
            return d.result || null;
        } catch { _rpcIdx++; await sleep(150); }
    }
    return null;
}

// Batch RPC: fire N calls in parallel using a single JSON-RPC batch request
async function ethCallBatch(calls) {
    // calls = [{to, data, id}, ...] → returns array of results in same order
    const rpc = BASE_RPCS[_rpcIdx % BASE_RPCS.length];
    const body = calls.map((c, i) => ({
        jsonrpc: '2.0', id: c.id !== undefined ? c.id : i,
        method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest']
    }));
    try {
        const r = await safeFetch(rpc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }, 10000);
        if (!r.ok) return calls.map(() => null);
        const results = await r.json();
        const map = {};
        for (const res of (Array.isArray(results) ? results : [])) map[res.id] = res.result || null;
        return calls.map((c, i) => map[c.id !== undefined ? c.id : i] || null);
    } catch { return calls.map(() => null); }
}

function hexAddr(h) { return (!h || h === '0x' || h.length < 42) ? null : '0x' + h.slice(-40); }
function hexInt(h)  { try { return (!h || h === '0x') ? 0 : parseInt(h, 16); } catch { return 0; } }
function hexBig(h)  { try { return (!h || h === '0x') ? 0n : BigInt(h); } catch { return 0n; } }
function decodeString(hex) {
    if (!hex || hex === '0x') return null;
    try {
        const raw = Buffer.from(hex.slice(2), 'hex');
        const len = parseInt(raw.slice(32, 64).toString('hex'), 16);
        return raw.slice(64, 64 + len).toString('utf8').replace(/\x00/g, '').trim();
    } catch { return null; }
}

async function getDexPrices(tokenAddresses) {
    const pm = {};
    const unique = [...new Set(tokenAddresses.filter(Boolean).map(a => a.toLowerCase()))];
    for (let i = 0; i < unique.length; i += 20) {
        const batch = unique.slice(i, i + 20);
        try {
            // Try new v1 endpoint first, fall back to legacy
            let pairs = [];
            const r = await safeFetch(`https://api.dexscreener.com/tokens/v1/base/${batch.join(',')}`, {}, 10000);
            if (r.ok) {
                const d = await r.json();
                pairs = Array.isArray(d) ? d : (d.pairs || []);
            }
            if (!pairs.length) {
                const r2 = await safeFetch(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`, {}, 10000);
                if (r2.ok) { const d = await r2.json(); pairs = d.pairs || []; }
            }
            for (const pair of pairs) {
                if (pair.chainId && pair.chainId !== 'base') continue;
                const ca = (pair.baseToken?.address || '').toLowerCase();
                const price = parseFloat(pair.priceUsd || 0);
                const liq = parseFloat(pair.liquidity?.usd || 0);
                if (ca && price > 0 && (!pm[ca] || liq > (pm[ca].liq || 0)))
                    pm[ca] = { price, liq, sym: pair.baseToken?.symbol || '' };
            }
        } catch (e) { console.warn('[BASE] DexScreener:', e.message); }
        if (i + 20 < unique.length) await sleep(300);
    }
    return pm;
}

// ─── BASE wallet ─────────────────────────────────────────────────────────────

async function fetchBase(address) {
    console.log(`[BASE] ${address}`);
    const tokens = [], priceMap = {};
    const ethPrice = await getEthPrice();
    priceMap['0x4200000000000000000000000000000000000006'] = ethPrice;

    try {
        const r = await safeFetch(`https://base.blockscout.com/api/v2/addresses/${address}`, {}, 8000);
        if (r.ok) {
            const d = await r.json();
            const b = parseFloat(d.coin_balance || 0) / 1e18;
            if (b > 0.0001) tokens.push({ symbol: 'ETH', name: 'Ethereum', balance: b, price: ethPrice, value: b * ethPrice, type: 'native' });
        }
    } catch (e) { console.warn('[BASE] ETH:', e.message); }

    let allItems = [];
    try {
        const r = await safeFetch(`https://base.blockscout.com/api/v2/addresses/${address}/token-balances`, {}, 12000);
        if (r.ok) { const d = await r.json(); allItems = Array.isArray(d) ? d : (d.items || []); }
    } catch (e) { console.warn('[BASE] ERC20:', e.message); }

    const lpItems = [], erc20Items = [];
    for (const item of allItems) {
        const tok = item.token || {}, dec = parseInt(tok.decimals || '18', 10) || 18;
        const bal = parseFloat(item.value || 0) / Math.pow(10, dec);
        if (bal < 0.000001) continue;
        const sym = tok.symbol || '', nm = tok.name || '';
        if (sym === '9mm-LP' || sym.includes('-LP') || sym.includes('UNI-V2') || (nm.includes(' LPs') && !nm.includes('Staked')))
            lpItems.push({ tok, dec, bal });
        else
            erc20Items.push({ tok, dec, bal });
    }
    console.log(`[BASE] ${erc20Items.length} erc20, ${lpItems.length} LP`);

    const needsPricing = [];
    for (const { tok, bal } of erc20Items) {
        const price = parseFloat(tok.exchange_rate || 0);
        const ca = (tok.address_hash || tok.address || '').toLowerCase();
        if (price > 0) {
            priceMap[ca] = price;
            tokens.push({ symbol: tok.symbol || '?', name: tok.name || tok.symbol, balance: bal, price, value: bal * price, type: 'erc20', contract: ca });
        } else if (ca) {
            needsPricing.push({ sym: tok.symbol || '?', name: tok.name || tok.symbol, bal, contract: ca });
        }
    }
    if (needsPricing.length > 0) {
        const pm = await getDexPrices(needsPricing.map(t => t.contract));
        for (const t of needsPricing) {
            const price = pm[t.contract]?.price || 0;
            if (price > 0) priceMap[t.contract] = price;
            tokens.push({ symbol: t.sym, name: t.name, balance: t.bal, price, value: t.bal * price, type: 'erc20', contract: t.contract });
        }
    }

    // ── LP positions: batched JSON-RPC batch calls to avoid rate limits ──────────
    // Each LP needs: token0, token1, getReserves, totalSupply, decimals (5 calls)
    // We fire them as JSON-RPC batch requests in groups of 5 LP contracts at once.
    const BATCH_SIZE = 5;
    const lpMeta = [];
    for (let i = 0; i < lpItems.length; i += BATCH_SIZE) {
        const chunk = lpItems.slice(i, i + BATCH_SIZE);
        // Build one batch per LP contract (5 calls each)
        const allCalls = chunk.flatMap(({ tok }, ci) => {
            const ca = (tok.address_hash || tok.address || '').toLowerCase();
            return [
                { id: ci * 5 + 0, to: ca, data: '0x0dfe1681' }, // token0()
                { id: ci * 5 + 1, to: ca, data: '0xd21220a7' }, // token1()
                { id: ci * 5 + 2, to: ca, data: '0x0902f1ac' }, // getReserves()
                { id: ci * 5 + 3, to: ca, data: '0x18160ddd' }, // totalSupply()
                { id: ci * 5 + 4, to: ca, data: '0x313ce567' }, // decimals()
            ];
        });
        const results = await ethCallBatch(allCalls);
        for (let ci = 0; ci < chunk.length; ci++) {
            const { tok, bal } = chunk[ci];
            const ca = (tok.address_hash || tok.address || '').toLowerCase();
            const t0h    = results[ci * 5 + 0];
            const t1h    = results[ci * 5 + 1];
            const resHex = results[ci * 5 + 2];
            const tsh    = results[ci * 5 + 3];
            const lpdh   = results[ci * 5 + 4];
            const t0 = hexAddr(t0h), t1 = hexAddr(t1h);
            const lpDec = hexInt(lpdh) || 18;
            const ts = tsh ? Number(hexBig(tsh)) / Math.pow(10, lpDec) : 0;
            const r0 = resHex ? Number(hexBig('0x' + resHex.slice(2, 66))) : 0;
            const r1 = resHex ? Number(hexBig('0x' + resHex.slice(66, 130))) : 0;
            lpMeta.push({ ca, bal, t0, t1, r0, r1, ts, lpDec });
        }
        if (i + BATCH_SIZE < lpItems.length) await sleep(250);
    }
    console.log(`[BASE] ${lpMeta.length} LP pairs resolved`);

    // Get symbol+decimals for unique underlying tokens via batched RPC
    const lpTokenAddrs = [...new Set(lpMeta.flatMap(lp => [lp.t0, lp.t1].filter(Boolean)).map(a => a.toLowerCase()))];
    const tokInfo = {};
    if (lpTokenAddrs.length > 0) {
        const tokCalls = lpTokenAddrs.flatMap((ta, i) => [
            { id: i * 2,     to: ta, data: '0x313ce567' }, // decimals()
            { id: i * 2 + 1, to: ta, data: '0x95d89b41' }, // symbol()
        ]);
        const tokResults = await ethCallBatch(tokCalls);
        for (let i = 0; i < lpTokenAddrs.length; i++) {
            const ta = lpTokenAddrs[i];
            tokInfo[ta] = {
                dec: hexInt(tokResults[i * 2]) || 18,
                sym: decodeString(tokResults[i * 2 + 1]) || ta.slice(-6),
            };
        }
    }

    const lpPrices = await getDexPrices(lpTokenAddrs);
    for (const [ca, price] of Object.entries(priceMap)) {
        if (price > 0 && !lpPrices[ca]) lpPrices[ca] = { price };
    }

    for (const lp of lpMeta) {
        const ti0 = lp.t0 ? (tokInfo[lp.t0.toLowerCase()] || { dec: 18, sym: '?' }) : { dec: 18, sym: '?' };
        const ti1 = lp.t1 ? (tokInfo[lp.t1.toLowerCase()] || { dec: 18, sym: '?' }) : { dec: 18, sym: '?' };
        const pairName = `${ti0.sym}/${ti1.sym}`;
        const rv0 = lp.r0 / Math.pow(10, ti0.dec);
        const rv1 = lp.r1 / Math.pow(10, ti1.dec);
        const p0 = lp.t0 ? (lpPrices[lp.t0.toLowerCase()]?.price || 0) : 0;
        const p1 = lp.t1 ? (lpPrices[lp.t1.toLowerCase()]?.price || 0) : 0;
        let poolUsd = rv0 * p0 + rv1 * p1;
        if (poolUsd === 0 && p0 > 0) poolUsd = rv0 * p0 * 2;
        else if (poolUsd === 0 && p1 > 0) poolUsd = rv1 * p1 * 2;
        const share = lp.ts > 0 ? lp.bal / lp.ts : 0;
        const userValue = share * poolUsd;
        tokens.push({
            symbol: pairName, name: `${pairName} LP`, balance: lp.bal,
            price: lp.bal > 0 ? userValue / lp.bal : 0,
            value: userValue, type: 'lp', contract: lp.ca,
            totalLiqUsd: poolUsd, userSharePct: (share * 100).toFixed(4),
            pairName, token0: lp.t0, token1: lp.t1, price0: p0, price1: p1,
        });
    }

    const total = tokens.reduce((s, t) => s + (t.value || 0), 0);
    console.log(`[BASE] $${total.toFixed(2)}, ${tokens.length} tokens`);
    return { tokens, total };
}

// ─── CHIA: token balances ─────────────────────────────────────────────────────

async function fetchChiaTokens(address) {
    console.log(`[CHIA-TOKENS] ${address.slice(-12)}`);
    const tokens = [];
    const xchUsd = await getXchPrice();

    // XCH balance — fast, never rate-limited
    try {
        const r = await safeFetch(`https://api.spacescan.io/address/xch-balance/${address}`, {}, 8000);
        if (r.ok) {
            const d = await r.json();
            const b = parseFloat(d.xch || 0);
            console.log(`[CHIA-TOKENS] XCH=${b}`);
            if (b > 0) tokens.push({
                symbol: 'XCH', name: 'Chia', balance: b,
                price: xchUsd, value: b * xchUsd, type: 'native'
            });
        }
    } catch (e) { console.warn('[CHIA-TOKENS] xch-balance:', e.message); }

    // CAT token balances — single attempt with 25s timeout.
    // NO retries: retry delays (7s+23s = 30s) exceed the 26s Netlify function limit.
    // W1 takes ~16s for 102 tokens on success. W2 takes <1s.
    // The emoji market no longer races this endpoint, so 429s should be rare.
    try {
        console.log(`[CHIA-TOKENS] fetching token-balance for ${address.slice(0,12)}...`);
        const r = await safeFetch(
            `https://api.spacescan.io/address/token-balance/${address}`,
            {},
            25000  // 25s — XCH balance already took ~0.5s, total budget = 26s
        );
        if (r.status === 429) {
            console.warn('[CHIA-TOKENS] 429 — Spacescan rate limited, returning XCH only');
        } else if (!r.ok) {
            console.warn(`[CHIA-TOKENS] HTTP ${r.status}`);
        } else {
            const d = await r.json();
            const cats = d.data || [];
            console.log(`[CHIA-TOKENS] ${cats.length} CATs`);
            for (const cat of cats) {
                const bal = parseFloat(cat.balance || 0);
                if (bal <= 0) continue;
                const pu  = parseFloat(cat.price || 0);
                const px  = parseFloat(cat.price_xch || 0);
                const fp  = pu > 0 ? pu : (px * xchUsd);
                const val = parseFloat(cat.total_value || 0) || (bal * fp);
                tokens.push({
                    symbol:  cat.symbol || cat.name || '?',
                    name:    cat.name   || cat.symbol || 'Unknown CAT',
                    assetId: cat.asset_id,
                    balance: bal, price: fp, priceXch: px, value: val, type: 'cat',
                    image: cat.preview_url || ''
                });
            }
        }
    } catch (e) {
        console.warn('[CHIA-TOKENS] token-balance error:', e.message);
    }

    const total = tokens.reduce((s, t) => s + (t.value || 0), 0);
    console.log(`[CHIA-TOKENS] done: ${tokens.length} tokens, $${total.toFixed(2)}`);
    return { tokens, total };
}

// ─── CHIA: NFTs (Spacescan list + MintGarden enrichment) ─────────────────────

async function fetchChiaNFTs(address) {
    console.log(`[CHIA-NFTS] ${address.slice(-12)}`);
    let rawNfts = [];

    // Spacescan nft-balance — reliable, rarely rate-limited
    for (let i = 0; i < 2; i++) {
        if (i > 0) await sleep(4000);
        try {
            const r = await safeFetch(
                `https://api.spacescan.io/address/nft-balance/${address}`, {}, 20000
            );
            if (r.status === 429) { console.warn('[CHIA-NFTS] 429'); continue; }
            if (!r.ok) break;
            const d = await r.json();
            rawNfts = d.balance || [];
            console.log(`[CHIA-NFTS] ${rawNfts.length} NFTs from Spacescan`);
            break;
        } catch (e) {
            console.warn(`[CHIA-NFTS] attempt ${i + 1}:`, e.message);
        }
    }

    // Collate into collections by collection_id
    const cm = {};
    for (const n of rawNfts) {
        const cid = n.collection_id || 'uncategorized';
        if (!cm[cid]) {
            // Strip trailing " #NNN" from name to get collection name
            const nm = (n.name || '').replace(/\s*#\d+\s*$/, '').trim();
            cm[cid] = {
                id: cid,
                name: nm || 'Unknown Collection',
                count: 0,
                image: n.preview_url || '',  // spacescan preview as fallback
                mgImage: '',                 // to be enriched by MintGarden
                mgName: '',
                nfts: []
            };
        }
        cm[cid].count++;
        if (cm[cid].nfts.length < 1)
            cm[cid].nfts.push({ id: n.nft_id || '', name: n.name || '', image: n.preview_url || '' });
    }

    // MintGarden enrichment — parallel, best-effort for real collection IDs
    const realCids = Object.keys(cm).filter(cid => cid !== 'uncategorized');
    console.log(`[CHIA-NFTS] enriching ${realCids.length} collections via MintGarden`);

    const BATCH = 8;
    for (let i = 0; i < realCids.length; i += BATCH) {
        const batch = realCids.slice(i, i + BATCH);
        await Promise.all(batch.map(async cid => {
            try {
                const r = await safeFetch(`https://api.mintgarden.io/collections/${cid}`, {}, 6000);
                if (r.ok) {
                    const d = await r.json();
                    if (d && cm[cid]) {
                        cm[cid].mgName  = d.name  || '';
                        cm[cid].mgImage = d.thumbnail_uri || '';
                        // Use MintGarden name if better
                        if (d.name) cm[cid].name = d.name;
                    }
                }
            } catch { /* best-effort */ }
        }));
        if (i + BATCH < realCids.length) await sleep(200);
    }

    const collections = Object.values(cm)
        .sort((a, b) => b.count - a.count)
        .map(c => ({
            ...c,
            // prefer mintgarden image, fall back to spacescan preview
            image: c.mgImage || c.image || ''
        }));

    console.log(`[CHIA-NFTS] done: ${rawNfts.length} NFTs in ${collections.length} collections`);
    return { nfts: collections, nftCount: rawNfts.length };
}

// ─── Handler ─────────────────────────────────────────────────────────────────


// ─── Vercel Handler ─────────────────────────────────────────────────────────

async function fetchChiaFull(address1, address2) {
    console.log('[CHIA-FULL] Starting sequential load for both wallets');
    const xchUsd = await getXchPrice();
    const allTokens = [];

    // Helper: fetch one wallet's tokens
    async function fetchOneWalletTokens(address) {
        console.log(`[CHIA-FULL] tokens for ${address.slice(-12)}`);
        const tokens = [];

        // XCH balance — fast, never rate-limited
        try {
            const r = await safeFetch(`https://api.spacescan.io/address/xch-balance/${address}`, {}, 8000);
            if (r.ok) {
                const d = await r.json();
                const b = parseFloat(d.xch || 0);
                if (b > 0) tokens.push({ symbol: 'XCH', name: 'Chia', assetId: 'XCH', balance: b, price: xchUsd, value: b * xchUsd, type: 'native' });
                console.log(`[CHIA-FULL] XCH ${address.slice(-12)} = ${b}`);
            }
        } catch (e) { console.warn('[CHIA-FULL] XCH err:', e.message); }

        // CAT tokens — retry with 0 / 8s / 16s backoff
        const RETRY_DELAYS = [0, 8000, 16000];
        for (let i = 0; i < RETRY_DELAYS.length; i++) {
            if (RETRY_DELAYS[i] > 0) {
                console.log(`[CHIA-FULL] CAT retry ${i}, sleeping ${RETRY_DELAYS[i]}ms`);
                await sleep(RETRY_DELAYS[i]);
            }
            try {
                const r = await safeFetch(`https://api.spacescan.io/address/token-balance/${address}`, {}, 23000);
                if (r.status === 429) { console.warn(`[CHIA-FULL] 429 attempt ${i+1}`); continue; }
                if (!r.ok) { console.warn(`[CHIA-FULL] HTTP ${r.status} attempt ${i+1}`); break; }
                const d = await r.json();
                const cats = d.data || [];
                console.log(`[CHIA-FULL] ${cats.length} CATs for ${address.slice(-12)} (attempt ${i+1})`);
                for (const cat of cats) {
                    const bal = parseFloat(cat.balance || 0);
                    if (bal <= 0) continue;
                    const pu  = parseFloat(cat.price || 0);
                    const px  = parseFloat(cat.price_xch || 0);
                    const fp  = pu > 0 ? pu : (px * xchUsd);
                    tokens.push({
                        symbol: cat.symbol || cat.name || '?',
                        name: cat.name || cat.symbol || 'Unknown CAT',
                        assetId: cat.asset_id,
                        balance: bal, price: fp, priceXch: px,
                        value: parseFloat(cat.total_value || 0) || (bal * fp),
                        type: 'cat', image: cat.preview_url || ''
                    });
                }
                break; // success
            } catch (e) { console.warn(`[CHIA-FULL] attempt ${i+1} err:`, e.message); }
        }
        return tokens;
    }

    // ── Sequential: W1 first, then sleep, then W2 ─────────────────────────────
    const w1Tokens = await fetchOneWalletTokens(address1);
    allTokens.push(...w1Tokens);

    // Wait between wallets — Spacescan rate limit window is ~10s
    // W1 token-balance takes ~16s anyway, so Spacescan will be fresh for W2
    console.log('[CHIA-FULL] W1 done, sleeping 2s before W2...');
    await sleep(2000);

    const w2Tokens = await fetchOneWalletTokens(address2);
    allTokens.push(...w2Tokens);

    // Merge by assetId
    const tMap = new Map();
    for (const t of allTokens) {
        const k = t.assetId || t.symbol;
        if (!tMap.has(k)) { tMap.set(k, { ...t }); }
        else {
            const ex = tMap.get(k);
            ex.balance = (ex.balance || 0) + (t.balance || 0);
            ex.value   = (ex.value   || 0) + (t.value   || 0);
        }
    }
    const tokens = Array.from(tMap.values()).sort((a, b) => (b.value || 0) - (a.value || 0));
    const tokenTotal = tokens.reduce((s, t) => s + (t.value || 0), 0);
    console.log(`[CHIA-FULL] Tokens done: ${tokens.length} unique, $${tokenTotal.toFixed(2)}`);

    // ── NFTs: both wallets in parallel (nft-balance is reliable) ─────────────
    console.log('[CHIA-FULL] Fetching NFTs for both wallets...');
    let rawNfts1 = [], rawNfts2 = [];
    const [nftR1, nftR2] = await Promise.all([
        safeFetch(`https://api.spacescan.io/address/nft-balance/${address1}`, {}, 20000)
            .then(r => r.ok ? r.json() : { balance: [] })
            .catch(() => ({ balance: [] })),
        safeFetch(`https://api.spacescan.io/address/nft-balance/${address2}`, {}, 20000)
            .then(r => r.ok ? r.json() : { balance: [] })
            .catch(() => ({ balance: [] })),
    ]);
    rawNfts1 = nftR1.balance || [];
    rawNfts2 = nftR2.balance || [];
    const rawNfts = [...rawNfts1, ...rawNfts2];
    console.log(`[CHIA-FULL] ${rawNfts1.length} + ${rawNfts2.length} = ${rawNfts.length} NFTs`);

    // Build collection map
    const cm = {};
    for (const n of rawNfts) {
        const cid = n.collection_id || 'uncategorized';
        if (!cm[cid]) {
            cm[cid] = {
                id: cid,
                name: (n.name || '').replace(/\s*#\d+\s*$/, '').trim() || 'Unknown Collection',
                count: 0, image: n.preview_url || '', mgImage: '', nfts: []
            };
        }
        cm[cid].count++;
        if (cm[cid].nfts.length < 1) cm[cid].nfts.push({ id: n.nft_id || '', name: n.name || '', image: n.preview_url || '' });
    }

    // MintGarden enrichment — parallel batches
    const realCids = Object.keys(cm).filter(c => c !== 'uncategorized');
    const BATCH = 8;
    for (let i = 0; i < realCids.length; i += BATCH) {
        await Promise.all(realCids.slice(i, i + BATCH).map(async cid => {
            try {
                const r = await safeFetch(`https://api.mintgarden.io/collections/${cid}`, {}, 6000);
                if (r.ok) {
                    const d = await r.json();
                    if (d && cm[cid]) {
                        if (d.name) cm[cid].name = d.name;
                        cm[cid].mgImage = d.thumbnail_uri || '';
                    }
                }
            } catch {}
        }));
        if (i + BATCH < realCids.length) await sleep(200);
    }

    const nfts = Object.values(cm)
        .sort((a, b) => b.count - a.count)
        .map(c => ({ ...c, image: c.mgImage || c.image || '' }));

    console.log(`[CHIA-FULL] Complete: ${tokens.length} tokens, ${rawNfts.length} NFTs in ${nfts.length} collections`);
    return { tokens, total: tokenTotal, nfts, nftCount: rawNfts.length };
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const p = req.query || {};

    // chia full mode (combined tokens + NFTs)
    if (p.chain === 'chia' && p.type === 'full') {
        const a1 = p.address1 || p.address || '';
        const a2 = p.address2 || '';
        if (!a1) return res.status(400).json({ error: 'Missing address1' });
        try {
            return res.status(200).json(await fetchChiaFull(a1, a2 || a1));
        } catch (err) {
            return res.status(200).json({ tokens: [], total: 0, nfts: [], nftCount: 0, error: err.message });
        }
    }

    if (!p.chain) return res.status(400).json({ error: 'Missing chain' });

    try {
        if (p.chain === 'base') {
            if (!p.address) return res.status(400).json({ error: 'Missing address' });
            return res.status(200).json(await fetchBase(p.address));
        }

        if (p.chain === 'chia') {
            if (!p.address) return res.status(400).json({ error: 'Missing address' });
            const type = p.type || 'tokens';
            if (type === 'tokens') return res.status(200).json(await fetchChiaTokens(p.address));
            if (type === 'nfts') return res.status(200).json(await fetchChiaNFTs(p.address));
        }

        return res.status(400).json({ error: 'Invalid chain/type' });
    } catch (err) {
        return res.status(200).json({ tokens: [], nfts: [], total: 0, nftCount: 0, error: err.message });
    }
}
