# 织点网络 原型 部署指南

原型阶段用 HTTP 跑,供自己与朋友试用。约 30 分钟(不含 DNS 生效)。

## 前置
- 1 台云服务器(1 核 1G 即可,境外 VPS 可免备案试用)
- 1 个域名(下文以 `yourdomain.com` 代指)

## 1. DNS
控制台加两条 A 记录:
```
@    A    <服务器IP>      # 主域名 → 管理面板
*    A    <服务器IP>      # 泛子域名 → 用户站点
```
验证:`dig +short yourdomain.com` 与 `dig +short test.yourdomain.com` 都指向服务器 IP。

## 2. 服务器环境
```bash
# Node 22+
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
apt install -y nginx
mkdir -p /data/sites /data/tmp
```

## 3. 部署代码
```bash
git clone https://github.com/DevelopmentZheng/zhidian-network.git /opt/zhidian
cd /opt/zhidian
npm install --omit=dev
```

## 4. Nginx
```bash
sed 's/__DOMAIN__/yourdomain.com/g' nginx.conf > /etc/nginx/conf.d/zhidian.conf
nginx -t && systemctl reload nginx
```

## 5. 启动应用
```bash
SITE_DOMAIN=yourdomain.com DATA_DIR=/data PORT=3000 node src/server.js
# 生产用 pm2/systemd 守护:
# pm2 start src/server.js --name zhidian --env-file=.env
```
建议写 `.env`:
```
SITE_DOMAIN=yourdomain.com
DATA_DIR=/data
PORT=3000
MAX_UPLOAD_MB=50
MAX_SITE_SIZE_MB=100
```

## 6. 验证
1. 打开 `http://yourdomain.com` → 看到登录页
2. 注册账号
3. 新建站点 → 上传一个含 `index.html` 的 ZIP
4. 访问 `http://<子域名>.yourdomain.com` → 看到你的网站
5. 重启服务器 → 用户/站点/文件仍在

## 7. 备份(简易)
```bash
# 每日 rsync 到另一台机器
rsync -a /data/ backup-host:/backup/zhidian-$(date +%F)/
```

## 常见问题
- **上传 413**:Nginx `client_max_body_size` 与 `MAX_UPLOAD_MB` 都要调。
- **子域名 404**:确认 `/data/sites/<子域名>/index.html` 存在;Nginx `root` 路径正确。
- **cookie 不生效**:原型 HTTP 下 Cookie 非 Secure,正常;若用 HTTPS 记得把 server.js 的 `secure:false` 改回 `true`。

## 上线前必补(欠债清单,见 docs/prototype-stage0.md 第 9 节)
- HTTPS + 泛域名证书;Cookie 改 Secure
- 限流、CSRF/Origin 校验
- 删除站点子域名冷却期
- 内容举报与人工下架流程
- 显式管理员初始化(不要靠"首个注册者即管理员"对外公开)
