# 简易自动发卡平台（含后台）

## 功能
- 前台商品展示、下单
- 下单后发起支付，支付成功后自动发卡
- 后台登录
- 后台系统设置（站点名称可配置）
- 后台支付配置（网关地址、商户号、AppId、密钥、通道编码）
- 后台商品管理（增/删/上下架）
- 后台卡密批量导入（每行一条）
- 后台订单查看

## 技术栈
- Node.js
- Express
- EJS
- SQLite（`data/store.db`）

## 启动
1. 安装依赖
   ```bash
   npm install
   ```
2. 配置环境变量
   - 复制 `.env.example` 为 `.env`
   - 修改后台账号密码和 `SESSION_SECRET`
3. 运行
   ```bash
   npm start
   ```
4. 访问
   - 前台: `http://localhost:3000`
   - 后台: `http://localhost:3000/admin/login`

## Docker Compose（Ubuntu 部署）
仓库地址：`https://github.com/yangye2/Faka.git`

### 首次部署
1. 安装 Docker 与 Compose 插件
   ```bash
   sudo apt update
   sudo apt install -y git docker.io docker-compose-plugin
   sudo systemctl enable --now docker
   ```
2. 拉取项目
   ```bash
   sudo mkdir -p /opt
   cd /opt
   sudo git clone https://github.com/yangye2/Faka.git faka
   cd /opt/faka
   ```
3. 配置环境变量
   ```bash
   cp .env.example .env
   ```
   - 请至少修改：`SESSION_SECRET`、`ADMIN_USER`、`ADMIN_PASS`
4. 构建并启动
   ```bash
   sudo docker compose up -d --build
   ```
5. 查看运行状态
   ```bash
   sudo docker compose ps
   sudo docker compose logs -f faka
   ```
6. 访问
   - 前台：`http://服务器IP:3000`
   - 后台：`http://服务器IP:3000/admin/login`

### 数据持久化
- SQLite 数据库存放在容器内 `/app/data/store.db`
- 已通过 `docker-compose.yml` 挂载到宿主机 `./data`，重建容器不会丢数据
- 如果 `data/store.json` 存在且数据库为空，服务首次启动会自动迁移旧 JSON 数据到 SQLite

### 升级说明（Git + Docker）
在 `/opt/faka` 目录执行：

1. 备份数据（建议）
   ```bash
   cp -r data data.bak.$(date +%F_%H%M%S)
   cp .env .env.bak.$(date +%F_%H%M%S)
   ```
2. 拉取最新代码
   ```bash
   git pull
   ```
3. 重新构建并启动
   ```bash
   sudo docker compose up -d --build
   ```
4. 检查状态和日志
   ```bash
   sudo docker compose ps
   sudo docker compose logs --tail=200 faka
   ```

### 常用运维命令
```bash
# 启动/重启
sudo docker compose up -d

# 停止
sudo docker compose down

# 实时日志
sudo docker compose logs -f faka

# 查看容器资源
sudo docker stats
```

### 常见问题：`unable to open database file`
如果容器日志出现：
```text
Error: unable to open database file
```
通常是宿主机挂载目录权限导致。可执行：
```bash
cd /opt/faka
sudo mkdir -p data
sudo chmod -R 775 data
sudo docker compose up -d --build
```

## 默认后台账号
- 用户名: `admin`
- 密码: `admin123`

> 仅为演示版，不包含真实支付回调、风控、审计日志、加密存储等生产能力。

## 支付对接说明（已接入）
- 下单接口：`/api/pay/unifiedOrder`
- 查单接口：`/api/pay/query`
- 本地回调地址：`/payment/notify/cfyle`
- 回调处理后返回：`success`（小写）
- 支持配置固定地址：
  - 下单URL：`https://mchapi.ttcfapi.com/api/pay/unifiedOrder`
  - 查单URL：`https://mchapi.ttcfapi.com/api/pay/query`
  - 回调IP白名单：`47.238.166.160,123.129.241.66,192.140.174.29,123.129.241.76,27.25.147.190`
