const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'openai/gpt-oss-20b';
const CONNECT_TIMEOUT_MS = 3_000;
const READ_TIMEOUT_MS = 4_000;
const MESSAGE_LIMIT = 2_000;

export type ClassifyCategory = { id: string; label: string };

export type ClassifyBody = {
  merchant: string;
  amount_minor: number;
  channel: string;
  message: string;
  allowed_categories: ClassifyCategory[];
};

export type ClassifyResult = { category_id: string; confidence: number };

export function parseClassifyBody(body: unknown): ClassifyBody {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray((body as { allowed_categories?: unknown }).allowed_categories)) {
    throw new Error('allowed_categories is required');
  }
  const raw = body as Record<string, unknown>;
  const allowed_categories: ClassifyCategory[] = [];
  for (const item of raw.allowed_categories as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const category = item as Record<string, unknown>;
    if (typeof category.id === 'string' && typeof category.label === 'string') {
      allowed_categories.push({ id: category.id, label: category.label });
    }
  }
  return {
    merchant: typeof raw.merchant === 'string' ? raw.merchant : '',
    amount_minor: typeof raw.amount_minor === 'number' && Number.isFinite(raw.amount_minor) ? raw.amount_minor : 0,
    channel: typeof raw.channel === 'string' ? raw.channel : '',
    message: typeof raw.message === 'string' ? raw.message : '',
    allowed_categories
  };
}

export type ClassifyFn = (apiKey: string, body: ClassifyBody) => Promise<ClassifyResult | null>;

export async function runClassify(apiKey: string | null, body: ClassifyBody, classify: ClassifyFn = classifyTransaction): Promise<ClassifyResult | null> {
  if (!apiKey || body.allowed_categories.length === 0) return null;
  try {
    const result = await classify(apiKey, body);
    if (!result || !body.allowed_categories.some((category) => category.id === result.category_id)) return null;
    return { category_id: result.category_id, confidence: result.confidence };
  } catch {
    return null;
  }
}

export async function classifyTransaction(apiKey: string, body: ClassifyBody): Promise<ClassifyResult | null> {
  if (body.allowed_categories.length === 0) return null;
  const allowedIds = body.allowed_categories.map((category) => category.id);
  const payload = {
    model: MODEL,
    temperature: 0,
    max_completion_tokens: 120,
    messages: [
      {
        role: 'system',
        content: 'Classify the transaction into exactly one allowed monthly budget category. Use merchant, payment channel, and message context. Never invent a category.'
      },
      {
        role: 'user',
        content: JSON.stringify({
          transaction: {
            merchant: body.merchant,
            amount_minor: body.amount_minor,
            channel: body.channel,
            message: body.message.slice(0, MESSAGE_LIMIT)
          },
          allowed_categories: body.allowed_categories
        })
      }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'transaction_category',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['category_id', 'confidence'],
          properties: {
            category_id: { type: 'string', enum: allowedIds },
            confidence: { type: 'number', minimum: 0, maximum: 1 }
          }
        }
      }
    }
  };

  try {
    const response = await groqPost(apiKey, payload);
    if (!response) return null;
    const content = (response as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;
    const parsed = JSON.parse(content) as { category_id?: unknown; confidence?: unknown };
    if (typeof parsed.category_id !== 'string' || !allowedIds.includes(parsed.category_id)) return null;
    if (typeof parsed.confidence !== 'number' || !Number.isFinite(parsed.confidence)) return null;
    return {
      category_id: parsed.category_id,
      confidence: Math.min(1, Math.max(0, parsed.confidence))
    };
  } catch {
    return null;
  }
}

// Device client uses 3s connect / 4s read; fetch resolves on headers, then we read the body.
async function groqPost(apiKey: string, payload: unknown): Promise<unknown | null> {
  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(connectTimer);
    if (!response.ok) return null;
    const readTimer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
    try {
      return await response.json();
    } finally {
      clearTimeout(readTimer);
    }
  } finally {
    clearTimeout(connectTimer);
  }
}
