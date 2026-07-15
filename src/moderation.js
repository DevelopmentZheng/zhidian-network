import { config } from './config.js';
import { httpErr } from './errors.js';

const DIMENSIONS = {
  pornography: { name: '色情低俗', icon: '🔞' },
  violence: { name: '暴力恐怖', icon: '🔫' },
  political: { name: '政治敏感', icon: '🚫' },
  spam: { name: '广告欺诈', icon: '📢' },
  drugs_gambling: { name: '毒品赌博', icon: '🚬' },
};

const RULES = {
  pornography: [
    { pattern: /色情|sex|porn|裸体|裸照|露点|性交|自慰|淫荡|AV|三级片/i, score: 80 },
    { pattern: /微信约炮|同城交友|一夜情|上门服务|特殊服务|按摩服务/i, score: 75 },
    { pattern: /露点|露胸|露臀|裸奔|裸体艺术|情色/i, score: 60 },
    { pattern: /sex.*video|nude.*photo|pornographic/i, score: 85 },
  ],
  violence: [
    { pattern: /杀人|自杀|砍人|刺杀|枪击|爆炸|炸弹|恐怖主义|恐怖分子/i, score: 85 },
    { pattern: /血腥|鲜血|肢解|酷刑|虐待|虐杀|屠杀/i, score: 80 },
    { pattern: /枪支|弹药|武器|刀具|凶器|手雷|导弹|核弹/i, score: 70 },
    { pattern: /violence|terrorism|bomb|weapon|murder/i, score: 80 },
  ],
  political: [
    { pattern: /法轮功|邪教|极端主义|分裂势力|台独|港独|藏独/i, score: 95 },
    { pattern: /反共|反政府|反动|颠覆|政变/i, score: 90 },
    { pattern: /敏感人物|敏感事件|敏感言论/i, score: 60 },
  ],
  spam: [
    { pattern: /免费领取|扫码加微信|加QQ|联系方式|微信号|QQ号/i, score: 70 },
    { pattern: /赌博网站|博彩|彩票|时时彩|六合彩|快三/i, score: 85 },
    { pattern: /减肥药|增高药|丰胸|壮阳|保健品|祛斑|美白/i, score: 65 },
    { pattern: /小额贷款|网贷|套现|信用卡代还|无抵押/i, score: 70 },
    { pattern: /兼职刷单|打字赚钱|日入千元|轻松赚钱/i, score: 75 },
    { pattern: /广告|推广|营销|引流|拉新/i, score: 50 },
  ],
  drugs_gambling: [
    { pattern: /毒品|冰毒|大麻|海洛因|可卡因|鸦片|摇头丸|K粉/i, score: 95 },
    { pattern: /吸毒|贩毒|制毒|戒毒|麻古/i, score: 90 },
    { pattern: /赌博|赌场|赌钱|赌徒|网赌|赌球|赌马/i, score: 85 },
    { pattern: /百家乐|德州扑克|老虎机|捕鱼机|棋牌游戏/i, score: 70 },
    { pattern: /drug|cocaine|heroin|marijuana|gambling|casino/i, score: 85 },
  ],
};

function matchRules(text) {
  const results = {};
  for (const [dim, rules] of Object.entries(RULES)) {
    let maxScore = 0;
    let matchedPattern = null;
    for (const { pattern, score } of rules) {
      if (pattern.test(text)) {
        if (score > maxScore) {
          maxScore = score;
          matchedPattern = pattern;
        }
      }
    }
    results[dim] = { score: maxScore, matched: maxScore > 0 };
  }
  return results;
}

function extractTextFromHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSnippet(text, pattern) {
  const match = text.match(new RegExp(`(.{0,50})(${pattern.source})(.{0,50})`, 'i'));
  if (match) {
    const prefix = match[1].length > 20 ? '...' + match[1].slice(-20) : match[1];
    const suffix = match[3].length > 20 ? match[3].slice(0, 20) + '...' : match[3];
    return prefix + match[2] + suffix;
  }
  return text.slice(0, 100) + '...';
}

async function moderateWithAI(text) {
  const { ai, threshold, suspectThreshold } = config.moderation;
  
  if (!ai.apiKey) {
    console.warn('AI审核: 未配置API Key,降级为规则引擎');
    return null;
  }

  const prompt = `你是一个内容安全审核专家，请对以下文本进行内容安全审核。

文本内容：
${text}

请按照以下五个维度进行评分（0-100分，分数越高表示越可能违规）：

1. pornography（色情低俗）：包含裸露、性暗示、低俗色情等内容
2. violence（暴力恐怖）：包含血腥、暴力、恐怖主义等内容
3. political（政治敏感）：包含敏感政治人物、事件、言论等内容
4. spam（广告欺诈）：包含垃圾广告、虚假宣传、诈骗信息等内容
5. drugs_gambling（毒品赌博）：包含毒品、赌博等内容

请输出严格的JSON格式结果（不要包含任何Markdown标记或额外文字）：
{
  "pornography": 0-100,
  "violence": 0-100,
  "political": 0-100,
  "spam": 0-100,
  "drugs_gambling": 0-100,
  "violation_dimension": "none" | "pornography" | "violence" | "political" | "spam" | "drugs_gambling",
  "reason": "违规原因描述（如无违规则为空字符串）"
}`;

  try {
    let response;
    switch (ai.provider.toLowerCase()) {
      case 'openai':
        response = await callOpenAI(prompt, ai);
        break;
      case 'anthropic':
        response = await callAnthropic(prompt, ai);
        break;
      case 'gemini':
        response = await callGemini(prompt, ai);
        break;
      default:
        console.warn(`不支持的AI服务商: ${ai.provider},降级为规则引擎`);
        return null;
    }

    let jsonStr = response.trim();
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    const result = JSON.parse(jsonStr);

    let maxScore = 0;
    let violationDim = result.violation_dimension;
    
    for (const dim of ['pornography', 'violence', 'political', 'spam', 'drugs_gambling']) {
      if (result[dim] > maxScore) {
        maxScore = result[dim];
      }
    }

    if (violationDim === 'none') {
      violationDim = null;
    }

    let status = 'passed';
    if (maxScore > threshold) {
      status = 'rejected';
    } else if (maxScore > suspectThreshold) {
      status = 'suspect';
    }

    let reason = '';
    if (status !== 'passed' && violationDim && DIMENSIONS[violationDim]) {
      reason = `${DIMENSIONS[violationDim].icon} ${DIMENSIONS[violationDim].name}内容检测`;
      if (result.reason) {
        reason += `: ${result.reason}`;
      }
    }

    return {
      status,
      dimension: violationDim,
      confidence: maxScore > 0 ? maxScore : null,
      reason,
      file_path: null,
      content_snippet: text.length > 100 ? text.slice(0, 100) + '...' : text,
      model_used: `${ai.provider}_${ai.model}`,
      ai_result: result,
    };
  } catch (err) {
    console.error('AI审核失败:', err.message);
    return null;
  }
}

async function callOpenAI(prompt, ai) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ai.apiKey}`,
    },
    body: JSON.stringify({
      model: ai.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 500,
    }),
    timeout: ai.timeout,
  });

  if (!res.ok) {
    throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

async function callAnthropic(prompt, ai) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ai.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ai.model || 'claude-3-5-sonnet-20240620',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 500,
    }),
    timeout: ai.timeout,
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.content[0].text;
}

async function callGemini(prompt, ai) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1/models/${ai.model || 'gemini-1.5-flash'}:generateContent?key=${ai.apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 500,
      },
    }),
    timeout: ai.timeout,
  });

  if (!res.ok) {
    throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
}

export async function moderateContent(entries, rootPrefix) {
  const { mode, threshold, suspectThreshold } = config.moderation || { mode: 'rule_engine', threshold: 50, suspectThreshold: 20 };
  
  let allText = '';
  const textFiles = [];
  
  for (const entry of entries) {
    const rel = entry.entryName.slice(rootPrefix.length);
    if (!rel) continue;
    
    const ext = rel.split('.').pop().toLowerCase();
    const textExts = ['html', 'htm', 'js', 'css', 'txt', 'json', 'md', 'xml'];
    
    if (textExts.includes(ext)) {
      try {
        const data = entry.getData();
        let content = data.toString('utf-8');
        if (ext === 'html' || ext === 'htm') {
          content = extractTextFromHtml(content);
        }
        allText += content + '\n';
        textFiles.push({ path: rel, content });
      } catch {}
    }
  }
  
  if (!allText.trim()) {
    return {
      status: 'passed',
      dimension: null,
      confidence: null,
      reason: '',
      file_path: null,
      content_snippet: null,
      model_used: mode === 'ai' ? 'no_content' : 'rule_engine',
      scannedFiles: textFiles.length,
    };
  }
  
  if (allText.length > (config.moderation?.maxTextLength || 20000)) {
    allText = allText.slice(0, config.moderation.maxTextLength);
  }
  
  if (mode === 'ai') {
    const aiResult = await moderateWithAI(allText);
    if (aiResult) {
      aiResult.scannedFiles = textFiles.length;
      return aiResult;
    }
  }
  
  const results = matchRules(allText);
  
  let maxScore = 0;
  let violationDim = null;
  let matchedPattern = null;
  let violatedFile = null;
  
  for (const [dim, { score, matched }] of Object.entries(results)) {
    if (matched && score > maxScore) {
      maxScore = score;
      violationDim = dim;
      const rules = RULES[dim];
      for (const { pattern } of rules) {
        if (pattern.test(allText)) {
          matchedPattern = pattern;
          break;
        }
      }
    }
  }
  
  for (const file of textFiles) {
    if (violationDim && RULES[violationDim].some(r => r.pattern.test(file.content))) {
      violatedFile = file.path;
      break;
    }
  }
  
  let status = 'passed';
  if (maxScore > threshold) {
    status = 'rejected';
  } else if (maxScore > suspectThreshold) {
    status = 'suspect';
  }
  
  let reason = '';
  let snippet = '';
  if (violationDim) {
    reason = `${DIMENSIONS[violationDim].icon} ${DIMENSIONS[violationDim].name}内容检测`;
    if (matchedPattern && allText) {
      snippet = extractSnippet(allText, matchedPattern);
    }
  }
  
  return {
    status,
    dimension: violationDim || null,
    confidence: maxScore > 0 ? maxScore : null,
    reason: status !== 'passed' ? reason : '',
    file_path: violatedFile || null,
    content_snippet: snippet || null,
    model_used: 'rule_engine',
    scannedFiles: textFiles.length,
  };
}

export function saveModeration(db, siteId, result) {
  db.prepare(`
    INSERT INTO moderations (site_id, status, dimension, confidence, reason, file_path, content_snippet, model_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    siteId,
    result.status,
    result.dimension,
    result.confidence,
    result.reason,
    result.file_path,
    result.content_snippet,
    result.model_used
  );
  
  db.prepare(`
    UPDATE sites SET moderation_status = ?, last_moderation_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
  `).run(result.status, siteId);
}

export function getDimensionInfo(dim) {
  return DIMENSIONS[dim] || { name: dim, icon: '⚠️' };
}
