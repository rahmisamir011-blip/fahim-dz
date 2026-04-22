/**
 * FAHIM DZ — AI Service (Google Gemini)
 * Multi-tenant: generates a personalised reply for each tenant's store
 * Powered by Gemini 2.0 Flash with model fallback chain
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

let genAI = null;

function getGenAI() {
  if (!genAI) {
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
 */
function buildSystemPrompt(tenantConfig = {}, products = []) {
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
- تثبيت الطلبيات بجمع: الاسم الكامل، رقم الهاتف، الولاية، المنتج، والكمية
- إذا طلب العميل إلغاء أو تعديل طلب، حوله للدعم البشري
- لا تخترع معلومات عن منتجات غير موجودة في القائمة المعطاة
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

  return prompt;
}

// ─────────────────────────────────────────────────────────────
// Main Reply Generator
// ─────────────────────────────────────────────────────────────

/**
 * Generate a personalised reply for a tenant
 * @param {string} userMessage   - the incoming customer message
 * @param {Array}  history       - [{role: 'user'|'assistant', content, ts}]
 * @param {Array}  products      - tenant product list from Firestore
 * @param {object} tenantConfig  - tenant settings (storeName, botName, language, ...)
 * @returns {Promise<{reply: string, orderData: object|null}>}
 */
async function generateReply(userMessage, history = [], products = [], tenantConfig = {}) {
  if (!process.env.GEMINI_API_KEY) {
    return {
      reply: 'عفواً، الذكاء الاصطناعي غير مُهيأ. تواصل مع المتجر مباشرة.',
      orderData: null,
    };
  }

  // Model fallback chain — most capable first
  const MODEL_CHAIN = [
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
  ];

  // Convert stored history to Gemini format (last 10 turns)
  const geminiHistory = history
    .slice(-10)
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const systemPrompt = buildSystemPrompt(tenantConfig, products);

  for (const modelName of MODEL_CHAIN) {
    try {
      const ai = getGenAI();
      const model = ai.getGenerativeModel({
        model: modelName,
        systemInstruction: systemPrompt,
      });

      const chat = model.startChat({ history: geminiHistory });
      const result = await chat.sendMessage(userMessage);
      const rawReply = result.response.text();

      // Extract hidden order data block
      let orderData = null;
      const orderMatch = rawReply.match(/\[ORDER_DATA\](.*?)\[\/ORDER_DATA\]/s);
      if (orderMatch) {
        try { orderData = JSON.parse(orderMatch[1].trim()); } catch { }
      }

      const reply = rawReply.replace(/\[ORDER_DATA\].*?\[\/ORDER_DATA\]/s, '').trim();

      if (modelName !== 'gemini-2.0-flash') {
        console.log(`⚠️ Used fallback model: ${modelName} for tenant ${tenantConfig.storeName || '?'}`);
      } else {
        console.log(`✅ Gemini reply via ${modelName} (${reply.length} chars)`);
      }

      return { reply, orderData };

    } catch (err) {
      const errMsg = err.message || String(err);
      const isQuota    = errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('RESOURCE_EXHAUSTED');
      const isNotFound = errMsg.includes('404') || errMsg.includes('not found') || errMsg.includes('NOT_FOUND');
      const isBadKey   = errMsg.includes('400') || errMsg.includes('API_KEY') || errMsg.includes('invalid');
      console.error(`❌ Gemini [${modelName}] failed (${isQuota ? 'QUOTA' : isNotFound ? 'NOT_FOUND' : isBadKey ? 'BAD_KEY' : 'ERROR'}): ${errMsg.substring(0, 200)}`);
      continue;
    }
  }

  // All models failed — log clearly so it's visible in Render
  console.error(`❌ ALL Gemini models failed for tenant "${tenantConfig.storeName}". Check GEMINI_API_KEY in Render env vars.`);
  console.error(`   Key present: ${process.env.GEMINI_API_KEY ? 'YES (length=' + process.env.GEMINI_API_KEY.length + ')' : 'NO — MISSING!'}`);

  return {
    reply: 'مرحباً! نحن هنا لخدمتك 😊 حاول مرة أخرى لو سمحت.',
    orderData: null,
  };
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

module.exports = { generateReply, detectIntent, buildSystemPrompt };
