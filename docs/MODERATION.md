# AI 内容审核功能设计文档

## 1. 功能概述

在用户部署静态网站时，自动对上传的内容进行 AI 审核，检测是否包含违规内容。审核通过后才允许上线部署，审核失败则拒绝部署并提示违规原因。

### 审核维度

| 维度 | 标识 | 描述 |
|------|------|------|
| 🔞 色情低俗 | `pornography` | 裸露、性暗示、低俗色情内容 |
| 🔫 暴力恐怖 | `violence` | 血腥、暴力、恐怖主义相关内容 |
| 🚫 政治敏感 | `political` | 敏感政治人物、事件、言论 |
| 📢 广告欺诈 | `spam` | 垃圾广告、虚假宣传、诈骗信息 |
| 🚬 毒品赌博 | `drugs_gambling` | 毒品、赌博相关内容 |

---

## 2. 审核流程图

```
用户上传 ZIP
    ↓
[inspectZip] 解析 ZIP 结构
    ↓
[scanFiles] 扫描所有文件内容
    ↓
[moderateText] 文本内容 AI 审核
    ↓
[moderateImages] 图片内容 AI 审核
    ↓
审核通过？
    ├─ YES → [deployZip] 正常部署上线
    └─ NO  → 拒绝部署，返回违规详情
```

### 详细流程

```
┌─────────────────────────────────────────────────────────────────┐
│                    部署请求到达                                  │
│  POST /api/sites/:id/deploy                                    │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Step 1: inspectZip() - 解析 ZIP                                │
│  • 安全校验（Zip Slip、Zip Bomb）                                │
│  • 提取文件列表                                                  │
│  • 校验 index.html 存在                                         │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Step 2: scanFiles() - 扫描文件内容                             │
│  • 过滤文本文件（HTML/JS/CSS/TXT/JSON等）                        │
│  • 提取图片文件（JPG/PNG/GIF/WebP）                              │
│  • 提取文本内容（去除 HTML 标签后的纯文本）                       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Step 3: moderateText() - 文本 AI 审核                          │
│  • 调用 LLM 进行多维度分类                                       │
│  • 输出: { dimension, confidence, reason, file_path }           │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Step 4: moderateImages() - 图片 AI 审核                        │
│  • 方案A: 调用视觉模型直接审核                                   │
│  • 方案B: OCR 识别文字 + 文本审核                                │
│  • 输出: { dimension, confidence, reason, file_path }           │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Step 5: 结果判定                                               │
│  • 任一维度置信度 > 阈值 → 拒绝部署                               │
│  • 所有维度置信度 ≤ 阈值 → 允许部署                               │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Step 6: 持久化审核记录                                         │
│  • 写入 moderations 表                                          │
│  • 更新 sites.moderation_status                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. AI 审核策略

### 3.1 文本审核（LLM 分类）

**适用文件类型**：`.html`, `.htm`, `.js`, `.css`, `.txt`, `.json`, `.md`, `.xml`

**审核方式**：将提取的文本内容发送给 LLM，使用结构化 Prompt 进行多维度分类。

#### Prompt 设计

```
你是一个内容安全审核专家，请对以下文本进行内容安全审核。

文本内容：
{{ text_content }}

请按照以下五个维度进行评分（0-100分，分数越高表示越可能违规）：

1. 色情低俗（pornography）：包含裸露、性暗示、低俗色情等内容
2. 暴力恐怖（violence）：包含血腥、暴力、恐怖主义等内容
3. 政治敏感（political）：包含敏感政治人物、事件、言论等内容
4. 广告欺诈（spam）：包含垃圾广告、虚假宣传、诈骗信息等内容
5. 毒品赌博（drugs_gambling）：包含毒品、赌博等内容

请输出 JSON 格式结果：
{
  "pornography": 0-100,
  "violence": 0-100,
  "political": 0-100,
  "spam": 0-100,
  "drugs_gambling": 0-100,
  "violation_dimension": "none" | "pornography" | "violence" | "political" | "spam" | "drugs_gambling",
  "reason": "违规原因描述（如无违规则为空）"
}

评分规则：
- 0-20：正常内容
- 21-50：疑似违规，需要人工复核
- 51-100：明确违规，拒绝部署
```

#### 文本预处理

```
1. HTML 文件：使用正则去除 <script>/<style>/<noscript> 标签，提取可见文本
2. 大文件：截取前 10000 字符（避免超出 LLM 上下文限制）
3. 多文件：合并后截取（总长度不超过 20000 字符）
4. 编码处理：统一转为 UTF-8
```

### 3.2 图片审核

**适用文件类型**：`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.svg`

#### 方案 A：视觉模型直接审核（推荐）

调用支持图像理解的多模态模型（如 GPT-4V、Claude 3.5 Sonnet、Gemini Pro Vision），直接对图片内容进行审核。

**Prompt 设计**：
```
你是一个内容安全审核专家，请对这张图片进行内容安全审核。

请按照以下五个维度进行评分（0-100分，分数越高表示越可能违规）：
1. 色情低俗：裸露、性暗示、低俗色情内容
2. 暴力恐怖：血腥、暴力、恐怖主义内容
3. 政治敏感：敏感政治人物、事件、言论
4. 广告欺诈：垃圾广告、虚假宣传、诈骗信息
5. 毒品赌博：毒品、赌博相关内容

请输出 JSON 格式结果：
{
  "pornography": 0-100,
  "violence": 0-100,
  "political": 0-100,
  "spam": 0-100,
  "drugs_gambling": 0-100,
  "violation_dimension": "none" | "pornography" | "violence" | "political" | "spam" | "drugs_gambling",
  "reason": "违规原因描述"
}
```

#### 方案 B：OCR + 文本审核（降级方案）

当视觉模型不可用时，使用 OCR 提取图片中的文字，然后走文本审核流程。

```
图片 → OCR识别 → 提取文字 → 文本审核流程
```

**适用场景**：
- 纯文字图片（如截图、海报）
- 视觉模型 API 不可用或成本过高

### 3.3 审核阈值配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `MODERATION_THRESHOLD` | 50 | 违规判定阈值（分数 > 此值视为违规） |
| `MODERATION_SUSPECT_THRESHOLD` | 20 | 疑似违规阈值（分数在此区间需要人工复核） |
| `MAX_TEXT_LENGTH` | 20000 | 单次审核最大文本长度 |
| `MAX_IMAGES_PER_DEPLOY` | 50 | 单次部署最多审核图片数量 |

---

## 4. 数据库设计

### 4.1 新增 moderations 表

```sql
CREATE TABLE IF NOT EXISTS moderations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id        INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending / passed / rejected / suspect
  dimension      TEXT,                              -- 违规维度标识
  confidence     REAL,                              -- 置信度 0-100
  reason         TEXT,                              -- 违规原因描述
  file_path      TEXT,                              -- 触发违规的文件路径
  model_used     TEXT,                              -- 使用的模型名称
  content_snippet TEXT,                             -- 违规内容片段（用于人工复核）
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_moderations_site ON moderations(site_id);
CREATE INDEX IF NOT EXISTS idx_moderations_status ON moderations(status);
```

### 4.2 sites 表新增字段

```sql
ALTER TABLE sites ADD COLUMN moderation_status TEXT DEFAULT 'pending';  -- pending / passed / rejected
ALTER TABLE sites ADD COLUMN last_moderation_at TEXT;
ALTER TABLE sites ADD COLUMN moderation_reason TEXT;
```

---

## 5. API 接口设计

### 5.1 部署接口增强（现有）

**端点**：`POST /api/sites/:id/deploy`

**响应变更**：

```json
{
  "ok": true,
  "fileCount": 10,
  "url": "http://testuser.localhost/",
  "moderation": {
    "status": "passed",
    "model": "gpt-4o-mini",
    "scannedFiles": 8,
    "scannedImages": 2,
    "details": []
  }
}
```

**审核失败响应**：

```json
{
  "error": "内容审核未通过",
  "moderation": {
    "status": "rejected",
    "dimension": "pornography",
    "confidence": 85,
    "reason": "检测到低俗色情内容",
    "file_path": "index.html",
    "content_snippet": "xxx"
  }
}
```

### 5.2 审核历史查询

**端点**：`GET /api/sites/:id/moderations`

**响应**：

```json
{
  "moderations": [
    {
      "id": 1,
      "status": "passed",
      "dimension": null,
      "confidence": null,
      "reason": null,
      "model_used": "rule_engine",
      "created_at": "2026-07-15 10:30:00"
    },
    {
      "id": 2,
      "status": "rejected",
      "dimension": "violence",
      "confidence": 78,
      "reason": "检测到暴力血腥内容",
      "file_path": "images/blood.jpg",
      "model_used": "gpt-4o-mini",
      "created_at": "2026-07-15 11:45:00"
    }
  ]
}
```

---

## 6. 实现模式

### 6.1 模式切换配置

在 `config.js` 中新增配置：

```javascript
export const config = {
  // ... 现有配置
  moderation: {
    mode: process.env.MODERATION_MODE || 'rule_engine',  // 'rule_engine' | 'ai'
    threshold: num(process.env.MODERATION_THRESHOLD, 50),
    suspectThreshold: num(process.env.MODERATION_SUSPECT_THRESHOLD, 20),
    maxTextLength: num(process.env.MAX_TEXT_LENGTH, 20000),
    maxImages: num(process.env.MAX_IMAGES_PER_DEPLOY, 50),
    // AI 模型配置
    ai: {
      provider: process.env.MODERATION_AI_PROVIDER || 'openai',  // 'openai' | 'anthropic' | 'gemini' | 'custom'
      apiKey: process.env.MODERATION_AI_KEY,
      model: process.env.MODERATION_AI_MODEL || 'gpt-4o-mini',
      timeout: num(process.env.MODERATION_AI_TIMEOUT, 30000),
    }
  }
};
```

### 6.2 模式一：规则引擎模式（Rule Engine）

**适用场景**：原型演示、无 AI API 密钥、成本控制

**实现方式**：基于关键词正则表达式进行匹配

**规则库设计**：

```javascript
const RULES = {
  pornography: [
    /色情|sex|porn|裸体|裸照|露点|性交|自慰|淫荡|AV|三级片/i,
    /微信约炮|同城交友|一夜情|上门服务|特殊服务/i,
    /露点|露胸|露臀|裸奔|裸体艺术/i
  ],
  violence: [
    /杀人|自杀|砍人|刺杀|枪击|爆炸|炸弹|恐怖主义/i,
    /血腥|鲜血|肢解|酷刑|虐待|虐杀/i,
    /枪支|弹药|武器|刀具|凶器|手雷/i
  ],
  political: [
    /敏感人物名|敏感事件|敏感言论/i,
    /反共|反政府|台独|港独|藏独/i,
    /法轮功|邪教|极端主义/i
  ],
  spam: [
    /免费领取|扫码加微信|加QQ|联系方式|微信号/i,
    /赌博网站|博彩|彩票|时时彩|六合彩/i,
    /减肥药|增高药|丰胸|壮阳|保健品/i,
    /小额贷款|网贷|套现|信用卡代还/i
  ],
  drugs_gambling: [
    /毒品|冰毒|大麻|海洛因|可卡因|鸦片/i,
    /吸毒|贩毒|制毒|戒毒/i,
    /赌博|赌场|赌钱|赌徒|网赌|赌球/i,
    /百家乐|德州扑克|老虎机|捕鱼机/i
  ]
};
```

**优点**：零成本、无延迟、无需外部依赖

**缺点**：准确率有限、容易被绕过、无法理解语义

### 6.3 模式二：AI 模型模式

**适用场景**：生产环境、需要高精度审核

**支持的 AI 服务商**：

| 服务商 | API | 推荐模型 | 特点 |
|--------|-----|----------|------|
| OpenAI | Chat Completions | gpt-4o-mini | 性价比高，支持图像 |
| Anthropic | Messages API | Claude 3.5 Sonnet | 上下文窗口大 |
| Google | Gemini API | Gemini 1.5 Flash | 多模态能力强 |
| 阿里云 | 内容安全 API | 文本/图片审核 | 国内合规 |
| 腾讯云 | 内容安全 API | 文本/图片审核 | 国内合规 |

**API 调用封装**：

```javascript
class ModerationService {
  constructor(config) {
    this.config = config;
    this.client = this.createClient();
  }
  
  createClient() {
    // 根据 provider 创建对应的客户端
    switch (this.config.provider) {
      case 'openai': return new OpenAIClient(this.config.apiKey);
      case 'anthropic': return new AnthropicClient(this.config.apiKey);
      case 'gemini': return new GeminiClient(this.config.apiKey);
      default: return new CustomAPIClient(this.config);
    }
  }
  
  async moderateText(text) {
    // 调用 LLM API 进行文本审核
  }
  
  async moderateImage(imageBuffer) {
    // 调用多模态 API 进行图片审核
  }
}
```

**优点**：语义理解能力强、准确率高、能识别复杂违规内容

**缺点**：有 API 调用成本、有延迟、依赖外部服务

---

## 7. 与现有代码集成

### 7.1 deploy.js 集成点

```javascript
// 在 deployZip 函数中插入审核逻辑
export function deployZip(subdomain, zipBuffer) {
  const { entries, rootPrefix } = inspectZip(zipBuffer);
  
  // 新增：内容审核
  const moderationResult = await moderateContent(entries, rootPrefix);
  if (moderationResult.status === 'rejected') {
    // 记录审核失败
    saveModeration(siteId, moderationResult);
    throw httpErr(403, `内容审核未通过：${moderationResult.reason}`);
  }
  
  // 审核通过，继续部署流程
  const liveDir = path.join(dirs.sites, subdomain);
  // ... 后续部署逻辑
}
```

### 7.2 新增文件结构

```
src/
├── deploy.js          # 现有：部署逻辑
├── moderation.js      # 新增：审核服务主入口
├── moderation/
│   ├── engine.js      # 规则引擎实现
│   ├── ai.js          # AI 模型调用封装
│   ├── text.js        # 文本提取与预处理
│   └── image.js       # 图片处理与 OCR
```

---

## 8. 降级容错策略

### 8.1 AI 服务不可用

```
AI API 调用失败
    ↓
重试 2 次（间隔 1 秒）
    ↓
仍然失败 → 降级为规则引擎模式
    ↓
记录降级日志
    ↓
继续部署流程
```

### 8.2 审核超时

```
审核时间 > 30 秒
    ↓
中断审核，标记为 'timeout'
    ↓
允许部署（但标记需要人工复核）
    ↓
发送通知给管理员
```

### 8.3 疑似违规

```
置信度在 [20, 50] 区间
    ↓
允许部署（但标记为 'suspect'）
    ↓
加入人工复核队列
    ↓
复核通过 → 保持正常状态
    ↓
复核失败 → 强制下线站点
```

---

## 9. 性能优化

### 9.1 文本审核优化

- **批量处理**：多个小文件合并为一次请求
- **采样审核**：文件数量多时，随机采样 80% 进行审核
- **缓存机制**：相同内容的文件只审核一次

### 9.2 图片审核优化

- **尺寸限制**：超过 2MB 的图片先压缩再审核
- **跳过重复图片**：通过文件哈希检测重复
- **异步审核**：图片审核可以异步进行，先允许部署再后台审核

### 9.3 并发控制

```javascript
// 限制同时进行的审核请求数
const MAX_CONCURRENT = 5;
const semaphore = new Semaphore(MAX_CONCURRENT);

async function moderateFiles(files) {
  return Promise.all(files.map(async (file) => {
    await semaphore.acquire();
    try {
      return await moderateFile(file);
    } finally {
      semaphore.release();
    }
  }));
}
```

---

## 10. 合规与隐私

### 10.1 数据处理

- **仅审核必要内容**：不存储完整的用户上传文件
- **审核记录保留**：保留审核结果供合规审计，保留期 90 天
- **敏感信息脱敏**：审核结果中的内容片段进行脱敏处理

### 10.2 用户告知

在用户协议中明确告知：
- 平台会对上传内容进行 AI 审核
- 审核目的是确保内容合规
- 审核过程可能涉及将内容发送给第三方 AI 服务商

---

## 11. 后续扩展

### 11.1 人工复核系统

```
审核结果为 'suspect' 或用户申诉
    ↓
进入人工复核队列
    ↓
管理员查看违规内容和 AI 判定
    ↓
做出最终裁决（通过/拒绝）
    ↓
更新审核状态和站点状态
```

### 11.2 审核模型自训练

```
积累足够的审核数据后
    ↓
训练自定义审核模型
    ↓
减少对外部 AI 服务的依赖
    ↓
降低成本，提高准确率
```

### 11.3 实时监控

```
站点上线后
    ↓
定期（每日/每周）重新审核
    ↓
发现新的违规内容
    ↓
自动下线或通知管理员
```

---

## 12. 实施步骤

| 阶段 | 任务 | 耗时估计 |
|------|------|----------|
| 1 | 数据库 schema 变更 | 1 小时 |
| 2 | 规则引擎模式实现 | 4 小时 |
| 3 | deploy.js 集成审核逻辑 | 2 小时 |
| 4 | AI 模型模式封装 | 6 小时 |
| 5 | API 接口增强 | 2 小时 |
| 6 | 测试与调试 | 4 小时 |
| 7 | 文档编写 | 2 小时 |

---

## 13. 配置清单

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `MODERATION_MODE` | 审核模式 | `rule_engine` |
| `MODERATION_THRESHOLD` | 违规判定阈值 | `50` |
| `MODERATION_SUSPECT_THRESHOLD` | 疑似违规阈值 | `20` |
| `MODERATION_AI_PROVIDER` | AI 服务商 | `openai` |
| `MODERATION_AI_KEY` | AI API 密钥 | `` |
| `MODERATION_AI_MODEL` | AI 模型名称 | `gpt-4o-mini` |
| `MAX_TEXT_LENGTH` | 单次审核最大文本长度 | `20000` |
| `MAX_IMAGES_PER_DEPLOY` | 单次部署最多审核图片数 | `50` |
