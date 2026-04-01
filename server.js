const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIGURAÇÕES ────────────────────────────────────────────────────────────
// Cole aqui os dados da sua instância Z-API depois de criar
const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID || 'SEU_INSTANCE_ID';
const ZAPI_TOKEN       = process.env.ZAPI_TOKEN       || 'SEU_TOKEN';
const ZAPI_CLIENT_TOKEN= process.env.ZAPI_CLIENT_TOKEN|| 'SEU_CLIENT_TOKEN';
const MEU_NUMERO       = process.env.MEU_NUMERO       || '5533XXXXXXXXX'; // seu WhatsApp Business com DDI+DDD

// ─── ESTADO ───────────────────────────────────────────────────────────────────
// guarda mensagens não atendidas: { telefone -> { nome, msg, chegouEm, timers[] } }
const naoAtendidas = new Map();

// clientes conectados via SSE (para alertar o CRM em tempo real)
const sseClients = new Set();

// ─── SSE — tempo real para o CRM ─────────────────────────────────────────────
app.get('/eventos', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  sseClients.add(res);
  console.log(`[SSE] Cliente conectado. Total: ${sseClients.size}`);

  // manda estado atual para quem acabou de conectar
  const atual = [...naoAtendidas.values()];
  if (atual.length > 0) {
    res.write(`data: ${JSON.stringify({ tipo: 'estado_atual', mensagens: atual })}\n\n`);
  }

  req.on('close', () => {
    sseClients.delete(res);
    console.log(`[SSE] Cliente desconectado. Total: ${sseClients.size}`);
  });
});

function broadcast(evento) {
  const payload = `data: ${JSON.stringify(evento)}\n\n`;
  sseClients.forEach(client => {
    try { client.write(payload); } catch (e) { sseClients.delete(client); }
  });
}

// ─── WEBHOOK Z-API ────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde 200 imediatamente (obrigatório)

  const body = req.body;
  console.log('[Webhook] Recebido:', JSON.stringify(body).substring(0, 300));

  // Ignora mensagens enviadas por você mesmo
  if (body.fromMe) return;
  // Ignora grupos
  if (body.isGroup) return;
  // Só processa mensagens de texto ou áudio
  if (!body.text && !body.audio) return;

  const telefone = body.phone;
  const nome     = body.senderName || body.pushName || telefone;
  const texto    = body.text?.message || '📎 Mídia recebida';
  const chegouEm = Date.now();

  console.log(`[Nova msg] De: ${nome} (${telefone}) — "${texto}"`);

  // Se já tem entrada, só atualiza a mensagem
  if (naoAtendidas.has(telefone)) {
    const entry = naoAtendidas.get(telefone);
    entry.ultimaMsg = texto;
    entry.totalMsgs = (entry.totalMsgs || 1) + 1;
    naoAtendidas.set(telefone, entry);
    broadcast({ tipo: 'nova_mensagem', telefone, nome, texto, totalMsgs: entry.totalMsgs });
    return;
  }

  // Primeira mensagem deste contato — cria entrada
  const entry = { telefone, nome, texto, chegouEm, totalMsgs: 1, timers: [] };
  naoAtendidas.set(telefone, entry);

  // Alerta imediato no CRM
  broadcast({ tipo: 'nova_mensagem', telefone, nome, texto, chegouEm });

  // Envia alerta no WhatsApp agora
  await enviarAlertaZap(nome, telefone, texto, 0);

  // Agenda repetições a cada 60s enquanto não atendido
  let repeticao = 1;
  const interval = setInterval(async () => {
    if (!naoAtendidas.has(telefone)) {
      clearInterval(interval);
      return;
    }
    const minutos = repeticao;
    repeticao++;
    console.log(`[Lembrete] ${nome} sem resposta há ${minutos} min`);
    await enviarAlertaZap(nome, telefone, texto, minutos);
    broadcast({ tipo: 'lembrete', telefone, nome, minutos });
  }, 60 * 1000);

  entry.timers.push(interval);
});

// ─── MARCAR COMO ATENDIDO ────────────────────────────────────────────────────
app.post('/atendido', (req, res) => {
  const { telefone } = req.body;
  if (naoAtendidas.has(telefone)) {
    const entry = naoAtendidas.get(telefone);
    entry.timers.forEach(t => clearInterval(t));
    naoAtendidas.delete(telefone);
    console.log(`[Atendido] ${telefone} marcado como atendido`);
    broadcast({ tipo: 'atendido', telefone });
  }
  res.json({ ok: true });
});

// ─── LISTAR NÃO ATENDIDAS ────────────────────────────────────────────────────
app.get('/nao-atendidas', (req, res) => {
  res.json([...naoAtendidas.values()].map(e => ({
    telefone: e.telefone,
    nome: e.nome,
    texto: e.texto,
    chegouEm: e.chegouEm,
    totalMsgs: e.totalMsgs,
  })));
});

// ─── HEALTHCHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    app: 'JP Auto Peças — Servidor WhatsApp',
    naoAtendidas: naoAtendidas.size,
    sseClientes: sseClients.size,
  });
});

// ─── ENVIAR ALERTA VIA Z-API ─────────────────────────────────────────────────
async function enviarAlertaZap(nome, telefone, texto, minutos) {
  const msg = minutos === 0
    ? `🔔 *NOVA MENSAGEM — JP Auto Peças*\n\n👤 *${nome}*\n📞 ${telefone}\n💬 "${texto}"\n\n_Abra o CRM para atender._`
    : `🚨 *SEM RESPOSTA HÁ ${minutos} MIN!*\n\n👤 *${nome}* ainda aguarda\n💬 "${texto}"\n\n_Atenda agora no CRM!_`;

  try {
    const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Token': ZAPI_CLIENT_TOKEN,
      },
      body: JSON.stringify({ phone: MEU_NUMERO, message: msg }),
    });
    const data = await resp.json();
    console.log(`[Z-API] Alerta enviado:`, data);
  } catch (e) {
    console.error('[Z-API] Erro ao enviar alerta:', e.message);
  }
}

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 JP Auto Peças — Servidor rodando na porta ${PORT}`);
  console.log(`   Instance ID : ${ZAPI_INSTANCE_ID}`);
  console.log(`   Meu número  : ${MEU_NUMERO}\n`);
});
