/**
 * FAHIM DZ — AI Service (Google Gemini)
 * Algerian Dialect Sales Agent powered by Gemini 2.0 Flash
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

let genAI = null;

function getGenAI() {
  if (!genAI) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return genAI;
}

const SYSTEM_PROMPT = `أنت "فهيم"، وكيل بيع ذكي يعمل لخدمة متجر جزائري على الإنترنت.
تتكلم بالدارجة الجزائرية بشكل طبيعي وودود، وتستطيع أيضًا الرد بالفرنسية والعربية الفصحى حسب لغة المحادثة.

**مهمتك الرئيسية:**
- الرد على استفسارات العملاء عن المنتجات (السعر، الوصف، التوفر)
- تثبيت الطلبيات بجمع: الاسم الكامل، رقم الهاتف، الولاية، المنتج، والكمية
- إذا طلب العميل إلغاء أو تعديل طلب، حوله للدعم البشري
- لا تخترع معلومات عن منتجات غير موجودة في القائمة المعطاة

**أسلوب التواصل:**
- كن ودوداً وطبيعياً (مثال: "واش راك؟ شو تحب نخدمك؟")
- استخدم الإيموجي بشكل معتدل 😊 🛍️
- كن مختصراً ومباشراً — لا ترد برسائل طويلة جداً
- إذا ما عندكش معلومات على سؤال، قول صراحةً "مانعرفش" ولا تخترع

**عند تثبيت الطلبية:**
إذا قدّم العميل كل المعلومات المطلوبة (الاسم، الهاتف، الولاية، المنتج)، قل له:
"الطلبية تأكدت! ✅ راح يتواصل معاك فريقنا قريب يتأكد من التسليم."

ثم أضف في آخر ردك هذا السطر بالضبط (لا تظهره للعميل، ضعه بين العلامتين):
[ORDER_DATA]{"intent":"order_confirmed","client":"...","phone":"...","wilaya":"...","product":"...","qty":1}[/ORDER_DATA]`;

/**
 * Generate Algerian dialect reply using Gemini
 * @param {string} userMessage
 * @param {Array} history - [{role: 'user'|'model', parts: [{text}]}]
 * @param {Array} products - tenant product list
 * @returns {Promise<{reply: string, orderData: object|null}>}
 */
async function generateReply(userMessage, history = [], products = []) {
  if (!process.env.GEMINI_API_KEY) {
    return {
      reply: 'عفواً، الذكاء الاصطناعي غير مُهيأ بعد. أضف GEMINI_API_KEY إلى ملف .env',
      orderData: null
    };
  }

  // Try models in order — fall back if quota or model not found
  const MODEL_FALLBACK_CHAIN = [
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
  ];

  const geminiHistory = history
    .slice(-10)
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const systemPrompt = buildSystemPrompt(products);

  for (const modelName of MODEL_FALLBACK_CHAIN) {
    try {
      const ai = getGenAI();
      const model = ai.getGenerativeModel({
        model: modelName,
        systemInstruction: systemPrompt,
      });

      const chat = model.startChat({ history: geminiHistory });
      const result = await chat.sendMessage(userMessage);
      const rawReply = result.response.text();

      // Extract order data if present
      let orderData = null;
      const orderMatch = rawReply.match(/\[ORDER_DATA\](.*?)\[\/ORDER_DATA\]/s);
      if (orderMatch) {
        try { orderData = JSON.parse(orderMatch[1].trim()); } catch { }
      }

      const reply = rawReply.replace(/\[ORDER_DATA\].*?\[\/ORDER_DATA\]/s, '').trim();
      if (modelName !== 'gemini-2.0-flash') {
        console.log(`⚠️ Used fallback AI model: ${modelName}`);
      }
      return { reply, orderData };

    } catch (err) {
      const isQuota = err.message?.includes('429') || err.message?.includes('quota') || err.message?.includes('RESOURCE_EXHAUSTED');
      const isNotFound = err.message?.includes('404') || err.message?.includes('not found') || err.message?.includes('NOT_FOUND');
      if (isQuota || isNotFound) {
        console.warn(`⚠️ Gemini ${isQuota ? 'quota' : 'not found'} for ${modelName}, trying next...`);
        continue; // try next model
      }
      console.error(`❌ Gemini error with model ${modelName}:`, err.message);
      continue; // try next model anyway
    }
  }

  return {
    reply: 'مرحباً! فهيم جاهز لخدمتك 😊 حاول مرة أخرى لو سمحت.',
    orderData: null
  };
}


function buildSystemPrompt(products) {
  let prompt = SYSTEM_PROMPT;
  if (products.length > 0) {
    prompt += '\n\n**قائمة المنتجات المتاحة:**\n' +
      products.map(p => `- ${p.name}: ${p.price} د.ج (المخزون: ${p.stock ?? '?'} وحدة)`).join('\n');
  }
  return prompt;
}

/**
 * Simple rule-based intent detection (free, instant)
 */
function detectIntent(message) {
  const m = message.toLowerCase();
  if (/سلام|مرحبا|أهلا|bonjour|hello|واش راك/.test(m)) return { intent: 'greeting' };
  if (/سعر|ثمن|prix|price|كم|combien|بكاش/.test(m))    return { intent: 'price_inquiry' };
  if (/شري|اشري|طلب|order|buy|حاب نشري/.test(m))       return { intent: 'purchase_intent' };
  if (/ألغ|إلغاء|annuler|cancel/.test(m))               return { intent: 'cancel' };
  if (/واش عندك|منتج|product|catalogue/.test(m))        return { intent: 'product_inquiry' };
  return { intent: 'unknown' };
}

module.exports = { generateReply, detectIntent };
