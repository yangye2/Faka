const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const {
  listActiveProductsWithStock,
  listAllProductsWithStock,
  createProduct,
  toggleProduct,
  deleteProduct,
  importCards,
  createPendingOrder,
  updateOrderPaymentCreated,
  applyPayState,
  markOrderPaidAndDeliver,
  getOrderByNo,
  getDashboardStats,
  listLatestOrders,
  listProductsBasic,
  listStockMapRows,
  listCardsByProduct,
  listOrdersPaged,
  deleteOrderByNo,
  cleanupUnpaidOrdersOlderThan,
  ensureDatabaseReady,
  getSiteName,
  setSiteName,
  getPaymentConfig,
  setPaymentConfig,
} = require('./store');
const { unifiedOrder, queryOrder, verifySign } = require('./payment');

loadEnvFile(path.resolve(__dirname, '..', '.env'));

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_secret';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const PAYMENT_DEBUG = isDebugEnabled(process.env.PAYMENT_DEBUG);
const TEST_DIRECT_ORDER_PAGE = isDebugEnabled(process.env.TEST_DIRECT_ORDER_PAGE);
const ORDER_EXPIRE_MINUTES = clampPositiveInt(process.env.ORDER_EXPIRE_MINUTES, 15);

app.set('view engine', 'ejs');
app.set('views', path.resolve(__dirname, '..', 'views'));
app.use(express.static(path.resolve(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 12,
      httpOnly: true,
    },
  })
);

app.use((req, res, next) => {
  try {
    res.locals.admin = req.session.admin || null;
    res.locals.msg = req.session.flashMsg || '';
    delete req.session.flashMsg;
    res.locals.siteName = getSiteName();
    res.locals.paymentEnabled = getPaymentConfig().enabled || TEST_DIRECT_ORDER_PAGE;
    next();
  } catch (err) {
    next(err);
  }
});

function requireAdmin(req, res, next) {
  if (req.session.admin) return next();
  return redirectWithMsg(req, res, '/admin/login', '请先登录后台');
}

app.get('/', (req, res, next) => {
  try {
    const products = listActiveProductsWithStock();
    res.render('index', { products });
  } catch (err) {
    next(err);
  }
});

app.post('/buy', async (req, res) => {
  const productId = Number(req.body.product_id);
  const buyerEmail = String(req.body.buyer_email || '').trim();
  let createdOrderNo = '';

  paymentDebug('buy request received', {
    productId,
    buyerEmail: buyerEmail ? maskEmail(buyerEmail) : '',
    clientIp: getClientIp(req),
  });

  if (!productId) {
    return redirectWithMsg(req, res, '/', '参数错误');
  }

  try {
    const paymentConfig = getPaymentConfig();
    if (!paymentConfig.enabled && !TEST_DIRECT_ORDER_PAGE) {
      return redirectWithMsg(req, res, '/', '支付通道未启用，请联系管理员');
    }

    const { orderNo, order } = createPendingOrder(productId, buyerEmail);
    createdOrderNo = orderNo;

    if (TEST_DIRECT_ORDER_PAGE) {
      applyPayState(order.order_no, 1, {
        payMsg: '测试模式：跳过支付下单接口',
      });
      return redirectWithMsg(req, res, `/order/${order.order_no}`, '测试模式：已跳过支付下单，直接进入订单页');
    }

    const notifyUrl = paymentConfig.notify_url || buildPublicUrl(req, '/payment/notify/cfyle');
    const returnUrl = paymentConfig.return_url || buildPublicUrl(req, `/payment/return/${orderNo}`);
    const unifiedPayload = {
      amount: order.amount_cents,
      mchOrderNo: order.order_no,
      subject: `${paymentConfig.subject_prefix}-${order.product_name}`.slice(0, 64),
      body: paymentConfig.body_text,
      reqTime: Date.now(),
      clientIp: getClientIp(req),
      notifyUrl,
      returnUrl,
      extParam: JSON.stringify({ orderNo: order.order_no }),
    };

    paymentDebug('start pay request', {
      orderNo: order.order_no,
      unifiedOrderUrl: paymentConfig.unified_order_url,
      payload: sanitizeForLog(unifiedPayload),
    });

    const response = await unifiedOrder(paymentConfig, unifiedPayload);
    paymentDebug('start pay response summary', {
      orderNo: order.order_no,
      code: response && response.code,
      msg: response && response.msg,
      payOrderId: response && response.data && response.data.payOrderId,
      orderState: response && response.data && response.data.orderState,
      payDataType: response && response.data && response.data.payDataType,
    });

    if (!isSuccessCode(response.code)) {
      deleteOrderByNo(order.order_no);
      return redirectWithMsg(
        req,
        res,
        '/',
        `下单失败: ${getGatewayMsg(response) || '网关错误'}`
      );
    }

    const payData = response.data || {};
    const orderState = resolvePayState(payData);
    const payDataType = String(payData.payDataType || '').toLowerCase();
    const payDataValue = String(payData.payData || '');
    if (payDataType !== 'payurl' || !payDataValue) {
      deleteOrderByNo(order.order_no);
      return redirectWithMsg(req, res, '/', '下单失败: 未返回有效支付链接');
    }

    updateOrderPaymentCreated(order.order_no, {
      payOrderId: payData.payOrderId || '',
      payUrl: payDataValue,
      payState: orderState,
      payMsg: getGatewayMsg(payData) || '',
    });

    if (orderState === 2) {
      markOrderPaidAndDeliver(order.order_no, {
        payOrderId: payData.payOrderId || '',
        payMsg: '下单同步返回已支付',
      });
    }

    return res.redirect(`/order/${order.order_no}`);
  } catch (err) {
    if (createdOrderNo) {
      deleteOrderByNo(createdOrderNo);
    }
    paymentDebug('start pay exception', {
      message: err.message,
      productId,
      buyerEmail: buyerEmail ? maskEmail(buyerEmail) : '',
    });
    return redirectWithMsg(req, res, '/', err.message || '下单失败');
  }
});

app.get('/order/:orderNo', (req, res, next) => {
  try {
    const order = getOrderByNo(req.params.orderNo);
    if (!order) {
      return res.status(404).render('order', { order: null });
    }
    res.render('order', { order });
  } catch (err) {
    next(err);
  }
});

app.post('/order/:orderNo/check-pay', async (req, res) => {
  const orderNo = String(req.params.orderNo || '').trim();
  try {
    if (TEST_DIRECT_ORDER_PAGE) {
      const order = markOrderPaidAndDeliver(orderNo, {
        payMsg: '测试模式：手动查单直接确认已支付',
      });
      if (!order) {
        return redirectWithMsg(req, res, `/order/${orderNo}`, '订单不存在');
      }
      if (order.status === 'out_of_stock') {
        return redirectWithMsg(req, res, `/order/${orderNo}`, '测试模式：支付成功但库存不足');
      }
      return redirectWithMsg(req, res, `/order/${orderNo}`, '测试模式：支付成功，卡密已发放');
    }

    const paymentConfig = getPaymentConfig();
    if (!paymentConfig.enabled) {
      return redirectWithMsg(req, res, `/order/${orderNo}`, '支付通道未启用');
    }

    const order = getOrderByNo(orderNo);
    if (!order) {
      return redirectWithMsg(req, res, `/order/${orderNo}`, '订单不存在');
    }

    const response = await queryOrder(paymentConfig, {
      mchOrderNo: order.order_no,
      payOrderId: order.pay_order_id || '',
      reqTime: Date.now(),
    });

    if (!isSuccessCode(response.code)) {
      return redirectWithMsg(req, res, `/order/${orderNo}`, `查单失败: ${getGatewayMsg(response) || '网关错误'}`);
    }

    const payData = response.data || {};
    const payState = resolvePayState(payData);

    applyPayState(order.order_no, payState, {
      payOrderId: payData.payOrderId || '',
      payMsg: getGatewayMsg(payData) || '',
    });

    if (payState === 2) {
      markOrderPaidAndDeliver(order.order_no, {
        payOrderId: payData.payOrderId || '',
        payMsg: '主动查单确认已支付',
      });
      return redirectWithMsg(req, res, `/order/${orderNo}`, '支付成功，卡密已发放');
    }

    return redirectWithMsg(req, res, `/order/${orderNo}`, `当前支付状态: ${payState}`);
  } catch (err) {
    return redirectWithMsg(req, res, `/order/${orderNo}`, err.message || '查单失败');
  }
});

app.get('/payment/return/:orderNo', (req, res) => {
  const orderNo = String(req.params.orderNo || '').trim();
  return redirectWithMsg(req, res, `/order/${orderNo}`, '已返回商户站点，请点击查单确认支付结果');
});

app.all('/payment/notify/cfyle', async (req, res) => {
  try {
    const paymentConfig = getPaymentConfig();
    if (!paymentConfig.enabled) {
      paymentDebug('notify ignored: payment disabled');
      return res.type('text/plain').send('fail');
    }

    if (paymentConfig.callback_ip_check) {
      const whitelist = String(paymentConfig.callback_ip_whitelist || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      const callerIp = getClientIp(req);
      if (whitelist.length && !whitelist.includes(callerIp)) {
        paymentDebug('notify rejected by ip whitelist', { callerIp, whitelist });
        return res.type('text/plain').send('fail');
      }
    }

    const hasBody = req.body && Object.keys(req.body).length > 0;
    const params = hasBody ? req.body : req.query;
    paymentDebug('notify received', {
      method: req.method,
      callerIp: getClientIp(req),
      hasBody,
      params: sanitizeForLog(params),
    });

    if (!verifySign(params, paymentConfig.app_secret)) {
      paymentDebug('notify sign verify failed', { params: sanitizeForLog(params) });
      return res.type('text/plain').send('fail');
    }

    if (String(params.mchNo || '') !== String(paymentConfig.mch_no || '')) {
      paymentDebug('notify rejected: mchNo mismatch', {
        incomingMchNo: params.mchNo || '',
        configMchNo: paymentConfig.mch_no || '',
      });
      return res.type('text/plain').send('fail');
    }

    if (String(params.appId || '') !== String(paymentConfig.app_id || '')) {
      paymentDebug('notify rejected: appId mismatch', {
        incomingAppId: params.appId || '',
        configAppId: paymentConfig.app_id || '',
      });
      return res.type('text/plain').send('fail');
    }

    const mchOrderNo = String(params.mchOrderNo || '').trim();
    if (!mchOrderNo) {
      paymentDebug('notify rejected: missing mchOrderNo', { params: sanitizeForLog(params) });
      return res.type('text/plain').send('fail');
    }

    const state = Number(params.state);
    if (state === 2) {
      const queryResp = await queryOrder(paymentConfig, {
        mchOrderNo,
        payOrderId: params.payOrderId || '',
        reqTime: Date.now(),
      });

      if (!isSuccessCode(queryResp.code)) {
        paymentDebug('notify paid verify failed: query api error', {
          mchOrderNo,
          payOrderId: params.payOrderId || '',
          queryCode: queryResp.code,
          queryMsg: getGatewayMsg(queryResp),
        });
        return res.type('text/plain').send('fail');
      }

      const queryState = resolvePayState(queryResp?.data || {});
      if (queryState !== 2) {
        paymentDebug('notify paid verify failed: query state not success', {
          mchOrderNo,
          payOrderId: params.payOrderId || '',
          queryState,
        });
        return res.type('text/plain').send('fail');
      }

      const order = markOrderPaidAndDeliver(mchOrderNo, {
        payOrderId: params.payOrderId || '',
        payMsg: getGatewayMsg(queryResp?.data || {}) || '异步回调并查单确认已支付',
      });
      if (!order) {
        paymentDebug('notify paid but order not found', { mchOrderNo, state });
        return res.type('text/plain').send('fail');
      }
      paymentDebug('notify paid processed', {
        mchOrderNo,
        payOrderId: params.payOrderId || '',
        state,
      });
      return res.type('text/plain').send('success');
    }

    const order = applyPayState(mchOrderNo, state, {
      payOrderId: params.payOrderId || '',
      payMsg: params.errMsg || '',
    });
    if (!order) {
      paymentDebug('notify state update failed: order not found', { mchOrderNo, state });
      return res.type('text/plain').send('fail');
    }

    paymentDebug('notify state updated', {
      mchOrderNo,
      payOrderId: params.payOrderId || '',
      state,
      errMsg: params.errMsg || '',
    });
    return res.type('text/plain').send('success');
  } catch (err) {
    console.error('notify error:', err.message);
    paymentDebug('notify exception', { message: err.message, stack: err.stack });
    return res.type('text/plain').send('fail');
  }
});

app.get('/admin/login', (req, res) => {
  if (req.session.admin) {
    return res.redirect('/admin');
  }
  res.render('admin/login');
});

app.post('/admin/login', (req, res) => {
  const username = String(req.body.username || '');
  const password = String(req.body.password || '');

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.admin = { username, loginAt: new Date().toISOString() };
    return res.redirect('/admin');
  }

  return redirectWithMsg(req, res, '/admin/login', '账号或密码错误');
});

app.get('/admin/logout', (req, res) => {
  req.session.admin = null;
  return redirectWithMsg(req, res, '/admin/login', '已退出登录');
});

app.get('/admin', requireAdmin, (req, res, next) => {
  try {
    const stats = getDashboardStats();
    const latestOrders = listLatestOrders(10);
    res.render('admin/dashboard', { stats, latestOrders });
  } catch (err) {
    next(err);
  }
});

app.get('/admin/products', requireAdmin, (req, res, next) => {
  try {
    const products = listAllProductsWithStock();
    res.render('admin/products', { products });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/products', requireAdmin, (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const description = String(req.body.description || '').trim();
    const price = Number(req.body.price || 0);

    if (!name || !price || price < 0) {
      return redirectWithMsg(req, res, '/admin/products', '商品名称和价格必填');
    }

    createProduct({
      name,
      description,
      price_cents: Math.round(price * 100),
    });

    redirectWithMsg(req, res, '/admin/products', '商品已创建');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/products/:id/toggle', requireAdmin, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    toggleProduct(id);
    redirectWithMsg(req, res, '/admin/products', '商品状态已更新');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/products/:id/delete', requireAdmin, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = deleteProduct(id);
    if (!result.ok) {
      return redirectWithMsg(req, res, '/admin/products', '该商品已有订单，不能删除');
    }
    redirectWithMsg(req, res, '/admin/products', '商品已删除');
  } catch (err) {
    next(err);
  }
});

app.get('/admin/cards', requireAdmin, (req, res, next) => {
  try {
    const products = listProductsBasic();
    const selectedProductId = Number(req.query.product_id || products[0]?.id || 0);
    const cardRows = selectedProductId ? listCardsByProduct(selectedProductId, 100) : [];
    const stockMapRows = listStockMapRows();

    res.render('admin/cards', {
      products,
      selectedProductId,
      cardRows,
      stockMapRows,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/cards/import', requireAdmin, (req, res, next) => {
  try {
    const productId = Number(req.body.product_id || 0);
    const rawText = String(req.body.cards || '');

    if (!productId || !rawText.trim()) {
      return redirectWithMsg(req, res, '/admin/cards', '请选择商品并输入卡密');
    }

    const lines = rawText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) {
      return redirectWithMsg(req, res, '/admin/cards?product_id=' + productId, '没有可导入的卡密');
    }

    const count = importCards(productId, lines);

    redirectWithMsg(req, res, '/admin/cards?product_id=' + productId, `导入成功，共 ${count} 条`);
  } catch (err) {
    next(err);
  }
});

app.get('/admin/orders', requireAdmin, (req, res, next) => {
  try {
    const page = req.query.page;
    const pageSize = req.query.page_size;
    const pager = listOrdersPaged({ page, pageSize });
    const pageSizeOptions = [20, 50, 100, 200];

    res.render('admin/orders', {
      orders: pager.rows,
      pagination: pager,
      pageSizeOptions,
      cleanupExpireMinutes: ORDER_EXPIRE_MINUTES,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/orders/:orderNo/check-pay', requireAdmin, async (req, res) => {
  const orderNo = String(req.params.orderNo || '').trim();
  const backUrl = buildAdminOrdersUrl(req);

  try {
    const paymentConfig = getPaymentConfig();
    if (!paymentConfig.enabled) {
      return redirectWithMsg(req, res, backUrl, '支付通道未启用');
    }

    const order = getOrderByNo(orderNo);
    if (!order) {
      return redirectWithMsg(req, res, backUrl, '订单不存在');
    }

    const response = await queryOrder(paymentConfig, {
      mchOrderNo: order.order_no,
      payOrderId: order.pay_order_id || '',
      reqTime: Date.now(),
    });

    if (!isSuccessCode(response.code)) {
      return redirectWithMsg(req, res, backUrl, `查单失败: ${getGatewayMsg(response) || '网关错误'}`);
    }

    const payData = response.data || {};
    const payState = resolvePayState(payData);

    applyPayState(order.order_no, payState, {
      payOrderId: payData.payOrderId || '',
      payMsg: getGatewayMsg(payData) || '',
    });

    if (payState === 2) {
      markOrderPaidAndDeliver(order.order_no, {
        payOrderId: payData.payOrderId || '',
        payMsg: '后台查单确认已支付',
      });
      return redirectWithMsg(req, res, backUrl, `订单 ${order.order_no} 支付成功，卡密已发放`);
    }

    return redirectWithMsg(req, res, backUrl, `订单 ${order.order_no} 当前支付状态: ${payState}`);
  } catch (err) {
    return redirectWithMsg(req, res, backUrl, err.message || '查单失败');
  }
});

app.post('/admin/orders/cleanup-unpaid', requireAdmin, (req, res) => {
  const backUrl = buildAdminOrdersUrl(req);
  const minutes = clampPositiveInt(req.body.expire_minutes, ORDER_EXPIRE_MINUTES);

  try {
    const result = cleanupUnpaidOrdersOlderThan(minutes);
    return redirectWithMsg(req, res, backUrl, `手动清理完成：删除 ${result.deletedCount} 条未支付订单（>${minutes}分钟）`);
  } catch (err) {
    return redirectWithMsg(req, res, backUrl, err.message || '手动清理失败');
  }
});

app.get('/admin/settings', requireAdmin, (req, res, next) => {
  try {
    res.render('admin/settings', {
      currentSiteName: getSiteName(),
      paymentConfig: getPaymentConfig(),
    });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/settings/site-name', requireAdmin, (req, res) => {
  try {
    const siteName = String(req.body.site_name || '');
    setSiteName(siteName);
    return redirectWithMsg(req, res, '/admin/settings', '站点名称已更新');
  } catch (err) {
    return redirectWithMsg(req, res, '/admin/settings', err.message || '更新失败');
  }
});

app.post('/admin/settings/payment', requireAdmin, (req, res) => {
  try {
    setPaymentConfig({
      enabled: req.body.enabled === 'on',
      unified_order_url: req.body.unified_order_url,
      query_order_url: req.body.query_order_url,
      mch_no: req.body.mch_no,
      app_id: req.body.app_id,
      app_secret: req.body.app_secret,
      way_code: req.body.way_code,
      callback_ip_check: req.body.callback_ip_check === 'on',
      callback_ip_whitelist: req.body.callback_ip_whitelist,
      notify_url: req.body.notify_url,
      return_url: req.body.return_url,
      subject_prefix: req.body.subject_prefix,
      body_text: req.body.body_text,
      version: req.body.version,
    });

    return redirectWithMsg(req, res, '/admin/settings', '支付配置已保存');
  } catch (err) {
    return redirectWithMsg(req, res, '/admin/settings', err.message || '保存失败');
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('服务器内部错误: ' + err.message);
});

app.listen(PORT, () => {
  const dbInfo = ensureDatabaseReady();
  console.log(`Simple Faka running: http://localhost:${PORT}`);
  console.log(`Admin backend: http://localhost:${PORT}/admin/login`);
  console.log(`Default admin: ${ADMIN_USER} / ${ADMIN_PASS}`);
  if (dbInfo.createdOnBoot) {
    console.log(`SQLite database created: ${dbInfo.dbFile}`);
  } else {
    console.log(`SQLite database ready: ${dbInfo.dbFile}`);
  }
  if (PAYMENT_DEBUG) {
    console.log('Payment debug logs: ENABLED (PAYMENT_DEBUG=true)');
  }
});

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const index = line.indexOf('=');
    if (index <= 0) continue;

    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function isSuccessCode(code) {
  const text = String(code || '').trim();
  return text === '0' || text.startsWith('0-');
}

function buildPublicUrl(req, pathname) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}${pathname}`;
}

function getClientIp(req) {
  const raw = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  return String(raw).split(',')[0].trim().replace('::ffff:', '').slice(0, 45);
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
    if (key.includes('sign')) {
      out[k] = maskText(v, 8);
      continue;
    }
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

function paymentDebug(event, payload) {
  if (!PAYMENT_DEBUG) return;
  if (payload === undefined) {
    console.log(`[payment-debug] ${new Date().toISOString()} ${event}`);
    return;
  }
  console.log(`[payment-debug] ${new Date().toISOString()} ${event}:`, payload);
}

function maskEmail(email) {
  const text = String(email || '').trim();
  const at = text.indexOf('@');
  if (at <= 1) return text ? '***' : '';
  return `${text.slice(0, 1)}***${text.slice(at)}`;
}

function redirectWithMsg(req, res, targetUrl, msg) {
  req.session.flashMsg = String(msg || '');
  return res.redirect(targetUrl);
}

function clampPositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function resolvePayState(payData) {
  const stateVal =
    payData && payData.orderState !== undefined && payData.orderState !== null && payData.orderState !== ''
      ? payData.orderState
      : payData && payData.state !== undefined
        ? payData.state
        : '';
  const n = Number(stateVal);
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

function getGatewayMsg(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return String(obj.errMsg || obj.msg || '').trim();
}

function buildAdminOrdersUrl(req) {
  const page = String((req.body && req.body.page) || req.query.page || '').trim();
  const pageSize = String((req.body && req.body.page_size) || req.query.page_size || '').trim();
  const parts = [];
  if (page) parts.push(`page=${encodeURIComponent(page)}`);
  if (pageSize) parts.push(`page_size=${encodeURIComponent(pageSize)}`);
  return `/admin/orders${parts.length ? `?${parts.join('&')}` : ''}`;
}
