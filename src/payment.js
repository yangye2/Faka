const crypto = require('crypto');

const PAYMENT_DEBUG = isDebugEnabled(process.env.PAYMENT_DEBUG);

async function unifiedOrder(config, payload) {
  const reqBody = {
    amount: String(payload.amount),
    extParam: payload.extParam || '',
    mchOrderNo: payload.mchOrderNo,
    subject: payload.subject,
    wayCode: config.way_code,
    reqTime: String(payload.reqTime),
    body: payload.body,
    version: config.version || '1.0',
    channelExtra: payload.channelExtra || '',
    appId: config.app_id,
    clientIp: payload.clientIp || '',
    notifyUrl: payload.notifyUrl || '',
    returnUrl: payload.returnUrl || '',
    signType: 'MD5',
    currency: 'cny',
    mchNo: config.mch_no,
  };

  validateUnifiedOrderReq(reqBody);
  reqBody.sign = buildSign(reqBody, config.app_secret);

  return httpFormPost(config.unified_order_url, reqBody, { api: 'unifiedOrder' });
}

async function queryOrder(config, payload) {
  const reqBody = {
    payOrderId: payload.payOrderId || '',
    mchOrderNo: payload.mchOrderNo || '',
    appId: config.app_id,
    signType: 'MD5',
    reqTime: String(payload.reqTime),
    mchNo: config.mch_no,
    version: config.version || '1.0',
  };

  validateQueryOrderReq(reqBody);
  reqBody.sign = buildSign(reqBody, config.app_secret);
  return httpFormPost(config.query_order_url, reqBody, { api: 'queryOrder' });
}

function buildSign(params, secret) {
  const pairs = [];
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined || value === null || value === '' || key === 'sign') {
      continue;
    }
    pairs.push(`${key}=${value}`);
  }

  const signStr = `${pairs.join('&')}&key=${secret}`;
  return crypto.createHash('md5').update(signStr, 'utf8').digest('hex').toUpperCase();
}

function verifySign(params, secret) {
  const sourceSign = String(params.sign || '').trim();
  if (!sourceSign) return false;

  const copied = { ...params };
  delete copied.sign;
  const expected = buildSign(copied, secret);
  return expected === sourceSign.toUpperCase();
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

function maskText(value, keep = 6) {
  const text = String(value || '');
  if (text.length <= keep) return '*'.repeat(text.length || 3);
  return `${text.slice(0, keep)}***`;
}

function debugLog(event, payload) {
  if (!PAYMENT_DEBUG) return;
  console.log(`[payment-debug] ${new Date().toISOString()} ${event}:`, payload);
}

function validateUnifiedOrderReq(body) {
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
    throw new Error('支付下单参数错误: amount必须为大于0的整数分');
  }

  if (!body.mchOrderNo) throw new Error('支付下单参数错误: mchOrderNo不能为空');
  if (!body.subject) throw new Error('支付下单参数错误: subject不能为空');
  if (!body.body) throw new Error('支付下单参数错误: body不能为空');
  if (!body.wayCode) throw new Error('支付下单参数错误: wayCode不能为空');
  if (!body.appId) throw new Error('支付下单参数错误: appId不能为空');
  if (!body.mchNo) throw new Error('支付下单参数错误: mchNo不能为空');
}

function validateQueryOrderReq(body) {
  if (!body.payOrderId && !body.mchOrderNo) {
    throw new Error('查单参数错误: payOrderId和mchOrderNo至少传一个');
  }
  if (!body.appId) throw new Error('查单参数错误: appId不能为空');
  if (!body.mchNo) throw new Error('查单参数错误: mchNo不能为空');
}

module.exports = {
  unifiedOrder,
  queryOrder,
  buildSign,
  verifySign,
};
