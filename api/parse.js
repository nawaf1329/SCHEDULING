export const config = {
  api: {
    bodyParser: { sizeLimit: '5mb' },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY environment variable is not set');
    return res.status(500).json({ error: 'Server not configured: GEMINI_API_KEY missing' });
  }

  const { text } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Missing schedule text' });
  }

  const prompt = `You are a hospital staff schedule parser. Parse the schedule text below and return ONLY a valid JSON object — no markdown, no explanation, no code blocks.

Output structure:
{
  "unit": "string — unit/ward name, or — if not found",
  "start": "YYYY-MM-DD",
  "end": "YYYY-MM-DD",
  "employees": [
    {
      "name": "LAST, FIRST",
      "role": "role code e.g. SN I, AHN, CA",
      "D":  ["YYYY-MM-DD", ...],
      "N":  ["YYYY-MM-DD", ...],
      "AL": ["YYYY-MM-DD", ...],
      "RO": ["YYYY-MM-DD", ...],
      "X":  ["YYYY-MM-DD", ...]
    }
  ]
}

Field definitions:
- D  = day shift
- N  = night shift
- AL = annual leave / vacation (any: ANNUAL, VACATION, LEAVE, AL)
- RO = request off / day off (any: REQUEST OFF, REQ OFF, RO, DAY OFF)
- X  = rest day / off / other (any: REST DAY, REST, OFF, -, EDU ON, EDU, STUDY, TRAINING)

Date format rules:
- All output dates must be YYYY-MM-DD
- Input may use MM/DD (e.g. 04/26) — infer year from the period line or nearby full dates
- Input may use MM/DD/YYYY (e.g. 04/26/2026) — use that year
- Expand ALL date ranges to individual dates

Common input patterns to handle:
- Period lines like: "Period: 04/26/2026 - 06/06/2026" or "04/26/2026 to 06/06/2026"
- Employee index lines like: "01. OMAR, SADAL [AHN]" or "EMPLOYEE: SMITH, JOHN"
- Skill/role lines like: "Skill : SN I" or "Role: AHN"
- Daily schedule rows like:
    "04/26 Sun : D 12 SN I"   → date 04/26, code D
    "05/25 Mon : ANNUAL"      → date 05/25, code AL
    "05/26 Tue : Request Off" → date 05/26, code RO
    "05/22 Fri : REST DAY"    → date 05/22, code X
    "05/06 Wed : EDU ON"      → date 05/06, code X
    "04/28 Tue : -"           → date 04/28, code X
    "04/27 Mon : N"           → date 04/27, code N
- Employee sections separated by ==== or --- or blank lines
- Quick section headers like: "QUICK SECTION - SMITH, JOHN"

Include ALL employees found. Return ONLY the JSON object.

Schedule text:
${text}`;

  try {
    const geminiRes = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 16384,
      },
    }),
  }
);

    if (!geminiRes.ok) {
      const errBody = await geminiRes.json().catch(() => ({}));
      const msg = errBody?.error?.message || `Gemini API error ${geminiRes.status}`;
      console.error('Gemini error:', msg);
      return res.status(geminiRes.status).json({ error: msg });
    }

    const geminiData = await geminiRes.json();
    const raw = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!raw.trim()) {
      return res.status(500).json({ error: 'Gemini returned an empty response. Try a more structured schedule format.' });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch (e) {
      console.error('JSON parse failed. Raw:', raw.slice(0, 300));
      return res.status(500).json({ error: 'Could not parse AI response. The schedule format may be too complex — try simplifying it.' });
    }

    if (!parsed.employees || !Array.isArray(parsed.employees)) {
      return res.status(500).json({ error: 'Unexpected response structure from AI.' });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Failed to reach AI service: ' + err.message });
  }
}
