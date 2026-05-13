export const config = {
  api: {
    bodyParser: { sizeLimit: '5mb' },
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
      return true;
    })
    .join('\n')
    .trim();
}

function extractJsonFromResponse(payload) {
  const outputText =
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

  if (!outputText) {
    throw new Error('OpenAI returned an empty response.');
  }

  return JSON.parse(outputText);
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

  const systemPrompt = `
You are a hospital staff schedule parser.

Return ONLY valid JSON matching the schema exactly.
No markdown.
No explanation.
No code fences.

Rules:
- D = day shift
- N = night shift
- ANNUAL / annual leave / vacation = AL
- Request Off / Req Off / RO = RO
- REST DAY / REST / OFF = X
- EDU ON / EDU / training / study = D
- "-" means blank, not a shift
- Support:
  1) YYYY-MM-DD
  2) MM/DD/YYYY
  3) MM/DD with year inferred from the schedule period
- Convert all output dates to YYYY-MM-DD
- Include all employees found
- If role is missing, return empty string
- If unit is missing, return "—"
- Deduplicate employees by name
- Expand date ranges if present

Examples you must understand:
- Period: 04/26/2026 - 06/06/2026
- 01. OMAR, SADAL [AHN]
- QUICK SECTION - ALSHAMMARI, NAWAF
- Skill   : SN I
- 04/26 Sun    : D 12 SN I
- 05/25 Mon    : ANNUAL
- 05/26 Tue    : Request Off
- 05/22 Fri    : REST DAY
- 05/06 Wed    : EDU ON
- 04/28 Tue    : -
`.trim();

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
            X: { type: 'array', items: { type: 'string' } },
          },
          required: ['name', 'role', 'D', 'N', 'AL', 'RO', 'X'],
        },
      },
    },
    required: ['unit', 'start', 'end', 'employees'],
  };

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.5',
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: systemPrompt,
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: text,
              },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'schedule_parse',
            strict: true,
            schema,
          },
        },
      }),
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
      parsed = extractJsonFromResponse(payload);
    } catch (e) {
      return res.status(500).json({
        error: 'OpenAI returned invalid JSON.',
      });
    }

    const result = normalizeResult(parsed);

    if (!result.employees.length) {
      return res.status(500).json({
        error: 'OpenAI returned no employees.',
      });
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reach OpenAI: ' + err.message });
  }
}
