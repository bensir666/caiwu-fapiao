# 供应商发票跟踪

记录每个供应商应该给我们开多少发票、已经开了多少、还欠多少。分**电商**和**工厂**两个板块，手机和电脑都能用。

## 能做什么

- **对账单**：跟单员和供应商对完账后，在系统里创建对账单并自己复核提交，财务终审。终审通过后，金额才计入「应开票额」。已生效的单据不能改，要冲减就开调整单（金额填负数）。供应商也可以填系统的 Excel 对账单模板，跟单员一键导入。
- **发票**：上传数电发票的 XML 或 PDF，系统读出发票号码、金额、销售方和购买方，然后：
  - 按购买方税号判断属于哪个板块（我方受票主体）。
  - 按销售方税号找到开票主体，再找到对应的供应商。
  - 同一个开票主体如果被几个供应商共用，就看谁在这个板块有欠票；有多家欠票时，放进「待处理」由财务手动分配。
  - 重复上传、金额对不上、购买方不是我方、开票主体没登记的发票，都会放进「待处理」。
  - 红字发票会自动冲减已开票额。供应商只在一个板块供货、发票却开到了另一个板块时，系统会自动改归，财务也可以手动改板块（跨板块核销）。
  - OFD 和照片暂时不能自动识别，需要手工填写，原件照样存档。
- **欠票总览和账龄**：按供应商和板块显示应开、已开、欠票，以及 0–30、31–60、61–90、90 天以上四段账龄（先开的票先抵最早的单）。
- **催票**：每个欠票的供应商都配好一段可以直接复制发送的话术。
- **税费成本**：有些供应商开票时我方要另付税费。这部分单独记录，不影响欠票；新入账的发票会提醒财务登记。
- **期初欠票**：系统启用前的历史欠票，按供应商分电商和工厂填总额。
- **导出 Excel**：欠票总览（含账龄）、发票明细、税费成本。
- **留痕**：创建、修改、终审、驳回、入账、删除等操作都会记录。

## 角色

| 角色 | 能做什么 |
|---|---|
| 跟单员 | 只看分配给自己的供应商；创建、复核、提交对账单；上传发票；看欠票和催票话术 |
| 财务 | 看全部；终审或驳回对账单；处理待处理发票；改发票板块；登记税费成本；维护基础资料；导出报表；看操作记录 |
| 管理员 | 财务能做的都能做，另外管理用户和系统设置 |

## 部署（Docker，推荐）

需要一台装了 Docker 的 Linux 服务器（阿里云或腾讯云的 1 核 2G 就够用）。

```bash
git clone https://github.com/bensir666/caiwu-fapiao.git
cd caiwu-fapiao
# 国内服务器建议先打开 docker-compose.yml，把 npmmirror 那两行的注释去掉，构建会快很多
docker compose up -d --build
docker compose logs app        # 第一次启动会打印管理员 admin 的初始密码
```

然后在服务器上访问 `http://127.0.0.1:3000`。默认只监听本机，对外访问要通过 Nginx 或 Caddy 加 HTTPS，配置见下文。如果只是先在内网试用，可以把 `docker-compose.yml` 里的 `127.0.0.1:3000:3000` 改成 `3000:3000`。

数据都在 `./data` 目录：`invoice.db` 是数据库，`uploads/` 是发票原件。

### 配 HTTPS（Caddy 最省事）

```
# /etc/caddy/Caddyfile
fapiao.你的域名.com {
    reverse_proxy 127.0.0.1:3000
}
```

配好之后，把 `docker-compose.yml` 里的 `COOKIE_SECURE` 改成 `"1"`，再执行 `docker compose up -d`。

用 Nginx 的话：

```nginx
server {
    listen 443 ssl;
    server_name fapiao.你的域名.com;
    # ssl_certificate / ssl_certificate_key 按你的证书填写
    client_max_body_size 25m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 升级

```bash
git pull
docker compose up -d --build
```

升级只替换程序，`./data` 里的数据不受影响。升级前建议先备份一次。

### 备份

建议每天备份一次，并把备份拷到另一台机器或对象存储上。

```bash
# 数据库在线备份，存到 data/backups/，自动保留最近 30 份
docker compose exec app node src/backup.js
# 发票原件
tar czf uploads-$(date +%F).tgz data/uploads
```

放进 crontab，每天凌晨 2 点执行：

```
0 2 * * * cd /路径/caiwu-fapiao && docker compose exec -T app node src/backup.js && tar czf data/backups/uploads-$(date +\%F).tgz data/uploads
```

恢复时先停服务，再用备份文件替换 `data/invoice.db`（同时删掉 `invoice.db-wal` 和 `invoice.db-shm`），然后重新启动。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | 3000 | 监听端口 |
| `DATA_DIR` | `/data`（Docker） | 数据库和原件存放目录 |
| `ADMIN_USERNAME` | admin | 第一次启动时创建的管理员账号 |
| `ADMIN_PASSWORD` | 随机 | 管理员初始密码；不填会随机生成，打印在日志里，首次登录必须修改 |
| `COOKIE_SECURE` | 0 | 配了 HTTPS 后设为 1 |
| `TZ` | Asia/Shanghai | 时区 |

## 第一次使用的顺序

1. 用 admin 登录并修改密码。在「用户与设置」里填写**公司名称**和**启用日**（期初欠票按这一天计算账龄），再给跟单员和财务建账号。
2. 在「基础资料 → 我方受票主体」里登记电商和工厂所有收票公司的名称和税号。**这一步决定了发票归哪个板块**，没登记的购买方都会进待处理。
3. 在「基础资料 → 批量导入」里下载**供应商资料模板**，填好供应商、供应板块、税率、是否另付税费、跟单员用户名、开票主体（全称和税号）、电商和工厂的期初欠票，然后上传。系统会先预检，确认后再写入。
4. 在「期初欠票」里核对一遍金额。
5. 之后的日常流程：跟单员录对账单，财务终审；收到发票就上传；财务每天看一眼「待处理」和「税费成本」里的提醒。

## 本地开发

需要 Node.js 20 或更高版本。

```bash
cd server && npm install && npm run dev      # 后端：http://localhost:3000，数据在 server/data
cd web && npm install && npm run dev         # 前端：http://localhost:5173，/api 会转发到 3000
cd server && npm test                        # 自动化测试
```

代码结构：

- `server/src/app.js`：登录、用户、设置、操作记录
- `server/src/routes/`：基础资料、对账单、发票和税费成本、报表
- `server/src/classify.js`：发票归属规则
- `server/src/parsers.js`：数电 XML 和 PDF 识别
- `server/src/money.js`：金额换算、欠票和账龄计算
- `web/src/views/`：各个页面
