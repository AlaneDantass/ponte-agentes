// Ponte entre agentes — servidor MCP remoto (Streamable HTTP, sem estado de sessão)
// Sem dependências: usa só Node 22.5+ (node:http e node:sqlite).
//
// Variáveis de ambiente:
//   PONTE_TOKEN  (obrigatória) segredo que entra na URL: https://seu-host/mcp/<PONTE_TOKEN>
//   PORT         (opcional, padrão 8080)
//   DB_PATH      (opcional, padrão ./ponte.db) — use um volume persistente em produção

import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { timingSafeEqual } from "node:crypto";

const TOKEN = process.env.PONTE_TOKEN;
const PORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.DB_PATH || "./ponte.db";

if (!TOKEN || TOKEN.length < 24) {
  console.error("Defina PONTE_TOKEN com pelo menos 24 caracteres (ex.: openssl rand -hex 24).");
  process.exit(1);
}

// ---------- Banco ----------
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS tarefas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo TEXT NOT NULL,
    descricao TEXT NOT NULL DEFAULT '',
    criada_por TEXT NOT NULL,
    responsavel TEXT,
    status TEXT NOT NULL DEFAULT 'aberta',
    prioridade TEXT NOT NULL DEFAULT 'normal',
    resultado TEXT,
    criada_em TEXT NOT NULL,
    atualizada_em TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mensagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    de TEXT NOT NULL,
    para TEXT NOT NULL,
    texto TEXT NOT NULL,
    tarefa_id INTEGER,
    lida INTEGER NOT NULL DEFAULT 0,
    criada_em TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS historico (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tarefa_id INTEGER NOT NULL,
    agente TEXT NOT NULL,
    evento TEXT NOT NULL,
    criado_em TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS leituras_gerais (
    agente TEXT PRIMARY KEY,
    ultimo_id INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_msg_para ON mensagens(para, lida);
  CREATE INDEX IF NOT EXISTS idx_tar_resp ON tarefas(responsavel, status);
`);

const agora = () => new Date().toISOString();
const STATUS = ["aberta", "em_andamento", "bloqueada", "em_revisao", "concluida", "cancelada"];
const PRIORIDADES = ["baixa", "normal", "alta", "urgente"];
const TODOS = "*"; // destinatário especial: todos os agentes

function registrar(tarefaId, agente, evento) {
  db.prepare("INSERT INTO historico (tarefa_id, agente, evento, criado_em) VALUES (?, ?, ?, ?)")
    .run(tarefaId, agente, evento, agora());
}

function exigir(args, campos) {
  for (const c of campos) {
    if (args[c] === undefined || args[c] === null || String(args[c]).trim() === "") {
      throw new Error(`Campo obrigatório ausente: ${c}`);
    }
  }
}

// ---------- Ferramentas ----------
const ferramentas = {
  criar_tarefa: {
    description:
      "Cria uma tarefa no quadro compartilhado e, se houver responsável, avisa por mensagem. Use para delegar trabalho a outro agente.",
    inputSchema: {
      type: "object",
      properties: {
        agente: { type: "string", description: "Seu nome de agente (quem está criando)." },
        titulo: { type: "string" },
        descricao: { type: "string", description: "Contexto, critérios de aceite, links, caminhos de arquivo." },
        responsavel: { type: "string", description: "Agente que deve executar. Vazio = qualquer um pode pegar." },
        prioridade: { type: "string", enum: PRIORIDADES },
      },
      required: ["agente", "titulo"],
    },
    run(a) {
      exigir(a, ["agente", "titulo"]);
      const prioridade = a.prioridade || "normal";
      if (!PRIORIDADES.includes(prioridade)) throw new Error(`Prioridade inválida: ${prioridade}`);
      const t = agora();
      const { lastInsertRowid: id } = db
        .prepare(
          `INSERT INTO tarefas (titulo, descricao, criada_por, responsavel, prioridade, criada_em, atualizada_em)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(a.titulo, a.descricao || "", a.agente, a.responsavel || null, prioridade, t, t);
      registrar(id, a.agente, `criou a tarefa${a.responsavel ? ` para ${a.responsavel}` : ""}`);
      if (a.responsavel) {
        db.prepare("INSERT INTO mensagens (de, para, texto, tarefa_id, criada_em) VALUES (?, ?, ?, ?, ?)")
          .run(a.agente, a.responsavel, `Nova tarefa #${id}: ${a.titulo}`, id, t);
      }
      return { id: Number(id), status: "aberta" };
    },
  },

  listar_tarefas: {
    description:
      "Lista tarefas do quadro. Filtre por responsável e/ou status. Sem filtros, mostra as não finalizadas.",
    inputSchema: {
      type: "object",
      properties: {
        responsavel: { type: "string", description: "Nome do agente, ou 'livre' para tarefas sem responsável." },
        status: { type: "string", enum: STATUS },
        limite: { type: "number", description: "Padrão 50." },
      },
    },
    run(a) {
      const where = [];
      const params = [];
      if (a.responsavel === "livre") where.push("responsavel IS NULL");
      else if (a.responsavel) { where.push("responsavel = ?"); params.push(a.responsavel); }
      if (a.status) { where.push("status = ?"); params.push(a.status); }
      else where.push("status NOT IN ('concluida','cancelada')");
      const limite = Math.min(Number(a.limite) || 50, 200);
      const sql = `SELECT id, titulo, criada_por, responsavel, status, prioridade, atualizada_em FROM tarefas
                   WHERE ${where.join(" AND ")}
                   ORDER BY CASE prioridade WHEN 'urgente' THEN 0 WHEN 'alta' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, id
                   LIMIT ${limite}`;
      return { tarefas: db.prepare(sql).all(...params) };
    },
  },

  ver_tarefa: {
    description: "Mostra uma tarefa completa, com histórico e mensagens ligadas a ela.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
    },
    run(a) {
      exigir(a, ["id"]);
      const tarefa = db.prepare("SELECT * FROM tarefas WHERE id = ?").get(a.id);
      if (!tarefa) throw new Error(`Tarefa #${a.id} não existe.`);
      const historico = db.prepare("SELECT agente, evento, criado_em FROM historico WHERE tarefa_id = ? ORDER BY id").all(a.id);
      const mensagens = db.prepare("SELECT de, para, texto, criada_em FROM mensagens WHERE tarefa_id = ? ORDER BY id").all(a.id);
      return { tarefa, historico, mensagens };
    },
  },

  atualizar_tarefa: {
    description:
      "Atualiza status, responsável ou resultado de uma tarefa (ex.: pegar uma tarefa livre, marcar em andamento, entregar resultado). Avisa o criador por mensagem.",
    inputSchema: {
      type: "object",
      properties: {
        agente: { type: "string", description: "Seu nome de agente." },
        id: { type: "number" },
        status: { type: "string", enum: STATUS },
        responsavel: { type: "string", description: "Novo responsável (use o seu nome para pegar a tarefa)." },
        resultado: { type: "string", description: "Entrega: resumo, links, caminhos de arquivo, PR etc." },
        nota: { type: "string", description: "Comentário curto que entra no histórico." },
      },
      required: ["agente", "id"],
    },
    run(a) {
      exigir(a, ["agente", "id"]);
      const tarefa = db.prepare("SELECT * FROM tarefas WHERE id = ?").get(a.id);
      if (!tarefa) throw new Error(`Tarefa #${a.id} não existe.`);
      if (a.status && !STATUS.includes(a.status)) throw new Error(`Status inválido: ${a.status}`);
      const mudancas = [];
      const novo = { ...tarefa };
      if (a.status && a.status !== tarefa.status) { novo.status = a.status; mudancas.push(`status → ${a.status}`); }
      if (a.responsavel && a.responsavel !== tarefa.responsavel) { novo.responsavel = a.responsavel; mudancas.push(`responsável → ${a.responsavel}`); }
      if (a.resultado) { novo.resultado = a.resultado; mudancas.push("resultado registrado"); }
      if (a.nota) mudancas.push(`nota: ${a.nota}`);
      if (!mudancas.length) return { id: tarefa.id, aviso: "Nada para atualizar." };
      db.prepare("UPDATE tarefas SET status = ?, responsavel = ?, resultado = ?, atualizada_em = ? WHERE id = ?")
        .run(novo.status, novo.responsavel, novo.resultado, agora(), tarefa.id);
      const evento = mudancas.join("; ");
      registrar(tarefa.id, a.agente, evento);
      if (tarefa.criada_por !== a.agente) {
        db.prepare("INSERT INTO mensagens (de, para, texto, tarefa_id, criada_em) VALUES (?, ?, ?, ?, ?)")
          .run(a.agente, tarefa.criada_por, `Tarefa #${tarefa.id} (${tarefa.titulo}): ${evento}`, tarefa.id, agora());
      }
      return { id: tarefa.id, status: novo.status, responsavel: novo.responsavel };
    },
  },

  enviar_mensagem: {
    description: "Envia uma mensagem a outro agente (ou a todos com para='*'), opcionalmente ligada a uma tarefa.",
    inputSchema: {
      type: "object",
      properties: {
        agente: { type: "string", description: "Seu nome de agente (remetente)." },
        para: { type: "string", description: "Agente destinatário, ou '*' para todos." },
        texto: { type: "string" },
        tarefa_id: { type: "number" },
      },
      required: ["agente", "para", "texto"],
    },
    run(a) {
      exigir(a, ["agente", "para", "texto"]);
      const { lastInsertRowid: id } = db
        .prepare("INSERT INTO mensagens (de, para, texto, tarefa_id, criada_em) VALUES (?, ?, ?, ?, ?)")
        .run(a.agente, a.para, a.texto, a.tarefa_id ?? null, agora());
      return { id: Number(id) };
    },
  },

  ler_mensagens: {
    description:
      "Lê a caixa de entrada de um agente (mensagens diretas e as enviadas a todos). Por padrão traz só as não lidas e as marca como lidas. Chame no início e no fim de cada tarefa.",
    inputSchema: {
      type: "object",
      properties: {
        agente: { type: "string", description: "Seu nome de agente." },
        incluir_lidas: { type: "boolean", description: "Padrão false." },
        marcar_como_lidas: { type: "boolean", description: "Padrão true." },
        limite: { type: "number", description: "Padrão 50." },
      },
      required: ["agente"],
    },
    run(a) {
      exigir(a, ["agente"]);
      const limite = Math.min(Number(a.limite) || 50, 200);
      const filtroLida = a.incluir_lidas ? "" : "AND lida = 0";
      // Mensagens para '*' são de todos: a leitura de cada agente fica em 'leituras_gerais'.
      const ultimoGeral = a.incluir_lidas
        ? 0
        : db.prepare("SELECT ultimo_id FROM leituras_gerais WHERE agente = ?").get(a.agente)?.ultimo_id ?? 0;
      const msgs = db
        .prepare(
          `SELECT id, de, para, texto, tarefa_id, lida, criada_em FROM mensagens
           WHERE ((para = ? ${filtroLida}) OR (para = '${TODOS}' AND de != ? AND id > ?))
           ORDER BY id DESC LIMIT ${limite}`
        )
        .all(a.agente, a.agente, ultimoGeral)
        .reverse();
      if (a.marcar_como_lidas !== false) {
        const ids = msgs.filter((m) => m.para === a.agente && !m.lida).map((m) => m.id);
        if (ids.length) db.prepare(`UPDATE mensagens SET lida = 1 WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
        const maxGeral = Math.max(0, ...msgs.filter((m) => m.para === TODOS).map((m) => m.id));
        if (maxGeral) {
          db.prepare(
            `INSERT INTO leituras_gerais (agente, ultimo_id) VALUES (?, ?)
             ON CONFLICT(agente) DO UPDATE SET ultimo_id = MAX(ultimo_id, excluded.ultimo_id)`
          ).run(a.agente, maxGeral);
        }
      }
      return { mensagens: msgs.map((m) => ({ ...m, lida: Boolean(m.lida) })) };
    },
  },
};

// ---------- MCP (JSON-RPC sobre Streamable HTTP, respostas em JSON) ----------
const VERSOES = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCOES = `Ponte compartilhada entre agentes (Claude e Antigravity).
Sempre informe seu nome de agente no campo 'agente' (ex.: 'claude-pesquisa', 'antigravity-dev').
Fluxo: ler_mensagens ao começar → listar_tarefas(responsavel=<você>) → atualizar_tarefa(status='em_andamento') → trabalhar → atualizar_tarefa(status='concluida', resultado=...) → ler_mensagens ao terminar.
O resultado deve ser autossuficiente: o outro agente não vê sua conversa nem seus arquivos locais.`;

function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }

function tratar(msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id, -32600, "Requisição inválida");
  }
  const ehNotificacao = msg.id === undefined;
  if (ehNotificacao) return null; // notifications/initialized etc.

  switch (msg.method) {
    case "initialize": {
      const pedida = msg.params?.protocolVersion;
      return rpcResult(msg.id, {
        protocolVersion: VERSOES.includes(pedida) ? pedida : VERSOES[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ponte-agentes", version: "1.0.0" },
        instructions: INSTRUCOES,
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, {
        tools: Object.entries(ferramentas).map(([name, f]) => ({ name, description: f.description, inputSchema: f.inputSchema })),
      });
    case "tools/call": {
      const nome = msg.params?.name;
      const f = ferramentas[nome];
      if (!f) return rpcError(msg.id, -32602, `Ferramenta desconhecida: ${nome}`);
      try {
        const saida = f.run(msg.params?.arguments || {});
        return rpcResult(msg.id, {
          content: [{ type: "text", text: JSON.stringify(saida, null, 2) }],
          structuredContent: saida,
        });
      } catch (e) {
        return rpcResult(msg.id, { content: [{ type: "text", text: `Erro: ${e.message}` }], isError: true });
      }
    }
    default:
      return rpcError(msg.id, -32601, `Método não suportado: ${msg.method}`);
  }
}

function tokenOk(candidato) {
  const a = Buffer.from(candidato || "");
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/health") { res.writeHead(200).end("ok"); return; }

  const m = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!m || !(tokenOk(m[1]) || tokenOk(bearer))) { res.writeHead(404).end(); return; }

  if (req.method === "GET" || req.method === "DELETE") {
    // Sem stream de servidor nem sessões neste servidor sem estado.
    res.writeHead(405, { Allow: "POST" }).end();
    return;
  }
  if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }).end(); return; }

  let corpo = "";
  req.on("data", (c) => {
    corpo += c;
    if (corpo.length > 1_000_000) { res.writeHead(413).end(); req.destroy(); }
  });
  req.on("end", () => {
    let msg;
    try { msg = JSON.parse(corpo); } catch {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify(rpcError(null, -32700, "JSON inválido")));
      return;
    }
    const lote = Array.isArray(msg);
    const respostas = (lote ? msg : [msg]).map(tratar).filter(Boolean);
    if (!respostas.length) { res.writeHead(202).end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(lote ? respostas : respostas[0]));
  });
});

servidor.listen(PORT, () => console.log(`Ponte de agentes ouvindo na porta ${PORT}`));
