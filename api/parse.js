export const config = {
  api: {
    bodyParser: { sizeLimit: '2mb' },
  },
};

function cleanInputText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^Phone\s*:/i.test(t)) return false;
      if (/^FTE\s*:/i.test(t)) return false;
      if (/^Pattern\s*:/i.test(t)) return false;
      if (/^EMPLOYEE INDEX$/i.test(t)) return false;
      if (/^\d+\.\s+.+\[[^\]]+\]\s*$/i.test(t)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

function extractJsonFromPayload(payload) {
  const text =
    typeof payload?.output_text === 'string'
      ? payload.output_text
      : Array.isArray(payload?.output)
        ? payload.output
            .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
            .filter((c) => c?.type === 'output_text' && typeof c?.text === 'string')
            .map((c) => c.text)
            .join('\n')
            .trim()
        : '';

  if (!text) {
    throw new Error('OpenAI returned an empty response.');
  }

  return JSON.parse(text);
}

function normalizeEmployee(emp) {
  const out = {
    name: String(emp?.name || '').trim(),
    role: String(emp?.role || '').trim(),
    D: Array.isArray(emp?.D) ? emp.D : [],
    N: Array.isArray(emp?.N) ? emp.N : [],
    AL: Array.isArray(emp?.AL) ? emp.AL : [],
    RO: Array.isArray(emp?.RO) ? emp.RO : [],
    X: Array.isArray(emp?.X) ? emp.X : [],
  };

  ['D', 'N', 'AL', 'RO', 'X'].forEach((k) => {
    out[k] = [...new Set(out[k].map((x) => String(x).trim()).filter(Boolean))].sort();
  });

  return out;
}

function normalizeResult(data) {
  return {
    unit: String(data?.unit || '—').trim() || '—',
    start: String(data?.start || '').trim(),
    end: String(data?.end || '').trim(),
    employees: Array.isArray(data?.employees) ? data.employees.map(normalizeEmployee) : [],
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server not configured: OPENAI_API_KEY missing' });
  }

  const originalText = String(req.body?.text || '').trim();
  if (!originalText) {
    return res.status(400).json({ error: 'Missing schedule text' });
  }

  const text = cleanInputText(originalText);

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      unit: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      employees: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            role: { type: 'string' },
            D: { type: 'array', items: { type: 'string' } },
            N: { type: 'array', items: { type: 'string' } },
            AL: { type: 'array', items: { type: 'string' } },
            RO: { type: 'array', items: { type: 'string' } },
            X: { type: 'array', items: { type: 'string' } }
          },
          required: ['name', 'role', 'D', 'N', 'AL', 'RO', 'X']
        }
      }
    },
    required: ['unit', 'start', 'end', 'employees']
  };

  const systemText = [
    'You are a hospital staff schedule parser.',
    'Return only valid JSON that matches the schema.',
    'No markdown. No explanation. No code fences.',
    'Map codes as follows:',
    'D = day shift',
    'N = night shift',
    'ANNUAL / annual leave / vacation = AL',
    'Request Off / Req Off / RO = RO',
    'REST DAY / REST / OFF = X',
    'EDU ON / EDU / training / study = D',
    '"-" means blank, not a shift.',
    'Support dates in YYYY-MM-DD, MM/DD/YYYY, and MM/DD with year inferred from the schedule period.',
    'Convert all output dates to YYYY-MM-DD.',
    'Deduplicate employees by name.',
    'If role is missing, return empty string.',
    'If unit is missing, return "—".'
  ].join('\n');

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        input: [
          {
            role: 'system',
            content: [{ type: 'input_text', text: systemText }]
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text }]
          }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'schedule_parse',
            strict: true,
            schema
          }
        },
        max_output_tokens: 5000
      })
    });

    const payload = await openaiRes.json().catch(() => ({}));

    if (!openaiRes.ok) {
      const msg =
        payload?.error?.message ||
        payload?.message ||
        `OpenAI API error ${openaiRes.status}`;
      return res.status(openaiRes.status).json({ error: msg });
    }

    let parsed;
    try {
      parsed = extractJsonFromPayload(payload);
    } catch (e) {
      return res.status(500).json({ error: 'OpenAI returned invalid JSON.' });
    }

    const result = normalizeResult(parsed);

    if (!result.employees.length) {
      return res.status(500).json({ error: 'OpenAI returned no employees.' });
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reach OpenAI: ' + err.message });
  }
}
