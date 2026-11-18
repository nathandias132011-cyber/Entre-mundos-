import http from 'node:http';

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-6.2-astra';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(x => x.trim()).filter(Boolean);
const MAX_BODY = 40 * 1024;
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_IP = 18;
const requestCounts = new Map();

const POWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    speaker: { type: 'string' },
    narrative: { type: 'string' },
    choices: { type: 'array', items: { type: 'string' } },
    powerEffects: {
      type: 'object',
      additionalProperties: false,
      properties: {
        comprehension: { type: 'string' },
        optimization: { type: 'string' },
        memory: { type: 'string' },
        selfRegulation: { type: 'string' },
        adaptation: { type: 'string' }
      },
      required: ['comprehension', 'optimization', 'memory', 'selfRegulation', 'adaptation']
    }
  },
  required: ['title', 'speaker', 'narrative', 'choices', 'powerEffects']
};

const INSTRUCTIONS = `Você é o motor narrativo de ENTRE MUNDOS, um RPG de simulação de vida em português brasileiro.
Escreva como narrador de um jogo imersivo, com cenas concretas, conversas naturais, pausas, expressões observáveis, linguagem corporal e personagens com objetivos próprios.

REGRAS DA CAMPANHA:
- Preserve os fatos do contexto e as memórias recentes. Não contradiga o histórico.
- O protagonista é controlado exclusivamente pelo jogador. Nunca decida suas falas, pensamentos íntimos, intenções, ações seguintes ou sentimentos por ele.
- Narre apenas o que aconteceu após a ação descrita e as reações plausíveis do mundo. Personagens podem discordar, hesitar, interpretar errado, estar ocupados ou recusar pedidos.
- Não faça NPCs saberem pensamentos privados. Diferencie sinais observáveis de hipóteses.
- Use as respostas fictícias da criação para personalizar família, escola, amizades, personalidade e rotina.
- O mundo continua tendo horários, compromissos, necessidades e objetivos próprios. Não transforme todos os personagens em pessoas que esperam pelo protagonista.
- Não invente alterações mecânicas em dinheiro, inventário, XP, energia, localização ou calendário. O resultado do motor local é a fonte de verdade para essas variáveis. Você pode descrever a experiência, mas não declarar uma compra, deslocamento ou mudança de estado que contradiga o resultado local.
- Sempre ofereça exatamente quatro alternativas diferentes e concretas. Elas são sugestões, não limites: o jogador também pode escrever qualquer ação.
- Escreva uma cena desenvolvida, normalmente 3 a 6 parágrafos, com diálogos completos quando houver personagens presentes. Evite respostas curtas, genéricas ou repetitivas.
- Mantenha o conteúdo apropriado para adolescentes: sem conteúdo sexual explícito, sem romance imersivo em primeira pessoa, sem descrições gráficas de violência, ferimentos ou autoagressão.

OS CINCO PODERES SUPREMOS:
1. Compreensão Absoluta: entende instantaneamente informações, padrões, fenômenos e técnicas encontrados; quando compreende completamente uma técnica, pode executá-la imediatamente.
2. Otimização Absoluta: encontra e implementa aperfeiçoamentos contínuos na execução escolhida pelo protagonista, inclusive nos próprios poderes.
3. Memória Absoluta: registra e recupera informações e experiências com precisão perfeita.
4. Autorregulação Absoluta: regula e aperfeiçoa o próprio organismo e seus processos internos, sem remover emoções nem controlar decisões pessoais.
5. Adaptação Absoluta: reconhece fenômenos e desenvolve respostas evolutivas; preserva adaptações, pode adaptar vários fenômenos e aperfeiçoar o próprio processo adaptativo. A Roda da Evolução pode girar e manifestar novas etapas.

REGRAS DOS PODERES:
- Os cinco poderes começam no auge absoluto. Não invente custos, recargas, esgotamento, fraquezas artificiais ou teto fixo.
- Eles atuam passivamente e podem atuar conscientemente. A sinergia entre eles é permanente.
- Em CADA resposta, preencha uma descrição contextual individual para TODOS os cinco poderes, na ordem dada. Diga exatamente o que cada um fez naquele instante em relação à ação atual. Se algum só atuou em segundo plano, explique isso concretamente; nunca omita um poder e não diga apenas que “todos ajudaram”.
- Não force uma grande manifestação sobrenatural em ações comuns. A atuação pode ser silenciosa e funcional: compreensão dos sinais, otimização da execução, registro da experiência, regulação fisiológica e monitoramento/adaptação do contexto.
- Se a Adaptação Absoluta desenvolver algo novo, explique o fenômeno reconhecido, a resposta iniciada e a etapa/rotação da Roda da Evolução. Não invente que uma adaptação avançou se a cena não trouxe novidade relevante.
- A utilização dos poderes nunca substitui a escolha do jogador. A história não pode decidir automaticamente usar um poder em nome dele quando ele não escolheu essa ação, embora os aspectos passivos continuem ativos.

FORMATO: retorne somente o objeto JSON no formato solicitado. `;

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(body));
}

function setCors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
  if (allowed) res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes('*') ? '*' : origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function rateLimited(req) {
  const now = Date.now();
  const ip = req.socket.remoteAddress || 'unknown';
  let entry = requestCounts.get(ip);
  if (!entry || now - entry.start > WINDOW_MS) entry = { start: now, count: 0 };
  entry.count += 1;
  requestCounts.set(ip, entry);
  return entry.count > MAX_REQUESTS_PER_IP;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('O pedido excede o tamanho permitido.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function extractOutputText(response) {
  if (typeof response.output_text === 'string' && response.output_text.trim()) return response.output_text;
  const parts = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

function validateTurn(turn) {
  const requiredPowers = ['comprehension', 'optimization', 'memory', 'selfRegulation', 'adaptation'];
  if (!turn || typeof turn.title !== 'string' || typeof turn.speaker !== 'string' || typeof turn.narrative !== 'string') return false;
  if (!Array.isArray(turn.choices) || turn.choices.length !== 4 || turn.choices.some(x => typeof x !== 'string' || !x.trim())) return false;
  if (!turn.powerEffects || requiredPowers.some(k => typeof turn.powerEffects[k] !== 'string' || !turn.powerEffects[k].trim())) return false;
  return true;
}

const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/health') {
    send(res, 200, { ok: true, aiConfigured: Boolean(OPENAI_API_KEY), model: OPENAI_MODEL });
    return;
  }

  if (req.method !== 'POST' || url.pathname !== '/api/rpg-turn') {
    send(res, 404, { ok: false, error: 'Rota não encontrada.' });
    return;
  }

  if (rateLimited(req)) {
    send(res, 429, { ok: false, error: 'Muitas solicitações em pouco tempo. Tente novamente mais tarde.' });
    return;
  }
  if (!OPENAI_API_KEY) {
    send(res, 503, { ok: false, error: 'O servidor ainda não foi configurado com OPENAI_API_KEY.' });
    return;
  }

  try {
    const body = await readJson(req);
    const context = body?.context;
    if (!context || typeof context !== 'object') {
      send(res, 400, { ok: false, error: 'Contexto da cena ausente.' });
      return;
    }

    const prompt = `CONTEXTO ATUAL DO RPG (JSON):\n${JSON.stringify(context)}\n\nGere a continuação narrativa desta ação. Use o resultado do motor local como referência factual. Faça diálogos naturais, uma cena bem detalhada, quatro alternativas e os cinco registros contextuais de poder. Retorne JSON válido exatamente conforme o esquema.`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 85_000);
    let upstream;
    try {
      upstream = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          instructions: INSTRUCTIONS,
          input: prompt,
          text: {
            format: {
              type: 'json_schema',
              name: 'entre_mundos_scene',
              strict: true,
              schema: POWER_SCHEMA
            },
            verbosity: 'high'
          },
          max_output_tokens: 2600,
          store: false
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const message = result?.error?.message || `O provedor de IA respondeu com HTTP ${upstream.status}.`;
      send(res, 502, { ok: false, error: message.slice(0, 300) });
      return;
    }

    const raw = extractOutputText(result);
    let turn;
    try { turn = JSON.parse(raw); }
    catch { send(res, 502, { ok: false, error: 'A IA não retornou uma cena em formato válido.' }); return; }
    if (!validateTurn(turn)) {
      send(res, 502, { ok: false, error: 'A resposta da IA não passou pela validação da cena.' });
      return;
    }
    send(res, 200, { ok: true, turn });
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    send(res, timedOut ? 504 : 400, { ok: false, error: timedOut ? 'A geração demorou demais.' : (error?.message || 'Não foi possível processar a solicitação.').slice(0, 300) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Entre Mundos IA disponível na porta ${PORT}`);
  console.log(`Modelo configurado: ${OPENAI_MODEL}`);
  if (!OPENAI_API_KEY) console.warn('Defina OPENAI_API_KEY no ambiente do servidor.');
});
