export const config = {
  api: {
    bodyParser: {
      sizeLimit: '2mb',
    },
  },
};

function extractGeminiText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('\n')
    .trim();
}

function safeJsonParse(raw) {
  const text = String(raw || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error('Model did not return valid JSON.');
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is missing on the server.' });
  }

  const text = String(req.body?.text || '').trim();
  if (!text) {
    return res.status(400).json({ error: 'Missing schedule text.' });
  }

  if (text.length > 180000) {
    return res.status(400).json({ error: 'Schedule text is too large for one AI parsing request.' });
  }

  const prompt = [
    'You convert messy hospital staff schedule text into strict JSON.',
    'Return JSON only. No markdown. No explanation.',
    'Use this exact shape:',
    '{"unit":"string","start":"YYYY-MM-DD","end":"YYYY-MM-DD","employees":[{"name":"string","role":"string","D":["YYYY-MM-DD"],"N":["YYYY-MM-DD"],"AL":["YYYY-MM-DD"],"RO":["YYYY-MM-DD"],"X":["YYYY-MM-DD"]}]}',
    'Rules:',
    '- D = working day shift.',
    '- N = working night shift.',
    '- ANNUAL or annual leave = AL.',
    '- Request Off = RO.',
    '- REST DAY or off/rest states = X.',
    '- EDU ON counts as D.',
    '- Ignore empty cells or bare dashes.',
    '- Support YYYY-MM-DD, MM/DD/YYYY, and MM/DD with year inferred from period.',
    '- Deduplicate employees by name.',
    '- If role is unknown, use an empty string.',
    '- If unit is unknown, use "—".',
    '- Return every date in ISO format YYYY-MM-DD.',
    '',
    'Schedule text:',
    text,
  ].join('\n');

  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
          },
        }),
      }
    );

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({
        error: payload?.error?.message || payload?.message || `Gemini API error ${response.status}`,
      });
    }

    const outputText = extractGeminiText(payload);
    if (!outputText) {
      return res.status(500).json({ error: 'Gemini returned an empty response.' });
    }

    const data = safeJsonParse(outputText);
    return res.status(200).json({ data });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Unexpected server error.' });
  }
}
