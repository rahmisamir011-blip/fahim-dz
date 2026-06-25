/**
 * FAHIM DZ — AI Service
 * Primary:  DeepSeek V4 Flash (+ Pro fallback)
 * Audio:    Google Gemini 2.0 Flash (for voice message transcription)
 */

const { OpenAI }             = require('openai');
const axios                  = require('axios');

// ─────────────────────────────────────────────────────────────
// DeepSeek Client (uses OpenAI-compatible API)
// ─────────────────────────────────────────────────────────────

let deepseekClient = null;
function getDeepSeek() {
  if (!deepseekClient && process.env.DEEPSEEK_API_KEY) {
    deepseekClient = new OpenAI({
      baseURL: 'https://api.deepseek.com',
      apiKey: process.env.DEEPSEEK_API_KEY,
    });
  }
  return deepseekClient;
}

// ─────────────────────────────────────────────────────────────
// Gemini Client (kept ONLY for audio transcription fallback)
// ─────────────────────────────────────────────────────────────

let genAI = null;
function getGenAI() {
  if (!genAI && process.env.GEMINI_API_KEY) {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return genAI;
}

// ─────────────────────────────────────────────────────────────
// Per-Tenant System Prompt Builder
// ─────────────────────────────────────────────────────────────

/**
 * Build a fully personalised system prompt for each tenant
 * @param {object} tenantConfig - from Firestore users/{userId}
 * @param {Array}  products     - from Firestore users/{userId}/products
 * @param {Array}  posts        - recent page/IG posts for context awareness
 */
function buildSystemPrompt(tenantConfig = {}, products = [], posts = []) {
  const botName   = tenantConfig.botName    || 'فهيم';
  const storeName = tenantConfig.storeName  || 'المتجر';
  const language  = tenantConfig.language   || 'dz'; // dz=darija, ar=arabic, fr=french
  const greeting  = tenantConfig.welcomeMessage || '';

  const langInstructions = {
    dz: 'تتكلم بالدارجة الجزائرية بشكل طبيعي وودود، وتستطيع الرد بالفرنسية إذا بدأ الزبون بالفرنسية.',
    ar: 'تتكلم بالعربية الفصحى البسيطة ووتستطيع الرد بالدارجة إذا تطلب الأمر.',
    fr: 'Tu parles en français naturellement. Tu peux aussi répondre en arabe dialectal si nécessaire.',
  };

  let prompt = `أنت "${botName}"، وكيل بيع ذكي يعمل لخدمة متجر "${storeName}" على الإنترنت.
${langInstructions[language] || langInstructions.dz}

**مهمتك الرئيسية:**
- الرد على استفسارات العملاء عن المنتجات (السعر، الوصف، التوفر)
- إذا سأل الزبون عن منشور أو صورة أو عرض شفته على الصفحة، ارجع للمنشورات الأخيرة أدناه وأجب بناءً عليها
- تثبيت الطلبيات بجمع: الاسم الكامل، رقم الهاتف، الولاية، المنتج، والكمية
- إذا طلب العميل إلغاء أو تعديل طلب، حوله للدعم البشري
- لا تخترع معلومات عن منتجات غير موجودة في القائمة المعطاة أو في المنشورات
- اذكر اسم المتجر "${storeName}" عند التعريف بنفسك

**أسلوب التواصل:**
- كن ودوداً وطبيعياً
- استخدم الإيموجي بشكل معتدل 😊 🛍️
- كن مختصراً ومباشراً — لا ترد برسائل طويلة جداً
- إذا ما عندكش معلومات على سؤال، قول صراحةً أنك ما تعرفش

**عند تثبيت الطلبية:**
إذا قدّم العميل كل المعلومات المطلوبة (الاسم، الهاتف، الولاية، المنتج)، قل له:
"الطلبية تأكدت! ✅ راح يتواصل معاك فريق ${storeName} قريب."

ثم أضف في آخر ردك هذا السطر بالضبط (لا تظهره للعميل):
[ORDER_DATA]{"intent":"order_confirmed","client":"...","phone":"...","wilaya":"...","product":"...","qty":1}[/ORDER_DATA]`;

  // Custom greeting / welcome message from dashboard settings
  if (greeting) {
    prompt += `\n\n**رسالة الترحيب الافتراضية عند أول رسالة:** "${greeting}"`;
  }

  // Product catalog
  if (products.length > 0) {
    prompt += '\n\n**قائمة المنتجات المتاحة:**\n' +
      products.map(p => {
        let line = `- ${p.name}: ${p.price} د.ج`;
        if (p.stock != null) line += ` (المخزون: ${p.stock} وحدة)`;
        if (p.description) line += ` — ${p.description}`;
        return line;
      }).join('\n');
  } else {
    prompt += '\n\n**ملاحظة:** لا توجد منتجات مُدخلة بعد. يمكنك الإجابة على الأسئلة العامة وإحالة العميل للتواصل المباشر.';
  }

  // Recent page posts — for context-aware replies about promoted content
  if (posts.length > 0) {
    const postLines = posts
      .slice(0, 6) // max 6 posts in prompt to keep it focused
      .map((p, i) => {
        // Support both FB posts (p.message) and IG posts (p.caption)
        const text = p.message || p.caption || '';
        const title = p.title ? ` [${p.title}]` : '';
        return text ? `${i + 1}.${title} ${text.substring(0, 300)}` : null;
      })
      .filter(Boolean);

    if (postLines.length > 0) {
      prompt += '\n\n**المنشورات الأخيرة على الصفحة (استخدمها كمرجع للإجابة على أسئلة الزبائن):**\n' +
        postLines.join('\n');
    }
  }

  return prompt;
}

// ─────────────────────────────────────────────────────────────
// Main Reply Generator — DeepSeek Primary
// ─────────────────────────────────────────────────────────────

/**
 * Generate a personalised reply for a tenant
 * @param {string} userMessage   - the incoming customer message
 * @param {Array}  history       - [{role: 'user'|'assistant', content, ts}]
 * @param {Array}  products      - tenant product list from Firestore
 * @param {object} tenantConfig  - tenant settings (storeName, botName, language, ...)
 * @param {Array}  posts         - recent page/IG posts for context (optional)
 * @returns {Promise<{reply: string, orderData: object|null}>}
 */
async function generateReply(userMessage, history = [], products = [], tenantConfig = {}, posts = []) {
  const systemPrompt = buildSystemPrompt(tenantConfig, products, posts);
  console.log(`📝 System prompt built: ${systemPrompt.length} chars, ${posts.length} posts injected`);

  // ── Try DeepSeek (primary) ──
  const ds = getDeepSeek();
  if (ds) {
    // Model fallback chain — fastest/cheapest first
    const DEEPSEEK_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'];

    for (const modelName of DEEPSEEK_MODELS) {
      try {
        const messages = [
          { role: 'system', content: systemPrompt },
          // inject last 10 history turns
          ...history.slice(-10).map(m => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content,
          })),
          { role: 'user', content: userMessage },
        ];

        const completion = await ds.chat.completions.create({
          model: modelName,
          messages,
          max_tokens: 400,
          temperature: 0.7,
        });

        const rawReply = completion.choices[0]?.message?.content || '';

        // Extract hidden order data block
        let orderData = null;
        const orderMatch = rawReply.match(/\[ORDER_DATA\](.*?)\[\/ORDER_DATA\]/s);
        if (orderMatch) {
          try { orderData = JSON.parse(orderMatch[1].trim()); } catch { }
        }

        const reply = rawReply.replace(/\[ORDER_DATA\].*?\[\/ORDER_DATA\]/s, '').trim();

        if (modelName !== 'deepseek-v4-flash') {
          console.log(`⚠️ Used fallback model: ${modelName} for tenant ${tenantConfig.storeName || '?'}`);
        } else {
          console.log(`✅ DeepSeek reply via ${modelName} (${reply.length} chars)`);
        }

        return { reply, orderData };

      } catch (err) {
        const errMsg = err.message || String(err);
        const isQuota    = errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('rate');
        const isNotFound = errMsg.includes('404') || errMsg.includes('not found');
        const isBadKey   = errMsg.includes('401') || errMsg.includes('API_KEY') || errMsg.includes('invalid') || errMsg.includes('authentication');
        console.error(`❌ DeepSeek [${modelName}] failed (${isQuota ? 'QUOTA' : isNotFound ? 'NOT_FOUND' : isBadKey ? 'BAD_KEY' : 'ERROR'}): ${errMsg.substring(0, 200)}`);
        continue;
      }
    }

    console.error(`❌ ALL DeepSeek models failed for tenant "${tenantConfig.storeName || '?'}".`);
  } else {
    console.warn('⚠️ No DEEPSEEK_API_KEY — DeepSeek unavailable.');
  }

  // ── Gemini text fallback (if key available) ──
  const geminiFallback = await geminiTextFallback(userMessage, history, systemPrompt, tenantConfig);
  if (geminiFallback) return geminiFallback;

  // Absolute last resort
  const storeName = tenantConfig.storeName || 'المتجر';
  return {
    reply: `مرحباً! 👋 شكراً على تواصلك مع ${storeName}. حالياً واجهنا مشكلة تقنية مؤقتة — حاول مرة أخرى بعد قليل أو تواصل معنا مباشرة. 🙏`,
    orderData: null,
  };
}

// ─────────────────────────────────────────────────────────────
// Gemini Text Fallback (when DeepSeek is down)
// ─────────────────────────────────────────────────────────────

async function geminiTextFallback(userMessage, history = [], systemPrompt = '', tenantConfig = {}) {
  const ai = getGenAI();
  if (!ai) {
    console.warn('⚠️ No GEMINI_API_KEY — cannot use Gemini fallback.');
    return null;
  }

  const MODEL_CHAIN = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'];
  const geminiHistory = history
    .slice(-10)
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  for (const modelName of MODEL_CHAIN) {
    try {
      const model = ai.getGenerativeModel({
        model: modelName,
        systemInstruction: systemPrompt,
      });

      const chat = model.startChat({ history: geminiHistory });
      const result = await chat.sendMessage(userMessage);
      const rawReply = result.response.text();

      let orderData = null;
      const orderMatch = rawReply.match(/\[ORDER_DATA\](.*?)\[\/ORDER_DATA\]/s);
      if (orderMatch) {
        try { orderData = JSON.parse(orderMatch[1].trim()); } catch { }
      }

      const reply = rawReply.replace(/\[ORDER_DATA\].*?\[\/ORDER_DATA\]/s, '').trim();
      console.log(`✅ Gemini fallback reply via ${modelName} (${reply.length} chars)`);
      return { reply, orderData };

    } catch (err) {
      console.error(`❌ Gemini fallback [${modelName}] failed: ${(err.message || '').substring(0, 200)}`);
      continue;
    }
  }

  return null;
}

/**
 * Simple rule-based intent detection (free, instant, no API call)
 */
function detectIntent(message) {
  const m = message.toLowerCase();
  if (/سلام|مرحبا|أهلا|bonjour|hello|واش راك|hi\b/.test(m))  return { intent: 'greeting' };
  if (/سعر|ثمن|prix|price|كم|combien|بكاش/.test(m))           return { intent: 'price_inquiry' };
  if (/شري|اشري|طلب|order|buy|حاب نشري|je veux/.test(m))     return { intent: 'purchase_intent' };
  if (/ألغ|إلغاء|annuler|cancel/.test(m))                     return { intent: 'cancel' };
  if (/واش عندك|منتج|product|catalogue|catalogue/.test(m))    return { intent: 'product_inquiry' };
  return { intent: 'unknown' };
}

/**
 * Transcribe a voice message and generate a reply.
 * Uses Gemini for audio transcription (multimodal), then DeepSeek for the reply.
 *
 * @param {string} audioUrl      - Public CDN URL of the audio file
 * @param {Array}  history       - Conversation history
 * @param {Array}  products      - Tenant product list
 * @param {object} tenantConfig  - Tenant settings
 * @param {Array}  posts         - Recent page posts (optional)
 * @returns {Promise<{reply: string, transcription: string, orderData: object|null}>}
 */
async function transcribeAudioAndReply(audioUrl, history = [], products = [], tenantConfig = {}, posts = []) {
  const systemPrompt = buildSystemPrompt(tenantConfig, products, posts);

  // Download audio from CDN
  let audioBase64, mimeType;
  try {
    const response = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' }, // some CDNs require a UA
    });
    audioBase64 = Buffer.from(response.data).toString('base64');
    // Detect MIME type from Content-Type header, fallback to audio/mp4 (IG default)
    mimeType = response.headers['content-type']?.split(';')[0] || 'audio/mp4';
    console.log(`🎤 Audio downloaded: ${Math.round(response.data.byteLength / 1024)}KB, mimeType=${mimeType}`);
  } catch (err) {
    console.error('❌ Failed to download audio:', err.message);
    const storeName = tenantConfig.storeName || 'المتجر';
    return {
      reply: `مرحباً! 👋 وصلتنا رسالتك الصوتية عند ${storeName}. للأسف ما قدرناش نفتحها حالياً — واش تحب تعرف عليه؟ أو اكتبلنا على طول. 🙏`,
      transcription: '',
      orderData: null,
    };
  }

  // Build conversation history in Gemini format
  const geminiHistory = history
    .slice(-10)
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  // ── Try Gemini for audio transcription + reply ──
  const ai = getGenAI();
  if (ai) {
    const AUDIO_MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash'];

    for (const modelName of AUDIO_MODELS) {
      try {
        const model = ai.getGenerativeModel({
          model: modelName,
          systemInstruction: systemPrompt,
        });

        const chat = model.startChat({ history: geminiHistory });
        const result = await chat.sendMessage([
          {
            inlineData: { data: audioBase64, mimeType },
          },
          {
            text: 'هذه رسالة صوتية من العميل. افهم محتواها ورد عليها بشكل طبيعي كما لو جاءت رسالة نصية.',
          },
        ]);

        const rawReply = result.response.text();

        let orderData = null;
        const orderMatch = rawReply.match(/\[ORDER_DATA\](.*?)\[\/ORDER_DATA\]/s);
        if (orderMatch) {
          try { orderData = JSON.parse(orderMatch[1].trim()); } catch { }
        }

        const reply = rawReply.replace(/\[ORDER_DATA\].*?\[\/ORDER_DATA\]/s, '').trim();
        console.log(`✅ Gemini audio reply via ${modelName}: "${reply.substring(0, 80)}"`);

        return { reply, transcription: '(voice)', orderData };

      } catch (err) {
        const errMsg = err.message || String(err);
        console.error(`❌ Gemini audio [${modelName}] failed: ${errMsg.substring(0, 200)}`);
        continue;
      }
    }
  }

  // Absolute last resort — politely ask user to type
  const storeName = tenantConfig.storeName || 'المتجر';
  return {
    reply: `مرحباً! 👋 وصلتنا رسالتك الصوتية عند ${storeName}. للأسف ماش قدرناش نفهموها حالياً — ممكن تكتبلنا طلبك بالنص وراح نخدمك 😊`,
    transcription: '',
    orderData: null,
  };
}

module.exports = { generateReply, transcribeAudioAndReply, detectIntent, buildSystemPrompt };
