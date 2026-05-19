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
  addPaymentLog,
  getDashboardStats,
  listLatestOrders,
  listProductsBasic,
  listStockMapRows,
  listCardsByProduct,
  listOrdersPaged,
  listPaymentLogsPaged,
  deleteOrderByNo,
  cleanupUnpaidOrdersOlderThan,
  ensureDatabaseReady,
  getSiteName,
  setSiteName,
  getPaymentConfig,
  setPaymentConfig,
} = require('./store');
const { createPayment, queryPayment, queryMerchantInfo, buildSign, verifySign } = require('./payment');

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

    const notifyUrl = paymentConfig.notify_url || buildPublicUrl(req, '/payment/notify/heisenlin');
    const returnUrl = paymentConfig.return_url || buildPublicUrl(req, `/payment/return/${orderNo}`);
    const createPayload = {
      type: paymentConfig.pay_type,
      outTradeNo: order.order_no,
      name: `${paymentConfig.subject_prefix}-${order.product_name}`.slice(0, 127),
      money: centsToYuan(order.amount_cents),
      clientIp: getClientIp(req),
      device: paymentConfig.device || detectDevice(req),
      notifyUrl,
      returnUrl,
      param: JSON.stringify({ orderNo: order.order_no }),
    };

    paymentDebug('start pay request', {
      orderNo: order.order_no,
      mapiUrl: paymentConfig.mapi_url,
      payload: sanitizeForLog(createPayload),
    });
    writePaymentLog(
      'create_payment_request',
      order.order_no,
      buildCreatePaymentLogRequest(paymentConfig, createPayload)
    );

    const response = await createPayment(paymentConfig, createPayload);
    writePaymentLog('create_payment_response', order.order_no, response);
    paymentDebug('start pay response summary', {
      orderNo: order.order_no,
      code: response && response.code,
      msg: response && response.msg,
      tradeNo: response && response.trade_no,
      payurl: response && response.payurl,
      qrcode: response && response.qrcode,
      urlscheme: response && response.urlscheme,
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

    const payUrl = String(response.payurl || response.qrcode || response.urlscheme || '').trim();
    if (!payUrl) {
      deleteOrderByNo(order.order_no);
      return redirectWithMsg(req, res, '/', '下单失败: 未返回有效支付链接');
    }

    updateOrderPaymentCreated(order.order_no, {
      payOrderId: response.trade_no || '',
      payUrl,
      payState: 1,
      payMsg: getGatewayMsg(response) || '',
    });

    return res.redirect(`/order/${order.order_no}`);
  } catch (err) {
    writePaymentLog('create_payment_exception', createdOrderNo, { message: err.message, stack: err.stack }, 'error');
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

    writePaymentLog(
      'order_check_query_request',
      order.order_no,
      buildQueryPaymentLogRequest(paymentConfig, {
        outTradeNo: order.order_no,
        tradeNo: order.pay_order_id || '',
      })
    );
    const response = await queryPayment(paymentConfig, {
      outTradeNo: order.order_no,
      tradeNo: order.pay_order_id || '',
    });
    writePaymentLog('order_check_query_response', order.order_no, response);

    if (!isSuccessCode(response.code)) {
      return redirectWithMsg(req, res, `/order/${orderNo}`, `查单失败: ${getGatewayMsg(response) || '网关错误'}`);
    }

    const payState = resolvePayState(response);

    applyPayState(order.order_no, payState, {
      payOrderId: response.trade_no || '',
      payMsg: getGatewayMsg(response) || '',
    });

    if (payState === 2) {
      markOrderPaidAndDeliver(order.order_no, {
        payOrderId: response.trade_no || '',
        payMsg: '主动查单确认已支付',
      });
      return redirectWithMsg(req, res, `/order/${orderNo}`, '支付成功，卡密已发放');
    }

    return redirectWithMsg(req, res, `/order/${orderNo}`, `当前支付状态: ${payStateText(payState)}`);
  } catch (err) {
    return redirectWithMsg(req, res, `/order/${orderNo}`, err.message || '查单失败');
  }
});

app.get('/payment/return/:orderNo', (req, res) => {
  const orderNo = String(req.params.orderNo || '').trim();
  return redirectWithMsg(req, res, `/order/${orderNo}`, '已返回商户站点，请点击查单确认支付结果');
});

async function paymentNotifyHandler(req, res) {
  try {
    const paymentConfig = getPaymentConfig();
    if (!paymentConfig.enabled) {
      paymentDebug('notify ignored: payment disabled');
      return res.type('text/plain').send('fail');
    }

    const hasBody = req.body && Object.keys(req.body).length > 0;
    const params = hasBody ? req.body : req.query;
    const callbackOrderNo = String((params && params.out_trade_no) || '').trim();
    writePaymentLog('notify_received', callbackOrderNo, {
      method: req.method,
      callerIp: getClientIp(req),
      hasBody,
      params,
    });
    paymentDebug('notify received', {
      method: req.method,
      callerIp: getClientIp(req),
      hasBody,
      params: sanitizeForLog(params),
    });

    if (!verifySign(params, paymentConfig.key)) {
      writePaymentLog('notify_sign_failed', callbackOrderNo, { params }, 'warn');
      paymentDebug('notify sign verify failed', { params: sanitizeForLog(params) });
      return res.type('text/plain').send('fail');
    }

    if (String(params.pid || '') !== String(paymentConfig.pid || '')) {
      writePaymentLog(
        'notify_pid_mismatch',
        callbackOrderNo,
        { incomingPid: params.pid || '', configPid: paymentConfig.pid || '', params },
        'warn'
      );
      paymentDebug('notify rejected: pid mismatch', {
        incomingPid: params.pid || '',
        configPid: paymentConfig.pid || '',
      });
      return res.type('text/plain').send('fail');
    }

    const orderNo = String(params.out_trade_no || '').trim();
    if (!orderNo) {
      writePaymentLog('notify_missing_order_no', '', { params }, 'warn');
      paymentDebug('notify rejected: missing out_trade_no', { params: sanitizeForLog(params) });
      return res.type('text/plain').send('fail');
    }

    const callbackState = resolvePayState(params);
    if (callbackState === 2) {
      writePaymentLog(
        'notify_verify_query_request',
        orderNo,
        buildQueryPaymentLogRequest(paymentConfig, {
          outTradeNo: orderNo,
          tradeNo: params.trade_no || '',
        })
      );
      const queryResp = await queryPayment(paymentConfig, {
        outTradeNo: orderNo,
        tradeNo: params.trade_no || '',
      });
      writePaymentLog('notify_verify_query_response', orderNo, queryResp);

      if (!isSuccessCode(queryResp.code)) {
        writePaymentLog(
          'notify_verify_query_failed',
          orderNo,
          { tradeNo: params.trade_no || '', queryCode: queryResp.code, queryResp },
          'warn'
        );
        paymentDebug('notify paid verify failed: query api error', {
          orderNo,
          tradeNo: params.trade_no || '',
          queryCode: queryResp.code,
          queryMsg: getGatewayMsg(queryResp),
        });
        return res.type('text/plain').send('fail');
      }

      const queryState = resolvePayState(queryResp || {});
      if (queryState !== 2) {
        writePaymentLog(
          'notify_verify_query_unpaid',
          orderNo,
          { tradeNo: params.trade_no || '', queryState, queryResp },
          'warn'
        );
        paymentDebug('notify paid verify failed: query state not success', {
          orderNo,
          tradeNo: params.trade_no || '',
          queryState,
        });
        return res.type('text/plain').send('fail');
      }

      const order = markOrderPaidAndDeliver(orderNo, {
        payOrderId: params.trade_no || '',
        payMsg: getGatewayMsg(queryResp || {}) || '异步回调并查单确认已支付',
      });
      if (!order) {
        writePaymentLog('notify_paid_order_not_found', orderNo, { tradeNo: params.trade_no || '' }, 'warn');
        paymentDebug('notify paid but order not found', { orderNo, callbackState });
        return res.type('text/plain').send('fail');
      }
      writePaymentLog('notify_paid_processed', orderNo, { tradeNo: params.trade_no || '', callbackState });
      paymentDebug('notify paid processed', {
        orderNo,
        tradeNo: params.trade_no || '',
        callbackState,
      });
      return res.type('text/plain').send('success');
    }

    const order = applyPayState(orderNo, callbackState, {
      payOrderId: params.trade_no || '',
      payMsg: params.msg || '',
    });
    if (!order) {
      writePaymentLog(
        'notify_state_update_order_not_found',
        orderNo,
        { tradeNo: params.trade_no || '', callbackState, params },
        'warn'
      );
      paymentDebug('notify state update failed: order not found', { orderNo, callbackState });
      return res.type('text/plain').send('fail');
    }

    writePaymentLog('notify_state_updated', orderNo, { tradeNo: params.trade_no || '', callbackState, params });
    paymentDebug('notify state updated', {
      orderNo,
      tradeNo: params.trade_no || '',
      callbackState,
      msg: params.msg || '',
    });
    return res.type('text/plain').send('success');
  } catch (err) {
    writePaymentLog('notify_exception', '', { message: err.message, stack: err.stack }, 'error');
    console.error('notify error:', err.message);
    paymentDebug('notify exception', { message: err.message, stack: err.stack });
    return res.type('text/plain').send('fail');
  }
}

app.all('/payment/notify/heisenlin', paymentNotifyHandler);
app.all('/payment/notify/cfyle', paymentNotifyHandler);

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

app.get('/admin/payment-logs', requireAdmin, (req, res, next) => {
  try {
    const page = req.query.page;
    const pageSize = req.query.page_size;
    const logType = req.query.log_type;
    const pager = listPaymentLogsPaged({ page, pageSize, logType });
    const pageSizeOptions = [20, 50, 100, 200];
    res.render('admin/payment-logs', {
      logs: pager.rows,
      pagination: pager,
      pageSizeOptions,
      currentLogType: pager.logType,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/admin/merchant-info', requireAdmin, (req, res) => {
  return res.render('admin/merchant-info', {
    merchantInfo: null,
    queryError: '',
    queriedAt: '',
  });
});

app.post('/admin/merchant-info/query', requireAdmin, async (req, res) => {
  try {
    const paymentConfig = getPaymentConfig();
    if (!paymentConfig.pid || !paymentConfig.key || !paymentConfig.api_url) {
      return res.render('admin/merchant-info', {
        merchantInfo: null,
        queryError: '请先在系统设置中填写 pid/key/api_url',
        queriedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      });
    }

    writePaymentLog('merchant_query_request', '', buildMerchantQueryLogRequest(paymentConfig));
    const data = await queryMerchantInfo(paymentConfig);
    writePaymentLog('merchant_query_response', '', data);
    writePaymentLog('merchant_query', '', { code: data.code, msg: data.msg || '' });
    return res.render('admin/merchant-info', {
      merchantInfo: data,
      queryError: '',
      queriedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    });
  } catch (err) {
    writePaymentLog('merchant_query_error', '', { message: err.message }, 'warn');
    return res.render('admin/merchant-info', {
      merchantInfo: null,
      queryError: err.message || '查询失败',
      queriedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    });
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

    writePaymentLog(
      'admin_order_check_query_request',
      order.order_no,
      buildQueryPaymentLogRequest(paymentConfig, {
        outTradeNo: order.order_no,
        tradeNo: order.pay_order_id || '',
      })
    );
    const response = await queryPayment(paymentConfig, {
      outTradeNo: order.order_no,
      tradeNo: order.pay_order_id || '',
    });
    writePaymentLog('admin_order_check_query_response', order.order_no, response);

    if (!isSuccessCode(response.code)) {
      return redirectWithMsg(req, res, backUrl, `查单失败: ${getGatewayMsg(response) || '网关错误'}`);
    }

    const payState = resolvePayState(response);

    applyPayState(order.order_no, payState, {
      payOrderId: response.trade_no || '',
      payMsg: getGatewayMsg(response) || '',
    });

    if (payState === 2) {
      markOrderPaidAndDeliver(order.order_no, {
        payOrderId: response.trade_no || '',
        payMsg: '后台查单确认已支付',
      });
      return redirectWithMsg(req, res, backUrl, `订单 ${order.order_no} 支付成功，卡密已发放`);
    }

    return redirectWithMsg(req, res, backUrl, `订单 ${order.order_no} 当前支付状态: ${payStateText(payState)}`);
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
      mapi_url: req.body.mapi_url,
      api_url: req.body.api_url,
      pid: req.body.pid,
      key: req.body.key,
      pay_type: req.body.pay_type,
      device: req.body.device,
      notify_url: req.body.notify_url,
      return_url: req.body.return_url,
      subject_prefix: req.body.subject_prefix,
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
  return text === '1' || text === '0' || text.startsWith('0-');
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
  if (!payData || typeof payData !== 'object') return 1;

  const tradeStatus = String(payData.trade_status || '').trim().toUpperCase();
  if (tradeStatus) {
    return tradeStatus === 'TRADE_SUCCESS' ? 2 : 0;
  }

  if (payData.status !== undefined && payData.status !== null && payData.status !== '') {
    const status = Number(payData.status);
    return status === 1 ? 2 : 0;
  }

  const stateVal =
    payData.orderState !== undefined && payData.orderState !== null && payData.orderState !== ''
      ? payData.orderState
      : payData.state !== undefined
        ? payData.state
        : '';
  const n = Number(stateVal);
  if (Number.isInteger(n) && n >= 0) {
    return n === 1 ? 1 : n;
  }
  return 1;
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

function writePaymentLog(scene, orderNo, payload, level = 'info') {
  try {
    addPaymentLog(scene, orderNo, JSON.stringify(payload || {}), level);
  } catch (_err) {
    // ignore log write failure
  }
}

function buildCreatePaymentLogRequest(paymentConfig, payload) {
  const body = {
    pid: String(paymentConfig.pid || ''),
    type: String(payload.type || paymentConfig.pay_type || ''),
    out_trade_no: String(payload.outTradeNo || ''),
    notify_url: String(payload.notifyUrl || ''),
    return_url: String(payload.returnUrl || ''),
    name: String(payload.name || ''),
    money: String(payload.money || ''),
    clientip: String(payload.clientIp || ''),
    device: String(payload.device || paymentConfig.device || ''),
    param: String(payload.param || ''),
    sign_type: 'MD5',
  };
  body.sign = buildSign(body, paymentConfig.key);
  return {
    url: paymentConfig.mapi_url,
    method: 'POST',
    body,
  };
}

function buildQueryPaymentLogRequest(paymentConfig, payload) {
  return {
    url: paymentConfig.api_url,
    method: 'GET',
    params: {
      act: 'order',
      pid: String(paymentConfig.pid || ''),
      key: String(paymentConfig.key || ''),
      trade_no: String(payload.tradeNo || ''),
      out_trade_no: String(payload.outTradeNo || ''),
    },
  };
}

function buildMerchantQueryLogRequest(paymentConfig) {
  return {
    url: paymentConfig.api_url,
    method: 'GET',
    params: {
      act: 'query',
      pid: String(paymentConfig.pid || ''),
      key: String(paymentConfig.key || ''),
    },
  };
}

function payStateText(state) {
  const n = Number(state);
  if (n === 0) return '未支付';
  if (n === 1) return '支付中';
  if (n === 2) return '支付成功';
  if (n === 3) return '支付失败';
  if (n === 4) return '支付关闭';
  if (n === 5) return '已退款';
  if (n === 6) return '订单关闭';
  return `状态码${state}`;
}

function centsToYuan(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function detectDevice(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('micromessenger')) return 'wechat';
  if (ua.includes('qq/')) return 'qq';
  if (ua.includes('alipayclient')) return 'alipay';
  if (ua.includes('mobile')) return 'mobile';
  return 'pc';
}
