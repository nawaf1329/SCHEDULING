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

function extractJson(text) {
  const raw = String(text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(raw);
  } catch (_) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error('Model did not return valid JSON.');
  }
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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server not configured: GEMINI_API_KEY missing' });
  }

  const originalText = String(req.body?.text || '').trim();
  if (!originalText) {
    return res.status(400).json({ error: 'Missing schedule text' });
  }

  const text = cleanInputText(originalText);

  const prompt = `
You are a hospital staff schedule parser.

Return ONLY one valid JSON object.
No markdown.
No code fences.
No explanation.

Required JSON format:
{
  "unit": "string",
  "start": "YYYY-MM-DD",
  "end": "YYYY-MM-DD",
  "employees": [
    {
      "name": "string",
      "role": "string",
      "D": ["YYYY-MM-DD"],
      "N": ["YYYY-MM-DD"],
      "AL": ["YYYY-MM-DD"],
      "RO": ["YYYY-MM-DD"],
      "X": ["YYYY-MM-DD"]
    }
  ]
}

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

Schedule text:
${text}
  `.trim();

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            maxOutputTokens: 8192,
          },
        }),
      }
    );

    const payload = await geminiRes.json().catch(() => ({}));

    if (!geminiRes.ok) {
      const msg =
        payload?.error?.message ||
        payload?.message ||
        `Gemini API error ${geminiRes.status}`;
      return res.status(geminiRes.status).json({ error: msg });
    }

    const rawText =
      payload?.candidates?.[0]?.content?.parts?.map((p) => p?.text || '').join('\n').trim() || '';

    if (!rawText) {
      return res.status(500).json({ error: 'Gemini returned an empty response.' });
    }

    let parsed;
    try {
      parsed = extractJson(rawText);
    } catch (e) {
      return res.status(500).json({
        error: 'Gemini returned invalid JSON.',
        raw_preview: rawText.slice(0, 500),
      });
    }

    const result = normalizeResult(parsed);

    if (!result.employees.length) {
      return res.status(500).json({
        error: 'Gemini returned no employees.',
        raw_preview: rawText.slice(0, 500),
      });
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reach Gemini: ' + err.message });
  }
}
