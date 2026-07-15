# 管理端功能文档

## 1. 概述

管理端提供站点审核、站点管理、用户管理等后台功能，仅管理员账号可访问。

## 2. 管理员角色

### 2.1 数据库字段

`users` 表新增 `is_admin` 字段：

```sql
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
```

### 2.2 设置管理员

通过数据库直接设置：

```bash
sqlite3 data/zhidian.db "UPDATE users SET is_admin = 1 WHERE username = 'your_username';"
```

### 2.3 权限校验

后端通过 `requireAdmin` 中间件校验管理员权限：

```javascript
const requireAdmin = async (c, next) => {
  const user = userFromToken(getCookie(c, 'session'));
  if (!user) return c.json({ error: '请先登录' }, 401);
  if (!user.is_admin) return c.json({ error: '无管理员权限' }, 403);
  c.set('user', user);
  await next();
};
```

## 3. 管理端页面

### 3.1 入口

管理员登录后，导航栏会显示「管理后台」按钮，点击进入管理端页面。

### 3.2 页面结构

管理端包含三个标签页：

| 标签页 | ID | 功能 |
|--------|-----|------|
| 审核队列 | `moderations` | 查看审核记录、人工裁决 |
| 站点管理 | `sites` | 管理所有站点、上线/下线/删除 |
| 用户管理 | `users` | 管理用户、设置管理员权限 |

## 4. API 接口

### 4.1 审核队列

#### 获取审核记录

```
GET /api/admin/moderations?status=all|suspect|rejected
```

**参数**：
- `status`（可选）：筛选状态，默认 `all`

**响应**：

```json
{
  "moderations": [
    {
      "id": 1,
      "site_id": 1,
      "status": "rejected",
      "dimension": "pornography",
      "confidence": 80,
      "reason": "🔞 色情低俗内容检测",
      "file_path": "index.html",
      "content_snippet": "...色情网站...",
      "model_used": "rule_engine",
      "site_name": "测试站点",
      "subdomain": "test",
      "user_name": "testuser",
      "created_at": "2026-07-15 10:30:00"
    }
  ]
}
```

#### 人工通过

```
POST /api/admin/moderations/:id/approve
```

**响应**：

```json
{ "ok": true }
```

**效果**：
- 将审核记录状态更新为 `passed`
- 将站点状态更新为 `active`
- 将站点审核状态更新为 `passed`

#### 人工拒绝

```
POST /api/admin/moderations/:id/reject
```

**响应**：

```json
{ "ok": true }
```

**效果**：
- 将审核记录状态更新为 `rejected`
- 将站点状态更新为 `offline`
- 将站点审核状态更新为 `rejected`

### 4.2 站点管理

#### 获取所有站点

```
GET /api/admin/sites
```

**响应**：

```json
{
  "sites": [
    {
      "id": 1,
      "user_id": 1,
      "name": "测试站点",
      "subdomain": "test",
      "status": "active",
      "moderation_status": "passed",
      "user_name": "testuser",
      "created_at": "2026-07-15 10:00:00",
      "updated_at": "2026-07-15 10:30:00"
    }
  ]
}
```

#### 切换站点状态（上线/下线）

```
POST /api/admin/sites/:id/toggle-status
```

**响应**：

```json
{ "ok": true, "status": "offline" }
```

#### 删除站点

```
DELETE /api/admin/sites/:id
```

**响应**：

```json
{ "ok": true }
```

**效果**：
- 删除站点文件
- 删除数据库记录

### 4.3 用户管理

#### 获取所有用户

```
GET /api/admin/users
```

**响应**：

```json
{
  "users": [
    {
      "id": 1,
      "username": "testuser",
      "is_admin": 0,
      "created_at": "2026-07-15 10:00:00"
    }
  ]
}
```

#### 切换管理员权限

```
POST /api/admin/users/:id/toggle-admin
```

**响应**：

```json
{ "ok": true, "isAdmin": true }
```

## 5. 审核流程

### 5.1 完整流程图

```
用户上传部署
    ↓
[moderateContent] 规则引擎审核
    ↓
审核结果判定
    ├─ 通过(status=passed) → 正常部署上线
    ├─ 疑似(status=suspect) → 允许部署,进入审核队列等待人工复核
    └─ 未通过(status=rejected) → 拒绝部署,进入审核队列等待人工复核
```

### 5.2 审核状态说明

| 状态 | 说明 | 部署结果 | 管理端操作 |
|------|------|----------|-----------|
| `passed` | 审核通过 | 站点上线 | 无 |
| `suspect` | 疑似违规 | 站点上线(标记) | 通过/拒绝 |
| `rejected` | 审核未通过 | 站点拒绝部署 | 通过/拒绝 |

### 5.3 阈值配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `MODERATION_THRESHOLD` | 50 | 违规判定阈值，超过此值视为拒绝 |
| `MODERATION_SUSPECT_THRESHOLD` | 20 | 疑似违规阈值，在此区间标记为疑似 |

## 6. 数据库表结构

### 6.1 sites 表新增字段

```sql
ALTER TABLE sites ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE sites ADD COLUMN moderation_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE sites ADD COLUMN last_moderation_at TEXT;
```

### 6.2 moderations 表

```sql
CREATE TABLE IF NOT EXISTS moderations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id        INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'pending',
  dimension      TEXT,
  confidence     REAL,
  reason         TEXT,
  file_path      TEXT,
  content_snippet TEXT,
  model_used     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## 7. 前端交互

### 7.1 审核队列

- 支持按状态筛选（全部/疑似/未通过）
- 显示违规维度、置信度、违规片段、触发文件
- 疑似和未通过记录显示「通过」「拒绝」按钮

### 7.2 站点管理

- 显示站点名称、状态、审核状态、所属用户
- 支持上线/下线切换
- 支持删除站点

### 7.3 用户管理

- 显示用户名、管理员标识、创建时间
- 支持设置/取消管理员权限

## 8. 使用示例

### 8.1 设置管理员

```bash
# 登录后查看用户ID
curl -s http://localhost:3000/api/me -H "Cookie: session=xxx"

# 设置管理员
sqlite3 data/zhidian.db "UPDATE users SET is_admin = 1 WHERE id = 1;"
```

### 8.2 测试审核拦截

```bash
# 创建包含违规内容的 ZIP
echo '<html><body>色情服务</body></html>' > index.html
zip test.zip index.html

# 部署（会被拦截）
curl -X POST http://localhost:3000/api/sites/1/deploy \
  -H "Cookie: session=xxx" \
  -F "file=@test.zip"

# 响应：{"error":"内容审核未通过：🔞 色情低俗内容检测"}
```

### 8.3 管理端操作

```bash
# 查看审核队列
curl -s http://localhost:3000/api/admin/moderations -H "Cookie: session=xxx"

# 通过审核
curl -X POST http://localhost:3000/api/admin/moderations/1/approve -H "Cookie: session=xxx"

# 拒绝审核
curl -X POST http://localhost:3000/api/admin/moderations/1/reject -H "Cookie: session=xxx"
```
