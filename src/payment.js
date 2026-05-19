const crypto = require('crypto');

const PAYMENT_DEBUG = isDebugEnabled(process.env.PAYMENT_DEBUG);

async function createPayment(config, payload) {
  const reqBody = {
    pid: String(config.pid || ''),
    type: String(payload.type || config.pay_type || ''),
    out_trade_no: String(payload.outTradeNo || ''),
    notify_url: String(payload.notifyUrl || ''),
    return_url: String(payload.returnUrl || ''),
    name: String(payload.name || ''),
    money: normalizeMoney(payload.money),
    clientip: String(payload.clientIp || ''),
    device: String(payload.device || config.device || ''),
    param: String(payload.param || ''),
    sign_type: 'MD5',
  };

  validateCreateReq(reqBody);
  reqBody.sign = buildSign(reqBody, config.key);

  return httpFormPost(config.mapi_url, reqBody, { api: 'createPayment' });
}

async function queryPayment(config, payload) {
  const params = {
    act: 'order',
    pid: String(config.pid || ''),
    key: String(config.key || ''),
    trade_no: String(payload.tradeNo || ''),
    out_trade_no: String(payload.outTradeNo || ''),
  };

  validateQueryReq(params);
  return httpGetJson(config.api_url, params, { api: 'queryPayment' });
}

async function queryMerchantInfo(config) {
  const params = {
    act: 'query',
    pid: String(config.pid || ''),
    key: String(config.key || ''),
  };
  validateMerchantQueryReq(params);
  return httpGetJson(config.api_url, params, { api: 'queryMerchantInfo' });
}

function buildSign(params, secret) {
  const pairs = [];
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined || value === null || value === '' || key === 'sign' || key === 'sign_type') {
      continue;
    }
    pairs.push(`${key}=${value}`);
  }

  const signStr = `${pairs.join('&')}${String(secret || '')}`;
  return crypto.createHash('md5').update(signStr, 'utf8').digest('hex').toLowerCase();
}

function verifySign(params, secret) {
  const sourceSign = String(params.sign || '').trim();
  if (!sourceSign) return false;

  const copied = { ...params };
  delete copied.sign;
  const expected = buildSign(copied, secret);
  return expected === sourceSign.toLowerCase();
}

async function httpFormPost(url, body, meta = {}) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    form.set(k, String(v));
  }
  const formBody = form.toString();

  debugLog(`${meta.api || 'paymentApi'} request`, {
    url,
    body: sanitizeForLog(body),
    formBody,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json, text/plain, */*',
    },
    body: formBody,
  });

  const text = await res.text();
  debugLog(`${meta.api || 'paymentApi'} response`, {
    url,
    status: res.status,
    statusText: res.statusText,
    rawBody: text,
  });

  let data;
  try {
    data = JSON.parse(text);
  } catch (_err) {
    debugLog(`${meta.api || 'paymentApi'} response parse_error`, {
      url,
      status: res.status,
      rawBody: text,
    });
    throw new Error(`支付网关返回非JSON: ${text.slice(0, 200)}`);
  }

  debugLog(`${meta.api || 'paymentApi'} response parsed`, sanitizeForLog(data));
  return data;
}

async function httpGetJson(baseUrl, params, meta = {}) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    query.set(k, String(v));
  }

  const url = `${stripTrailingSlash(baseUrl)}?${query.toString()}`;
  debugLog(`${meta.api || 'paymentApi'} request`, {
    url,
    params: sanitizeForLog(params),
  });

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
    },
  });

  const text = await res.text();
  debugLog(`${meta.api || 'paymentApi'} response`, {
    url,
    status: res.status,
    statusText: res.statusText,
    rawBody: text,
  });

  let data;
  try {
    data = JSON.parse(text);
  } catch (_err) {
    debugLog(`${meta.api || 'paymentApi'} response parse_error`, {
      url,
      status: res.status,
      rawBody: text,
    });
    throw new Error(`支付网关返回非JSON: ${text.slice(0, 200)}`);
  }

  debugLog(`${meta.api || 'paymentApi'} response parsed`, sanitizeForLog(data));
  return data;
}

function isDebugEnabled(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function sanitizeForLog(input) {
  if (Array.isArray(input)) {
    return input.map((item) => sanitizeForLog(item));
  }
  if (!input || typeof input !== 'object') {
    return input;
  }

  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const key = k.toLowerCase();
    if (key.includes('secret') || key.includes('password')) {
      out[k] = '***';
      continue;
    }
    out[k] = sanitizeForLog(v);
  }
  return out;
}

function debugLog(event, payload) {
  if (!PAYMENT_DEBUG) return;
  console.log(`[payment-debug] ${new Date().toISOString()} ${event}:`, payload);
}

function validateCreateReq(body) {
  if (!body.pid) throw new Error('支付下单参数错误: pid不能为空');
  if (!body.type) throw new Error('支付下单参数错误: type不能为空');
  if (!body.out_trade_no) throw new Error('支付下单参数错误: out_trade_no不能为空');
  if (!body.notify_url) throw new Error('支付下单参数错误: notify_url不能为空');
  if (!body.name) throw new Error('支付下单参数错误: name不能为空');
  if (!body.clientip) throw new Error('支付下单参数错误: clientip不能为空');

  const money = Number(body.money);
  if (!Number.isFinite(money) || money <= 0) {
    throw new Error('支付下单参数错误: money必须大于0');
  }
}

function validateQueryReq(params) {
  if (!params.pid) throw new Error('查单参数错误: pid不能为空');
  if (!params.key) throw new Error('查单参数错误: key不能为空');
  if (!params.trade_no && !params.out_trade_no) {
    throw new Error('查单参数错误: trade_no和out_trade_no至少传一个');
  }
}

function validateMerchantQueryReq(params) {
  if (!params.pid) throw new Error('查询商户参数错误: pid不能为空');
  if (!params.key) throw new Error('查询商户参数错误: key不能为空');
}

function normalizeMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return String(value || '');
  return n.toFixed(2);
}

function stripTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

module.exports = {
  createPayment,
  queryPayment,
  queryMerchantInfo,
  buildSign,
  verifySign,
};
