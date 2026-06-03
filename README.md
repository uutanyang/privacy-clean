# PrivacyClean — Cloudflare Worker 订阅制工具

轻量、零服务器、纯浏览器处理。用户拖入文件 → 本地清除 EXIF/元数据 → 下载干净文件。付费解锁批量处理。

## 架构

```
用户浏览器 ←→ Cloudflare Worker (Hono API) ←→ Paddle Checkout
                      ↕
              Static Assets (public/)
                      ↕
              WASM Module (Rust → lossless stripping)
                      ↕
              Cloudflare KV (订阅状态 + 备份)
                      ↕
              Cloudflare Turnstile (人机验证)
                      ↕
              Resend (Magic Link 邮件, 3000封/天免费)
                      ↕
              Analytics Engine (使用追踪, 可选)
```

- **前端**：HTML + Tailwind + 原生 JS，WASM 无损剥离 + Canvas 回退
- **WASM**：Rust 编译的高性能 EXIF/PDF 解析器（47KB），替代 Canvas 重编码避免画质损失
- **后端**：Cloudflare Worker + Hono 路由，4 个 API 端点
- **邮件**：Resend API 发送 Magic Link（免费 3000 封/天），无 Key 时回退控制台打印
- **支付**：Paddle (Merchant of Record，替你扛 VAT/Sales Tax)
- **数据库**：Cloudflare KV（键值存储，免费额度 10 万读/天）
- **身份**：自建 Magic Link，无密码、无第三方依赖
- **安全**：Cloudflare Turnstile 人机验证 + KV Rate Limiting + 增强安全头
- **SEO**：3 个独立落地页（iPhone/Android/PDF），含 HowTo + FAQPage 结构化数据
- **分析**：Workers Analytics Engine（可选，需手动创建）
- **构建**：Vite + @cloudflare/vite-plugin

## 目录结构

```
privacy-clean/
├── src/
│   ├── index.ts               # Hono 应用（API 路由 + SPA fallback + Turnstile + Analytics）
│   └── lib/
│       ├── jwt.ts              # Web Crypto JWT（无外部依赖）
│       ├── paddle.ts           # Webhook 签名校验
│       └── email.ts            # Resend Magic Link 邮件（HTML+纯文本双格式 + Tags）
├── wasm/
│   ├── Cargo.toml              # Rust → WASM 构建配置
│   └── src/lib.rs              # JPEG/PNG/PDF 无损元数据剥离
├── public/
│   ├── js/
│   │   ├── app.js              # 前端逻辑 + WASM 加载器 + Paddle + Turnstile + 倒计时
│   │   └── landing-shared.js   # SEO 落地页共享 WASM 加载器
│   ├── wasm/                   # 编译产物（privacy_clean_wasm_bg.wasm 47KB）
│   ├── index.html              # 主落地页
│   ├── remove-exif-iphone.html # SEO: iPhone EXIF 移除（HowTo + FAQPage schema）
│   ├── remove-exif-android.html# SEO: Android EXIF 移除
│   ├── strip-pdf-metadata.html # SEO: PDF 元数据剥离
│   ├── privacy.html            # Privacy Policy (GDPR/CCPA)
│   └── terms.html              # Terms of Service
├── package.json
├── wrangler.jsonc              # Worker 配置
├── vite.config.ts
├── tsconfig.json
└── README.md
```

## WASM 无损剥离 vs Canvas 重编码

| 特性 | WASM（Rust） | Canvas（回退） |
|------|-------------|----------------|
| JPEG 画质 | **零损失**（仅删 APP1/APP13 段） | ~92% 重编码质量 |
| PNG 画质 | 零损失（仅删 tEXt/iTXt/zTXt/eXIf） | 零损失 |
| PDF 内容 | 保留原样（空值替换） | 保留原样 |
| 速度 | 极快（原生 WASM） | 较慢（需 Canvas 绘制） |
| 文件大小 | 可能更小（删除了元数据段） | 可能更大（重编码开销） |
| WASM 体积 | 47KB（gzip 更小） | 无需加载 |

## SEO 落地页

每个页面针对特定搜索意图优化，含结构化数据：

| 页面 | URL | 目标关键词 | Schema |
|------|-----|-----------|--------|
| iPhone | `/remove-exif-iphone` | remove EXIF iPhone, iPhone GPS remover | HowTo + FAQPage |
| Android | `/remove-exif-android` | remove EXIF Android, Samsung photo privacy | HowTo + FAQPage |
| PDF | `/strip-pdf-metadata` | strip PDF metadata, remove PDF author | HowTo + FAQPage |

### SEO 特性
- 每页独立的 `<title>` / `<meta description>` / `<link rel="canonical">`
- Open Graph + Twitter Card 元数据
- HowTo 结构化数据（3 步流程）
- FAQPage 结构化数据（4-5 个 FAQ，可能出现在搜索结果富摘要中）
- 独立 CTA（拖拽上传 + 清洗 + 下载）
- 页面间交叉链接（footer 导航）

## API 路由

| Method | Path | 说明 | 安全措施 |
|--------|------|------|----------|
| GET | `/api/health` | 健康检查 | 无 |
| POST | `/api/auth` | Magic Link 登录（action=request/verify） | Turnstile + Rate Limit (5/min) |
| GET | `/api/verify` | 查询订阅状态（Header: x-user-email） | 邮箱校验 |
| POST | `/api/webhook` | Paddle 支付回调 | HMAC-SHA256 签名验证 |

## 安全措施

| 措施 | 说明 |
|------|------|
| Cloudflare Turnstile | 登录表单人机验证，防机器人滥用（免费、隐私友好） |
| KV Rate Limiting | 登录接口 5 次/分钟/IP |
| HMAC-SHA256 JWT | Magic Link Token 签名验证 |
| Token 一次性使用 | 使用后标记 `used: true` |
| Paddle Webhook 签名 | 验证回调真实性 |
| CORS 白名单 | `ALLOWED_ORIGINS` 环境变量控制（空=开发模式） |
| HSTS | `max-age=63072000; includeSubDomains; preload` |
| CSP | API 响应 `default-src 'none'; frame-ancestors 'none'` |
| Permissions-Policy | 禁用 camera/microphone/geolocation |
| X-Frame-Options | DENY |
| X-Content-Type-Options | nosniff |
| KV 数据备份 | 写入时双写到 `user_backup:` Key，保留最近 3 份 + 90 天 TTL |

## 费用

| 服务 | 起步成本 |
|------|---------|
| Cloudflare Workers | **$0** (10万次请求/天) |
| Cloudflare KV | **$0** (10万读/天) |
| Cloudflare Turnstile | **$0** (无限量) |
| Cloudflare Analytics Engine | **$0** (10M 写/月) |
| Resend | **$0** (3,000 封/天) |
| Paddle | 交易额的 **5% + $0.50**（含税务处理） |

**月度固定成本：$0**

## 部署步骤

### 1. 前置准备

- [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（免费）
- [Resend 账号](https://resend.com/signup)（免费 3000 封/天）
- [Paddle Sandbox 账号](https://sandbox-vendors.paddle.com/)（测试用）
- 安装 Node.js 18+ 和 Rust (for WASM rebuild)

### 2. 安装 & 登录

```bash
cd privacy-clean
npm install
npx wrangler login
```

### 3. 构建 WASM（可选 — 已有预编译产物）

```bash
cd wasm
cargo install wasm-pack  # 如未安装
wasm-pack build --target web --out-dir ../public/wasm --release --no-opt
cd ..
```

### 4. 创建 KV 存储

```bash
npx wrangler kv namespace create "KV"
```

复制返回的 `id`，填入 `wrangler.jsonc`：

```jsonc
"kv_namespaces": [{ "binding": "KV", "id": "your_kv_id_here" }]
```

### 5. 创建 Analytics Engine（可选）

```bash
npx wrangler analytics-engine create privacy_clean_analytics
```

取消 `wrangler.jsonc` 中 `analytics_engine_datasets` 的注释。

### 6. 配置 Resend

1. 登录 [Resend Dashboard](https://resend.com/)
2. 添加并验证你的域名（DNS TXT/CNAME 记录）
3. 复制 API Key

```bash
npx wrangler secret put RESEND_API_KEY
```

### 7. 配置 Paddle

#### 7.1 获取 Token & Price ID

1. 登录 [Paddle Sandbox Dashboard](https://sandbox-vendors.paddle.com/)
2. 创建 Catalog → Product → Price（订阅价 + 买断价两个 Price）
3. 记录 **Price ID**（如 `pri_01j...`）
4. 进入 Developer Tools → Authentication → 复制 **Client-side Token** 和 **Webhook Secret**

#### 7.2 填入前端

编辑 `public/js/app.js`：

```js
const PADDLE_CLIENT_TOKEN = 'your_sandbox_client_token';
const PADDLE_PRICE_ID = 'pri_your_subscription_price_id';
const PADDLE_LIFETIME_PRICE_ID = 'pri_your_lifetime_price_id';
```

#### 7.3 设置 Secrets

```bash
npx wrangler secret put PADDLE_WEBHOOK_SECRET
npx wrangler secret put JWT_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
```

### 8. 配置 Turnstile（推荐）

1. 在 [Cloudflare Dashboard](https://dash.cloudflare.com/?to=/:account/turnstile) 创建 Turnstile Site
2. 复制 **Site Key** 和 **Secret Key**
3. 前端 `public/js/app.js` 填入 `TURNSTILE_SITE_KEY`
4. 后端 `npx wrangler secret put TURNSTILE_SECRET_KEY`

### 9. 配置 CORS（生产环境）

在 `wrangler.jsonc` 的 `vars` 中设置允许的域名：

```jsonc
"vars": {
  "ALLOWED_ORIGINS": "https://privacyclean.app,https://www.privacyclean.app"
}
```

### 10. 本地开发

```bash
npm run dev
```

打开 `http://localhost:8787`

### 11. 部署

```bash
npm run deploy
```

#### 11.1 配置 Paddle Webhook 回调地址

在 Paddle Dashboard → Developer → Webhooks：

```
https://privacy-clean.<your-subdomain>.workers.dev/api/webhook
```

勾选事件：
- `transaction.completed`
- `subscription.activated`
- `subscription.updated`
- `subscription.canceled`

#### 11.2 切到生产环境

1. 在 Paddle 开通正式账号
2. 前端 `PADDLE_ENV` 改为 `'production'`
3. 前端 `PADDLE_CLIENT_TOKEN` 和 `PADDLE_PRICE_ID` 替换为生产值
4. `npx wrangler secret put PADDLE_WEBHOOK_SECRET` 更新为生产密钥
5. `wrangler.jsonc` 设置 `ALLOWED_ORIGINS` 为生产域名
6. 重新部署

## 收款路径

```
用户付费 → Paddle (自动处理 VAT/Sales Tax) → Paddle 结算 → 打款至你的银行卡
```

- **无需注册美国公司**
- **无需自己申报税务**
- **Paddle 作为 Merchant of Record 全扛**
- 支持提现至国内银行卡（电汇）或 Wise

## 定价

| 层级 | 功能 | 价格 |
|------|------|------|
| Free | 单文件处理 | $0 |
| Pro | 批量文件夹、生成清理报告、优先支持 | **$4/月** 或 **$39/年** |
| Lifetime | Pro 全部功能 + 永久可用 + 未来更新 | **$89 买断** |

## 常见问题

**Q: KV 免费额度够用吗？**
A: 10 万次读取/天 = 支持约 3000 个日活用户查询订阅状态，绰绰有余。

**Q: Paddle 支持中国开发者吗？**
A: 支持。KYC 用护照即可，无需美国公司。

**Q: WASM 剥离和 Canvas 重编码有什么区别？**
A: WASM 直接删除 JPEG/PNG 中的元数据段（APP1/APP13/tEXt 等），图像数据逐字节不变——零画质损失。Canvas 重编码需要将图片绘制到 Canvas 再 toBlob，JPEG 会有 ~8% 的重编码质量损失。WASM 不可用时自动回退到 Canvas。

**Q: Resend 免费额度够用吗？**
A: 3000 封/天对初期产品完全足够。Magic Link 邮件很小，远低于额度。未配置 RESEND_API_KEY 时自动回退到控制台打印。

**Q: Turnstile 是必须的吗？**
A: 不是必须的。不配置时前端不显示验证组件，后端跳过验证。但生产环境强烈推荐开启。

**Q: Analytics Engine 有额外费用吗？**
A: 免费额度 1000 万写入/月，对小型工具完全够用。超出后按 $0.25/百万写入计费。

**Q: SEO 落地页需要额外部署吗？**
A: 不需要。它们是 `public/` 目录下的静态 HTML，随 Worker 一起部署，零额外成本。
