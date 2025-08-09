import axios from 'axios';
import chalk from 'chalk';
import inquirer from 'inquirer';
import SearchCheckboxPrompt from 'inquirer-search-checkbox';
import { HttpsProxyAgent } from 'https-proxy-agent';

inquirer.registerPrompt('search-checkbox', SearchCheckboxPrompt);

/**
 * 此处为监控可配置参数
 * 刷新频率：最好5s以上
 * 波动阈值：根据自己认为的稳定状态设置（如VRA就可以设置为千分之一也就是0.001）
 * 监控分钟数：默认3分钟，每个币种都有一段时间的稳定期，主要看持续时间，像VRA时不时就会有一段X分钟的稳定期
 * 缓存分钟数：缓存分钟数，用处不大，主要是辅助趋势判断
 */
const REFRESH_INTERVAL = 5000;   // 5秒刷新一次
const STABLE_THRESHOLD = 0.0015;  // 千分之一点五价格波动阈值
const MONITOR_MINUTES = 3;       // 监控分钟数
const CACHE_MINUTES = 10;        // 缓存分钟数

/**
 * 代理开关，true启用代理，false直连
 */
const USE_PROXY = false;

const proxyHost = '0.0.0.0';
const proxyPort = 15385;
const proxyUser = 'xxx';
const proxyPass = 'xxx';
const proxyUrl = `http://${proxyUser}:${proxyPass}@${proxyHost}:${proxyPort}`;

const agent = USE_PROXY ? new HttpsProxyAgent(proxyUrl) : null;
const axiosProxyConfig = USE_PROXY ? { httpsAgent: agent, proxy: false } : {};

const symbolToAlphaId = {};
const alphaIdToSymbol = {};
const stableNotified = {};
const tradesCache = {};

function displaySymbol(symbol) {
    return replaceAlphaIdsWithSymbols(symbol);
}

function formatTimestamp(ts) {
    const d = new Date(ts);
    return d.toISOString().replace('T', ' ').replace('Z', '');
}

async function loadAlphaTokens() {
    try {
        const res = await axios.get(
            'https://www.bmwweb.net/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list',
            axiosProxyConfig
        );
        if (res.data?.code === '000000' && Array.isArray(res.data.data)) {
            for (const token of res.data.data) {
                symbolToAlphaId[token.symbol] = token.alphaId;
                alphaIdToSymbol[token.alphaId] = token.symbol;
            }
            console.log(chalk.green(`加载 ${res.data.data.length} 个 Alpha Token`));
        } else {
            console.warn(chalk.yellow('Token列表异常或无数据'));
        }
    } catch (err) {
        console.error(chalk.red('加载 Alpha Token 失败：'), err.message);
    }
}

async function getAlphaPairs() {
    try {
        const res = await axios.get(
            'https://www.bmwweb.net/bapi/defi/v1/public/alpha-trade/get-exchange-info',
            axiosProxyConfig
        );
        if (res.data?.data?.symbols) {
            return res.data.data.symbols.map(s => s.symbol);
        }
        return [];
    } catch (err) {
        console.error(chalk.red('获取 Alpha 交易对失败：'), err.message);
        return [];
    }
}

function replaceAlphaIdsWithSymbols(tradingSymbol) {
    if (!tradingSymbol) return '';

    const match = tradingSymbol.match(/^([A-Z0-9_]+)(USDT|USDC|BTC|ETH|BNB)$/);

    if (match) {
        const baseCurrency = match[1];
        const quoteCurrency = match[2];

        if (alphaIdToSymbol[baseCurrency]) {
            return `${alphaIdToSymbol[baseCurrency]}${quoteCurrency}`;
        }
    }
    return tradingSymbol;
}

async function fetchTicker(symbol) {
    try {
        const res = await axios.get(
            'https://www.bmwweb.net/bapi/defi/v1/public/alpha-trade/ticker',
            {
                params: { symbol },
                ...axiosProxyConfig,
                timeout: 10000,
            }
        );
        if (res.data?.data) {
            return parseFloat(res.data.data.lastPrice);
        }
    } catch (err) {
        console.error(chalk.red(`获取 ${displaySymbol(symbol)} 行情失败：`), err.message);
    }
    return null;
}

async function fetchAggregatedTradesRecent(symbol, minutes = MONITOR_MINUTES, limit = 1000) {
    const now = Date.now();
    const startTime = now - minutes * 60 * 1000;

    try {
        const res = await axios.get(
            'https://www.bmwweb.net/bapi/defi/v1/public/alpha-trade/agg-trades',
            {
                params: { symbol, startTime, limit },
                ...axiosProxyConfig,
                timeout: 10000,
            }
        );

        if (res.data?.code === '000000' && Array.isArray(res.data.data)) {
            return res.data.data.filter(t => t.T >= startTime);
        } else {
            console.warn(chalk.yellow(`接口返回异常或无数据，code=${res.data?.code}`));
        }
    } catch (err) {
        if (err.response && err.response.status === 404) {
            console.warn(chalk.yellow(`警告：交易对 ${displaySymbol(symbol)} 可能不存在或无成交数据，接口返回404`));
        } else {
            console.error(chalk.red(`获取${displaySymbol(symbol)}近${minutes}分钟聚合成交记录失败：`), err.message);
        }
    }
    return [];
}

function calculateMinuteKlines(trades, minutes) {
    const now = Date.now();
    const startTime = now - minutes * 60 * 1000;
    const minuteMap = {};

    for (const t of trades) {
        if (t.T < startTime) continue;
        const minuteKey = Math.floor(t.T / 60000) * 60000;
        if (!minuteMap[minuteKey]) {
            minuteMap[minuteKey] = { prices: [] };
        }
        minuteMap[minuteKey].prices.push(parseFloat(t.p));
    }

    const sortedKeys = Object.keys(minuteMap).map(k => parseInt(k)).sort((a, b) => a - b);

    const klines = sortedKeys.map(key => {
        const prices = minuteMap[key].prices;
        const max = Math.max(...prices);
        const min = Math.min(...prices);
        const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
        return { minute: key, max, min, avg };
    });

    return klines;
}

function judgeTrendByKlines(klines) {
    if (klines.length < 2) return '趋势不明显';

    let upCount = 0;
    let downCount = 0;

    for (let i = 1; i < klines.length; i++) {
        const diff = klines[i].avg - klines[i - 1].avg;
        if (diff > 0) {
            upCount++;
        } else if (diff < 0) {
            downCount++;
        }
    }

    if (upCount === klines.length - 1) {
        return '趋势向上 ↑';
    } else if (downCount === klines.length - 1) {
        return '趋势向下 ↓';
    } else {
        return '震荡 ↔';
    }
}

function calculateOverallVolatility(klines) {
    if (klines.length === 0) return 0;
    const highs = klines.map(k => k.max);
    const lows = klines.map(k => k.min);
    const globalMax = Math.max(...highs);
    const globalMin = Math.min(...lows);
    return (globalMax - globalMin) / globalMin;
}

function checkStableState(klines, threshold = STABLE_THRESHOLD) {
    if (klines.length < MONITOR_MINUTES) return false;

    const trend = judgeTrendByKlines(klines);

    if (trend === '趋势向上 ↑') {
        // 每分钟波动率都不大于阈值
        for (let i = 0; i < klines.length; i++) {
            const k = klines[i];
            const volatility = (k.max - k.min) / k.min;
            if (volatility > threshold) {
                return false;
            }
        }
        return true;
    } else if (trend === '震荡 ↔') {
        // 计算监控区间整体波动率
        const overallVolatility = calculateOverallVolatility(klines);
        if (overallVolatility <= threshold) {
            return true;
        }
    }

    return false;
}

async function monitorExtended(symbols) {
    const now = Date.now();

    for (const symbol of symbols) {
        const price = await fetchTicker(symbol);
        if (price === null) continue;

        const recentTrades = await fetchAggregatedTradesRecent(symbol, CACHE_MINUTES);
        if (!tradesCache[symbol]) tradesCache[symbol] = [];
        const existingIds = new Set(tradesCache[symbol].map(t => t.a));
        for (const t of recentTrades) {
            if (!existingIds.has(t.a)) tradesCache[symbol].push(t);
        }
        const cacheStart = now - CACHE_MINUTES * 60 * 1000;
        tradesCache[symbol] = tradesCache[symbol].filter(t => t.T >= cacheStart);

        const klines = calculateMinuteKlines(tradesCache[symbol], MONITOR_MINUTES);

        const stable = checkStableState(klines);

        const prices = [];
        klines.forEach(k => {
            prices.push(k.max);
            prices.push(k.min);
        });
        const maxPrice = prices.length > 0 ? Math.max(...prices) : null;
        const minPrice = prices.length > 0 ? Math.min(...prices) : null;

        const trend = judgeTrendByKlines(klines);

        console.log(chalk.blue('='.repeat(80)));
        const overallVolatility = calculateOverallVolatility(klines);
        console.log(`${chalk.cyan(displaySymbol(symbol))} 现价: ${price.toFixed(8)} | 监控区间: 最近${MONITOR_MINUTES}分钟 波动率: ${(overallVolatility * 100).toFixed(3)}%`);
        console.log(`趋势判断：${chalk.magenta(trend)}`);
        console.log(`稳定状态判断：${stable ? chalk.green('稳定') : chalk.yellow('不稳定')}`);
        if (maxPrice !== null && minPrice !== null) {
            console.log(`最高价: ${maxPrice.toFixed(8)} | 最低价: ${minPrice.toFixed(8)}`);
        }

        const last10 = tradesCache[symbol].slice(-10);

        console.log(chalk.gray('最近10笔成交（时间 - 价格 - 数量）：'));
        last10.forEach(t => {
            console.log(
                `${formatTimestamp(t.T)} | 价格: ${t.p} | 数量: ${t.q}`
            );
        });

        if (stable && !stableNotified[symbol]) {
            stableNotified[symbol] = true;
            console.log(chalk.bgGreen.black(`>>> 发现稳定状态！币种：${displaySymbol(symbol)} <<<`));
        } else if (!stable) {
            stableNotified[symbol] = false;
        }
        console.log(chalk.blue('='.repeat(80)));
    }
}

(async () => {
    await loadAlphaTokens();

    const rawPairs = await getAlphaPairs();
    if (rawPairs.length === 0) {
        console.error(chalk.red('没有获取到任何 Alpha 交易对，程序退出'));
        process.exit(1);
    }

    const choices = rawPairs.map(rawSymbol => ({
        name: displaySymbol(rawSymbol),
        value: rawSymbol,
    }));

    const answers = await inquirer.prompt([
        {
            type: 'search-checkbox',
            name: 'selected',
            message: '请输入关键词进行模糊搜索并选择交易对（多选）：',
            choices,
            validate: input => input.length > 0 || '请至少选择一个交易对',
            pageSize: 10,
            searchText: '输入关键词进行搜索',
            emptyText: '无匹配结果，请换个关键词',
        }
    ]);

    const selectedSymbols = answers.selected;

    console.log(chalk.magenta(`开始监控以下交易对：${selectedSymbols.map(displaySymbol).join(', ')}`));

    setInterval(() => {
        monitorExtended(selectedSymbols);
    }, REFRESH_INTERVAL);
})();
